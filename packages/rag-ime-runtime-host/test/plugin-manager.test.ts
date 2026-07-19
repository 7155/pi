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
		await expect(
			manager.install({ sourcePath: first.sourcePath, expectedDigest: first.digest, approvalToken: "wrong" }),
		).rejects.toMatchObject({ code: "PLUGIN_APPROVAL_REQUIRED" });

		const installed = await manager.install({
			sourcePath: first.sourcePath,
			expectedDigest: first.digest,
			approvalToken: "approved-by-product",
			enable: true,
		});
		expect(installed).toMatchObject({ id: "weather-helper", version: "1.0.0", enabled: true });

		const second = await manager.createDraft({
			draftId: "weather-v2",
			manifest: manifest("2.0.0"),
			files: { "index.ts": "export default function () { return 'v2'; }\n" },
		});
		const secondInstall = await manager.install({
			sourcePath: second.sourcePath,
			expectedDigest: second.digest,
			approvalToken: "approved-by-product",
			enable: true,
		});
		expect(secondInstall.rollbackTarget).toMatchObject({ version: "1.0.0", digest: first.digest });
		const rolledBack = await manager.rollback("weather-helper", "approved-by-product", second.digest, first.digest);
		expect(rolledBack.version).toBe("1.0.0");
		expect(rolledBack.rollbackTarget).toBeUndefined();
		expect(await readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).toContain(first.digest);
		expect((await manager.disable("weather-helper", "approved-by-product")).enabled).toBe(false);
		await expect(readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
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
		await manager.install({
			sourcePath: first.sourcePath,
			expectedDigest: first.digest,
			approvalToken: "approved-by-product",
			enable: true,
		});
		const second = await manager.createDraft({
			draftId: "guarded-v2",
			manifest: manifest("2.0.0"),
			files: { "index.ts": "export default function () { return 'v2'; }\n" },
		});
		await manager.install({
			sourcePath: second.sourcePath,
			expectedDigest: second.digest,
			approvalToken: "approved-by-product",
			enable: true,
		});

		await expect(
			manager.rollback("weather-helper", "approved-by-product", first.digest, first.digest),
		).rejects.toMatchObject({ code: "PLUGIN_STATE_CHANGED" });
		await expect(
			manager.rollback("weather-helper", "approved-by-product", second.digest, "0".repeat(64)),
		).rejects.toMatchObject({ code: "PLUGIN_STATE_CHANGED" });
		expect((await manager.list())[0]?.version).toBe("2.0.0");
	});
});
