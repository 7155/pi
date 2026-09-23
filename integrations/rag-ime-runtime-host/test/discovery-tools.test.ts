import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSyntheticSourceInfo,
	type ResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type BackendToolRouteEntry,
	backendToolRouteEntry,
	createDiscoveryToolsExtension,
	diffSkillCatalog,
	formatBackendToolRouteCatalog,
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
import type { SkillRoutingCard, SkillWithRouting } from "../src/skill-routing-cards.ts";
import { type BackendToolManifest, BackendToolRegistry } from "../src/tool-bridge.ts";

function skill(options: {
	name: string;
	description: string;
	filePath?: string;
	disableModelInvocation?: boolean;
	routing?: SkillRoutingCard;
}): SkillWithRouting {
	const filePath = options.filePath ?? `/managed/${options.name}/SKILL.md`;
	return {
		name: options.name,
		description: options.description,
		...(options.routing ? { routing: options.routing } : {}),
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

	it("keeps grill-me-docs deferred until an ordinary Agent explicitly loads it", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-grill-me-docs-"));
		try {
			const filePath = join(root, "SKILL.md");
			await writeFile(
				filePath,
				[
					"---",
					"name: grill-me-docs",
					"description: Preserve a user-confirmed durable decision.",
					"---",
					"",
					"Ask one consequential question, then document only the user's confirmed decision.",
				].join("\n"),
			);
			const grillMeDocs = skill({
				name: "grill-me-docs",
				description: "Preserve a user-confirmed durable decision.",
				filePath,
				routing: {
					when: ["User asks for an ADR, glossary, or durable decision record."],
					notFor: ["Routine repair or an ordinary Room stage."],
					input: "Verified evidence and one user-owned choice.",
					output: "A confirmed decision or an explicitly open question.",
					does: "Records only a user-confirmed durable decision.",
				},
			});

			const beforeExplicitLoad = searchSkills([grillMeDocs], {
				query: "ADR glossary durable decision",
			});
			expect(beforeExplicitLoad.items).toEqual([expect.objectContaining({ name: "grill-me-docs" })]);
			expect(JSON.stringify(beforeExplicitLoad)).not.toContain("<loaded_skill");

			const loaded = await loadSkill([grillMeDocs], { name: "grill-me-docs" });
			expect(loaded.text).toContain('<loaded_skill name="grill-me-docs" revision="sha256:');
			expect(loaded.text).toContain("Ask one consequential question");
			expect(loaded.text).not.toContain("description: Preserve a user-confirmed durable decision.");

			expect(
				searchSkills([grillMeDocs], { query: "ADR glossary durable decision" }, ["grill-me-docs"]).items as Array<{
					name: string;
				}>,
			).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps active Skill bodies mutually exclusive with deferred search and load", async () => {
		const active = skill({
			name: "managed-task-execution",
			description: "Execute a managed task.",
			filePath: "/already-loaded/SKILL.md",
		});
		const deferred = skill({ name: "quality-gate", description: "Review delivery evidence." });

		const result = searchSkills([active, deferred], { query: "" }, [active.name]);

		expect((result.items as Array<{ name: string }>).map((item) => item.name)).toEqual(["quality-gate"]);
		expect(result.catalogRevision).toEqual(searchSkills([active, deferred], { query: "" }).catalogRevision);
		await expect(loadSkill([active, deferred], { name: active.name }, [active.name])).rejects.toThrow(
			"Skill body is already active",
		);
	});

	it("keeps the current epoch prompt stable and restores loaded Skill bodies only after compaction", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-skill-projection-"));
		try {
			const filePath = join(root, "SKILL.md");
			await writeFile(
				filePath,
				[
					"---",
					"name: quality-gate",
					"description: Check delivery evidence.",
					"---",
					"",
					"Check every acceptance criterion.",
				].join("\n"),
			);
			const projected = {
				...skill({
					name: "quality-gate",
					description: "Check delivery evidence.",
					filePath,
				}),
				promptCatalog: {
					family: "quality-review",
					focus: true,
					bodyLoaded: false,
				},
			};
			const registered = new Map<string, ToolDefinition>();
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			const customEntries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
			let activeTools = ["skill_search", "skill_load"];
			let effectiveSystemPrompt = "stable-prefix\n用户原始字节保持不变";
			const promptBytesBeforeLoad = Buffer.from(effectiveSystemPrompt, "utf8");
			const promptShaBeforeLoad = createHash("sha256").update(promptBytesBeforeLoad).digest("hex");
			let rebuilds = 0;
			const extension = createDiscoveryToolsExtension({
				getResourceLoader: () =>
					({
						getSkills: () => ({ skills: [projected], diagnostics: [] }),
					}) as unknown as ResourceLoader,
				registry: new BackendToolRegistry(),
				getLoadedSkillNames: () => [],
			});
			if (typeof extension === "function") throw new Error("Expected a named inline extension");
			await extension.factory({
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				registerTool(toolDefinition: ToolDefinition) {
					registered.set(toolDefinition.name, toolDefinition);
				},
				appendEntry(customType: string, data: unknown) {
					customEntries.push({ type: "custom", customType, data });
				},
				getActiveTools() {
					return activeTools;
				},
				setActiveTools(toolNames: string[]) {
					activeTools = [...toolNames];
					effectiveSystemPrompt = "unexpected-rebuild";
					rebuilds += 1;
				},
			} as never);
			const loadTool = registered.get(SKILL_LOAD_TOOL_NAME);
			if (!loadTool) throw new Error("skill_load was not registered");

			const loadResult = await loadTool.execute(
				"load-quality",
				{ name: "quality-gate" } as never,
				undefined,
				undefined,
				{} as never,
			);
			const loadedBody = loadResult.content.find((item) => item.type === "text")?.text;
			if (!loadedBody) throw new Error("skill_load did not return the exact Skill body");

			expect(projected.promptCatalog).toEqual({
				family: "quality-review",
				focus: true,
				bodyLoaded: false,
			});
			expect(rebuilds).toBe(0);
			expect(activeTools).toEqual(["skill_search", "skill_load"]);
			expect(Buffer.from(effectiveSystemPrompt, "utf8").equals(promptBytesBeforeLoad)).toBe(true);
			expect(createHash("sha256").update(effectiveSystemPrompt, "utf8").digest("hex")).toBe(promptShaBeforeLoad);
			expect(loadedBody).toContain('<loaded_skill name="quality-gate" revision="sha256:');
			expect(customEntries).toEqual([
				expect.objectContaining({
					type: "custom",
					customType: "rag-ime.loaded-skill-state.v1",
					data: expect.objectContaining({
						name: "quality-gate",
						body: loadedBody,
						contentRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
						resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
					}),
				}),
			]);
			const searchTool = registered.get(SKILL_SEARCH_TOOL_NAME);
			if (!searchTool) throw new Error("skill_search was not registered");
			const search = await searchTool.execute(
				"search-after-load",
				{ query: "" } as never,
				undefined,
				undefined,
				{} as never,
			);
			expect(search.details).toMatchObject({ items: [] });

			const compactHandler = handlers.get("session_compact");
			if (!compactHandler) throw new Error("session_compact handler was not registered");
			const compactResult = await compactHandler(
				{ type: "session_compact" },
				{
					getSystemPrompt: () => effectiveSystemPrompt,
					sessionManager: { getBranch: () => customEntries },
				},
			);
			expect(compactResult).toBeUndefined();
			const beforeAgentStart = handlers.get("before_agent_start");
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
			const nextEpoch = (await beforeAgentStart({
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: effectiveSystemPrompt,
			})) as { systemPrompt?: string };
			expect(nextEpoch.systemPrompt).toBe(`${effectiveSystemPrompt}\n\n${loadedBody}`);
			expect(
				Buffer.from(nextEpoch.systemPrompt ?? "", "utf8").subarray(0, promptBytesBeforeLoad.length),
			).toEqual(promptBytesBeforeLoad);

			const duplicate = await compactHandler(
				{ type: "session_compact" },
				{
					getSystemPrompt: () => nextEpoch.systemPrompt ?? "",
					sessionManager: { getBranch: () => customEntries },
				},
			);
			expect(duplicate).toBeUndefined();
			expect(
				await beforeAgentStart({
					type: "before_agent_start",
					prompt: "continue",
					systemPrompt: nextEpoch.systemPrompt ?? "",
				}),
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers manual Skill load state after resume without rewriting the current epoch prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-skill-resume-"));
		try {
			const filePath = join(root, "SKILL.md");
			await writeFile(
				filePath,
				["---", "name: quality-gate", "description: Check evidence.", "---", "", "Check fresh evidence."].join(
					"\n",
				),
			);
			const projected = skill({ name: "quality-gate", description: "Check evidence.", filePath });
			const persisted: Array<{ type: "custom"; customType: string; data: unknown }> = [];
			const firstTools = new Map<string, ToolDefinition>();
			const first = createDiscoveryToolsExtension({
				getResourceLoader: () =>
					({
						getSkills: () => ({ skills: [projected], diagnostics: [] }),
					}) as unknown as ResourceLoader,
				registry: new BackendToolRegistry(),
			});
			if (typeof first === "function") throw new Error("Expected a named inline extension");
			await first.factory({
				on() {},
				registerTool(toolDefinition: ToolDefinition) {
					firstTools.set(toolDefinition.name, toolDefinition);
				},
				appendEntry(customType: string, data: unknown) {
					persisted.push({ type: "custom", customType, data });
				},
				getActiveTools: () => ["skill_search", "skill_load"],
				setActiveTools() {
					throw new Error("skill_load must not rebuild tools");
				},
			} as never);
			const firstLoad = firstTools.get(SKILL_LOAD_TOOL_NAME);
			if (!firstLoad) throw new Error("skill_load was not registered");
			const firstResult = await firstLoad.execute(
				"load-before-resume",
				{ name: "quality-gate" } as never,
				undefined,
				undefined,
				{} as never,
			);
			const loadedBody = firstResult.content.find((item) => item.type === "text")?.text;
			if (!loadedBody) throw new Error("skill_load did not return the exact Skill body");

			const resumedTools = new Map<string, ToolDefinition>();
			const resumedHandlers = new Map<string, (...args: unknown[]) => unknown>();
			let resumedPrompt = "stable-prefix";
			let rebuilds = 0;
			const resumed = createDiscoveryToolsExtension({
				getResourceLoader: () =>
					({
						getSkills: () => ({ skills: [projected], diagnostics: [] }),
					}) as unknown as ResourceLoader,
				registry: new BackendToolRegistry(),
			});
			if (typeof resumed === "function") throw new Error("Expected a named inline extension");
			await resumed.factory({
				on(event: string, handler: (...args: unknown[]) => unknown) {
					resumedHandlers.set(event, handler);
				},
				registerTool(toolDefinition: ToolDefinition) {
					resumedTools.set(toolDefinition.name, toolDefinition);
				},
				appendEntry() {},
				getActiveTools: () => ["skill_search", "skill_load"],
				setActiveTools() {
					resumedPrompt = "unexpected-rebuild";
					rebuilds += 1;
				},
			} as never);
			const startHandler = resumedHandlers.get("session_start");
			if (!startHandler) throw new Error("session_start handler was not registered");
			await startHandler(
				{ type: "session_start", reason: "resume" },
				{ sessionManager: { getBranch: () => persisted } },
			);
			const resumedSearch = resumedTools.get(SKILL_SEARCH_TOOL_NAME);
			const resumedLoad = resumedTools.get(SKILL_LOAD_TOOL_NAME);
			if (!resumedSearch || !resumedLoad) throw new Error("Skill discovery tools were not registered");
			const searchResult = await resumedSearch.execute(
				"search-after-resume",
				{ query: "" } as never,
				undefined,
				undefined,
				{} as never,
			);
			expect(searchResult.details).toMatchObject({ items: [] });
			await expect(
				resumedLoad.execute(
					"duplicate-after-resume",
					{ name: "quality-gate" } as never,
					undefined,
					undefined,
					{} as never,
				),
			).rejects.toThrow("Skill body is already active");
			expect(rebuilds).toBe(0);
			expect(resumedPrompt).toBe("stable-prefix");

			const compactHandler = resumedHandlers.get("session_compact");
			if (!compactHandler) throw new Error("session_compact handler was not registered");
			const compactResult = await compactHandler(
				{ type: "session_compact" },
				{
					getSystemPrompt: () => resumedPrompt,
					sessionManager: { getBranch: () => persisted },
				},
			);
			expect(compactResult).toBeUndefined();
			const beforeAgentStart = resumedHandlers.get("before_agent_start");
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
			const nextEpoch = (await beforeAgentStart({
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: resumedPrompt,
			})) as { systemPrompt?: string };
			expect(nextEpoch.systemPrompt).toBe(`stable-prefix\n\n${loadedBody}`);
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

	it("renders capability families plus current-stage cards while excluding active Tool schemas", () => {
		const tools: BackendToolManifest[] = [
			{
				name: "room_partner",
				description: "Coordinate the active Room directly.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace_read",
				description: "Read a workspace file.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace_shell",
				description: "Run a workspace command.",
				parameters: { type: "object", properties: {} },
			},
		];

		const prompt = formatBackendToolRouteCatalog(tools, "revision", {
			activeNames: ["room_partner"],
			focusNames: ["workspace_read"],
		});
		const search = searchBackendTools(tools, { query: "" }, "revision", ["room_partner"]);

		expect(prompt).toContain('<product_tool_capability_families format="family-jsonl">');
		expect(prompt).toContain(
			'{"family":"workspace","count":2,"does":"授权工作区内的查找、读取、修改与命令执行","examples":["workspace_read","workspace_shell"]}',
		);
		expect(prompt).toContain('"name":"workspace_read"');
		expect(prompt).not.toContain('"name":"workspace_shell"');
		expect(prompt).not.toContain("room_partner");
		expect(search).toMatchObject({
			items: [{ name: "workspace_read" }, { name: "workspace_shell" }],
			activeDirectCalls: ["room_partner"],
		});
	});

	it("excludes always-available tools from the progressive route catalog", () => {
		const prompt = formatBackendToolRouteCatalog(
			[
				{
					name: "room_partner",
					description: "Coordinate the active Room directly.",
					parameters: { type: "object", properties: {} },
					alwaysAvailable: true,
				},
				{
					name: "workspace_read",
					description: "Read a workspace file.",
					parameters: { type: "object", properties: {} },
				},
			],
			"revision",
		);

		expect(prompt).toContain('"name":"workspace_read"');
		expect(prompt).not.toContain('"name":"room_partner"');
	});

	it("classifies product-prefixed tools by capability instead of treating every ime tool as input", () => {
		const tools = [
			"ime_agents",
			"ime_browser",
			"ime_configuration",
			"ime_input",
			"ime_knowledge",
			"ime_models",
			"ime_overview",
			"ime_plugins",
			"ime_runtime",
			"ime_voice",
		].map<BackendToolManifest>((name) => ({
			name,
			description: `${name} capability.`,
			parameters: { type: "object", properties: {} },
		}));

		const prompt = formatBackendToolRouteCatalog(tools, "revision", {
			focusNames: [],
		});

		expect(prompt).toContain(
			'{"family":"agent","count":2,"does":"Agent 会话、角色、模型与运行状态","examples":["ime_agents","ime_models"]}',
		);
		expect(prompt).toContain(
			'{"family":"input","count":1,"does":"输入法状态、候选与上下文","examples":["ime_input"]}',
		);
		expect(prompt).toContain(
			'{"family":"system","count":3,"does":"配置、诊断和运行维护","examples":["ime_configuration","ime_overview"]}',
		);
		expect(prompt).toContain('{"family":"voice","count":1,"does":"语音输入状态与受控配置","examples":["ime_voice"]}');
		expect(prompt).toContain(
			'{"family":"plugin","count":1,"does":"插件目录、状态与受控管理","examples":["ime_plugins"]}',
		);
		expect(prompt).not.toContain('{"family":"input","count":10');
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
		const nextPrompt = await beforeAgentStart({ systemPrompt: "base prompt" });
		const deferredCatalog = nextPrompt?.systemPrompt.match(
			/<available_product_tools[^>]*>([\s\S]*?)<\/available_product_tools>/u,
		)?.[1];
		expect(deferredCatalog).toBeDefined();
		expect(deferredCatalog).not.toContain("memory.query");
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
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					result: {
						items: [
							{
								receiptId: "load:load-batch:0:workspace_search",
								toolName: "workspace_search",
							},
							{
								receiptId: "load:load-batch:1:workspace_read",
								toolName: "workspace_read",
							},
						],
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
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

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
			expect(JSON.parse(String(request.body))).toMatchObject({
				sessionId: "session-room",
				loads: [
					{
						receiptId: "load:load-batch:0:workspace_search",
						toolName: "workspace_search",
					},
					{
						receiptId: "load:load-batch:1:workspace_read",
						toolName: "workspace_read",
					},
				],
			});
			expect(registry.disclosed().map((tool) => tool.name)).toEqual(["workspace_search", "workspace_read"]);
			expect(activeTools.slice(-2)).toEqual(["workspace_search", "workspace_read"]);
			expect(result.details).toMatchObject({
				schemaVersion: "rag-ime.tool-load-batch.v1",
				tools: [
					{
						tool: { name: "workspace_search" },
						governedReceipt: {
							receiptId: "load:load-batch:0:workspace_search",
						},
					},
					{
						tool: { name: "workspace_read" },
						governedReceipt: {
							receiptId: "load:load-batch:1:workspace_read",
						},
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
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: false, error: "batch load rejected" }), {
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
			).rejects.toThrow("batch load rejected");
			expect(registry.disclosed()).toEqual([]);
			expect(registry.governedLoadReceipts()).toEqual([]);
			expect(activeTools).toEqual(["tool_load"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects active Tool schemas atomically before any governed load request", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			{
				name: "room_partner",
				description: "Coordinate the active Room.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "workspace_read",
				description: "Read a workspace file.",
				parameters: { type: "object", properties: {} },
			},
		]);
		registry.disclose("room_partner");
		const registered = new Map<string, ToolDefinition>();
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
				return ["tool_load", "room_partner"];
			},
			setActiveTools() {},
		} as never);
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const loadTool = registered.get(TOOL_LOAD_TOOL_NAME);
			if (!loadTool) throw new Error("tool_load was not registered");
			await expect(
				loadTool.execute("load-active", { name: "room_partner" } as never, undefined, undefined, {} as never),
			).rejects.toThrow("Tool schema is already active");
			await expect(
				loadTool.execute(
					"load-mixed",
					{ names: ["workspace_read", "room_partner"] } as never,
					undefined,
					undefined,
					{} as never,
				),
			).rejects.toThrow("Tool schema is already active");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(registry.isDisclosed("workspace_read")).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
