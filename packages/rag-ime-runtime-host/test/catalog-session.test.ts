import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession, restoreBackendToolDisclosures } from "../src/pi-session.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

function manifest(risk: string, requireQuery = false) {
	return [
		{
			name: "memory.query",
			description: "Query long-term memory.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				...(requireQuery ? { required: ["query"] } : {}),
			},
			profile: "memory",
			risk,
		},
	];
}

describe("PiProductSession catalog updates", () => {
	it("loads one pinned Room Skill body before the Agent starts and returns its receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-required-room-skill-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		const skillDir = join(root, "product-skills", "structured-handoff");
		const body = "# Structured Handoff\n\nCarry the exact remaining work and evidence to the next owner.";
		const skillHash = createHash("sha256").update(body).digest("hex");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
			mkdir(skillDir, { recursive: true }),
		]);
		await writeFile(
			join(skillDir, "SKILL.md"),
			[
				"---",
				"name: structured-handoff",
				"description: Hand off bounded work.",
				"when:",
				"  - another owner must continue",
				"notFor:",
				"  - final closure with no next owner",
				"input: remaining work and evidence",
				"output: an addressed handoff package",
				"does: transfer exact ownership and next action",
				"---",
				"",
				body,
			].join("\n"),
		);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const productSession = await PiProductSession.create({
			externalSessionId: "required-room-skill-test",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [skillDir],
			piSkillPaths: [],
			codexSkillPaths: [],
			modelRuntime,
			toolManifest: [],
			systemPrompt: "stable managed prompt",
			roomSkillPolicy: {
				selection: "required",
				skillId: "structured-handoff",
				skillHash,
			},
			noContextFiles: true,
			emitEvent: () => undefined,
		});

		try {
			expect(productSession.roomSkillLoad).toEqual({
				schemaVersion: "rag-ime.skill-load.v1",
				name: "structured-handoff",
				catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
				contentRevision: skillHash,
				loadReason: "stage_required",
			});
			const internal = productSession as unknown as { session: { systemPrompt: string } };
			expect(internal.session.systemPrompt).toContain("stable managed prompt");
			expect(internal.session.systemPrompt).toContain(
				`<loaded_skill name="structured-handoff" revision="sha256:${skillHash}">`,
			);
			expect(internal.session.systemPrompt).toContain(body);
			expect(internal.session.systemPrompt).not.toContain("description: Hand off bounded work.");
			expect(internal.session.systemPrompt.match(/<loaded_skill /gu)).toHaveLength(1);
			const deferredCatalog = internal.session.systemPrompt.match(
				/<available_skills[^>]*>([\s\S]*?)<\/available_skills>/u,
			)?.[1];
			expect(deferredCatalog).toBeDefined();
			expect(deferredCatalog).not.toContain("structured-handoff");
			expect(internal.session.systemPrompt).toContain("never load that Skill again");
			expect(productSession.snapshot()).toMatchObject({ roomSkillLoad: productSession.roomSkillLoad });
		} finally {
			productSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("starts a managed Room with one direct room_partner tool and a projected memory capture tool", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-room-bootstrap-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const request = JSON.parse(String(init?.body)) as { toolName?: string };
			return new Response(
				JSON.stringify({
					ok: true,
					result: { receiptId: `receipt:${request.toolName}` },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		let productSession: PiProductSession | undefined;
		try {
			productSession = await PiProductSession.create({
				externalSessionId: "room-bootstrap-session",
				cwd: root,
				sessionDir,
				agentDir,
				activePluginDir,
				skillPaths: [],
				piSkillPaths: [],
				codexSkillPaths: [],
				modelRuntime,
				toolManifest: [
					{
						name: "room_partner",
						description: "Coordinate Room Partners and publish Room results.",
						parameters: {
							type: "object",
							properties: { op: { enum: ["list", "delegate", "post"] } },
							required: ["op"],
						},
						alwaysAvailable: true,
					},
					{
						name: "ime_memory",
						description: "Use governed memory.",
						parameters: {
							type: "object",
							oneOf: [
								{
									type: "object",
									properties: {
										op: { const: "capture" },
										kind: { type: "string" },
										claim: { type: "string" },
										captureScope: { type: "string" },
										reason: { type: "string" },
									},
								},
							],
						},
						runtimeProjections: [
							{
								name: "memory_capture",
								operation: "capture",
							},
						],
					},
				],
				roomCapability: {
					manifestId: "manifest:room-bootstrap",
					manifestHash: "c".repeat(64),
				},
				toolGatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				noContextFiles: true,
				emitEvent() {},
			});

			expect(productSession.snapshot()).toMatchObject({
				disclosedBackendTools: ["room_partner"],
				activeBackendTools: ["room_partner"],
			});
			const tools = new Map(productSession.listTools().map((tool) => [String(tool.name), tool]));
			expect(tools.get("room_partner")).toMatchObject({ active: true });
			expect(tools.get("memory_capture")).toMatchObject({ active: true });
			expect(tools.get("ime_memory")).toMatchObject({ active: false });
			const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))) as Array<{
				toolName: string;
			}>;
			expect(requests.map((request) => request.toolName)).toEqual(["ime_memory"]);
		} finally {
			productSession?.dispose();
			vi.unstubAllGlobals();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps edit and write out of the complete Agent tool registry", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-five-native-tools-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const target = (name: string, runtimeProjections: Array<{ name: string; operation: string }>) => ({
			name,
			description: `Run ${name}.`,
			parameters: {
				type: "object",
				oneOf: runtimeProjections.map(({ operation }) => ({
					type: "object",
					properties: { op: { const: operation } },
					required: ["op"],
				})),
			},
			modelVisible: false,
			runtimeProjections,
		});
		const productSession = await PiProductSession.create({
			externalSessionId: "five-native-tools-session",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [],
			piSkillPaths: [],
			codexSkillPaths: [],
			modelRuntime,
			toolManifest: [
				target("workspace_read", [{ name: "read", operation: "read" }]),
				target("workspace_search", [
					{ name: "grep", operation: "search" },
					{ name: "find", operation: "search" },
				]),
				target("workspace_list", [{ name: "ls", operation: "list" }]),
				target("workspace_edit", [{ name: "edit", operation: "apply" }]),
				target("workspace_write", [{ name: "write", operation: "apply" }]),
				target("workspace_shell", [{ name: "bash", operation: "run" }]),
			],
			toolGatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			noContextFiles: true,
			emitEvent() {},
		});

		try {
			const tools = new Map(productSession.listTools().map((tool) => [String(tool.name), tool]));
			expect(["read", "grep", "find", "ls", "bash"].map((name) => tools.get(name)?.active)).toEqual([
				true,
				true,
				true,
				true,
				true,
			]);
			expect(tools.get("edit")?.active).toBe(false);
			expect(tools.get("write")?.active).toBe(false);
			expect(productSession.snapshot().activeBackendTools).not.toEqual(
				expect.arrayContaining(["workspace_edit", "workspace_write"]),
			);
		} finally {
			productSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads product Skills always and Pi/Codex Skills only through their independent settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-product-skills-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		const promptDir = join(agentDir, "prompts");
		const ambientSkillDir = join(agentDir, "skills", "ambient-workspace-skill");
		const productSkillDir = join(root, "product-skills", "rag-ime-product-skill");
		const piSkillDir = join(root, "pi-skills", "pi-user-skill");
		const codexSkillDir = join(root, "codex-skills", "codex-user-skill");
		await Promise.all([
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
			mkdir(promptDir, { recursive: true }),
			mkdir(ambientSkillDir, { recursive: true }),
			mkdir(productSkillDir, { recursive: true }),
			mkdir(piSkillDir, { recursive: true }),
			mkdir(codexSkillDir, { recursive: true }),
		]);
		await Promise.all([
			writeFile(
				join(promptDir, "init.md"),
				"---\ndescription: Initialize project instructions.\n---\nCreate or update AGENTS.md.\n",
			),
			writeFile(
				join(ambientSkillDir, "SKILL.md"),
				"---\nname: ambient-workspace-skill\ndescription: Must remain outside the product catalog.\n---\n",
			),
			writeFile(
				join(productSkillDir, "SKILL.md"),
				"---\nname: rag-ime-product-skill\ndescription: Explicit product Skill.\n---\n",
			),
			writeFile(join(piSkillDir, "SKILL.md"), "---\nname: pi-user-skill\ndescription: Optional Pi Skill.\n---\n"),
			writeFile(
				join(codexSkillDir, "SKILL.md"),
				"---\nname: codex-user-skill\ndescription: Optional Codex Skill.\n---\n",
			),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const sessionOptions = {
			externalSessionId: "product-skill-test",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [productSkillDir],
			piSkillPaths: [piSkillDir],
			codexSkillPaths: [codexSkillDir],
			modelRuntime,
			toolManifest: [],
			noContextFiles: true,
			emitEvent: () => undefined,
		};
		const productSession = await PiProductSession.create(sessionOptions);

		try {
			expect(productSession.listCommands()).toEqual([
				expect.objectContaining({ name: "init", source: "prompt" }),
				expect.objectContaining({ name: "skill:rag-ime-product-skill" }),
			]);
			expect(productSession.snapshot()).toMatchObject({
				piSkillsEnabled: false,
				codexSkillsEnabled: false,
			});
			expect(JSON.stringify(productSession.listCommands())).not.toContain("ambient-workspace-skill");
			expect(JSON.stringify(productSession.listCommands())).not.toContain("pi-user-skill");
			expect(JSON.stringify(productSession.listCommands())).not.toContain("codex-user-skill");
		} finally {
			productSession.dispose();
		}

		const piSession = await PiProductSession.create({
			...sessionOptions,
			externalSessionId: "pi-skill-test",
			piSkillsEnabled: true,
		});
		try {
			expect(piSession.listCommands().map((command) => command.name)).toEqual([
				"init",
				"skill:rag-ime-product-skill",
				"skill:pi-user-skill",
			]);
			expect(piSession.snapshot()).toMatchObject({ piSkillsEnabled: true, codexSkillsEnabled: false });
		} finally {
			piSession.dispose();
		}

		const codexSession = await PiProductSession.create({
			...sessionOptions,
			externalSessionId: "codex-skill-test",
			codexSkillsEnabled: true,
		});
		try {
			expect(codexSession.listCommands().map((command) => command.name)).toEqual([
				"init",
				"skill:rag-ime-product-skill",
				"skill:codex-user-skill",
			]);
			expect(codexSession.snapshot()).toMatchObject({ piSkillsEnabled: false, codexSkillsEnabled: true });
		} finally {
			codexSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("restores only schemas explicitly disclosed by tool_load", () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			...manifest("read"),
			{
				name: "settings.apply",
				description: "Apply settings.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace.read",
				description: "Read workspace files.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace.search",
				description: "Internal governed search target.",
				parameters: { type: "object", properties: {} },
				modelVisible: false,
			},
		]);
		const sessionManager = {
			getBranch: () => [
				{
					type: "message",
					message: { role: "toolResult", toolName: "memory.query", isError: false },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "tool_load",
						isError: false,
						details: { tool: { name: "settings.apply" } },
					},
				},
				{
					type: "message",
					message: { role: "toolResult", toolName: "unknown.tool", isError: false },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "tool_load",
						isError: false,
						details: { tool: { name: "workspace.search" } },
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "tool_load",
						isError: false,
						details: {
							schemaVersion: "rag-ime.tool-load-batch.v1",
							tools: [
								{
									tool: { name: "workspace.read" },
									governedReceipt: { receiptId: "receipt:workspace-read" },
								},
								{ tool: { name: "missing.tool" } },
							],
						},
					},
				},
			],
		} as unknown as SessionManager;

		expect(restoreBackendToolDisclosures(registry, sessionManager)).toEqual(["settings.apply", "workspace.read"]);
		expect(registry.disclosed().map((tool) => tool.name)).toEqual(["settings.apply", "workspace.read"]);
		expect(registry.loadReceipt("workspace.read")).toBe("receipt:workspace-read");
	});

	it("keeps permission-only changes in the incremental suffix and reloads only real schema changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-catalog-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const events: Array<Record<string, unknown>> = [];
		const productSession = await PiProductSession.create({
			externalSessionId: "catalog-test",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [],
			piSkillPaths: [],
			codexSkillPaths: [],
			modelRuntime,
			toolManifest: manifest("read"),
			noContextFiles: true,
			emitEvent: (event) => events.push(event as unknown as Record<string, unknown>),
		});

		try {
			expect(productSession.snapshot()).toMatchObject({
				activeBackendTools: [],
				disclosedBackendTools: [],
			});
			expect(productSession.listTools()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "memory.query",
						active: false,
						disclosed: false,
						routable: true,
						catalogOnly: false,
					}),
					expect.objectContaining({
						name: "tool_load",
						active: true,
						catalogOnly: false,
					}),
				]),
			);
			const internal = productSession as unknown as {
				session: {
					reload(): Promise<void>;
					agent: { resolveToolForExecution?: (name: string) => unknown };
				};
			};
			expect(internal.session.agent.resolveToolForExecution?.("memory.query")).toBeDefined();
			const reload = vi.spyOn(internal.session, "reload").mockResolvedValue(undefined);

			await productSession.syncTools(manifest("approval"));

			expect(reload).not.toHaveBeenCalled();
			expect(productSession.snapshot().messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "custom",
						customType: "rag-ime.runtime-catalog-change",
					}),
				]),
			);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: "runtime.notice",
						payload: expect.objectContaining({
							type: "runtime_catalog_changed",
							schemaReloaded: false,
						}),
					}),
				]),
			);

			productSession.toolRegistry.disclose("memory.query");
			await productSession.syncTools(manifest("approval", true));

			expect(reload).toHaveBeenCalledTimes(1);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: "runtime.notice",
						payload: expect.objectContaining({
							type: "runtime_catalog_changed",
							schemaReloaded: true,
						}),
					}),
				]),
			);
		} finally {
			productSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
