import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSyntheticSourceInfo,
	type ResourceLoader,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type BackendToolRouteEntry,
	backendToolRouteEntry,
	createDiscoveryToolsExtension,
	diffSkillCatalog,
	loadBackendTool,
	loadBackendTools,
	loadSkill,
	searchBackendTools,
	searchSkills,
} from "../src/discovery-tools.ts";
import {
	SKILL_LOAD_TOOL_NAME,
	SKILL_SEARCH_TOOL_NAME,
	TOOL_LOAD_TOOL_NAME,
	TOOL_SEARCH_TOOL_NAME,
} from "../src/runtime-tool-names.ts";
import { type BackendToolManifest, BackendToolRegistry } from "../src/tool-bridge.ts";

function skill(options: {
	name: string;
	description: string;
	filePath?: string;
	disableModelInvocation?: boolean;
	routing?: Skill["routing"];
}): Skill {
	const filePath = options.filePath ?? `/managed/${options.name}/SKILL.md`;
	return {
		name: options.name,
		description: options.description,
		routing: options.routing,
		filePath,
		baseDir: filePath.slice(0, -"/SKILL.md".length),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("runtime discovery tools", () => {
	it("searches a stable public Skill catalog without exposing hidden skills or paths", () => {
		const skills = [
			skill({ name: "memory-review", description: "Review long-term memory." }),
			skill({ name: "daily-plan", description: "Maintain the daily task plan." }),
			skill({
				name: "operator-only",
				description: "Private operator instructions.",
				disableModelInvocation: true,
			}),
		];

		const result = searchSkills(skills, { query: "memory" });

		expect(result.items).toEqual([
			{
				name: "memory-review",
				when: ["Review long-term memory."],
				notFor: ["The task does not match the stated use case."],
				input: "Task request and relevant working context.",
				output: "Result defined by the loaded Skill instructions.",
				does: "Review long-term memory.",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("/managed/");
		expect(JSON.stringify(result)).not.toContain("operator-only");
		expect(searchSkills(skills.slice().reverse(), { query: "" }).catalogRevision).toBe(
			searchSkills(skills, { query: "" }).catalogRevision,
		);
	});

	it("searches structured routing-card fields and returns the exact public card", () => {
		const skills = [
			skill({
				name: "memory-review",
				description: "Compatibility-only description.",
				routing: {
					when: ["用户要求审阅记忆草案", "用户要求回滚已应用草案"],
					notFor: ["普通记忆查询"],
					input: "记忆草案、证据与用户决定。",
					output: "受控审阅结论与应用回执。",
					does: "审阅并受控应用长期记忆草案。",
				},
			}),
		];

		const result = searchSkills(skills, { query: "回滚" });

		expect(result).toMatchObject({
			schemaVersion: "rag-ime.skill-search.v2",
			items: [
				{
					name: "memory-review",
					when: ["用户要求审阅记忆草案", "用户要求回滚已应用草案"],
					notFor: ["普通记忆查询"],
					input: "记忆草案、证据与用户决定。",
					output: "受控审阅结论与应用回执。",
					does: "审阅并受控应用长期记忆草案。",
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("Compatibility-only description");
	});

	it("treats notFor as a veto instead of a positive search hit", () => {
		const tools = [
			{
				name: "agent_plan",
				description: "Maintain the Agent execution checklist.",
				parameters: { type: "object", properties: {} },
				when: ["复杂任务需要跨回合维护执行步骤"],
				notFor: ["修改用户每日计划或简单单步任务"],
				input: "Agent 清单项",
				output: "Agent 执行清单",
				does: "维护 Session 内执行清单。",
			},
			{
				name: "ime_planning",
				description: "Read and update the user's daily plan.",
				parameters: { type: "object", properties: {} },
				when: ["用户要查看每日计划或更新真实任务状态"],
				notFor: ["维护 Agent 自己的执行清单"],
				input: "日期与计划动作",
				output: "用户每日计划",
				does: "读取并受控更新用户每日规划。",
			},
		] as BackendToolManifest[];

		const result = searchBackendTools(tools, { query: "用户每日计划" }, "revision") as {
			items: BackendToolRouteEntry[];
		};

		expect(result.items.map((item) => item.name)).toEqual(["ime_planning"]);
	});

	it("loads a managed Skill by exact name and strips its frontmatter", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-skill-"));
		try {
			const filePath = join(root, "SKILL.md");
			await writeFile(
				filePath,
				["---", "name: memory-review", "description: Review memory", "---", "", "Follow the memory workflow."].join(
					"\n",
				),
			);

			const result = await loadSkill([skill({ name: "memory-review", description: "Review memory", filePath })], {
				name: "memory-review",
			});

			expect(result.text).toContain('name="memory-review"');
			expect(result.text).toContain("Follow the memory workflow.");
			expect(result.text).not.toContain("description: Review memory");
			expect(result.details.contentRevision).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports deterministic Skill catalog deltas", () => {
		const before = [
			skill({ name: "daily-plan", description: "Plan a day." }),
			skill({ name: "memory-review", description: "Review memory." }),
		];
		const after = [
			skill({ name: "memory-review", description: "Review and curate memory." }),
			skill({ name: "research", description: "Research a topic." }),
		];

		expect(diffSkillCatalog(before, after)).toMatchObject({
			added: ["research"],
			removed: ["daily-plan"],
			changed: ["memory-review"],
		});
	});

	it("treats routing-card edits as catalog changes", () => {
		const before = [
			skill({
				name: "memory-review",
				description: "Stable compatibility description.",
				routing: { when: ["用户要求审阅记忆草案"], does: "审阅记忆草案。" },
			}),
		];
		const after = [
			skill({
				name: "memory-review",
				description: "Stable compatibility description.",
				routing: { when: ["用户要求审阅或回滚记忆草案"], does: "审阅记忆草案。" },
			}),
		];

		expect(diffSkillCatalog(before, after).changed).toEqual(["memory-review"]);
	});

	it("bounds the always-visible tool route entry without exposing its schema", () => {
		const entry = backendToolRouteEntry({
			name: "workspace.long-running-operation",
			description: "Long tool purpose. ".repeat(40),
			parameters: { type: "object", properties: { secretArgument: { type: "string" } } },
		});

		expect(Object.keys(entry)).toEqual(["name", "when", "notFor", "input", "output", "does"]);
		expect(Array.from(JSON.stringify(entry)).length).toBeLessThanOrEqual(512);
		expect(JSON.stringify(entry)).not.toContain("secretArgument");
	});

	it("registers fixed discovery schemas and searches the live backend catalog", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			{
				name: "memory.query",
				description: "Query long-term memory.",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				when: ["需要从长期记忆中查找用户确认过的事实"],
				notFor: ["当前上下文已经包含答案"],
				input: "检索问题与范围",
				output: "有来源的记忆原文",
				does: "查询长期记忆。",
				profile: "memory",
				risk: "read",
			},
		]);
		const skills = [skill({ name: "memory-review", description: "Review memory." })];
		const resourceLoader = {
			getSkills: () => ({ skills, diagnostics: [] }),
		} as unknown as ResourceLoader;
		const registered = new Map<string, ToolDefinition>();
		let activeTools: string[] = [];
		let beforeAgentStart:
			| ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>)
			| undefined;
		const extension = createDiscoveryToolsExtension({
			getResourceLoader: () => resourceLoader,
			registry,
		});
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			on(event: string, handler: typeof beforeAgentStart) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			registerTool(toolDefinition: ToolDefinition) {
				registered.set(toolDefinition.name, toolDefinition);
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(toolNames: string[]) {
				activeTools = [...toolNames];
			},
		} as never);
		activeTools = [...registered.keys()];

		expect([...registered.keys()]).toEqual([
			SKILL_SEARCH_TOOL_NAME,
			SKILL_LOAD_TOOL_NAME,
			TOOL_SEARCH_TOOL_NAME,
			TOOL_LOAD_TOOL_NAME,
		]);
		if (!beforeAgentStart) throw new Error("before_agent_start hook was not registered");
		const prompt = await beforeAgentStart({ systemPrompt: "base prompt" });
		expect(prompt?.systemPrompt).toContain('<available_product_tools format="route-jsonl"');
		expect(prompt?.systemPrompt).toContain(
			'{"name":"memory.query","when":["需要从长期记忆中查找用户确认过的事实"],"notFor":["当前上下文已经包含答案"]',
		);
		expect(prompt?.systemPrompt).toContain('"input":"检索问题与范围"');
		expect(prompt?.systemPrompt).toContain('"output":"有来源的记忆原文"');
		expect(prompt?.systemPrompt).not.toContain('"parameters"');
		const result = searchBackendTools(registry.list(), { query: "memory" }, registry.revision());
		expect(result.items).toEqual([
			{
				name: "memory.query",
				when: ["需要从长期记忆中查找用户确认过的事实"],
				notFor: ["当前上下文已经包含答案"],
				input: "检索问题与范围",
				output: "有来源的记忆原文",
				does: "查询长期记忆。",
			},
		]);
		expect(JSON.stringify(result)).not.toContain('"parameters"');

		const loaded = loadBackendTool(registry, { name: "memory.query" });
		expect(loaded.result).toMatchObject({
			tool: {
				name: "memory.query",
				parameters: {
					properties: { query: { type: "string" } },
					type: "object",
				},
			},
		});
		const loadTool = registered.get(TOOL_LOAD_TOOL_NAME);
		if (!loadTool) throw new Error("tool_load was not registered");
		const loadResult = await loadTool.execute(
			"load-1",
			{ name: "memory.query" } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(registry.isDisclosed("memory.query")).toBe(true);
		expect(activeTools).toContain("memory.query");
		expect(registered.has("memory.query")).toBe(false);
		expect(loadResult.details).toMatchObject({
			disclosed: true,
			alreadyDisclosed: false,
			tool: { name: "memory.query" },
		});
		expect(JSON.stringify(loadResult.content)).not.toContain('"parameters"');
		const providerLoad = JSON.parse((loadResult.content[0] as { text: string }).text) as {
			tool: Record<string, unknown>;
		};
		expect(Object.keys(providerLoad.tool)).toEqual(["name", "when", "notFor", "input", "output", "does"]);
		expect(providerLoad.tool.input).toBe("检索问题与范围");
		expect(providerLoad.tool).not.toHaveProperty("profile");
		expect(providerLoad.tool).not.toHaveProperty("risk");
	});

	it("validates and discloses up to four exact Tool schemas as one Provider update", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			{
				name: "workspace_read",
				description: "Read a workspace file.",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
			{
				name: "workspace_search",
				description: "Search the workspace.",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		]);
		expect(
			loadBackendTools(registry, { names: ["workspace_search", "workspace_read"] }).map((item) => item.tool.name),
		).toEqual(["workspace_search", "workspace_read"]);
		expect(() => loadBackendTools(registry, { name: "workspace_read", names: ["workspace_search"] })).toThrow(
			"exactly one",
		);
		expect(() => loadBackendTools(registry, { names: ["workspace_read", "workspace_read"] })).toThrow("unique");

		const registered = new Map<string, ToolDefinition>();
		let activeTools: string[] = [];
		const extension = createDiscoveryToolsExtension({
			getResourceLoader: () =>
				({
					getSkills: () => ({ skills: [], diagnostics: [] }),
				}) as unknown as ResourceLoader,
			registry,
			gateway: {
				sessionId: "session-room",
				registry,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				roomCapability: { manifestId: "manifest:room" },
			},
		});
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			on() {},
			registerTool(toolDefinition: ToolDefinition) {
				registered.set(toolDefinition.name, toolDefinition);
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(toolNames: string[]) {
				activeTools = [...toolNames];
			},
		} as never);
		activeTools = [...registered.keys()];
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: "receipt:search" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: "receipt:read" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const loadTool = registered.get(TOOL_LOAD_TOOL_NAME);
			if (!loadTool) throw new Error("tool_load was not registered");
			const result = await loadTool.execute(
				"load-batch",
				{ names: ["workspace_search", "workspace_read"] } as never,
				undefined,
				undefined,
				{} as never,
			);

			expect(registry.disclosed().map((tool) => tool.name)).toEqual(["workspace_search", "workspace_read"]);
			expect(activeTools.slice(-2)).toEqual(["workspace_search", "workspace_read"]);
			expect(result.details).toMatchObject({
				schemaVersion: "rag-ime.tool-load-batch.v1",
				tools: [
					{
						tool: { name: "workspace_search" },
						governedReceipt: { receiptId: "receipt:search" },
					},
					{
						tool: { name: "workspace_read" },
						governedReceipt: { receiptId: "receipt:read" },
					},
				],
			});
			const providerResult = JSON.parse((result.content[0] as { text: string }).text) as {
				schemaVersion: string;
				tools: Array<Record<string, unknown>>;
			};
			expect(providerResult.schemaVersion).toBe("rag-ime.tool-load-batch.v1");
			expect(providerResult.tools.map((tool) => tool.name)).toEqual(["workspace_search", "workspace_read"]);
			expect(JSON.stringify(providerResult)).not.toContain('"parameters"');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does not expose any batch Tool schema when a governed load fails", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			{
				name: "workspace_read",
				description: "Read a workspace file.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace_search",
				description: "Search the workspace.",
				parameters: { type: "object", properties: {} },
			},
		]);
		const registered = new Map<string, ToolDefinition>();
		let activeTools = ["tool_load"];
		const extension = createDiscoveryToolsExtension({
			getResourceLoader: () =>
				({
					getSkills: () => ({ skills: [], diagnostics: [] }),
				}) as unknown as ResourceLoader,
			registry,
			gateway: {
				sessionId: "session-room",
				registry,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				roomCapability: { manifestId: "manifest:room" },
			},
		});
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			on() {},
			registerTool(toolDefinition: ToolDefinition) {
				registered.set(toolDefinition.name, toolDefinition);
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(toolNames: string[]) {
				activeTools = [...toolNames];
			},
		} as never);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: "receipt:search" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: false, error: "second load rejected" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const loadTool = registered.get(TOOL_LOAD_TOOL_NAME);
			if (!loadTool) throw new Error("tool_load was not registered");
			await expect(
				loadTool.execute(
					"load-batch-fail",
					{ names: ["workspace_search", "workspace_read"] } as never,
					undefined,
					undefined,
					{} as never,
				),
			).rejects.toThrow("second load rejected");
			expect(registry.disclosed()).toEqual([]);
			expect(registry.governedLoadReceipts()).toEqual([]);
			expect(activeTools).toEqual(["tool_load"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
