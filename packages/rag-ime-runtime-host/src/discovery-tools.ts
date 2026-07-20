import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	type InlineExtension,
	type ResourceLoader,
	type Skill,
	skillCatalogEntry,
	skillCatalogRevision,
	stripFrontmatter,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	SKILL_LOAD_TOOL_NAME,
	SKILL_SEARCH_TOOL_NAME,
	TOOL_LOAD_TOOL_NAME,
	TOOL_SEARCH_TOOL_NAME,
} from "./runtime-tool-names.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	type BackendToolRegistry,
	backendToolSchemaRevision,
	requestProductGateway,
} from "./tool-bridge.ts";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 20;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_TOOL_ROUTE_CHARS = 200;
const TOOL_CATALOG_MARKER = '<available_product_tools format="route-jsonl"';

const SKILL_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "Optional name, when, does, or notFor keywords. Leave empty to list the catalog.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_RESULT_LIMIT,
			description: `Maximum results. Defaults to ${DEFAULT_RESULT_LIMIT}.`,
		},
	},
	additionalProperties: false,
} as ToolDefinition["parameters"];

const SKILL_LOAD_PARAMETERS = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			description: "Exact skill name returned by skill_search or the Skill Catalog.",
		},
	},
	required: ["name"],
	additionalProperties: false,
} as ToolDefinition["parameters"];

const TOOL_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "Optional tool name, description, profile, or risk keywords.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_RESULT_LIMIT,
			description: `Maximum results. Defaults to ${DEFAULT_RESULT_LIMIT}.`,
		},
	},
	additionalProperties: false,
} as ToolDefinition["parameters"];

const TOOL_LOAD_PARAMETERS = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			description: "Exact product tool name returned by tool_search.",
		},
	},
	required: ["name"],
	additionalProperties: false,
} as ToolDefinition["parameters"];

export interface SkillCatalogDiff {
	previousRevision: string;
	revision: string;
	added: string[];
	removed: string[];
	changed: string[];
}

export interface DiscoveryToolsOptions {
	getResourceLoader(): ResourceLoader;
	registry: BackendToolRegistry;
	includeToolSearch?: boolean;
	gateway?: BackendToolBridgeOptions;
}

export interface BackendToolRouteEntry {
	name: string;
	does: string;
}

function visibleSkills(skills: Skill[]): Skill[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizedLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_RESULT_LIMIT;
	return Math.max(1, Math.min(MAX_RESULT_LIMIT, value));
}

function searchScore(query: string, name: string, description: string, extra = ""): number {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return 1;
	const normalizedName = name.toLocaleLowerCase();
	const normalizedDescription = description.toLocaleLowerCase();
	const normalizedExtra = extra.toLocaleLowerCase();
	if (normalizedName === normalizedQuery) return 1000;

	let score = 0;
	if (normalizedName.includes(normalizedQuery)) score += 300;
	if (normalizedDescription.includes(normalizedQuery)) score += 120;
	if (normalizedExtra.includes(normalizedQuery)) score += 60;
	for (const token of normalizedQuery.split(/\s+/u).filter(Boolean)) {
		if (normalizedName.includes(token)) score += 40;
		if (normalizedDescription.includes(token)) score += 16;
		if (normalizedExtra.includes(token)) score += 8;
	}
	return score;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function backendToolRouteEntry(tool: BackendToolManifest): BackendToolRouteEntry {
	const normalized = tool.description.replace(/\s+/gu, " ").trim();
	let does = normalized;
	let entry = { name: tool.name, does };
	while (Array.from(JSON.stringify(entry)).length > MAX_TOOL_ROUTE_CHARS && does.length > 4) {
		does = `${Array.from(does).slice(0, -8).join("")}...`;
		entry = { name: tool.name, does };
	}
	return entry;
}

export function formatBackendToolRouteCatalog(tools: BackendToolManifest[], revision: string): string {
	if (tools.length === 0) return "";
	const entries = tools.map(backendToolRouteEntry).sort((left, right) => left.name.localeCompare(right.name));
	return [
		"",
		"",
		`${TOOL_CATALOG_MARKER} revision="sha256:${revision}">`,
		"Each JSON line exposes only a tool name and short purpose. Use tool_search for its full description and risk, then tool_load before calling it so the Provider receives its parameter schema.",
		...entries.map((entry) => JSON.stringify(entry)),
		"</available_product_tools>",
	].join("\n");
}

export function runtimeSkillCatalogRevision(skills: Skill[]): string {
	return skillCatalogRevision(skills);
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function diffSkillCatalog(before: Skill[], after: Skill[]): SkillCatalogDiff {
	const previous = new Map(
		visibleSkills(before).map((skill) => [skill.name, JSON.stringify(skillCatalogEntry(skill))]),
	);
	const next = new Map(visibleSkills(after).map((skill) => [skill.name, JSON.stringify(skillCatalogEntry(skill))]));
	const added = [...next.keys()].filter((name) => !previous.has(name)).sort();
	const removed = [...previous.keys()].filter((name) => !next.has(name)).sort();
	const changed = [...next.keys()]
		.filter((name) => previous.has(name) && previous.get(name) !== next.get(name))
		.sort();
	return {
		previousRevision: runtimeSkillCatalogRevision(before),
		revision: runtimeSkillCatalogRevision(after),
		added,
		removed,
		changed,
	};
}

export function searchSkills(skills: Skill[], args: { query?: unknown; limit?: unknown }): Record<string, unknown> {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const limit = normalizedLimit(args.limit);
	const items = visibleSkills(skills)
		.map((skill) => {
			const entry = skillCatalogEntry(skill);
			const routingText =
				"description" in entry ? entry.description : [...entry.when, entry.does, ...(entry.notFor ?? [])].join(" ");
			return {
				entry,
				score: searchScore(query, skill.name, routingText),
			};
		})
		.filter((item) => !query || item.score > 0)
		.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
		.slice(0, limit)
		.map(({ entry }) => entry);
	return {
		schemaVersion: "rag-ime.skill-search.v2",
		catalogRevision: runtimeSkillCatalogRevision(skills),
		query,
		items,
	};
}

export async function loadSkill(
	skills: Skill[],
	args: { name?: unknown },
): Promise<{ text: string; details: Record<string, unknown> }> {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new Error("skill_load requires an exact skill name");
	}
	const name = args.name.trim();
	const skill = visibleSkills(skills).find((candidate) => candidate.name === name);
	if (!skill) throw new Error(`Unknown or unavailable skill: ${name}`);

	const content = await readFile(skill.filePath, "utf8");
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
		throw new Error(`Skill exceeds the ${MAX_SKILL_BYTES}-byte managed loading limit: ${name}`);
	}
	const body = stripFrontmatter(content).trim();
	const contentRevision = sha256(body);
	const text = [
		`<loaded_skill name="${escapeXmlAttribute(skill.name)}" revision="sha256:${contentRevision}">`,
		`Relative references resolve from: ${skill.baseDir}`,
		"",
		body,
		"</loaded_skill>",
	].join("\n");
	return {
		text,
		details: {
			schemaVersion: "rag-ime.skill-load.v1",
			name: skill.name,
			catalogRevision: runtimeSkillCatalogRevision(skills),
			contentRevision,
		},
	};
}

export function searchBackendTools(
	tools: BackendToolManifest[],
	args: { query?: unknown; limit?: unknown },
	registryRevision: string,
): Record<string, unknown> {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const limit = normalizedLimit(args.limit);
	const items = tools
		.map((tool) => ({
			tool,
			score: searchScore(query, tool.name, tool.description, `${tool.profile ?? ""} ${tool.risk ?? ""}`),
		}))
		.filter((item) => !query || item.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit)
		.map(({ tool }) => ({
			name: tool.name,
			description: tool.description,
			profile: tool.profile,
			risk: tool.risk,
		}));
	return {
		schemaVersion: "rag-ime.tool-search.v1",
		catalogRevision: registryRevision,
		query,
		items,
		nextTool: TOOL_LOAD_TOOL_NAME,
	};
}

export function loadBackendTool(
	registry: BackendToolRegistry,
	args: { name?: unknown },
): { tool: BackendToolManifest; result: Record<string, unknown> } {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new Error("tool_load requires an exact product tool name");
	}
	const name = args.name.trim();
	const tool = registry.get(name);
	if (!tool) throw new Error(`Unknown or unavailable product tool: ${name}`);
	return {
		tool,
		result: {
			schemaVersion: "rag-ime.tool-load.v1",
			catalogRevision: registry.revision(),
			schemaRevision: backendToolSchemaRevision([tool]),
			tool: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				profile: tool.profile,
				risk: tool.risk,
			},
		},
	};
}

export function createDiscoveryToolsExtension(options: DiscoveryToolsOptions): InlineExtension {
	const initialToolCatalog = formatBackendToolRouteCatalog(options.registry.list(), options.registry.revision());
	return {
		name: "rag-ime-discovery-tools",
		factory(pi) {
			pi.on("before_agent_start", async (event) => {
				if (!initialToolCatalog || event.systemPrompt.includes(TOOL_CATALOG_MARKER)) return undefined;
				return { systemPrompt: `${event.systemPrompt}${initialToolCatalog}` };
			});
			pi.registerTool({
				name: SKILL_SEARCH_TOOL_NAME,
				label: "Search skills",
				description: "Search the managed Skill Catalog by name, trigger, purpose, or exclusion.",
				promptSnippet: "Search the stable managed Skill Catalog by routing-card fields",
				parameters: SKILL_SEARCH_PARAMETERS,
				execute: async (_toolCallId, args) => {
					const result = searchSkills(
						options.getResourceLoader().getSkills().skills,
						args as { query?: unknown; limit?: unknown },
					);
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: result,
					};
				},
			});
			pi.registerTool({
				name: SKILL_LOAD_TOOL_NAME,
				label: "Load skill",
				description: "Load one managed Skill by its exact catalog name.",
				promptSnippet: "Load one managed Skill by exact catalog name",
				parameters: SKILL_LOAD_PARAMETERS,
				execute: async (_toolCallId, args) => {
					const result = await loadSkill(
						options.getResourceLoader().getSkills().skills,
						args as { name?: unknown },
					);
					return {
						content: [{ type: "text", text: result.text }],
						details: result.details,
					};
				},
			});
			if (options.includeToolSearch !== false) {
				pi.registerTool({
					name: TOOL_SEARCH_TOOL_NAME,
					label: "Search tools",
					description: "Search the product tool catalog by name or description without loading parameter schemas.",
					promptSnippet: "Search the product tool catalog, then use tool_load before calling a result",
					parameters: TOOL_SEARCH_PARAMETERS,
					execute: async (toolCallId, args, signal) => {
						let result = searchBackendTools(
							options.registry.list(),
							args as { query?: unknown; limit?: unknown },
							options.registry.revision(),
						);
						if (options.gateway?.roomCapability) {
							const governed = await requestProductGateway(
								options.gateway,
								"search",
								{
									sessionId: options.gateway.sessionId,
									receiptId: `search:${toolCallId}`,
									query:
										typeof (args as { query?: unknown }).query === "string"
											? (args as { query: string }).query
											: "",
									createdAtMs: Date.now(),
								},
								signal,
							);
							result = governed.result ?? result;
						}
						return {
							content: [{ type: "text", text: JSON.stringify(result) }],
							details: result,
						};
					},
				});
				pi.registerTool({
					name: TOOL_LOAD_TOOL_NAME,
					label: "Load tool",
					description:
						"Disclose one exact product tool schema to the Provider only when its parameters are needed.",
					promptSnippet: "Disclose one exact tool schema returned by tool_search before calling it",
					parameters: TOOL_LOAD_PARAMETERS,
					execute: async (toolCallId, args, signal) => {
						const loaded = loadBackendTool(options.registry, args as { name?: unknown });
						let governedReceipt: Record<string, unknown> | undefined;
						if (options.gateway?.roomCapability) {
							const governed = await requestProductGateway(
								options.gateway,
								"load",
								{
									sessionId: options.gateway.sessionId,
									receiptId: `load:${toolCallId}`,
									toolName: loaded.tool.name,
									createdAtMs: Date.now(),
								},
								signal,
							);
							governedReceipt = governed.result;
							const receiptId = typeof governedReceipt?.receiptId === "string" ? governedReceipt.receiptId : "";
							options.registry.recordLoadReceipt(loaded.tool.name, receiptId);
						}
						const alreadyDisclosed = options.registry.isDisclosed(loaded.tool.name);
						options.registry.disclose(loaded.tool.name);
						const activeTools = new Set(pi.getActiveTools());
						activeTools.add(loaded.tool.name);
						pi.setActiveTools([...activeTools]);
						const nextCall = {
							tool: loaded.tool.name,
							instruction: `Call ${loaded.tool.name} directly with arguments from its newly disclosed Provider schema.`,
						};
						const providerResult = {
							schemaVersion: "rag-ime.tool-load.v1",
							catalogRevision: options.registry.revision(),
							schemaRevision: backendToolSchemaRevision([loaded.tool]),
							tool: {
								name: loaded.tool.name,
								description: loaded.tool.description,
								profile: loaded.tool.profile,
								risk: loaded.tool.risk,
							},
							disclosed: true,
							alreadyDisclosed,
							nextCall,
						};
						const details = {
							...loaded.result,
							disclosed: true,
							alreadyDisclosed,
							nextCall,
							...(governedReceipt ? { governedReceipt } : {}),
						};
						return {
							content: [{ type: "text", text: JSON.stringify(providerResult) }],
							details,
						};
					},
				});
			}
		},
	};
}
