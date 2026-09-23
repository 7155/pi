import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedPluginManager } from "../src/plugin-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function manifest(version: string) {
	return {
		schemaVersion: 1,
		id: "weather-helper",
		name: "Weather Helper",
		version,
		description: "Shows a bounded weather summary",
		entry: "index.ts",
		permissions: ["network.weather"],
	};
}

async function installReviewed(
	manager: ManagedPluginManager,
	draft: { sourcePath: string; digest: string },
	enable: boolean,
) {
	const preview = await manager.previewInstall({
		sourcePath: draft.sourcePath,
		expectedDigest: draft.digest,
		enable,
	});
	return manager.install({
		sourcePath: draft.sourcePath,
		expectedDigest: draft.digest,
		approvalToken: "approved-by-product",
		enable,
		previewToken: preview.previewToken,
		payloadSha256: preview.payloadSha256,
		confirmText: "apply",
	});
}

describe("managed plugin lifecycle", () => {
	it("creates, validates, installs, disables and rolls back immutable versions", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-plugins-"));
		roots.push(root);
		const manager = new ManagedPluginManager({
			pluginsRoot: join(root, "installed"),
			inboxRoot: join(root, "inbox"),
			approvalToken: "approved-by-product",
		});
		const first = await manager.createDraft({
			draftId: "weather-v1",
			manifest: manifest("1.0.0"),
			files: { "index.ts": "export default function () {}\n" },
		});
		expect(first.installPreview.operation).toBe("install");
		const firstPreview = await manager.previewInstall({
			sourcePath: first.sourcePath,
			expectedDigest: first.digest,
			enable: true,
		});
		await expect(
			manager.install({
				sourcePath: first.sourcePath,
				expectedDigest: first.digest,
				approvalToken: "wrong",
				enable: true,
				previewToken: firstPreview.previewToken,
				payloadSha256: firstPreview.payloadSha256,
				confirmText: "apply",
			}),
		).rejects.toMatchObject({ code: "PLUGIN_APPROVAL_REQUIRED" });

		const installed = await manager.install({
			sourcePath: first.sourcePath,
			expectedDigest: first.digest,
			approvalToken: "approved-by-product",
			enable: true,
			previewToken: firstPreview.previewToken,
			payloadSha256: firstPreview.payloadSha256,
			confirmText: "apply",
		});
		expect(installed).toMatchObject({ id: "weather-helper", version: "1.0.0", enabled: true });

		const second = await manager.createDraft({
			draftId: "weather-v2",
			manifest: manifest("2.0.0"),
			files: { "index.ts": "export default function () { return 'v2'; }\n" },
		});
		const secondInstall = await installReviewed(manager, second, true);
		expect(secondInstall.rollbackTarget).toMatchObject({ version: "1.0.0", digest: first.digest });
		const rolledBack = await manager.rollback("weather-helper", "approved-by-product", second.digest, first.digest);
		expect(rolledBack.version).toBe("1.0.0");
		expect(rolledBack.rollbackTarget).toBeUndefined();
		expect(await readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).toContain(first.digest);
		expect((await manager.disable("weather-helper", "approved-by-product", first.digest, true)).enabled).toBe(false);
		await expect(readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(
			await manager.uninstall("weather-helper", "approved-by-product", first.digest, false),
		).toMatchObject({
			id: "weather-helper",
			digest: first.digest,
			distribution: "legacy_runtime_extension",
			removed: true,
		});
		expect(await manager.list()).toEqual([]);
		await expect(readFile(join(root, "installed", "weather-helper", "state.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("binds enable and disable to the reviewed digest and enabled state", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-plugin-toggle-guards-"));
		roots.push(root);
		const manager = new ManagedPluginManager({
			pluginsRoot: join(root, "installed"),
			inboxRoot: join(root, "inbox"),
			approvalToken: "approved-by-product",
		});
		const draft = await manager.createDraft({
			draftId: "toggle-v1",
			manifest: manifest("1.0.0"),
			files: { "index.ts": "export default function () {}\n" },
		});
		await installReviewed(manager, draft, false);

		await expect(
			manager.enable("weather-helper", "approved-by-product", "0".repeat(64), false),
		).rejects.toMatchObject({ code: "PLUGIN_STATE_CHANGED" });
		await expect(manager.enable("weather-helper", "approved-by-product", draft.digest, true)).rejects.toMatchObject({
			code: "PLUGIN_STATE_CHANGED",
		});
		expect((await manager.enable("weather-helper", "approved-by-product", draft.digest, false)).enabled).toBe(true);
	});

	it("binds rollback to the reviewed active and target digests", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-plugin-guards-"));
		roots.push(root);
		const manager = new ManagedPluginManager({
			pluginsRoot: join(root, "installed"),
			inboxRoot: join(root, "inbox"),
			approvalToken: "approved-by-product",
		});
		const first = await manager.createDraft({
			draftId: "guarded-v1",
			manifest: manifest("1.0.0"),
			files: { "index.ts": "export default function () { return 'v1'; }\n" },
		});
		await installReviewed(manager, first, true);
		const second = await manager.createDraft({
			draftId: "guarded-v2",
			manifest: manifest("2.0.0"),
			files: { "index.ts": "export default function () { return 'v2'; }\n" },
		});
		await installReviewed(manager, second, true);

		await expect(
			manager.rollback("weather-helper", "approved-by-product", first.digest, first.digest),
		).rejects.toMatchObject({ code: "PLUGIN_STATE_CHANGED" });
		await expect(
			manager.rollback("weather-helper", "approved-by-product", second.digest, "0".repeat(64)),
		).rejects.toMatchObject({ code: "PLUGIN_STATE_CHANGED" });
		expect((await manager.list())[0]?.version).toBe("2.0.0");
	});

	it("requires and consumes a one-time Runtime Host install preview", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-plugin-preview-"));
		roots.push(root);
		const manager = new ManagedPluginManager({
			pluginsRoot: join(root, "installed"),
			inboxRoot: join(root, "inbox"),
			approvalToken: "approved-by-product",
		});
		const draft = await manager.createDraft({
			draftId: "preview-v1",
			manifest: manifest("1.0.0"),
			files: { "index.ts": "export default function () {}\n" },
		});
		await expect(
			manager.install({
				sourcePath: draft.sourcePath,
				expectedDigest: draft.digest,
				approvalToken: "approved-by-product",
				enable: true,
				confirmText: "apply",
			}),
		).rejects.toMatchObject({ code: "PLUGIN_PREVIEW_REQUIRED" });
		const preview = await manager.previewInstall({
			sourcePath: draft.sourcePath,
			expectedDigest: draft.digest,
			enable: true,
		});
		const request = {
			sourcePath: draft.sourcePath,
			expectedDigest: draft.digest,
			approvalToken: "approved-by-product",
			enable: true,
			previewToken: preview.previewToken,
			payloadSha256: preview.payloadSha256,
			confirmText: "apply",
		};
		await manager.install(request);
		await expect(manager.install(request)).rejects.toMatchObject({ code: "PLUGIN_PREVIEW_REQUIRED" });
	});

	it("serializes concurrent mutations and rejects the stale reviewed install", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-plugin-concurrency-"));
		roots.push(root);
		const manager = new ManagedPluginManager({
			pluginsRoot: join(root, "installed"),
			inboxRoot: join(root, "inbox"),
			approvalToken: "approved-by-product",
		});
		const first = await manager.createDraft({
			draftId: "concurrent-v1",
			manifest: manifest("1.0.0"),
			files: { "index.ts": "export default function () { return 'v1'; }\n" },
		});
		await installReviewed(manager, first, true);
		const [second, third] = await Promise.all([
			manager.createDraft({
				draftId: "concurrent-v2",
				manifest: manifest("2.0.0"),
				files: { "index.ts": "export default function () { return 'v2'; }\n" },
			}),
			manager.createDraft({
				draftId: "concurrent-v3",
				manifest: manifest("3.0.0"),
				files: { "index.ts": "export default function () { return 'v3'; }\n" },
			}),
		]);
		const [secondPreview, thirdPreview] = await Promise.all([
			manager.previewInstall({ sourcePath: second.sourcePath, expectedDigest: second.digest, enable: true }),
			manager.previewInstall({ sourcePath: third.sourcePath, expectedDigest: third.digest, enable: true }),
		]);
		const result = await Promise.allSettled([
			manager.install({
				sourcePath: second.sourcePath,
				expectedDigest: second.digest,
				approvalToken: "approved-by-product",
				enable: true,
				previewToken: secondPreview.previewToken,
				payloadSha256: secondPreview.payloadSha256,
				confirmText: "apply",
			}),
			manager.install({
				sourcePath: third.sourcePath,
				expectedDigest: third.digest,
				approvalToken: "approved-by-product",
				enable: true,
				previewToken: thirdPreview.previewToken,
				payloadSha256: thirdPreview.payloadSha256,
				confirmText: "apply",
			}),
		]);
		expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		const rejected = result.find((entry) => entry.status === "rejected");
		expect(rejected).toMatchObject({ reason: { code: "PLUGIN_STATE_CHANGED" } });
		expect((await manager.list())[0]?.installedVersions).toHaveLength(2);
	});
});
