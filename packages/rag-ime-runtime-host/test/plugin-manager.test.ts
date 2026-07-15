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
		await manager.install({
			sourcePath: second.sourcePath,
			expectedDigest: second.digest,
			approvalToken: "approved-by-product",
			enable: true,
		});
		const rolledBack = await manager.rollback("weather-helper", "approved-by-product");
		expect(rolledBack.version).toBe("1.0.0");
		expect(await readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).toContain(first.digest);
		expect((await manager.disable("weather-helper", "approved-by-product")).enabled).toBe(false);
		await expect(readFile(join(root, "installed", "active", "weather-helper.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
