import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";

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
			modelRuntime,
			toolManifest: manifest("read"),
			noContextFiles: true,
			emitEvent: (event) => events.push(event as unknown as Record<string, unknown>),
		});

		try {
			expect(productSession.snapshot()).toMatchObject({ activeBackendTools: [] });
			expect(productSession.listTools()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "memory.query",
						active: false,
						catalogOnly: true,
					}),
					expect.objectContaining({
						name: "tool_load",
						active: true,
						catalogOnly: false,
					}),
				]),
			);
			const internal = productSession as unknown as {
				session: { reload(): Promise<void> };
			};
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

			productSession.toolRegistry.activate("memory.query");
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
