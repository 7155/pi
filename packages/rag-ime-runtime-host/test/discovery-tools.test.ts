import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSyntheticSourceInfo,
	type ResourceLoader,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
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
import { BackendToolRegistry } from "../src/tool-bridge.ts";

function skill(options: {
	name: string;
	description: string;
	filePath?: string;
	disableModelInvocation?: boolean;
}): Skill {
	const filePath = options.filePath ?? `/managed/${options.name}/SKILL.md`;
	return {
		name: options.name,
		description: options.description,
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
		const extension = createDiscoveryToolsExtension({
			getResourceLoader: () => resourceLoader,
			registry,
			createBackendTool: (tool) => ({
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: tool.parameters as ToolDefinition["parameters"],
				execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
			}),
		});
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			registerTool(toolDefinition: ToolDefinition) {
				registered.set(toolDefinition.name, toolDefinition);
			},
		} as never);

		expect([...registered.keys()]).toEqual([
			SKILL_SEARCH_TOOL_NAME,
			SKILL_LOAD_TOOL_NAME,
			TOOL_SEARCH_TOOL_NAME,
			TOOL_LOAD_TOOL_NAME,
		]);
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
		expect(registry.isActive("memory.query")).toBe(true);
		expect(registered.has("memory.query")).toBe(true);
		expect(loadResult.details).toMatchObject({
			active: true,
			alreadyActive: false,
			tool: { name: "memory.query" },
		});
		expect(JSON.stringify(loadResult.content)).not.toContain('"parameters"');
	});
});
