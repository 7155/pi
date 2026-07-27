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
	parameters?: Record<string, unknown>;
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
				receiptId: "invoke:room-state",
				canonicalCommand: { rootId: "root:private" },
			},
			executionReceipt: {
				executionReceiptId: "execution:invoke:room-state",
				sessionId: "session:private",
				toolName: "room_state",
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

			const commitTool = createBackendToolDefinition(options, tool({ name: "room_commit" }), artifacts);
			await commitTool.execute(
				"call-commit",
				{
					decision: "deliver",
					summary: "完成",
					evidence: [],
					residualRisks: [],
				} as never,
				undefined,
				undefined,
				{} as never,
			);
			const commitRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
				args: Record<string, unknown>;
			};
			expect(commitRequest.args.blocks).toEqual([block]);
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
				tool({ name: "room_post" }),
				artifacts,
			);
			await expect(
				definition.execute("call-post", { content: "交付" } as never, undefined, undefined, {} as never),
			).rejects.toThrow("gateway unavailable");
			expect(artifacts.size()).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps every model-visible product Tool result inside Pi's 50 KiB budget", async () => {
		const output = '长输出"\\\n'.repeat(40_000);
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
				summary: "测试输出已完成",
				exitCode: 0,
				mutationApplied: false,
				truncated: true,
				modelResultTruncated: true,
				truncatedBy: "model_result_bytes",
				maxBytes: MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES,
			});
			expect(String(visible.preview)).toContain("长输出");
			expect(result.details).toMatchObject({ output });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("binds a governed Room invocation to the loaded manifest receipt", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "room_post" })]);
		registry.recordLoadReceipt("room_post", "load:room-post");
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
				tool({ name: "room_post" }),
			);
			await definition.execute("call-room", { query: "done" } as never, undefined, undefined, {} as never);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				sessionId: "session-room",
				tool: "room_post",
				toolCallId: "call-room",
				loadReceiptId: "load:room-post",
				roomCapability: { manifestId: "manifest:1", manifestHash: "a".repeat(64) },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rebinds disclosed Tool receipts when the Room Dispatch manifest advances", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([tool({ name: "room_post" })]);
		registry.disclose("room_post");
		registry.recordLoadReceipt("room_post", "load:old-dispatch");
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

			expect(rebound).toEqual([{ name: "room_post", receiptId: "load:new-dispatch" }]);
			expect(registry.loadReceipt("room_post")).toBe("load:new-dispatch");
			expect(registry.disclosed().map((item) => item.name)).toEqual(["room_post"]);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(request).toMatchObject({
				sessionId: "session-room",
				receiptId: "load:rebind:dispatch:2:room_post",
				toolName: "room_post",
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
});
