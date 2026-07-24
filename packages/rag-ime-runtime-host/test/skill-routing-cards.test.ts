import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySkillRoutingCardCatalog, parseSkillRoutingCardCatalog } from "../src/skill-routing-cards.ts";

describe("Skill routing card catalog", () => {
	it("parses bounded structured cards and rejects oversized entries", () => {
		const catalog = parseSkillRoutingCardCatalog({
			cards: [{ name: "codex", when: ["用户要求委派 Codex CLI"], does: "执行 Codex CLI。" }],
		});
		expect(catalog.codex).toEqual({ when: ["用户要求委派 Codex CLI"], does: "执行 Codex CLI。" });
		expect(() =>
			parseSkillRoutingCardCatalog({
				cards: [{ name: "too-long", when: ["x".repeat(220)], does: "run" }],
			}),
		).toThrow(/exceeds 200 characters/);
	});

	it("overlays known cards and creates a bounded fallback for future Skills", () => {
		const result = applySkillRoutingCardCatalog(
			{
				diagnostics: [],
				skills: [
					{
						name: "known",
						description: "Known description",
						filePath: "/known/SKILL.md",
						baseDir: "/known",
						sourceInfo: createSyntheticSourceInfo("/known/SKILL.md", { source: "test" }),
						disableModelInvocation: false,
					},
					{
						name: "future",
						description: "A very long future description ".repeat(20),
						filePath: "/future/SKILL.md",
						baseDir: "/future",
						sourceInfo: createSyntheticSourceInfo("/future/SKILL.md", { source: "test" }),
						disableModelInvocation: false,
					},
				],
			},
			{ known: { when: ["known trigger"], does: "known action" } },
		);

		expect(result.skills[0]?.routing).toEqual({ when: ["known trigger"], does: "known action" });
		const fallback = { name: "future", ...result.skills[1]?.routing };
		expect(Array.from(JSON.stringify(fallback)).length).toBeLessThanOrEqual(200);
	});

	it("maps a cataloged Codex plugin Skill to its public prefixed name", () => {
		const filePath =
			"/Users/test/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/control-in-app-browser/SKILL.md";
		const result = applySkillRoutingCardCatalog(
			{
				diagnostics: [],
				skills: [
					{
						name: "control-in-app-browser",
						description: "Control the in-app Browser.",
						filePath,
						baseDir: filePath.slice(0, -"/SKILL.md".length),
						sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
						disableModelInvocation: false,
					},
				],
			},
			{
				"browser:control-in-app-browser": {
					when: ["需要操作应用内浏览器"],
					does: "控制应用内浏览器。",
				},
			},
		);

		expect(result.skills[0]).toMatchObject({
			name: "browser:control-in-app-browser",
			routing: { when: ["需要操作应用内浏览器"], does: "控制应用内浏览器。" },
		});
	});

	it("attaches runtime-only family, focus, and loaded-body projection without changing routing cards", () => {
		const result = applySkillRoutingCardCatalog(
			{
				diagnostics: [],
				skills: [
					{
						name: "room-structured-handoff",
						description: "Hand off Room work.",
						filePath: "/handoff/SKILL.md",
						baseDir: "/handoff",
						sourceInfo: createSyntheticSourceInfo("/handoff/SKILL.md", { source: "test" }),
						disableModelInvocation: false,
					},
					{
						name: "quality-gate",
						description: "Check evidence.",
						filePath: "/quality/SKILL.md",
						baseDir: "/quality",
						sourceInfo: createSyntheticSourceInfo("/quality/SKILL.md", { source: "test" }),
						disableModelInvocation: false,
					},
				],
			},
			{},
			{
				focusNames: ["quality-gate"],
				loadedNames: ["room-structured-handoff"],
			},
		);

		expect(result.skills).toMatchObject([
			{
				name: "room-structured-handoff",
				promptCatalog: { family: "room-workflow", focus: false, bodyLoaded: true },
			},
			{
				name: "quality-gate",
				promptCatalog: { family: "quality-review", focus: true, bodyLoaded: false },
			},
		]);
	});
});
