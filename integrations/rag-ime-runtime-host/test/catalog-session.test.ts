import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession, restoreBackendToolDisclosures } from "../src/pi-session.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

function manifest(risk: string, requireQuery = false) {
	return [
		{
			name: "memory.query",
			description: "Query long-term memory.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				...(requireQuery ? { required: ["query"] } : {}),
			},
			profile: "memory",
			risk,
		},
	];
}

describe("PiProductSession catalog updates", () => {
	it("loads product Skills always and Pi/Codex Skills only through their independent settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-product-skills-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		const ambientSkillDir = join(agentDir, "skills", "ambient-workspace-skill");
		const productSkillDir = join(root, "product-skills", "rag-ime-product-skill");
		const piSkillDir = join(root, "pi-skills", "pi-user-skill");
		const codexSkillDir = join(root, "codex-skills", "codex-user-skill");
		await Promise.all([
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
			mkdir(ambientSkillDir, { recursive: true }),
			mkdir(productSkillDir, { recursive: true }),
			mkdir(piSkillDir, { recursive: true }),
			mkdir(codexSkillDir, { recursive: true }),
		]);
		await Promise.all([
			writeFile(
				join(ambientSkillDir, "SKILL.md"),
				"---\nname: ambient-workspace-skill\ndescription: Must remain outside the product catalog.\n---\n",
			),
			writeFile(
				join(productSkillDir, "SKILL.md"),
				"---\nname: rag-ime-product-skill\ndescription: Explicit product Skill.\n---\n",
			),
			writeFile(join(piSkillDir, "SKILL.md"), "---\nname: pi-user-skill\ndescription: Optional Pi Skill.\n---\n"),
			writeFile(
				join(codexSkillDir, "SKILL.md"),
				"---\nname: codex-user-skill\ndescription: Optional Codex Skill.\n---\n",
			),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const sessionOptions = {
			externalSessionId: "product-skill-test",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [productSkillDir],
			piSkillPaths: [piSkillDir],
			codexSkillPaths: [codexSkillDir],
			modelRuntime,
			toolManifest: [],
			noContextFiles: true,
			emitEvent: () => undefined,
		};
		const productSession = await PiProductSession.create(sessionOptions);

		try {
			expect(productSession.listCommands()).toEqual([
				expect.objectContaining({ name: "skill:rag-ime-product-skill" }),
			]);
			expect(productSession.snapshot()).toMatchObject({
				piSkillsEnabled: false,
				codexSkillsEnabled: false,
			});
			expect(JSON.stringify(productSession.listCommands())).not.toContain("ambient-workspace-skill");
			expect(JSON.stringify(productSession.listCommands())).not.toContain("pi-user-skill");
			expect(JSON.stringify(productSession.listCommands())).not.toContain("codex-user-skill");
		} finally {
			productSession.dispose();
		}

		const piSession = await PiProductSession.create({
			...sessionOptions,
			externalSessionId: "pi-skill-test",
			piSkillsEnabled: true,
		});
		try {
			expect(piSession.listCommands().map((command) => command.name)).toEqual([
				"skill:rag-ime-product-skill",
				"skill:pi-user-skill",
			]);
			expect(piSession.snapshot()).toMatchObject({ piSkillsEnabled: true, codexSkillsEnabled: false });
		} finally {
			piSession.dispose();
		}

		const codexSession = await PiProductSession.create({
			...sessionOptions,
			externalSessionId: "codex-skill-test",
			codexSkillsEnabled: true,
		});
		try {
			expect(codexSession.listCommands().map((command) => command.name)).toEqual([
				"skill:rag-ime-product-skill",
				"skill:codex-user-skill",
			]);
			expect(codexSession.snapshot()).toMatchObject({ piSkillsEnabled: false, codexSkillsEnabled: true });
		} finally {
			codexSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("restores only schemas explicitly disclosed by tool_load", () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			...manifest("read"),
			{
				name: "settings.apply",
				description: "Apply settings.",
				parameters: { type: "object", properties: {} },
			},
		]);
		const sessionManager = {
			getBranch: () => [
				{
					type: "message",
					message: { role: "toolResult", toolName: "memory.query", isError: false },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "tool_load",
						isError: false,
						details: { tool: { name: "settings.apply" } },
					},
				},
				{
					type: "message",
					message: { role: "toolResult", toolName: "unknown.tool", isError: false },
				},
			],
		} as unknown as SessionManager;

		expect(restoreBackendToolDisclosures(registry, sessionManager)).toEqual(["settings.apply"]);
		expect(registry.disclosed().map((tool) => tool.name)).toEqual(["settings.apply"]);
	});

	it("keeps permission-only changes in the incremental suffix and reloads only real schema changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-catalog-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const activePluginDir = join(root, "plugins", "active");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(activePluginDir, { recursive: true }),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const events: Array<Record<string, unknown>> = [];
		const productSession = await PiProductSession.create({
			externalSessionId: "catalog-test",
			cwd: root,
			sessionDir,
			agentDir,
			activePluginDir,
			skillPaths: [],
			piSkillPaths: [],
			codexSkillPaths: [],
			modelRuntime,
			toolManifest: manifest("read"),
			noContextFiles: true,
			emitEvent: (event) => events.push(event as unknown as Record<string, unknown>),
		});

		try {
			expect(productSession.snapshot()).toMatchObject({
				activeBackendTools: [],
				disclosedBackendTools: [],
			});
			expect(productSession.listTools()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "memory.query",
						active: false,
						disclosed: false,
						routable: true,
						catalogOnly: false,
					}),
					expect.objectContaining({
						name: "tool_load",
						active: true,
						catalogOnly: false,
					}),
				]),
			);
			const internal = productSession as unknown as {
				session: {
					reload(): Promise<void>;
					agent: { resolveToolForExecution?: (name: string) => unknown };
				};
			};
			expect(internal.session.agent.resolveToolForExecution?.("memory.query")).toBeDefined();
			const reload = vi.spyOn(internal.session, "reload").mockResolvedValue(undefined);

			await productSession.syncTools(manifest("approval"));

			expect(reload).not.toHaveBeenCalled();
			expect(productSession.snapshot().messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "custom",
						customType: "rag-ime.runtime-catalog-change",
					}),
				]),
			);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: "runtime.notice",
						payload: expect.objectContaining({
							type: "runtime_catalog_changed",
							schemaReloaded: false,
						}),
					}),
				]),
			);

			productSession.toolRegistry.disclose("memory.query");
			await productSession.syncTools(manifest("approval", true));

			expect(reload).toHaveBeenCalledTimes(1);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: "runtime.notice",
						payload: expect.objectContaining({
							type: "runtime_catalog_changed",
							schemaReloaded: true,
						}),
					}),
				]),
			);
		} finally {
			productSession.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
