import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";

export interface SkillRoutingCard {
	when: string[];
	does: string;
	notFor?: string[];
	input?: string;
	output?: string;
}

export interface SkillCatalogEntry {
	name: string;
	when: string[];
	notFor: string[];
	input: string;
	output: string;
	does: string;
}

export type SkillWithRouting = Skill & { routing?: SkillRoutingCard };
export type SkillRoutingCardCatalog = Readonly<Record<string, SkillRoutingCard>>;

export interface SkillPromptProjection {
	focusNames: readonly string[];
	loadedNames: readonly string[];
}

const MAX_ROUTING_CARD_CHARS = 200;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${field} must be a non-empty string array`);
	}
	const strings = value.map((item) => (typeof item === "string" ? item.trim() : ""));
	if (strings.some((item) => !item)) throw new Error(`${field} must contain only non-empty strings`);
	return [...new Set(strings)];
}

function routingCardLength(name: string, routing: SkillRoutingCard): number {
	return Array.from(JSON.stringify({ name, ...routing })).length;
}

function routingForSkill(skill: Skill): SkillRoutingCard | undefined {
	return (skill as SkillWithRouting).routing;
}

export function skillCatalogEntry(skill: Skill): SkillCatalogEntry {
	const routing = routingForSkill(skill) ?? fallbackRoutingCard(skill);
	return {
		name: skill.name,
		when: routing.when,
		notFor: routing.notFor ?? ["The task does not match the stated use case."],
		input: routing.input?.trim() || "Task request and relevant working context.",
		output: routing.output?.trim() || "Result defined by the loaded Skill instructions.",
		does: routing.does,
	};
}

export function skillCatalogRevision(skills: Skill[]): string {
	const entries = skills
		.filter((skill) => !skill.disableModelInvocation)
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(skillCatalogEntry);
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function codexPluginSkillCatalogNames(pluginName: string, skillName: string): string[] {
	const names = [`${pluginName}:${skillName}`];
	const pluginPrefix = `${pluginName}-`;
	if (skillName.startsWith(pluginPrefix) && skillName.length > pluginPrefix.length) {
		names.push(`${pluginName}:${skillName.slice(pluginPrefix.length)}`);
	}
	return [...new Set(names)];
}

export function parseSkillRoutingCardCatalog(value: unknown): SkillRoutingCardCatalog {
	const root = objectRecord(value);
	if (!root || !Array.isArray(root.cards)) throw new Error("Skill routing card catalog must contain cards[]");
	const result: Record<string, SkillRoutingCard> = {};
	for (const [index, item] of root.cards.entries()) {
		const card = objectRecord(item);
		const name = typeof card?.name === "string" ? card.name.trim() : "";
		const does = typeof card?.does === "string" ? card.does.trim() : "";
		if (!name || !does) throw new Error(`cards[${index}] must contain non-empty name and does`);
		if (result[name]) throw new Error(`duplicate Skill routing card: ${name}`);
		const routing: SkillRoutingCard = {
			when: nonEmptyStrings(card?.when, `cards[${index}].when`),
			does,
		};
		if (card?.notFor !== undefined) routing.notFor = nonEmptyStrings(card.notFor, `cards[${index}].notFor`);
		if (card?.input !== undefined) {
			if (typeof card.input !== "string" || !card.input.trim()) {
				throw new Error(`cards[${index}].input must be a non-empty string`);
			}
			routing.input = card.input.trim();
		}
		if (card?.output !== undefined) {
			if (typeof card.output !== "string" || !card.output.trim()) {
				throw new Error(`cards[${index}].output must be a non-empty string`);
			}
			routing.output = card.output.trim();
		}
		if (routingCardLength(name, routing) > MAX_ROUTING_CARD_CHARS) {
			throw new Error(`Skill routing card exceeds ${MAX_ROUTING_CARD_CHARS} characters: ${name}`);
		}
		result[name] = routing;
	}
	return result;
}

export function loadSkillRoutingCardCatalog(filePath: string): SkillRoutingCardCatalog {
	try {
		return parseSkillRoutingCardCatalog(JSON.parse(readFileSync(filePath, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Skill routing card catalog at ${filePath}: ${message}`);
	}
}

function fallbackRoutingCard(skill: Skill): SkillRoutingCard {
	const normalizedDescription = skill.description.replace(/\s+/g, " ").trim();
	let trigger = normalizedDescription || `用户明确要求使用 ${skill.name}`;
	let does = normalizedDescription || `加载并执行 ${skill.name} 的完整 Skill 工作流。`;
	let routing: SkillRoutingCard = { when: [trigger], does };
	while (routingCardLength(skill.name, routing) > MAX_ROUTING_CARD_CHARS) {
		if (trigger.length >= does.length && trigger.length > 12) {
			trigger = `${Array.from(trigger).slice(0, -8).join("")}...`;
		} else if (does.length > 12) {
			does = `${Array.from(does).slice(0, -8).join("")}...`;
		} else {
			break;
		}
		routing = { when: [trigger], does };
	}
	return routing;
}

function catalogMatch(
	skill: Skill,
	catalog: SkillRoutingCardCatalog,
): { name: string; routing: SkillRoutingCard } | undefined {
	if (catalog[skill.name]) return { name: skill.name, routing: catalog[skill.name] };
	const segments = skill.filePath.split(/[\\/]+/);
	const cacheIndex = segments.lastIndexOf("cache");
	const skillsIndex = segments.lastIndexOf("skills");
	if (cacheIndex < 0 || skillsIndex <= cacheIndex + 3) return undefined;
	const pluginName = segments[cacheIndex + 2];
	if (!pluginName) return undefined;
	const sourceNames = [skill.name, segments[skillsIndex + 1]].filter(
		(name): name is string => typeof name === "string" && name.length > 0,
	);
	for (const sourceName of sourceNames) {
		for (const name of codexPluginSkillCatalogNames(pluginName, sourceName)) {
			if (catalog[name]) return { name, routing: catalog[name] };
		}
	}
	return undefined;
}

function skillCapabilityFamily(name: string): string {
	if (name.startsWith("room-")) return "room-workflow";
	if (name.includes("memory")) return "memory";
	if (name.includes("handoff") || name.includes("collaborat")) return "collaboration";
	if (name.includes("quality") || name.includes("review")) return "quality-review";
	if (
		name.includes("implementation") ||
		name.includes("debugging") ||
		name.includes("architecture") ||
		name.includes("code")
	)
		return "engineering";
	if (name.includes("solution") || name.includes("planning")) return "planning";
	if (name.includes("grill") || name.includes("clarification") || name.includes("alignment")) return "requirements";
	if (name.includes(":")) return `plugin:${name.split(":", 1)[0]}`;
	const prefix = name.split("-", 1)[0]?.trim();
	return prefix || "other";
}

export function applySkillRoutingCardCatalog(
	base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
	catalog: SkillRoutingCardCatalog,
	projection?: SkillPromptProjection,
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
	const focusNames = new Set(projection?.focusNames ?? []);
	const loadedNames = new Set(projection?.loadedNames ?? []);
	return {
		diagnostics: base.diagnostics,
		skills: base.skills.map((skill) => {
			const match = catalogMatch(skill, catalog);
			const routed = skill as SkillWithRouting;
			const name = match?.name ?? skill.name;
			return {
				...skill,
				name,
				routing: routed.routing ?? match?.routing ?? fallbackRoutingCard(skill),
				...(projection
					? {
							promptCatalog: {
								family: skillCapabilityFamily(name),
								focus: focusNames.has(name),
								bodyLoaded: loadedNames.has(name),
							},
						}
					: {}),
			};
		}),
	};
}
