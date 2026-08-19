import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSyntheticSourceInfo,
	type ResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	backendToolRouteEntry,
	createDiscoveryToolsExtension,
	diffSkillCatalog,
	loadBackendTool,
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
import { BackendToolRegistry } from "../src/tool-bridge.ts";

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
				description: "Review long-term memory.",
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
					does: "审阅并受控应用长期记忆草案。",
					notFor: ["普通记忆查询"],
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
					does: "审阅并受控应用长期记忆草案。",
					notFor: ["普通记忆查询"],
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("Compatibility-only description");
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

		expect(Array.from(JSON.stringify(entry)).length).toBeLessThanOrEqual(200);
		expect(JSON.stringify(entry)).not.toContain("secretArgument");
	});

	it("registers fixed discovery schemas and searches the live backend catalog", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			{
				name: "memory.query",
				description: "Query long-term memory.",
				parameters: { type: "object", properties: { query: { type: "string" } } },
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
		expect(prompt?.systemPrompt).toContain('{"name":"memory.query","does":"Query long-term memory."}');
		expect(prompt?.systemPrompt).not.toContain('"parameters"');
		const result = searchBackendTools(registry.list(), { query: "memory" }, registry.revision());
		expect(result.items).toEqual([
			{
				name: "memory.query",
				description: "Query long-term memory.",
				profile: "memory",
				risk: "read",
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
	});
});
