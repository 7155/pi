import { readFileSync } from "node:fs";
import type { ResourceDiagnostic, Skill, SkillRoutingCard } from "@earendil-works/pi-coding-agent";

export type SkillRoutingCardCatalog = Readonly<Record<string, SkillRoutingCard>>;

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
	return strings;
}

function routingCardLength(name: string, routing: SkillRoutingCard): number {
	return Array.from(JSON.stringify({ name, ...routing })).length;
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
	const does = `加载并执行 ${skill.name} 的完整 Skill 工作流。`;
	const normalizedDescription = skill.description.replace(/\s+/g, " ").trim();
	let trigger = normalizedDescription || `用户明确要求使用 ${skill.name}`;
	let routing: SkillRoutingCard = { when: [trigger], does };
	while (routingCardLength(skill.name, routing) > MAX_ROUTING_CARD_CHARS && trigger.length > 12) {
		trigger = `${Array.from(trigger).slice(0, -8).join("")}...`;
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

export function applySkillRoutingCardCatalog(
	base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
	catalog: SkillRoutingCardCatalog,
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
	return {
		diagnostics: base.diagnostics,
		skills: base.skills.map((skill) => {
			const match = catalogMatch(skill, catalog);
			return {
				...skill,
				...(match ? { name: match.name } : {}),
				routing: skill.routing ?? match?.routing ?? fallbackRoutingCard(skill),
			};
		}),
	};
}
