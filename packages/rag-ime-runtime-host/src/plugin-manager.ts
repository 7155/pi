import { createHash, timingSafeEqual } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RuntimeProtocolError } from "./protocol.ts";

const MANIFEST_FILE = "rag-ime-plugin.json";
const MANIFEST_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const MAX_PLUGIN_FILES = 256;
const MAX_PLUGIN_BYTES = 5 * 1024 * 1024;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_SOURCE_FILE_PATTERN = /\.(?:ts|js|mjs|json|md)$/;

export interface PluginManifest {
	schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
	id: string;
	name: string;
	version: string;
	description?: string;
	entry: string;
	permissions?: string[];
}

export interface PluginValidation {
	manifest: PluginManifest;
	digest: string;
	files: string[];
	totalBytes: number;
	installPreview: {
		operation: "install" | "replace" | "noop";
		enabledAfterInstall: boolean;
	};
}

interface PluginInstallRecord {
	manifest: PluginManifest;
	digest: string;
	directory: string;
	installedAt: string;
}

interface PluginState {
	schemaVersion: typeof STATE_SCHEMA_VERSION;
	id: string;
	enabled: boolean;
	activeDigest?: string;
	installs: PluginInstallRecord[];
	/** Previous active versions in activation order, newest last. */
	activationHistory?: string[];
}

export interface InstalledPlugin {
	id: string;
	name: string;
	version: string;
	description?: string;
	permissions: string[];
	digest: string;
	enabled: boolean;
	installedVersions: Array<{ version: string; digest: string; installedAt: string }>;
	rollbackTarget?: { version: string; digest: string; installedAt: string };
}

interface ScannedPlugin {
	validation: PluginValidation;
	sourceRoot: string;
}

export interface PluginManagerOptions {
	pluginsRoot: string;
	inboxRoot: string;
	approvalToken?: string;
}

export interface PluginDraftInput {
	draftId: string;
	manifest: unknown;
	files: Record<string, string>;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function requireString(record: Record<string, unknown>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", `${name} must be a non-empty string`);
	}
	return value;
}

function parseManifest(value: unknown): PluginManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", "Plugin manifest must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new RuntimeProtocolError(
			"INVALID_PLUGIN_MANIFEST",
			`Plugin schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`,
		);
	}
	const id = requireString(record, "id");
	if (!PLUGIN_ID_PATTERN.test(id)) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", `Invalid plugin id: ${id}`);
	}
	const version = requireString(record, "version");
	if (!VERSION_PATTERN.test(version)) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", `Invalid plugin version: ${version}`);
	}
	const entry = requireString(record, "entry");
	if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..") || !/\.(?:ts|js|mjs)$/.test(entry)) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", "entry must be a relative TypeScript/JavaScript file");
	}
	const permissions = record.permissions;
	if (
		permissions !== undefined &&
		(!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string"))
	) {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", "permissions must be an array of strings");
	}
	const description = record.description;
	if (description !== undefined && typeof description !== "string") {
		throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", "description must be a string");
	}
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		id,
		name: requireString(record, "name"),
		version,
		description,
		entry,
		permissions: permissions as string[] | undefined,
	};
}

function rollbackRecord(state: PluginState): PluginInstallRecord | undefined {
	const history = state.activationHistory ?? [];
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const digest = history[index];
		const record = state.installs.find(
			(candidate) => candidate.digest === digest && candidate.digest !== state.activeDigest,
		);
		if (record) return record;
	}
	// Legacy v1 state did not persist activation history. Use its immutable
	// install order once, then the first guarded rollback writes an empty
	// history instead of allowing version toggling.
	if (state.activationHistory === undefined) {
		return [...state.installs].reverse().find((record) => record.digest !== state.activeDigest);
	}
	return undefined;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

export class ManagedPluginManager {
	readonly pluginsRoot: string;
	readonly inboxRoot: string;
	readonly activeDir: string;
	private readonly approvalToken?: string;

	constructor(options: PluginManagerOptions) {
		this.pluginsRoot = resolve(options.pluginsRoot);
		this.inboxRoot = resolve(options.inboxRoot);
		this.activeDir = join(this.pluginsRoot, "active");
		this.approvalToken = options.approvalToken;
	}

	async initialize(): Promise<void> {
		await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 });
		await mkdir(this.inboxRoot, { recursive: true, mode: 0o700 });
		await mkdir(this.activeDir, { recursive: true, mode: 0o700 });
	}

	private requireApproval(token: string | undefined): void {
		if (!this.approvalToken) {
			throw new RuntimeProtocolError(
				"PLUGIN_MUTATION_DISABLED",
				"Plugin mutation is disabled until the product approval token is configured",
			);
		}
		if (!token) {
			throw new RuntimeProtocolError("PLUGIN_APPROVAL_REQUIRED", "Product approval token is required");
		}
		const expected = Buffer.from(this.approvalToken);
		const actual = Buffer.from(token);
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
			throw new RuntimeProtocolError("PLUGIN_APPROVAL_REQUIRED", "Product approval token is invalid");
		}
	}

	private async scan(sourcePath: string, requireInboxBoundary: boolean): Promise<ScannedPlugin> {
		let sourceRoot: string;
		try {
			sourceRoot = await realpath(resolve(sourcePath));
		} catch {
			throw new RuntimeProtocolError("PLUGIN_SOURCE_NOT_FOUND", `Plugin source does not exist: ${sourcePath}`);
		}
		if (requireInboxBoundary) {
			const inbox = await realpath(this.inboxRoot);
			if (!isInside(inbox, sourceRoot)) {
				throw new RuntimeProtocolError("PLUGIN_PATH_BOUNDARY", "Plugin source must be inside the managed inbox");
			}
		}
		if (!(await stat(sourceRoot)).isDirectory()) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_SOURCE", "Plugin source must be a directory");
		}

		const files: string[] = [];
		let totalBytes = 0;
		const visit = async (directory: string): Promise<void> => {
			const entries = await readdir(directory, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const absolute = join(directory, entry.name);
				const info = await lstat(absolute);
				if (info.isSymbolicLink()) {
					throw new RuntimeProtocolError("INVALID_PLUGIN_SOURCE", `Symbolic links are not allowed: ${entry.name}`);
				}
				if (info.isDirectory()) {
					await visit(absolute);
					continue;
				}
				if (!info.isFile()) {
					throw new RuntimeProtocolError("INVALID_PLUGIN_SOURCE", `Unsupported file type: ${entry.name}`);
				}
				const file = relative(sourceRoot, absolute).split(sep).join("/");
				files.push(file);
				totalBytes += info.size;
				if (files.length > MAX_PLUGIN_FILES || totalBytes > MAX_PLUGIN_BYTES) {
					throw new RuntimeProtocolError(
						"PLUGIN_LIMIT_EXCEEDED",
						`Plugin exceeds ${MAX_PLUGIN_FILES} files or ${MAX_PLUGIN_BYTES} bytes`,
					);
				}
			}
		};
		await visit(sourceRoot);

		if (!files.includes(MANIFEST_FILE)) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", `Missing ${MANIFEST_FILE}`);
		}
		let manifestValue: unknown;
		try {
			manifestValue = JSON.parse(await readFile(join(sourceRoot, MANIFEST_FILE), "utf8"));
		} catch (error) {
			throw new RuntimeProtocolError(
				"INVALID_PLUGIN_MANIFEST",
				`Cannot parse ${MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const manifest = parseManifest(manifestValue);
		const entryPath = resolve(sourceRoot, manifest.entry);
		if (!isInside(sourceRoot, entryPath) || !files.includes(relative(sourceRoot, entryPath).split(sep).join("/"))) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_MANIFEST", `Plugin entry does not exist: ${manifest.entry}`);
		}

		const hash = createHash("sha256");
		for (const file of files) {
			hash.update(file);
			hash.update("\0");
			hash.update(await readFile(join(sourceRoot, file)));
			hash.update("\0");
		}
		const digest = hash.digest("hex");
		const existing = await this.readState(manifest.id);
		const installed = existing?.installs.some((record) => record.digest === digest) ?? false;
		return {
			sourceRoot,
			validation: {
				manifest,
				digest,
				files,
				totalBytes,
				installPreview: {
					operation: installed ? "noop" : existing ? "replace" : "install",
					enabledAfterInstall: existing?.enabled ?? false,
				},
			},
		};
	}

	async validate(sourcePath: string): Promise<PluginValidation> {
		return (await this.scan(sourcePath, true)).validation;
	}

	async createDraft(input: PluginDraftInput): Promise<PluginValidation & { sourcePath: string }> {
		await this.initialize();
		if (!DRAFT_ID_PATTERN.test(input.draftId)) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", "draftId must be a safe lowercase identifier");
		}
		const manifest = parseManifest(input.manifest);
		if (typeof input.files !== "object" || input.files === null || Array.isArray(input.files)) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", "files must be an object of UTF-8 source files");
		}
		const files = Object.entries(input.files);
		if (files.length === 0 || files.length > MAX_PLUGIN_FILES) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", "files must contain between 1 and 256 entries");
		}
		const draftRoot = join(this.inboxRoot, input.draftId);
		try {
			await stat(draftRoot);
			throw new RuntimeProtocolError("PLUGIN_DRAFT_EXISTS", `Plugin draft already exists: ${input.draftId}`);
		} catch (error) {
			if (error instanceof RuntimeProtocolError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temporary = join(this.inboxRoot, `.${input.draftId}.${process.pid}.${Date.now()}.tmp`);
		let totalBytes = 0;
		await mkdir(temporary, { recursive: false, mode: 0o700 });
		try {
			for (const [file, content] of files) {
				const normalized = file.split("\\").join("/");
				const target = resolve(temporary, normalized);
				if (
					file !== normalized ||
					isAbsolute(normalized) ||
					normalized.split("/").some((part) => !part || part === "." || part === "..") ||
					!SAFE_SOURCE_FILE_PATTERN.test(normalized) ||
					!isInside(temporary, target) ||
					typeof content !== "string"
				) {
					throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", `Unsafe plugin source file: ${file}`);
				}
				const bytes = Buffer.byteLength(content, "utf8");
				totalBytes += bytes;
				if (totalBytes > MAX_PLUGIN_BYTES) {
					throw new RuntimeProtocolError("PLUGIN_LIMIT_EXCEEDED", `Plugin exceeds ${MAX_PLUGIN_BYTES} bytes`);
				}
				await mkdir(dirname(target), { recursive: true, mode: 0o700 });
				await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			}
			await writeFile(join(temporary, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			const scanned = await this.scan(temporary, false);
			await rename(temporary, draftRoot);
			return { ...scanned.validation, sourcePath: draftRoot };
		} catch (error) {
			await rm(temporary, { recursive: true, force: true });
			throw error;
		}
	}

	private statePath(pluginId: string): string {
		return join(this.pluginsRoot, pluginId, "state.json");
	}

	private async readState(pluginId: string): Promise<PluginState | undefined> {
		try {
			return JSON.parse(await readFile(this.statePath(pluginId), "utf8")) as PluginState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async writeState(state: PluginState): Promise<void> {
		await atomicWrite(this.statePath(state.id), `${JSON.stringify(state, null, 2)}\n`);
	}

	private async syncActiveEntry(state: PluginState): Promise<void> {
		const shimPath = join(this.activeDir, `${state.id}.ts`);
		if (!state.enabled || !state.activeDigest) {
			await rm(shimPath, { force: true });
			return;
		}
		const active = state.installs.find((record) => record.digest === state.activeDigest);
		if (!active) throw new Error(`Active plugin record is missing: ${state.id}/${state.activeDigest}`);
		const entry = join(this.pluginsRoot, state.id, "versions", active.directory, active.manifest.entry);
		let modulePath = relative(this.activeDir, entry).split(sep).join("/");
		if (!modulePath.startsWith(".")) modulePath = `./${modulePath}`;
		await atomicWrite(shimPath, `export { default } from ${JSON.stringify(modulePath)};\n`);
	}

	async list(): Promise<InstalledPlugin[]> {
		await this.initialize();
		const directories = await readdir(this.pluginsRoot, { withFileTypes: true });
		const result: InstalledPlugin[] = [];
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.name === "active") continue;
			const state = await this.readState(directory.name);
			if (!state?.activeDigest) continue;
			const active = state.installs.find((record) => record.digest === state.activeDigest);
			if (!active) continue;
			const rollback = rollbackRecord(state);
			result.push({
				id: state.id,
				name: active.manifest.name,
				version: active.manifest.version,
				description: active.manifest.description,
				permissions: [...(active.manifest.permissions ?? [])],
				digest: active.digest,
				enabled: state.enabled,
				installedVersions: state.installs.map((record) => ({
					version: record.manifest.version,
					digest: record.digest,
					installedAt: record.installedAt,
				})),
				rollbackTarget: rollback
					? {
							version: rollback.manifest.version,
							digest: rollback.digest,
							installedAt: rollback.installedAt,
						}
					: undefined,
			});
		}
		return result.sort((left, right) => left.id.localeCompare(right.id));
	}

	async install(options: {
		sourcePath: string;
		expectedDigest: string;
		approvalToken?: string;
		enable?: boolean;
	}): Promise<InstalledPlugin> {
		this.requireApproval(options.approvalToken);
		const scanned = await this.scan(options.sourcePath, true);
		if (scanned.validation.digest !== options.expectedDigest) {
			throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Plugin changed after validation", {
				expected: options.expectedDigest,
				actual: scanned.validation.digest,
			});
		}
		const { manifest, digest, files } = scanned.validation;
		const versionsDir = join(this.pluginsRoot, manifest.id, "versions");
		await mkdir(versionsDir, { recursive: true, mode: 0o700 });
		const directory = `${manifest.version}-${digest}`;
		const destination = join(versionsDir, directory);
		const temporary = join(versionsDir, `.${directory}.${process.pid}.${Date.now()}.tmp`);
		let destinationExists = false;
		try {
			destinationExists = (await stat(destination)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!destinationExists) {
			await mkdir(temporary, { recursive: true, mode: 0o700 });
			try {
				for (const file of files) {
					const target = join(temporary, file);
					await mkdir(dirname(target), { recursive: true, mode: 0o700 });
					await copyFile(join(scanned.sourceRoot, file), target);
				}
				const copied = await this.scan(temporary, false);
				if (copied.validation.digest !== digest) {
					throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Plugin changed while being installed");
				}
				await rename(temporary, destination);
			} catch (error) {
				await rm(temporary, { recursive: true, force: true });
				throw error;
			}
		}

		const previous = await this.readState(manifest.id);
		const installs = previous?.installs.filter((record) => record.digest !== digest) ?? [];
		installs.push({ manifest, digest, directory, installedAt: new Date().toISOString() });
		const activationHistory = [...(previous?.activationHistory ?? [])];
		if (
			previous?.activeDigest &&
			previous.activeDigest !== digest &&
			activationHistory.at(-1) !== previous.activeDigest
		) {
			activationHistory.push(previous.activeDigest);
		}
		const state: PluginState = {
			schemaVersion: STATE_SCHEMA_VERSION,
			id: manifest.id,
			enabled: options.enable ?? previous?.enabled ?? false,
			activeDigest: digest,
			installs,
			activationHistory,
		};
		await this.writeState(state);
		await this.syncActiveEntry(state);
		return (await this.list()).find((plugin) => plugin.id === manifest.id)!;
	}

	private async mutate(
		pluginId: string,
		approvalToken: string | undefined,
		change: (state: PluginState) => void,
	): Promise<InstalledPlugin> {
		this.requireApproval(approvalToken);
		if (!PLUGIN_ID_PATTERN.test(pluginId)) {
			throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Invalid plugin id: ${pluginId}`);
		}
		const state = await this.readState(pluginId);
		if (!state) throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Plugin is not installed: ${pluginId}`);
		change(state);
		await this.writeState(state);
		await this.syncActiveEntry(state);
		return (await this.list()).find((plugin) => plugin.id === pluginId)!;
	}

	async enable(pluginId: string, approvalToken?: string): Promise<InstalledPlugin> {
		return this.mutate(pluginId, approvalToken, (state) => {
			if (!state.activeDigest)
				throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Plugin has no install: ${pluginId}`);
			state.enabled = true;
		});
	}

	async disable(pluginId: string, approvalToken?: string): Promise<InstalledPlugin> {
		return this.mutate(pluginId, approvalToken, (state) => {
			state.enabled = false;
		});
	}

	async rollback(
		pluginId: string,
		approvalToken: string | undefined,
		expectedActiveDigest: string | undefined,
		targetDigest: string | undefined,
	): Promise<InstalledPlugin> {
		return this.mutate(pluginId, approvalToken, (state) => {
			if (!expectedActiveDigest || !targetDigest) {
				throw new RuntimeProtocolError(
					"PLUGIN_ROLLBACK_GUARD_REQUIRED",
					"Rollback requires the reviewed active and target digests",
				);
			}
			if (state.activeDigest !== expectedActiveDigest) {
				throw new RuntimeProtocolError(
					"PLUGIN_STATE_CHANGED",
					"Plugin active version changed after rollback preview",
					{ expected: expectedActiveDigest, actual: state.activeDigest },
				);
			}
			const previous = rollbackRecord(state);
			if (!previous) {
				throw new RuntimeProtocolError(
					"PLUGIN_ROLLBACK_UNAVAILABLE",
					`No previous install for plugin: ${pluginId}`,
				);
			}
			if (previous.digest !== targetDigest) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Plugin rollback target changed after preview", {
					expected: targetDigest,
					actual: previous.digest,
				});
			}
			state.activeDigest = previous.digest;
			state.activationHistory = [...(state.activationHistory ?? [])];
			while (state.activationHistory.at(-1) === previous.digest) {
				state.activationHistory.pop();
			}
		});
	}
}
