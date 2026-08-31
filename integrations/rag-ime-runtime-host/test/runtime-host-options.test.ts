import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
			sessionSettlementGet: true,
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

describe("runtime host metadata and workspace boundaries", () => {
	it("reports the actual upstream baseline from the embedded host", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-runtime-metadata-"));
		let host: RagImeRuntimeHost | undefined;
		try {
				host = await RagImeRuntimeHost.create({
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
				pluginsRoot: join(root, "plugins"),
				pluginInbox: join(root, "plugin-inbox"),
				maxSessions: 1,
				emitEvent: () => undefined,
			});
			await expect(
				host.handle({ protocolVersion: "2", id: "hello", method: "hello", params: {} }),
			).resolves.toMatchObject({ piVersion: "0.84.2" });
		} finally {
			await host?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("canonicalizes configured workspace roots before enforcing boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-runtime-roots-"));
		const canonicalRoot = join(root, "canonical");
		const linkedRoot = join(root, "linked");
		const child = join(canonicalRoot, "child");
		let host: RagImeRuntimeHost | undefined;
		try {
			await mkdir(child, { recursive: true });
			await symlink(canonicalRoot, linkedRoot);
			host = await RagImeRuntimeHost.create({
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
				pluginsRoot: join(root, "plugins"),
				pluginInbox: join(root, "plugin-inbox"),
				allowedWorkspaceRoots: [linkedRoot],
				maxSessions: 1,
				emitEvent: () => undefined,
			});
			const workspace = (host as unknown as { workspace(value: unknown): Promise<string> }).workspace;
			await expect(workspace.call(host, join(linkedRoot, "child"))).resolves.toBe(await realpath(child));
		} finally {
			await host?.dispose();
			await rm(root, { recursive: true, force: true });
		}
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

describe("runtime host bounded model selection", () => {
	it("applies and reports the Provider output budget through session.model.set", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-runtime-model-budget-"));
		let host: RagImeRuntimeHost | undefined;
		try {
			await writeFile(
				join(root, "auth.json"),
				JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
			);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "auth.json"),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const selected = modelRuntime
				.getModels()
				.find((candidate) => candidate.provider === "anthropic" && candidate.maxTokens >= 16_384);
			expect(selected).toBeDefined();
			host = await RagImeRuntimeHost.create({
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
				pluginsRoot: join(root, "plugins"),
				pluginInbox: join(root, "plugin-inbox"),
				maxSessions: 1,
				modelRuntime,
				emitEvent: () => undefined,
			});
			await host.handle({
				protocolVersion: "2",
				id: "open",
				method: "session.open",
				params: {
					sessionId: "session:model-budget",
					cwd: root,
					provider: selected?.provider,
					modelId: selected?.id,
				},
			});

			await expect(
				host.handle({
					protocolVersion: "2",
					id: "select",
					method: "session.model.set",
					params: {
						sessionId: "session:model-budget",
						provider: selected?.provider,
						modelId: selected?.id,
						maxTokens: 16_384,
					},
				}),
			).resolves.toMatchObject({ maxTokens: 16_384 });
			await expect(
				host.handle({
					protocolVersion: "2",
					id: "invalid-select",
					method: "session.model.set",
					params: {
						sessionId: "session:model-budget",
						provider: selected?.provider,
						modelId: selected?.id,
						maxTokens: 15,
					},
				}),
			).rejects.toThrow("maxTokens must be an integer between 16 and 262144");
		} finally {
			await host?.dispose();
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

describe("runtime host native Pi Package protocol", () => {
	it("creates, reviews, installs, disables and uninstalls a Pi Package", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-runtime-native-package-"));
		let host: RagImeRuntimeHost | undefined;
		try {
			host = await RagImeRuntimeHost.create({
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
				pluginsRoot: join(root, "plugins"),
				pluginInbox: join(root, "plugin-inbox"),
				pluginApprovalToken: "approved-by-product",
				maxSessions: 1,
				emitEvent: () => undefined,
			});
			const catalog = (await host.handle({
				protocolVersion: "2",
				id: "plugins-catalog",
				method: "plugins.catalog",
				params: {},
			})) as { packages: Array<Record<string, unknown>> };
			expect(catalog.packages).toEqual(
				expect.arrayContaining([
						expect.objectContaining({
							id: "@paw/pi-session-workflow",
							displayName: "Session Workflow",
							capabilities: ["session-workflow"],
							bundled: true,
							installed: false,
							enabled: false,
						}),
						expect.objectContaining({
							id: "@paw/pi-subagent",
							displayName: "Subagent",
							capabilities: ["subagent"],
							bundled: true,
							installed: false,
							enabled: false,
						}),
				]),
			);
			const draft = (await host.handle({
				protocolVersion: "2",
				id: "package-create",
				method: "plugins.package.create",
				params: {
					draftId: "session-workflow-v1",
					packageJson: {
						name: "paw-session-workflow",
						version: "1.0.0",
						pi: { skills: ["./skills"] },
					},
					files: {
						"skills/session-workflow/SKILL.md":
							"---\nname: session-workflow\ndescription: Session workflow.\n---\n",
					},
				},
			})) as { sourcePath: string };
			const prepared = (await host.handle({
				protocolVersion: "2",
				id: "package-prepare",
				method: "plugins.package.prepare",
				params: { source: draft.sourcePath },
			})) as { preparedPackageId: string; digest: string };
			const preview = (await host.handle({
				protocolVersion: "2",
				id: "package-preview",
				method: "plugins.install.preview",
				params: {
					preparedPackageId: prepared.preparedPackageId,
					expectedDigest: prepared.digest,
					enable: true,
				},
			})) as { previewToken: string; payloadSha256: string };
			const installed = (await host.handle({
				protocolVersion: "2",
				id: "package-install",
				method: "plugins.install",
				params: {
					preparedPackageId: prepared.preparedPackageId,
					expectedDigest: prepared.digest,
					enable: true,
					previewToken: preview.previewToken,
					payloadSha256: preview.payloadSha256,
					confirmText: "apply",
					approvalToken: "approved-by-product",
				},
			})) as { id: string; digest: string; enabled: boolean };
			expect(installed).toMatchObject({ id: "paw-session-workflow", enabled: true });

			const disabled = (await host.handle({
				protocolVersion: "2",
				id: "package-disable",
				method: "plugins.disable",
				params: {
					pluginId: installed.id,
					expectedActiveDigest: installed.digest,
					expectedEnabled: true,
					approvalToken: "approved-by-product",
				},
			})) as { enabled: boolean };
			expect(disabled.enabled).toBe(false);

			await expect(
				host.handle({
					protocolVersion: "2",
					id: "package-uninstall",
					method: "plugins.uninstall",
					params: {
						pluginId: installed.id,
						expectedActiveDigest: installed.digest,
						expectedEnabled: false,
						approvalToken: "approved-by-product",
					},
				}),
			).resolves.toMatchObject({ id: installed.id, removed: true, distribution: "pi_package" });
			await expect(
				host.handle({ protocolVersion: "2", id: "plugins-list", method: "plugins.list", params: {} }),
			).resolves.toEqual({ plugins: [] });
		} finally {
			await host?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
