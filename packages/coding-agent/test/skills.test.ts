import { homedir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
	routing?: Skill["routing"];
	promptCatalog?: Skill["promptCatalog"];
}): Skill {
	return {
		name: options.name,
		description: options.description,
		routing: options.routing,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
		promptCatalog: options.promptCatalog,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(false);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});

		it("should parse a compact routing card", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "routing-card"),
				source: "test",
			});

			expect(diagnostics).toHaveLength(0);
			expect(skills).toHaveLength(1);
			expect(skills[0].routing).toEqual({
				when: ["用户要求整理长期记忆", "用户要求审阅记忆草案"],
				notFor: ["普通记忆查询"],
				input: "用户请求、候选记忆与来源证据。",
				output: "受控记忆草案与审阅结论。",
				does: "生成并审阅受控记忆草案。",
			});
		});

		it("should reject a partial or malformed routing card", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-routing-card"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((diagnostic) => diagnostic.message.includes("when must be"))).toBe(true);
			expect(diagnostics.some((diagnostic) => diagnostic.message.includes("does must be"))).toBe(true);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the read tool to load a skill's file");
		});

		it("supports a controlled skill loader without exposing file locations", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills, {
				loadToolName: "skill_load",
				searchToolName: "skill_search",
				includeLocations: false,
				includeRevision: true,
			});

			expect(result).toContain("Use skill_search for full routing details");
			expect(result).toContain("Use skill_load with the exact name");
			expect(result).toContain('<available_skills revision="sha256:');
			expect(result).not.toContain("<location>");
		});

		it("renders structured routing cards as compact JSONL for a controlled loader", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "memory-review",
					description: "Compatibility description that must not enter the catalog.",
					filePath: "/path/to/memory-review/SKILL.md",
					baseDir: "/path/to/memory-review",
					routing: {
						when: ["用户要求审阅记忆草案", "用户要求回滚已应用草案"],
						notFor: ["普通记忆查询"],
						input: "记忆草案、证据与用户决定。",
						output: "受控审阅结论与应用回执。",
						does: "审阅并受控应用长期记忆草案。",
					},
				}),
			];

			const result = formatSkillsForPrompt(skills, {
				loadToolName: "skill_load",
				searchToolName: "skill_search",
				includeLocations: false,
				includeRevision: true,
			});

			expect(result).toContain('format="routing-card-jsonl"');
			expect(result).toContain(
				JSON.stringify({
					name: "memory-review",
					when: ["用户要求审阅记忆草案"],
					notFor: ["普通记忆查询"],
					input: "记忆草案、证据与用户决定。",
					output: "受控审阅结论与应用回执。",
					does: "审阅并受控应用长期记忆草案。",
				}),
			);
			expect(result).not.toContain("Compatibility description");
			expect(result).not.toContain("<location>");
		});

		it("keeps the family index stable while limiting detailed cards to current-stage deferred skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "grill-me",
					description: "Clarify requirements.",
					filePath: "/path/to/grill-me/SKILL.md",
					baseDir: "/path/to/grill-me",
					routing: {
						when: ["需求与验收尚未对齐"],
						does: "通过追问固定需求边界。",
					},
					promptCatalog: {
						family: "requirements",
						focus: true,
						bodyLoaded: false,
					},
				}),
				createTestSkill({
					name: "quality-gate",
					description: "Review delivery evidence.",
					filePath: "/path/to/quality-gate/SKILL.md",
					baseDir: "/path/to/quality-gate",
					routing: {
						when: ["需要准备质量回执"],
						does: "逐项核对验收证据。",
					},
					promptCatalog: {
						family: "quality-review",
						focus: false,
						bodyLoaded: false,
					},
				}),
				createTestSkill({
					name: "managed-task-execution",
					description: "Execute a managed task.",
					filePath: "/path/to/managed-task-execution/SKILL.md",
					baseDir: "/path/to/managed-task-execution",
					routing: {
						when: ["已收到结构化执行任务"],
						does: "执行任务并提交质量回执。",
					},
					promptCatalog: {
						family: "room-workflow",
						focus: true,
						bodyLoaded: true,
					},
				}),
			];

			const result = formatSkillsForPrompt(skills, {
				loadToolName: "skill_load",
				searchToolName: "skill_search",
				includeLocations: false,
				includeRevision: true,
			});

			expect(result).toContain('<skill_capability_families format="family-jsonl">');
			expect(result).toContain('{"family":"quality-review","count":1,"examples":["quality-gate"]}');
			expect(result).toContain('{"family":"requirements","count":1,"examples":["grill-me"]}');
			expect(result).toContain('{"family":"room-workflow","count":1,"examples":["managed-task-execution"]}');
			expect(result).toContain('"name":"grill-me"');
			expect(result).not.toContain('"name":"quality-gate"');
			const detailedCards = result.match(/<available_skills[^>]*>([\s\S]*?)<\/available_skills>/u)?.[1] ?? "";
			expect(detailedCards).not.toContain("managed-task-execution");
			expect(result).toContain("never load that Skill again");
			expect(result).toContain('<available_skills revision="sha256:');
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".pi/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.pi/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
