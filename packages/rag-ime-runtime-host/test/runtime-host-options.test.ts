import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_PRIMITIVE_CAPABILITIES, runtimeHostOptionsFromEnvironment } from "../src/runtime-host.ts";

describe("runtime host primitive capabilities", () => {
	it("advertises only the product-neutral primitives available in this release", () => {
		expect(RUNTIME_PRIMITIVE_CAPABILITIES).toEqual({
			continuationEnvelope: "1",
			cancelScope: "1",
			sessionContinuationQueue: false,
			sessionCancelOperationRegistry: false,
			sessionCancelOperations: {
				provider: true,
				tool: true,
				retrySleep: true,
				manualCompaction: true,
				autoCompaction: true,
				branchSummary: false,
				bashProcess: true,
				continuationTimer: false,
			},
			roomTypes: false,
		});
	});
});

describe("runtime host managed skills", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("disables ambient Pi, Codex, and project Skill discovery by default", () => {
		vi.stubEnv("RAG_IME_PI_SKILL_PATHS", "");
		vi.stubEnv("RAG_IME_PI_USER_SKILL_PATHS", "");
		vi.stubEnv("RAG_IME_CODEX_SKILL_PATHS", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		vi.stubEnv("CODEX_HOME", "");

		const options = runtimeHostOptionsFromEnvironment(() => undefined);

		expect(options.skillPaths).toEqual([]);
		expect(options.piSkillPaths).toEqual([join(homedir(), ".pi", "agent", "skills")]);
		expect(options.codexSkillPaths).toEqual([
			join(homedir(), ".codex", "skills", ".system"),
			join(homedir(), ".codex", "skills"),
			join(homedir(), ".agents", "skills"),
		]);
	});

	it("loads only explicitly configured product Skill paths", () => {
		vi.stubEnv(
			"RAG_IME_PI_SKILL_PATHS",
			["/managed/rag-ime-memory-curator", "/managed/rag-ime-plugin-creator"].join(delimiter),
		);
		vi.stubEnv("RAG_IME_PI_USER_SKILL_PATHS", "/user/pi-skills");
		vi.stubEnv("RAG_IME_CODEX_SKILL_PATHS", ["/user/codex-skills", "/user/agent-skills"].join(delimiter));

		const options = runtimeHostOptionsFromEnvironment(() => undefined);

		expect(options.skillPaths).toEqual([
			resolve("/managed/rag-ime-memory-curator"),
			resolve("/managed/rag-ime-plugin-creator"),
		]);
		expect(options.piSkillPaths).toEqual([resolve("/user/pi-skills")]);
		expect(options.codexSkillPaths).toEqual([resolve("/user/codex-skills"), resolve("/user/agent-skills")]);
	});

	it("adds only cataloged Codex plugin Skills from the local cache", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-codex-plugin-skills-"));
		const browserSkill = join(
			root,
			"plugins",
			"cache",
			"openai-bundled",
			"browser",
			"1.0.0",
			"skills",
			"control-in-app-browser",
		);
		const staleSkill = join(root, "plugins", "cache", "openai-bundled", "latex", "1.0.0", "skills", "latex-doctor");
		const catalogPath = join(root, "routing-cards.json");
		try {
			await Promise.all([mkdir(browserSkill, { recursive: true }), mkdir(staleSkill, { recursive: true })]);
			await Promise.all([
				writeFile(
					join(browserSkill, "SKILL.md"),
					"---\nname: control-in-app-browser\ndescription: Browser.\n---\n",
				),
				writeFile(join(staleSkill, "SKILL.md"), "---\nname: latex-doctor\ndescription: Stale.\n---\n"),
				writeFile(
					catalogPath,
					JSON.stringify({
						cards: [
							{
								name: "browser:control-in-app-browser",
								when: ["browser task"],
								does: "control browser",
							},
						],
					}),
				),
			]);
			vi.stubEnv("CODEX_HOME", root);
			vi.stubEnv("RAG_IME_CODEX_SKILL_PATHS", "");
			vi.stubEnv("RAG_IME_PI_SKILL_ROUTING_CARDS", catalogPath);

			const options = runtimeHostOptionsFromEnvironment(() => undefined);

			expect(options.codexSkillPaths).toContain(browserSkill);
			expect(options.codexSkillPaths).not.toContain(staleSkill);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
