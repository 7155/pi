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
	modelVisibleBackendToolParameters,
	requestGovernedToolLoads,
	requestProductGateway,
} from "./tool-bridge.ts";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 20;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_TOOL_ROUTE_CHARS = 512;
const TOOL_CATALOG_MARKER = '<available_product_tools format="route-jsonl"';
const LOADED_SKILL_STATE_ENTRY = "rag-ime.loaded-skill-state.v1";

const SKILL_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "Optional name, when, notFor, input, output, or does keywords. Leave empty to list the catalog.",
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
			description: "Optional tool name, when, notFor, input, output, or does keywords.",
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
		names: {
			type: "array",
			minItems: 1,
			maxItems: 4,
			uniqueItems: true,
			items: {
				type: "string",
				minLength: 1,
			},
			description: "One to four exact product tool names needed for the same concrete next step.",
		},
	},
	oneOf: [{ required: ["name"] }, { required: ["names"] }],
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
	focusToolNames?: readonly string[];
	getLoadedSkillNames?: () => readonly string[];
}

export interface BackendToolRouteEntry {
	name: string;
	when: string[];
	notFor: string[];
	input: string;
	output: string;
	does: string;
}

function visibleSkills(skills: Skill[]): Skill[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name));
}

type PromptProjectedSkill = Skill & {
	promptCatalog?: {
		bodyLoaded?: boolean;
	};
};

function deferredSkills(skills: Skill[]): Skill[] {
	return visibleSkills(skills).filter((skill) => (skill as PromptProjectedSkill).promptCatalog?.bodyLoaded !== true);
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

function queryFragments(query: string): string[] {
	const normalized = query.trim().toLocaleLowerCase();
	const fragments = new Set<string>();
	for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
		fragments.add(token);
		const characters = Array.from(token);
		if (characters.length < 2 || !characters.every((character) => /\p{Script=Han}/u.test(character))) continue;
		for (let index = 0; index < characters.length - 1; index += 1) {
			fragments.add(characters.slice(index, index + 2).join(""));
		}
	}
	return [...fragments];
}

function fragmentCoverage(query: string, value: string): number {
	const fragments = queryFragments(query);
	if (fragments.length === 0) return 0;
	const normalizedValue = value.toLocaleLowerCase();
	return fragments.filter((fragment) => normalizedValue.includes(fragment)).length / fragments.length;
}

function routingSearchScore(
	query: string,
	name: string,
	when: string[],
	notFor: string[],
	supportingText: string,
): number {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return 1;
	const normalizedName = name.toLocaleLowerCase();
	if (normalizedName === normalizedQuery) return 1000;

	const excluded = notFor.some((item) => {
		const normalized = item.toLocaleLowerCase();
		return normalized.includes(normalizedQuery) || fragmentCoverage(normalizedQuery, normalized) >= 0.75;
	});
	if (excluded) return -1;

	let score = searchScore(normalizedQuery, normalizedName, when.join(" "), supportingText);
	const positiveCoverage = Math.max(0, ...when.map((item) => fragmentCoverage(normalizedQuery, item)));
	if (positiveCoverage >= 0.5) score += Math.round(positiveCoverage * 100);
	return score;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function compactText(value: string, maxCharacters: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (Array.from(normalized).length <= maxCharacters) return normalized;
	return `${Array.from(normalized)
		.slice(0, Math.max(1, maxCharacters - 3))
		.join("")}...`;
}

export function backendToolRouteEntry(tool: BackendToolManifest): BackendToolRouteEntry {
	const purpose = tool.description.replace(/\s+/gu, " ").trim();
	const source = {
		name: tool.name,
		when: tool.when ?? [purpose],
		notFor: tool.notFor ?? ["The task does not match this tool's stated use case."],
		input: tool.input ?? "Arguments required by the selected tool.",
		output: tool.output ?? "The selected tool's execution result.",
		does: tool.does ?? purpose,
	};
	for (let maxCharacters = 160; maxCharacters >= 24; maxCharacters -= 8) {
		const entry: BackendToolRouteEntry = {
			name: source.name,
			when: source.when.map((item) => compactText(item, maxCharacters)),
			notFor: source.notFor.map((item) => compactText(item, maxCharacters)),
			input: compactText(source.input, maxCharacters),
			output: compactText(source.output, maxCharacters),
			does: compactText(source.does, maxCharacters),
		};
		if (Array.from(JSON.stringify(entry)).length <= MAX_TOOL_ROUTE_CHARS) return entry;
	}
	throw new Error(`Tool routing card exceeds ${MAX_TOOL_ROUTE_CHARS} characters: ${tool.name}`);
}

function promptBackendToolRouteEntry(tool: BackendToolManifest): BackendToolRouteEntry {
	const entry = backendToolRouteEntry(tool);
	return {
		name: entry.name,
		when: entry.when.slice(0, 1).map((value) => compactText(value, 72)),
		notFor: entry.notFor.slice(0, 1).map((value) => compactText(value, 72)),
		input: compactText(entry.input, 72),
		output: compactText(entry.output, 72),
		does: compactText(entry.does, 72),
	};
}

interface ToolPromptCatalogOptions {
	activeNames?: readonly string[];
	focusNames?: readonly string[];
}

const TOOL_FAMILY_PURPOSES: Readonly<Record<string, string>> = {
	room: "Room 状态、协作、公开发布与责任提交",
	workspace: "授权工作区内的查找、读取、修改与命令执行",
	memory: "用户记忆的查询、整理、审阅与治理",
	planning: "用户计划和 Agent 执行清单",
	agent: "Agent 会话、角色、模型与运行状态",
	knowledge: "知识库检索、导入和证据读取",
	browser: "浏览器页面读取与受控交互",
	desktop: "桌面应用观察与受控操作",
	input: "输入法状态、候选与上下文",
	voice: "语音输入状态与受控配置",
	plugin: "插件目录、状态与受控管理",
	system: "配置、诊断和运行维护",
	other: "其他产品能力",
};

function backendToolFamily(name: string): string {
	if (name.startsWith("room_")) return "room";
	if (name.startsWith("workspace_")) return "workspace";
	if (name.includes("memory")) return "memory";
	if (name.includes("planning") || name.includes("plan")) return "planning";
	if (name.startsWith("knowledge_")) return "knowledge";
	if (name.startsWith("browser_")) return "browser";
	if (name.startsWith("desktop_")) return "desktop";
	if (name === "ime_input") return "input";
	if (name === "ime_voice") return "voice";
	if (name === "ime_browser") return "browser";
	if (name === "ime_knowledge") return "knowledge";
	if (name === "ime_plugins") return "plugin";
	if (name === "ime_agents" || name === "ime_models") return "agent";
	if (name === "ime_overview" || name === "ime_configuration" || name === "ime_runtime") return "system";
	if (name.startsWith("agent_")) return "agent";
	if (name.includes("config") || name.includes("runtime") || name.includes("diagnostic")) return "system";
	return "other";
}

export function formatBackendToolRouteCatalog(
	tools: BackendToolManifest[],
	revision: string,
	options: ToolPromptCatalogOptions = {},
): string {
	if (tools.length === 0) return "";
	const activeNames = new Set(options.activeNames ?? []);
	const deferred = tools.filter((tool) => !activeNames.has(tool.name));
	const projected = options.focusNames !== undefined;
	const focusNames = new Set(options.focusNames ?? []);
	const entries = deferred
		.filter((tool) => !projected || focusNames.has(tool.name))
		.map(promptBackendToolRouteEntry)
		.sort((left, right) => left.name.localeCompare(right.name));
	const families = new Map<string, string[]>();
	for (const tool of deferred) {
		const family = backendToolFamily(tool.name);
		const names = families.get(family) ?? [];
		names.push(tool.name);
		families.set(family, names);
	}
	return [
		"",
		"",
		...(projected
			? [
					'<product_tool_capability_families format="family-jsonl">',
					...[...families]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([family, names]) =>
							JSON.stringify({
								family,
								count: names.length,
								does: TOOL_FAMILY_PURPOSES[family],
								examples: names.slice(0, 2),
							}),
						),
					"</product_tool_capability_families>",
					"",
				]
			: []),
		`${TOOL_CATALOG_MARKER} revision="sha256:${revision}">`,
		projected
			? "Only current-stage tool candidates have exact cards here. Use tool_search for the complete catalog. A successful tool_load receipt or an active Provider schema immediately supersedes its earlier card; the card may remain only as immutable cache history and is no longer deferred. Call active tools directly and never pass them to tool_load."
			: "Cards contain name, when, notFor, input, output, and does. Use tool_search for detail and tool_load for one to four exact schemas needed by the same next step.",
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

export function searchSkills(
	skills: Skill[],
	args: { query?: unknown; limit?: unknown },
	loadedNames: readonly string[] = [],
): Record<string, unknown> {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const limit = normalizedLimit(args.limit);
	const loaded = new Set(loadedNames);
	const items = deferredSkills(skills)
		.filter((skill) => !loaded.has(skill.name))
		.map((skill) => {
			const entry = skillCatalogEntry(skill);
			return {
				entry,
				score: routingSearchScore(
					query,
					skill.name,
					entry.when,
					entry.notFor,
					[entry.input, entry.output, entry.does].join(" "),
				),
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
	loadedNames: readonly string[] = [],
): Promise<{ text: string; details: Record<string, unknown> }> {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new Error("skill_load requires an exact skill name");
	}
	const name = args.name.trim();
	if (loadedNames.includes(name)) {
		throw new Error(`Skill body is already active; follow it directly and do not call skill_load again: ${name}`);
	}
	const skill = deferredSkills(skills).find((candidate) => candidate.name === name);
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
	activeNames?: readonly string[],
): Record<string, unknown> {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const limit = normalizedLimit(args.limit);
	const active = new Set(activeNames ?? []);
	const items = tools
		.filter((tool) => !active.has(tool.name))
		.map((tool) => {
			const entry = backendToolRouteEntry(tool);
			return {
				tool,
				score: routingSearchScore(
					query,
					tool.name,
					entry.when,
					entry.notFor,
					[tool.description, entry.input, entry.output, entry.does].join(" "),
				),
			};
		})
		.filter((item) => !query || item.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit)
		.map(({ tool }) => ({
			...backendToolRouteEntry(tool),
		}));
	const result: Record<string, unknown> = {
		schemaVersion: "rag-ime.tool-search.v1",
		catalogRevision: registryRevision,
		query,
		items,
		nextTool: TOOL_LOAD_TOOL_NAME,
	};
	if (activeNames !== undefined) {
		result.activeDirectCalls = tools
			.filter((tool) => active.has(tool.name))
			.filter((tool) => {
				if (!query) return true;
				const entry = backendToolRouteEntry(tool);
				return (
					routingSearchScore(
						query,
						tool.name,
						entry.when,
						entry.notFor,
						[tool.description, entry.input, entry.output, entry.does].join(" "),
					) > 0
				);
			})
			.map((tool) => tool.name)
			.slice(0, limit);
	}
	return result;
}

export function loadBackendTool(
	registry: BackendToolRegistry,
	args: { name?: unknown },
): { tool: BackendToolManifest; result: Record<string, unknown> } {
	if (typeof args.name !== "string" || !args.name.trim()) {
		throw new Error("tool_load requires an exact product tool name");
	}
	const name = args.name.trim();
	if (registry.isDisclosed(name)) {
		throw new Error(`Tool schema is already active; call it directly and do not pass it to tool_load: ${name}`);
	}
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
				parameters: modelVisibleBackendToolParameters(tool),
				profile: tool.profile,
				risk: tool.risk,
			},
		},
	};
}

function exactToolNames(args: { name?: unknown; names?: unknown }): string[] {
	const hasName = args.name !== undefined;
	const hasNames = args.names !== undefined;
	if (hasName === hasNames) {
		throw new Error("tool_load requires exactly one of name or names");
	}
	const values = hasName ? [args.name] : args.names;
	if (!Array.isArray(values) || values.length < 1 || values.length > 4) {
		throw new Error("tool_load names must contain between one and four exact product tool names");
	}
	const names = values.map((value) => {
		if (typeof value !== "string" || !value.trim()) {
			throw new Error("tool_load requires exact non-empty product tool names");
		}
		return value.trim();
	});
	if (new Set(names).size !== names.length) {
		throw new Error("tool_load names must be unique");
	}
	return names;
}

export function loadBackendTools(
	registry: BackendToolRegistry,
	args: { name?: unknown; names?: unknown },
): Array<{ tool: BackendToolManifest; result: Record<string, unknown> }> {
	const names = exactToolNames(args);
	const unavailable = names.find((name) => !registry.get(name));
	if (unavailable) throw new Error(`Unknown or unavailable product tool: ${unavailable}`);
	const active = names.find((name) => registry.isDisclosed(name));
	if (active) {
		throw new Error(`Tool schema is already active; call it directly and do not pass it to tool_load: ${active}`);
	}
	return names.map((name) => loadBackendTool(registry, { name }));
}

export function createDiscoveryToolsExtension(options: DiscoveryToolsOptions): InlineExtension {
	return {
		name: "rag-ime-discovery-tools",
		factory(pi) {
			const loadedSkillNames = new Set(options.getLoadedSkillNames?.() ?? []);
			// Hard cache invariant: skill_load only appends its Tool Result in the
			// current epoch. Exact bodies may enter systemPrompt only at compaction,
			// which is the boundary that creates the next stable prefix.
			const loadedSkillBodies = new Map<string, string>();
			const restoreLoadedSkillState = (entries: readonly unknown[]): void => {
				for (const entry of entries) {
					if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
					const record = entry as Record<string, unknown>;
					if (record.type !== "custom" || record.customType !== LOADED_SKILL_STATE_ENTRY) continue;
					if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) continue;
					const data = record.data as Record<string, unknown>;
					const name = typeof data.name === "string" ? data.name.trim() : "";
					const contentRevision =
						typeof data.contentRevision === "string" ? data.contentRevision.trim().toLowerCase() : "";
					const resultSha256 = typeof data.resultSha256 === "string" ? data.resultSha256.trim().toLowerCase() : "";
					const body = typeof data.body === "string" ? data.body : "";
					if (!name || !/^[a-f0-9]{64}$/u.test(contentRevision) || !/^[a-f0-9]{64}$/u.test(resultSha256)) {
						continue;
					}
					if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES + 2048 || sha256(body) !== resultSha256) continue;
					if (
						!body.includes(
							`<loaded_skill name="${escapeXmlAttribute(name)}" revision="sha256:${contentRevision}">`,
						)
					) {
						continue;
					}
					loadedSkillNames.add(name);
					loadedSkillBodies.set(name, body);
				}
			};
			const currentLoadedSkillNames = (): string[] => {
				for (const name of options.getLoadedSkillNames?.() ?? []) loadedSkillNames.add(name);
				return [...loadedSkillNames];
			};
			pi.on("session_start", async (_event, ctx) => {
				restoreLoadedSkillState(ctx.sessionManager.getBranch());
			});
			pi.on("before_agent_start", async (event) => {
				if (event.systemPrompt.includes(TOOL_CATALOG_MARKER)) return undefined;
				const toolCatalog = formatBackendToolRouteCatalog(options.registry.list(), options.registry.revision(), {
					activeNames: options.registry.disclosed().map((tool) => tool.name),
					...(options.focusToolNames !== undefined ? { focusNames: options.focusToolNames } : {}),
				});
				if (!toolCatalog) return undefined;
				return { systemPrompt: `${event.systemPrompt}${toolCatalog}` };
			});
			pi.on("session_compact", async (_event, ctx) => {
				restoreLoadedSkillState(ctx.sessionManager.getBranch());
				const current = ctx.getSystemPrompt();
				const missingBodies = [...loadedSkillBodies]
					.filter(([name]) => !current.includes(`<loaded_skill name="${escapeXmlAttribute(name)}"`))
					.map(([, body]) => body);
				if (missingBodies.length === 0) return undefined;
				return {
					systemPrompt: [current, ...missingBodies].filter(Boolean).join("\n\n"),
				};
			});
			pi.registerTool({
				name: SKILL_SEARCH_TOOL_NAME,
				label: "Search skills",
				description: "Search the managed Skill Catalog by its six compact routing fields.",
				promptSnippet: "Search the stable managed Skill Catalog by routing-card fields",
				parameters: SKILL_SEARCH_PARAMETERS,
				execute: async (_toolCallId, args) => {
					const result = searchSkills(
						options.getResourceLoader().getSkills().skills,
						args as { query?: unknown; limit?: unknown },
						currentLoadedSkillNames(),
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
					const loadedNames = currentLoadedSkillNames();
					const result = await loadSkill(
						options.getResourceLoader().getSkills().skills,
						args as { name?: unknown },
						loadedNames,
					);
					const loadedName = String(result.details.name ?? "");
					const contentRevision = String(result.details.contentRevision ?? "");
					loadedSkillNames.add(loadedName);
					loadedSkillBodies.set(loadedName, result.text);
					pi.appendEntry(LOADED_SKILL_STATE_ENTRY, {
						name: loadedName,
						contentRevision,
						resultSha256: sha256(result.text),
						body: result.text,
					});
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
					description:
						"Search the product tool catalog by its six compact routing fields without loading schemas.",
					promptSnippet: "Search the product tool catalog, then use tool_load before calling a result",
					parameters: TOOL_SEARCH_PARAMETERS,
					execute: async (toolCallId, args, signal) => {
						let result = searchBackendTools(
							options.registry.list(),
							args as { query?: unknown; limit?: unknown },
							options.registry.revision(),
							options.registry.disclosed().map((tool) => tool.name),
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
							if (governed.result) {
								const activeNames = new Set(options.registry.disclosed().map((tool) => tool.name));
								const governedItems = Array.isArray(governed.result.items)
									? governed.result.items.filter((item) => {
											if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
											const name = (item as Record<string, unknown>).name;
											return typeof name === "string" && !activeNames.has(name);
										})
									: result.items;
								result = {
									...result,
									...governed.result,
									items: governedItems,
									activeDirectCalls: result.activeDirectCalls,
									nextTool: TOOL_LOAD_TOOL_NAME,
								};
							}
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
					description: "Disclose one to four exact product tool schemas needed for the same concrete next step.",
					promptSnippet: "Disclose one to four exact tool schemas returned by tool_search before calling them",
					parameters: TOOL_LOAD_PARAMETERS,
					execute: async (toolCallId, args, signal) => {
						const loaded = loadBackendTools(options.registry, args as { name?: unknown; names?: unknown });
						const loadRequests = loaded.map((item, index) => ({
							name: item.tool.name,
							receiptId:
								loaded.length === 1 ? `load:${toolCallId}` : `load:${toolCallId}:${index}:${item.tool.name}`,
						}));
						const governedReceipts = options.gateway?.roomCapability
							? await requestGovernedToolLoads(options.gateway, loadRequests, signal)
							: loadRequests.map(() => undefined);
						const prepared = loaded.map((item, index) => ({
							...item,
							alreadyDisclosed: false,
							governedReceipt: governedReceipts[index],
						}));
						for (const item of prepared) {
							const receiptId =
								typeof item.governedReceipt?.receiptId === "string" ? item.governedReceipt.receiptId : "";
							if (receiptId) options.registry.recordLoadReceipt(item.tool.name, receiptId);
							options.registry.disclose(item.tool.name);
						}
						const activeTools = new Set(pi.getActiveTools());
						for (const item of prepared) activeTools.add(item.tool.name);
						pi.setActiveTools([...activeTools]);
						const nextCalls = prepared.map((item) => ({
							tool: item.tool.name,
							instruction: `Call ${item.tool.name} directly with arguments from its newly disclosed Provider schema.`,
						}));
						const providerResult =
							prepared.length === 1
								? {
										schemaVersion: "rag-ime.tool-load.v1",
										catalogRevision: options.registry.revision(),
										schemaRevision: backendToolSchemaRevision([prepared[0].tool]),
										tool: backendToolRouteEntry(prepared[0].tool),
										disclosed: true,
										alreadyDisclosed: prepared[0].alreadyDisclosed,
										nextCall: nextCalls[0],
									}
								: {
										schemaVersion: "rag-ime.tool-load-batch.v1",
										catalogRevision: options.registry.revision(),
										schemaRevision: backendToolSchemaRevision(prepared.map((item) => item.tool)),
										tools: prepared.map((item) => ({
											...backendToolRouteEntry(item.tool),
											disclosed: true,
											alreadyDisclosed: item.alreadyDisclosed,
										})),
										nextCalls,
									};
						const details =
							prepared.length === 1
								? {
										...prepared[0].result,
										disclosed: true,
										alreadyDisclosed: prepared[0].alreadyDisclosed,
										nextCall: nextCalls[0],
										...(prepared[0].governedReceipt ? { governedReceipt: prepared[0].governedReceipt } : {}),
									}
								: {
										schemaVersion: "rag-ime.tool-load-batch.v1",
										catalogRevision: options.registry.revision(),
										schemaRevision: backendToolSchemaRevision(prepared.map((item) => item.tool)),
										tools: prepared.map((item, index) => ({
											...item.result,
											disclosed: true,
											alreadyDisclosed: item.alreadyDisclosed,
											nextCall: nextCalls[index],
											...(item.governedReceipt ? { governedReceipt: item.governedReceipt } : {}),
										})),
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
