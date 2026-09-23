import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativePiPackageManager } from "../src/native-package-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function packageJson(version: string) {
	return {
		name: "paw-context-helper",
		version,
		description: "Session context helper",
		pi: { skills: ["./skills"] },
		paw: { capabilities: ["session-workflow"] },
	};
}

function skill(version: string): string {
	return `---\nname: context-helper\ndescription: Session context helper ${version}\n---\n\nVersion ${version}.\n`;
}

async function createManager(root: string): Promise<NativePiPackageManager> {
	const manager = new NativePiPackageManager({
		agentDir: join(root, "agent"),
		inboxRoot: join(root, "inbox"),
		pluginsRoot: join(root, "plugins"),
		approvalToken: "approved-by-product",
	});
	await manager.initialize();
	return manager;
}

async function installReviewed(
	manager: NativePiPackageManager,
	prepared: Awaited<ReturnType<NativePiPackageManager["prepare"]>>,
	enable: boolean,
) {
	const preview = await manager.previewInstall({
		preparedPackageId: prepared.preparedPackageId,
		expectedDigest: prepared.digest,
		enable,
	});
	return manager.install({
		preparedPackageId: prepared.preparedPackageId,
		expectedDigest: prepared.digest,
		enable,
		approvalToken: "approved-by-product",
		previewToken: preview.previewToken,
		payloadSha256: preview.payloadSha256,
		confirmText: "apply",
	});
}

describe("native Pi Package lifecycle", () => {
	it("creates, prepares, installs and toggles a package through Pi settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-native-package-"));
		roots.push(root);
		const manager = await createManager(root);
		const draft = await manager.createDraft({
			draftId: "context-helper-v1",
			packageJson: packageJson("1.0.0"),
			files: { "skills/context-helper/SKILL.md": skill("1.0.0") },
		});
		const prepared = await manager.prepare(draft.sourcePath);
		expect(prepared).toMatchObject({
			manifest: { id: "paw-context-helper", version: "1.0.0", capabilities: ["session-workflow"] },
			resources: { skills: ["skills/context-helper/SKILL.md"] },
			capabilities: ["session-workflow"],
			installPreview: { operation: "install" },
		});

		const installed = await installReviewed(manager, prepared, true);
		expect(installed).toMatchObject({
			id: "paw-context-helper",
			version: "1.0.0",
			distribution: "pi_package",
			enabled: true,
			capabilities: ["session-workflow"],
		});
			expect(manager.hasEnabledCapability("session-workflow")).toBe(true);
			expect(installed.source).not.toBe(draft.sourcePath);
			expect(installed.source).toContain(join(root, "plugins", "packages"));

			await expect.poll(async () => JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8"))).toMatchObject({
				packages: [installed.source],
			});
			await writeFile(join(draft.sourcePath, "skills", "context-helper", "SKILL.md"), skill("mutated-draft"));
			expect(await readFile(join(installed.source, "skills", "context-helper", "SKILL.md"), "utf8")).toBe(
				skill("1.0.0"),
			);

		const disabled = await manager.setEnabled({
			packageId: installed.id,
			enabled: false,
			expectedActiveDigest: installed.digest,
			expectedEnabled: true,
			approvalToken: "approved-by-product",
		});
		expect(disabled.enabled).toBe(false);
		expect(manager.hasEnabledCapability("session-workflow")).toBe(false);
			await expect.poll(async () => JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8"))).toMatchObject({
				packages: [{ source: installed.source, autoload: false, skills: [] }],
		});

		expect(
			await manager.uninstall({
				packageId: installed.id,
				expectedActiveDigest: installed.digest,
				expectedEnabled: false,
				approvalToken: "approved-by-product",
			}),
		).toMatchObject({ id: installed.id, digest: installed.digest, distribution: "pi_package", removed: true });
		expect(await manager.list()).toEqual([]);
		await expect.poll(async () => JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8"))).toMatchObject({
			packages: [],
		});
	});

	it("requires a one-time reviewed install and preserves a verified rollback", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-native-package-review-"));
		roots.push(root);
		const manager = await createManager(root);
		const firstDraft = await manager.createDraft({
			draftId: "context-helper-v1",
			packageJson: packageJson("1.0.0"),
			files: { "skills/context-helper/SKILL.md": skill("1.0.0") },
		});
		const first = await manager.prepare(firstDraft.sourcePath);
		await installReviewed(manager, first, true);

		const secondDraft = await manager.createDraft({
			draftId: "context-helper-v2",
			packageJson: packageJson("2.0.0"),
			files: { "skills/context-helper/SKILL.md": skill("2.0.0") },
		});
		const second = await manager.prepare(secondDraft.sourcePath);
		const preview = await manager.previewInstall({
			preparedPackageId: second.preparedPackageId,
			expectedDigest: second.digest,
			enable: true,
		});
		const request = {
			preparedPackageId: second.preparedPackageId,
			expectedDigest: second.digest,
			enable: true,
			approvalToken: "approved-by-product",
			previewToken: preview.previewToken,
			payloadSha256: preview.payloadSha256,
			confirmText: "apply",
		};
		const installed = await manager.install(request);
		expect(installed.rollbackTarget).toMatchObject({ version: "1.0.0", digest: first.digest });
		await expect(manager.install(request)).rejects.toMatchObject({ code: "PLUGIN_PREPARE_REQUIRED" });

		const rolledBack = await manager.rollback({
			packageId: installed.id,
			expectedActiveDigest: installed.digest,
			targetDigest: first.digest,
			approvalToken: "approved-by-product",
		});
		expect(rolledBack).toMatchObject({ version: "1.0.0", digest: first.digest, enabled: true });
		expect(rolledBack.rollbackTarget).toBeUndefined();
	});
});
