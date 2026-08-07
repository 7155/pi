import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RagImeRuntimeHost,
	RUNTIME_PRIMITIVE_CAPABILITIES,
	runtimeHostOptionsFromEnvironment,
} from "../src/runtime-host.ts";

describe("runtime host primitive capabilities", () => {
	it("advertises only the product-neutral primitives available in this release", () => {
		expect(RUNTIME_PRIMITIVE_CAPABILITIES).toEqual({
			continuationEnvelope: "2",
			continuationLease: "1",
			cancelScope: "1",
			runScope: "1",
			agentSettledReceipt: "2",
			contextProvider: "1",
			sessionAwaitSettled: true,
			sessionContinuationQueue: true,
			sessionCancelOperationRegistry: true,
			sessionCancelOperations: {
				provider: true,
				tool: true,
				retrySleep: true,
				manualCompaction: true,
				autoCompaction: true,
				branchSummary: true,
				bashProcess: true,
				continuationTimer: true,
			},
			roomTypes: true,
		});
	});
});

describe("runtime host provider transport", () => {
	it("restores an environment-aware dispatcher before creating the production model runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-runtime-transport-"));
		const originalDispatcher = getGlobalDispatcher();
		const directDispatcher = new Agent();
		const originalFetch = globalThis.fetch;
		const originalHttpProxy = process.env.HTTP_PROXY;
		const originalHttpsProxy = process.env.HTTPS_PROXY;
		let host: RagImeRuntimeHost | undefined;
		try {
			process.env.HTTP_PROXY = "http://127.0.0.1:7890";
			process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
			setGlobalDispatcher(directDispatcher);
			// Prevent the test from replacing all web-platform globals when the
			// dispatcher is configured; production keeps the original fetch and
			// therefore installs the matching undici globals.
			globalThis.fetch = (async () => {
				throw new Error("fetch is not used by this transport composition test");
			}) as typeof globalThis.fetch;

			host = await RagImeRuntimeHost.create({
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
				pluginsRoot: join(root, "plugins"),
				pluginInbox: join(root, "plugin-inbox"),
				maxSessions: 1,
				emitEvent: () => undefined,
			});

			expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
		} finally {
			await host?.dispose();
			const activeDispatcher = getGlobalDispatcher();
			setGlobalDispatcher(originalDispatcher);
			if (activeDispatcher !== originalDispatcher) {
				await activeDispatcher.close();
			}
			if (directDispatcher !== activeDispatcher) {
				await directDispatcher.close();
			}
			globalThis.fetch = originalFetch;
			if (originalHttpProxy === undefined) {
				delete process.env.HTTP_PROXY;
			} else {
				process.env.HTTP_PROXY = originalHttpProxy;
			}
			if (originalHttpsProxy === undefined) {
				delete process.env.HTTPS_PROXY;
			} else {
				process.env.HTTPS_PROXY = originalHttpsProxy;
			}
			await rm(root, { recursive: true, force: true });
		}
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
		vi.stubEnv("RAG_IME_PI_SKILL_PATHS", ["/managed/memory-curation", "/managed/plugin-creator"].join(delimiter));
		vi.stubEnv("RAG_IME_PI_USER_SKILL_PATHS", "/user/pi-skills");
		vi.stubEnv("RAG_IME_CODEX_SKILL_PATHS", ["/user/codex-skills", "/user/agent-skills"].join(delimiter));

		const options = runtimeHostOptionsFromEnvironment(() => undefined);

		expect(options.skillPaths).toEqual([resolve("/managed/memory-curation"), resolve("/managed/plugin-creator")]);
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
