import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { NativeInstalledPackage } from "./native-package-manager.ts";
import { RuntimeProtocolError } from "./protocol.ts";

const CATALOG_URL = new URL("../pi-packages/catalog.json", import.meta.url);
const SAFE_DIRECTORY = /^[a-z0-9][a-z0-9-]{0,63}$/u;

interface BundledCatalogManifest {
	schemaVersion: 1;
	packages: Array<{ directory: string; displayName: string }>;
}

interface BundledPackageManifest {
	name: string;
	version: string;
	description?: string;
	paw?: { capabilities?: string[] };
}

export interface BundledPiPackage {
	id: string;
	name: string;
	displayName: string;
	version: string;
	description?: string;
	capabilities: string[];
	source: string;
	distribution: "pi_package";
	bundled: true;
	installed: boolean;
	enabled: boolean;
	installedVersion?: string;
	installedDigest?: string;
}

function requireCatalog(value: unknown): BundledCatalogManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_BUNDLED_PACKAGE_CATALOG", "Bundled Package catalog must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || !Array.isArray(record.packages)) {
		throw new RuntimeProtocolError("INVALID_BUNDLED_PACKAGE_CATALOG", "Bundled Package catalog schema is invalid");
	}
	for (const entry of record.packages) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new RuntimeProtocolError("INVALID_BUNDLED_PACKAGE_CATALOG", "Bundled Package entry is invalid");
		}
		const item = entry as Record<string, unknown>;
		if (
			typeof item.directory !== "string" ||
			!SAFE_DIRECTORY.test(item.directory) ||
			typeof item.displayName !== "string" ||
			!item.displayName.trim()
		) {
			throw new RuntimeProtocolError("INVALID_BUNDLED_PACKAGE_CATALOG", "Bundled Package entry is invalid");
		}
	}
	return value as BundledCatalogManifest;
}

function requirePackageManifest(value: unknown, directory: string): BundledPackageManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError(
			"INVALID_BUNDLED_PACKAGE_CATALOG",
			`Bundled Package ${directory} has an invalid package.json`,
		);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name || typeof record.version !== "string" || !record.version) {
		throw new RuntimeProtocolError(
			"INVALID_BUNDLED_PACKAGE_CATALOG",
			`Bundled Package ${directory} is missing name or version`,
		);
	}
	const paw = record.paw;
	const capabilities =
		paw && typeof paw === "object" && !Array.isArray(paw)
			? (paw as Record<string, unknown>).capabilities
			: undefined;
	if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string"))) {
		throw new RuntimeProtocolError(
			"INVALID_BUNDLED_PACKAGE_CATALOG",
			`Bundled Package ${directory} has invalid capabilities`,
		);
	}
	return value as BundledPackageManifest;
}

export async function listBundledPiPackages(
	installedPackages: readonly NativeInstalledPackage[] = [],
): Promise<BundledPiPackage[]> {
	const catalog = requireCatalog(JSON.parse(await readFile(CATALOG_URL, "utf8")));
	const catalogRoot = fileURLToPath(new URL("../pi-packages/", import.meta.url));
	const installedById = new Map(installedPackages.map((item) => [item.id, item]));
	const result = await Promise.all(
		catalog.packages.map(async (entry): Promise<BundledPiPackage> => {
			const source = await realpath(join(catalogRoot, entry.directory));
			const manifest = requirePackageManifest(
				JSON.parse(await readFile(join(source, "package.json"), "utf8")),
				entry.directory,
			);
			const installed = installedById.get(manifest.name);
			return {
				id: manifest.name,
				name: manifest.name,
				displayName: entry.displayName,
				version: manifest.version,
				...(manifest.description ? { description: manifest.description } : {}),
				capabilities: [...new Set(manifest.paw?.capabilities ?? [])].sort(),
				source,
				distribution: "pi_package",
				bundled: true,
				installed: Boolean(installed),
				enabled: installed?.enabled ?? false,
				...(installed ? { installedVersion: installed.version, installedDigest: installed.digest } : {}),
			};
		}),
	);
	return result.sort((left, right) => left.id.localeCompare(right.id));
}
