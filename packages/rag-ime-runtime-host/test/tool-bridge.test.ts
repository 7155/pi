import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES,
	modelVisibleResult,
	modelVisibleToolGatewayResult,
	ToolArtifactBuffer,
	toolAgentBlocks,
} from "../src/tool-artifact-buffer.ts";
import {
	BackendToolRegistry,
	backendToolCatalogRevision,
	backendToolSchemaRevision,
	createBackendToolDefinition,
	createBackendToolExtension,
	diffBackendToolCatalog,
	rebindGovernedToolReceipts,
} from "../src/tool-bridge.ts";
import { ToolResultStore } from "../src/tool-result-store.ts";

function managedFileBlock(sessionId = "session-room") {
	const mediaId = "media_abcdefghijklmnop";
	return {
		id: "tool-artifact:file:0123456789abcdef",
		type: "file",
		data: {
			mediaId,
			sessionId,
			fileName: "handoff.md",
			mimeType: "text/markdown",
			byteSize: 42,
			sha256: "a".repeat(64),
			receiptUrl: `/api/agent/media/${mediaId}/content?sessionId=${encodeURIComponent(sessionId)}`,
		},
	};
}

function tool(options: {
	name: string;
	description?: string;
	profile?: string;
	risk?: string;
	alwaysAvailable?: boolean;
	parameters?: Record<string, unknown>;
	modelVisible?: boolean;
	runtimeProjections?: Array<{ name: string; operation: string }>;
}) {
	return {
		name: options.name,
		description: options.description ?? `Run ${options.name}`,
		parameters:
			options.parameters ??
			({
				type: "object",
				properties: {
					query: { type: "string" },
				},
			} as Record<string, unknown>),
		profile: options.profile,
		risk: options.risk,
		alwaysAvailable: options.alwaysAvailable,
		modelVisible: options.modelVisible,
		runtimeProjections: options.runtimeProjections,
	};
}

describe("BackendToolRegistry", () => {
	it("canonicalizes manifest and schema ordering for a stable cache prefix", () => {
		const registry = new BackendToolRegistry();
		const first = registry.sync([
			tool({
				name: "zeta.run",
				parameters: {
					properties: { z: { type: "string" }, a: { type: "integer" } },
					type: "object",
				},
			}),
			tool({ name: "alpha.query" }),
		]);
		const firstRevision = registry.revision();
		const firstSchemaRevision = backendToolSchemaRevision(first);

		const second = registry.sync([
			tool({ name: "alpha.query" }),
			tool({
				name: "zeta.run",
				parameters: {
					type: "object",
					properties: { a: { type: "integer" }, z: { type: "string" } },
				},
			}),
		]);

		expect(second.map((item) => item.name)).toEqual(["alpha.query", "zeta.run"]);
		expect(registry.revision()).toBe(firstRevision);
		expect(backendToolSchemaRevision(second)).toBe(firstSchemaRevision);
	});

	it("automatically discloses always-available tools without treating them as explicit loads", () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "todo", alwaysAvailable: true }), tool({ name: "memory.query" })]);
		expect(registry.automaticallyDisclosed().map((item) => item.name)).toEqual(["todo"]);
		expect(registry.explicitlyDisclosed()).toEqual([]);
		expect(registry.disclosed().map((item) => item.name)).toEqual(["todo"]);
		expect(registry.isDisclosed("todo")).toBe(true);
		expect(registry.isAutomaticallyDisclosed("todo")).toBe(true);

		registry.disclose("memory.query");
		registry.sync([tool({ name: "todo", alwaysAvailable: false }), tool({ name: "memory.query" })]);
		expect(registry.automaticallyDisclosed()).toEqual([]);
		expect(registry.isDisclosed("todo")).toBe(false);
		expect(registry.isDisclosed("memory.query")).toBe(true);
		expect(registry.isExplicitlyDisclosed("memory.query")).toBe(true);
	});

	it("keeps Room governance receipts out of model context and exposes one short evidence ref", () => {
		const product = modelVisibleToolGatewayResult({
			ok: true,
			result: { content: "bounded file content" },
			roomExecutionReceipt: {
				executionReceiptId: "execution:invoke:workspace-read",
				invocationReceiptId: "invoke:workspace-read",
				sessionId: "session:private",
				toolName: "workspace_read",
				status: "applied",
			},
		});
		expect(product).toEqual({
			evidenceRef: "execution:invoke:workspace-read",
			ok: true,
			result: { content: "bounded file content" },
		});

		const lifecycle = modelVisibleToolGatewayResult({
			ok: true,
			result: {
				participants: [{ participantRef: "P1", displayName: "伙伴" }],
			},
			invocationReceipt: {
				receiptId: "invoke:room-partner",
				canonicalCommand: { rootId: "root:private" },
			},
			executionReceipt: {
				executionReceiptId: "execution:invoke:room-partner",
				sessionId: "session:private",
				toolName: "room_partner",
				status: "applied",
			},
		});
		expect(lifecycle).toEqual({
			ok: true,
			result: {
				participants: [{ participantRef: "P1", displayName: "伙伴" }],
			},
		});
	});

	it("keeps approval and memory audit payloads in details instead of model context", () => {
		const product = modelVisibleToolGatewayResult({
			summary: "命令执行完成，退出码 0",
			approvalRequired: false,
			autoApproved: true,
			approvalId: "approval:private",
			approval: {
				approvalId: "approval:private",
				preview: { command: "private command" },
				receipt: { auditId: "audit:private" },
			},
			receipt: {
				summary: "命令执行完成，退出码 0",
				output: "3 tests passed",
				approvalId: "approval:private",
				auditId: "audit:private",
				roomExecutionReceipt: {
					executionReceiptId: "execution:invoke:nested",
					toolName: "workspace_shell",
					status: "applied",
				},
			},
			memoryCheckpoint: {
				source: { sourceId: "agent-memory:private" },
			},
			roomExecutionReceipt: {
				executionReceiptId: "execution:invoke:workspace-shell",
				toolName: "workspace_shell",
				status: "applied",
			},
		});

		expect(product).toEqual({
			evidenceRef: "execution:invoke:workspace-shell",
			summary: "命令执行完成，退出码 0",
			approvalRequired: false,
			autoApproved: true,
			receipt: {
				summary: "命令执行完成，退出码 0",
				output: "3 tests passed",
			},
		});
	});

	it("separates metadata-only permission changes from schema changes", () => {
		const before = [tool({ name: "memory.query", profile: "standard", risk: "read" })];
		const metadataOnly = [tool({ name: "memory.query", profile: "strict", risk: "approval" })];
		const schemaChange = [
			tool({
				name: "memory.query",
				profile: "strict",
				risk: "approval",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			}),
		];

		const metadataDiff = diffBackendToolCatalog(before, metadataOnly);
		expect(metadataDiff.changed).toEqual(["memory.query"]);
		expect(metadataDiff.metadataChanged).toEqual(["memory.query"]);
		expect(metadataDiff.schemaChanged).toEqual([]);
		expect(metadataDiff.previousSchemaRevision).toBe(metadataDiff.schemaRevision);
		expect(metadataDiff.previousRevision).not.toBe(metadataDiff.revision);

		const schemaDiff = diffBackendToolCatalog(metadataOnly, schemaChange);
		expect(schemaDiff.schemaChanged).toEqual(["memory.query"]);
		expect(schemaDiff.previousSchemaRevision).not.toBe(schemaDiff.schemaRevision);
	});

	it("reports additions and removals and reserves runtime discovery names", () => {
		const before = [tool({ name: "memory.query" })];
		const after = [tool({ name: "planning.update" })];

		expect(diffBackendToolCatalog(before, after)).toMatchObject({
			added: ["planning.update"],
			removed: ["memory.query"],
		});
		expect(backendToolCatalogRevision(before)).not.toBe(backendToolCatalogRevision(after));

		const registry = new BackendToolRegistry();
		registry.sync(before);
		expect(registry.disclosed()).toEqual([]);
		expect(registry.disclose("memory.query").name).toBe("memory.query");
		expect(registry.disclosed().map((item) => item.name)).toEqual(["memory.query"]);
		registry.sync(after);
		expect(registry.disclosed()).toEqual([]);

		for (const name of ["skill_load", "tool_load", "memory_capture"]) {
			expect(() => registry.sync([tool({ name })])).toThrow("Tool name is reserved by the runtime host");
		}
	});

	it("keeps newly disclosed Tool schemas in append order without reordering the stable prefix", () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "alpha.query" }), tool({ name: "zeta.run" })]);

		registry.disclose("zeta.run");
		registry.disclose("alpha.query");
		registry.disclose("zeta.run");

		expect(registry.disclosed().map((item) => item.name)).toEqual(["zeta.run", "alpha.query"]);
	});

	it("registers the authorized catalog without disclosing every schema", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "memory.query" }), tool({ name: "planning.update" })]);
		const registered: string[] = [];
		const extension = createBackendToolExtension({ sessionId: "session-1", registry });
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			registerTool(definition: ToolDefinition) {
				registered.push(definition.name);
			},
		} as never);

		expect(registered.sort()).toEqual(["memory.query", "planning.update"]);
		expect(registry.disclosed()).toEqual([]);
	});

	it("bounds one Session's parallel gateway requests without serializing the Tool loop", async () => {
		let activeRequests = 0;
		let maximumActiveRequests = 0;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
			activeRequests += 1;
			maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
			await new Promise((resolve) => setTimeout(resolve, 4));
			activeRequests -= 1;
			return new Response(JSON.stringify({ ok: true, result: { summary: "已读取文件" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const options = {
				sessionId: "session-many-reads",
				registry: new BackendToolRegistry(),
				gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			};
			const definition = createBackendToolDefinition(options, tool({ name: "workspace_read" }));
			const results = await Promise.all(
				Array.from({ length: 52 }, (_, index) =>
					definition.execute(
						`call-${index}`,
						{ query: `file-${index}` } as never,
						undefined,
						undefined,
						{} as never,
					),
				),
			);

			expect(fetchMock).toHaveBeenCalledTimes(52);
			expect(maximumActiveRequests).toBe(8);
			expect(results).toHaveLength(52);
			expect(results.every((result) => result.content[0]?.type === "text")).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps the native approval bridge on a dynamically loaded tool", async () => {
		const waitForDecision = vi.fn(async () => true);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							approvalRequired: true,
							approval: { approvalId: "approval-1", state: "pending" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						approval: {
							approvalId: "approval-1",
							state: "applied",
							receipt: {
								summary: "设置已应用",
								roomExecutionReceipt: {
									executionReceiptId: "execution:invoke:settings-apply",
									invocationReceiptId: "invoke:settings-apply",
									sessionId: "session-1",
									toolName: "settings.apply",
									status: "applied",
								},
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-1",
					registry: new BackendToolRegistry(),
					gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
					waitForDecision,
				},
				tool({ name: "settings.apply" }),
			);
			expect(definition.executionMode).toBe("parallel");

			const result = await definition.execute(
				"call-1",
				{ query: "apply" } as never,
				undefined,
				undefined,
				{} as never,
			);

			expect(waitForDecision).toHaveBeenCalledWith(
				"approval",
				"approval-1",
				expect.objectContaining({ approvalRequired: true }),
				undefined,
			);
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
				"http://127.0.0.1:8768/api/agent/tool/execute",
				"http://127.0.0.1:8768/api/agent/tool/approval-result",
			]);
			expect(result.details).toMatchObject({
				approvalState: "applied",
				approval: { receipt: { summary: "设置已应用" } },
			});
			const visibleContent = result.content[0];
			if (visibleContent?.type !== "text") throw new Error("Expected a model-visible text result");
			const visible = JSON.parse(visibleContent.text) as Record<string, unknown>;
			expect(visible).toMatchObject({
				summary: "设置已应用",
				approvalState: "applied",
				evidenceRef: "execution:invoke:settings-apply",
			});
			expect(JSON.stringify(visible)).not.toContain("roomExecutionReceipt");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("preserves an outer gateway execution receipt as one model-visible evidence ref", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: { summary: "已读取文件", content: "bounded" },
					roomExecutionReceipt: {
						executionReceiptId: "execution:invoke:workspace-read",
						invocationReceiptId: "invoke:workspace-read",
						sessionId: "session-room",
						toolName: "workspace_read",
						status: "applied",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-room",
					registry: new BackendToolRegistry(),
					gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
				},
				tool({ name: "workspace_read" }),
			);
			const result = await definition.execute(
				"call-read",
				{ path: "README.md" } as never,
				undefined,
				undefined,
				{} as never,
			);
			const visibleContent = result.content[0];
			if (visibleContent?.type !== "text") throw new Error("Expected a model-visible text result");
			const visible = JSON.parse(visibleContent.text) as Record<string, unknown>;
			expect(visible).toEqual({
				summary: "已读取文件",
				content: "bounded",
				evidenceRef: "execution:invoke:workspace-read",
			});
			expect(result.details).toMatchObject({
				roomExecutionReceipt: {
					executionReceiptId: "execution:invoke:workspace-read",
				},
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps managed artifacts out of model context and carries them into the governed Room delivery", async () => {
		const artifacts = new ToolArtifactBuffer();
		const block = managedFileBlock();
		const waitForDecision = vi.fn(async () => true);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							approvalRequired: true,
							approval: { approvalId: "approval-artifact", state: "pending" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						approval: {
							approvalId: "approval-artifact",
							state: "applied",
							receipt: { summary: "文件已写入", agentBlocks: [block] },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const options = {
				sessionId: "session-room",
				registry: new BackendToolRegistry(),
				gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
				waitForDecision,
			};
			const patchTool = createBackendToolDefinition(options, tool({ name: "workspace_patch" }), artifacts);
			const patchResult = await patchTool.execute(
				"call-patch",
				{ query: "apply" } as never,
				undefined,
				undefined,
				{} as never,
			);

			const modelText = JSON.stringify(patchResult.content);
			expect(modelText).toContain("文件已写入");
			expect(modelText).not.toContain("agentBlocks");
			expect(modelText).not.toContain("media_abcdefghijklmnop");
			expect(patchResult.details).toMatchObject({ agentBlocks: [block] });
			expect(artifacts.size()).toBe(1);

			const roomPartnerTool = createBackendToolDefinition(options, tool({ name: "room_partner" }), artifacts);
			await roomPartnerTool.execute(
				"call-room-result",
				{
					op: "post",
					kind: "result",
					content: "完成",
				} as never,
				undefined,
				undefined,
				{} as never,
			);
			const roomResultRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
				args: Record<string, unknown>;
			};
			expect(roomResultRequest.args.blocks).toEqual([block]);
			expect(artifacts.size()).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("retains a pending Room artifact when delivery fails and rejects forged receipts", async () => {
		const artifacts = new ToolArtifactBuffer();
		const block = managedFileBlock();
		expect(artifacts.capture({ details: { approval: { receipt: { agentBlocks: [block] } } } })).toEqual([block]);
		expect(
			toolAgentBlocks({ agentBlocks: [{ ...block, data: { ...block.data, mediaId: "../../secret" } }] }),
		).toEqual([]);
		expect(modelVisibleResult({ receipt: { agentBlocks: [block], summary: "done" } })).toEqual({
			receipt: { summary: "done" },
		});

		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("gateway unavailable"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-room",
					registry: new BackendToolRegistry(),
					gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
				},
				tool({ name: "room_partner" }),
				artifacts,
			);
			await expect(
				definition.execute(
					"call-post",
					{ op: "post", kind: "result", content: "交付" } as never,
					undefined,
					undefined,
					{} as never,
				),
			).rejects.toThrow("gateway unavailable");
			expect(artifacts.size()).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps every model-visible product Tool result inside Pi's 50 KiB budget", async () => {
		const output = '长输出"\\\n'.repeat(40_000);
		const resultDirectory = mkdtempSync(join(tmpdir(), "pi-tool-result-"));
		const resultStore = new ToolResultStore(resultDirectory);
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: {
						summary: "测试输出已完成",
						exitCode: 0,
						mutationApplied: false,
						output,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-bounded-result",
					registry: new BackendToolRegistry(),
					gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
					resultStore,
				},
				tool({ name: "workspace_shell" }),
			);
			const result = await definition.execute(
				"call-large-output",
				{ command: "test" } as never,
				undefined,
				undefined,
				{} as never,
			);
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			const visible = JSON.parse(text) as Record<string, unknown>;

			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES);
			expect(visible).toMatchObject({
				evidenceAvailable: true,
				summary: "测试输出已完成",
				exitCode: 0,
				mutationApplied: false,
				truncated: true,
				modelResultTruncated: true,
				truncatedBy: "model_result_bytes",
				maxBytes: MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES,
			});
			expect(Object.keys(visible)[0]).toBe("evidenceHandle");
			expect(String(visible.previewHead)).toContain("长输出");
			expect(resultStore.read(String(visible.evidenceHandle)).content).toContain("长输出");
			expect(result.details).toMatchObject({ output });
		} finally {
			vi.unstubAllGlobals();
			rmSync(resultDirectory, { recursive: true, force: true });
		}
	});

	it("binds a governed deferred Tool invocation to the loaded manifest receipt", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "ime_plugins" })]);
		registry.recordLoadReceipt("ime_plugins", "load:plugins");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-room",
					registry,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					roomCapability: { manifestId: "manifest:1", manifestHash: "a".repeat(64) },
				},
				tool({ name: "ime_plugins" }),
			);
			await definition.execute("call-room", { query: "done" } as never, undefined, undefined, {} as never);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				sessionId: "session-room",
				tool: "ime_plugins",
				toolCallId: "call-room",
				loadReceiptId: "load:plugins",
				roomCapability: { manifestId: "manifest:1", manifestHash: "a".repeat(64) },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rebinds disclosed Tool receipts when the Room Dispatch manifest advances", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "ime_plugins" })]);
		registry.disclose("ime_plugins");
		registry.recordLoadReceipt("ime_plugins", "load:old-dispatch");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, result: { receiptId: "load:new-dispatch" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const rebound = await rebindGovernedToolReceipts(
				{
					sessionId: "session-room",
					registry,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					roomCapability: { manifestId: "manifest:2", manifestHash: "b".repeat(64) },
				},
				"dispatch:2",
			);

			expect(rebound).toEqual([{ name: "ime_plugins", receiptId: "load:new-dispatch" }]);
			expect(registry.loadReceipt("ime_plugins")).toBe("load:new-dispatch");
			expect(registry.disclosed().map((item) => item.name)).toEqual(["ime_plugins"]);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				sessionId: "session-room",
				receiptId: "load:rebind:dispatch:2:ime_plugins",
				toolName: "ime_plugins",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rebinds a governed projected Tool target without disclosing its schema", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "ime_memory" })]);
		registry.recordLoadReceipt("ime_memory", "load:old-memory");
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, result: { receiptId: "load:new-memory" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const rebound = await rebindGovernedToolReceipts(
				{
					sessionId: "session-room",
					registry,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					roomCapability: { manifestId: "manifest:2", manifestHash: "b".repeat(64) },
				},
				"dispatch:2",
			);

			expect(rebound).toEqual([{ name: "ime_memory", receiptId: "load:new-memory" }]);
			expect(registry.loadReceipt("ime_memory")).toBe("load:new-memory");
			expect(registry.disclosed()).toEqual([]);
			expect(registry.governedLoadReceipts()).toEqual([]);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				receiptId: "load:rebind:dispatch:2:ime_memory",
				toolName: "ime_memory",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rebinds hidden native coding targets without making them discoverable", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			tool({
				name: "workspace_read",
				modelVisible: false,
				parameters: {
					type: "object",
					oneOf: [
						{
							type: "object",
							properties: {
								op: { const: "read" },
								path: { type: "string" },
							},
							required: ["op", "path"],
						},
					],
				},
				runtimeProjections: [{ name: "read", operation: "read" }],
			}),
		]);
		registry.recordLoadReceipt("workspace_read", "load:old-read");
		const receiptId = "load:rebind:dispatch:2:workspace_read";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: { items: [{ receiptId, toolName: "workspace_read" }] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const rebound = await rebindGovernedToolReceipts(
				{
					sessionId: "session-room",
					registry,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					roomCapability: { manifestId: "manifest:2", manifestHash: "b".repeat(64) },
				},
				"dispatch:2",
			);

			expect(rebound).toEqual([{ name: "workspace_read", receiptId }]);
			expect(registry.loadReceipt("workspace_read")).toBe(receiptId);
			expect(registry.catalog()).toEqual([]);
			expect(registry.disclosed()).toEqual([]);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				sessionId: "session-room",
				loads: [{ receiptId, toolName: "workspace_read" }],
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
