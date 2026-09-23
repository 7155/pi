import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	DefaultPackageManager,
	type PackageSource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { RuntimeProtocolError } from "./protocol.ts";

const PACKAGE_STATE_SCHEMA_VERSION = 1;
const PREPARED_PACKAGE_TTL_MS = 15 * 60 * 1000;
const INSTALL_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PACKAGE_FILES = 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const DRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_DRAFT_FILE_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|svg)$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

type ResourceKind = "extensions" | "skills" | "prompts" | "themes";

interface NativePackageResources {
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
}

interface NativePackageInstallRecord {
	name: string;
	version: string;
	description?: string;
	digest: string;
	source: string;
	installedAt: string;
	resources: NativePackageResources;
	capabilities?: string[];
}

interface NativePackageState {
	id: string;
	enabled: boolean;
	active: NativePackageInstallRecord;
	history: NativePackageInstallRecord[];
}

interface NativePackageStateFile {
	schemaVersion: typeof PACKAGE_STATE_SCHEMA_VERSION;
	packages: NativePackageState[];
}

interface PreparedPackage {
	preparedPackageId: string;
	packageRoot: string;
	name: string;
	version: string;
	description?: string;
	digest: string;
	source: string;
	files: string[];
	totalBytes: number;
	resources: NativePackageResources;
	capabilities: string[];
	expiresAtMs: number;
}

interface NativeInstallPreviewRecord {
	preparedPackageId: string;
	packageId: string;
	expectedDigest: string;
	enable: boolean;
	expectedActiveDigest?: string;
	expectedEnabled?: boolean;
	payloadSha256: string;
	expiresAtMs: number;
}

export interface NativePackageValidation {
	preparedPackageId: string;
	manifest: {
		schemaVersion: 1;
		id: string;
		name: string;
		version: string;
		description?: string;
		entry: string;
		permissions: string[];
		capabilities: string[];
	};
	digest: string;
	files: string[];
	totalBytes: number;
	resources: NativePackageResources;
	capabilities: string[];
	source: { kind: "local" | "npm" | "git"; requested: string; resolved: string };
	installPreview: { operation: "install" | "replace" | "noop"; enabledAfterInstall: boolean };
}

export interface NativeInstalledPackage {
	id: string;
	name: string;
	version: string;
	description?: string;
	permissions: string[];
	digest: string;
	enabled: boolean;
	distribution: "pi_package";
	source: string;
	resources: NativePackageResources;
	capabilities: string[];
	installedVersions: Array<{ version: string; digest: string; installedAt: string; source: string }>;
	rollbackTarget?: { version: string; digest: string; installedAt: string; source: string };
}

export interface NativeRemovedPackage {
	id: string;
	digest: string;
	distribution: "pi_package";
	removed: true;
}

export interface NativePackageManagerOptions {
	agentDir: string;
	inboxRoot: string;
	pluginsRoot: string;
	approvalToken?: string;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function sourceKind(source: string): "local" | "npm" | "git" {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:") || source.startsWith("git+") || source.includes("github.com")) return "git";
	return "local";
}

function packageSourceValue(value: PackageSource): string {
	return typeof value === "string" ? value : value.source;
}

function disabledPackageSource(source: string): PackageSource {
	return { source, autoload: false, extensions: [], skills: [], prompts: [], themes: [] };
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

function requirePackageJson(value: unknown): {
	name: string;
	version: string;
	description?: string;
	pi: Partial<Record<ResourceKind, string[]>>;
	capabilities: string[];
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json must be an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name.trim()) {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json name is required");
	}
	if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(record.version)) {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json version must be semantic");
	}
	if (record.description !== undefined && typeof record.description !== "string") {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json description must be a string");
	}
	if (typeof record.pi !== "object" || record.pi === null || Array.isArray(record.pi)) {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json must contain a Pi resource manifest");
	}
	const piRecord = record.pi as Record<string, unknown>;
	const pi: Partial<Record<ResourceKind, string[]>> = {};
	let resources = 0;
	for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
		const entries = piRecord[kind];
		if (entries === undefined) continue;
		if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
			throw new RuntimeProtocolError("INVALID_PI_PACKAGE", `package.json pi.${kind} must be an array of paths`);
		}
		pi[kind] = entries as string[];
		resources += entries.length;
	}
	if (resources === 0) {
		throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "Pi Package must declare at least one resource");
	}
	let capabilities: string[] = [];
	if (record.paw !== undefined) {
		if (typeof record.paw !== "object" || record.paw === null || Array.isArray(record.paw)) {
			throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "package.json paw metadata must be an object");
		}
		const declared = (record.paw as Record<string, unknown>).capabilities;
		if (
			declared !== undefined &&
			(!Array.isArray(declared) ||
				declared.some((capability) => typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)))
		) {
			throw new RuntimeProtocolError(
				"INVALID_PI_PACKAGE",
				"package.json paw.capabilities must be an array of lowercase capability names",
			);
		}
		capabilities = [...new Set((declared as string[] | undefined) ?? [])].sort();
	}
	return {
		name: record.name,
		version: record.version,
		description: record.description as string | undefined,
		pi,
		capabilities,
	};
}

export class NativePiPackageManager {
	private readonly agentDir: string;
	private readonly inboxRoot: string;
	private readonly statePath: string;
	private readonly managedPackagesRoot: string;
	private readonly approvalToken?: string;
	private readonly settingsManager: SettingsManager;
	private readonly packageManager: DefaultPackageManager;
	private readonly prepared = new Map<string, PreparedPackage>();
	private readonly previews = new Map<string, NativeInstallPreviewRecord>();
	private readonly mutationTails = new Map<string, Promise<void>>();
	private enabledCapabilities = new Set<string>();

	constructor(options: NativePackageManagerOptions) {
		this.agentDir = resolve(options.agentDir);
		this.inboxRoot = resolve(options.inboxRoot);
		const pluginsRoot = resolve(options.pluginsRoot);
		this.statePath = join(pluginsRoot, "native-packages.json");
		this.managedPackagesRoot = join(pluginsRoot, "packages");
		this.approvalToken = options.approvalToken;
		this.settingsManager = SettingsManager.create(this.agentDir, this.agentDir, { projectTrusted: true });
		this.packageManager = new DefaultPackageManager({
			cwd: this.agentDir,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.agentDir, { recursive: true, mode: 0o700 }),
			mkdir(this.inboxRoot, { recursive: true, mode: 0o700 }),
			mkdir(this.managedPackagesRoot, { recursive: true, mode: 0o700 }),
			mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 }),
		]);
		this.refreshEnabledCapabilities(await this.readState());
	}

	private refreshEnabledCapabilities(state: NativePackageStateFile): void {
		this.enabledCapabilities = new Set(
			state.packages.flatMap((entry) => (entry.enabled ? (entry.active.capabilities ?? []) : [])),
		);
	}

	hasEnabledCapability(capability: string): boolean {
		return this.enabledCapabilities.has(capability);
	}

	private requireApproval(token: string | undefined): void {
		if (!this.approvalToken) {
			throw new RuntimeProtocolError(
				"PLUGIN_MUTATION_DISABLED",
				"Plugin mutation is disabled until the product approval token is configured",
			);
		}
		if (!token) throw new RuntimeProtocolError("PLUGIN_APPROVAL_REQUIRED", "Product approval token is required");
		const expected = Buffer.from(this.approvalToken);
		const actual = Buffer.from(token);
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
			throw new RuntimeProtocolError("PLUGIN_APPROVAL_REQUIRED", "Product approval token is invalid");
		}
	}

	private async withMutation<T>(packageId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.mutationTails.get(packageId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const tail = previous.catch(() => undefined).then(() => gate);
		this.mutationTails.set(packageId, tail);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.mutationTails.get(packageId) === tail) this.mutationTails.delete(packageId);
		}
	}

	private prune(nowMs = Date.now()): void {
		for (const [id, value] of this.prepared) if (value.expiresAtMs <= nowMs) this.prepared.delete(id);
		for (const [id, value] of this.previews) if (value.expiresAtMs <= nowMs) this.previews.delete(id);
	}

	private async readState(): Promise<NativePackageStateFile> {
		try {
			const value = JSON.parse(await readFile(this.statePath, "utf8")) as NativePackageStateFile;
			if (value.schemaVersion !== PACKAGE_STATE_SCHEMA_VERSION || !Array.isArray(value.packages)) {
				throw new RuntimeProtocolError("INVALID_PLUGIN_STATE", "Native Pi Package state is invalid");
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { schemaVersion: PACKAGE_STATE_SCHEMA_VERSION, packages: [] };
			}
			throw error;
		}
	}

	private async writeState(state: NativePackageStateFile): Promise<void> {
		await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
		this.refreshEnabledCapabilities(state);
	}

	private async scanPackage(source: string): Promise<PreparedPackage> {
		const paths = await this.packageManager.resolveExtensionSources([source], { temporary: true });
		const byKind = {
			extensions: paths.extensions,
			skills: paths.skills,
			prompts: paths.prompts,
			themes: paths.themes,
		};
		const all = Object.values(byKind).flat();
		if (all.length === 0) {
			throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "Pi Package did not resolve any resources");
		}
		const roots = new Set(all.map((entry) => entry.metadata.baseDir).filter((value): value is string => Boolean(value)));
		if (roots.size !== 1) {
			throw new RuntimeProtocolError("INVALID_PI_PACKAGE", "Pi Package resources must resolve from one package root");
		}
		const packageRoot = await realpath([...roots][0]!);
		let packageJson: ReturnType<typeof requirePackageJson>;
		try {
			packageJson = requirePackageJson(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
		} catch (error) {
			if (error instanceof RuntimeProtocolError) throw error;
			throw new RuntimeProtocolError(
				"INVALID_PI_PACKAGE",
				`Cannot read Pi Package manifest: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const files: string[] = [];
		let totalBytes = 0;
		const visit = async (directory: string): Promise<void> => {
			const entries = await readdir(directory, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const absolute = join(directory, entry.name);
				const info = await lstat(absolute);
				if (info.isSymbolicLink()) {
					throw new RuntimeProtocolError("INVALID_PI_PACKAGE", `Symbolic links are not allowed: ${entry.name}`);
				}
				if (info.isDirectory()) {
					await visit(absolute);
					continue;
				}
				if (!info.isFile()) throw new RuntimeProtocolError("INVALID_PI_PACKAGE", `Unsupported file: ${entry.name}`);
				files.push(relative(packageRoot, absolute).split(sep).join("/"));
				totalBytes += info.size;
				if (files.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
					throw new RuntimeProtocolError(
						"PLUGIN_LIMIT_EXCEEDED",
						`Pi Package exceeds ${MAX_PACKAGE_FILES} files or ${MAX_PACKAGE_BYTES} bytes`,
					);
				}
			}
		};
		await visit(packageRoot);
		const hash = createHash("sha256");
		for (const file of files) {
			hash.update(file);
			hash.update("\0");
			hash.update(await readFile(join(packageRoot, file)));
			hash.update("\0");
		}
		const resources = {} as NativePackageResources;
		for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
			resources[kind] = await Promise.all(byKind[kind].map(async (entry) => {
				// macOS exposes /var through /private/var. Compare canonical paths so a
				// harmless system path alias is not mistaken for a package escape.
				const absolute = await realpath(resolve(entry.path));
				if (!isInside(packageRoot, absolute)) {
					throw new RuntimeProtocolError("INVALID_PI_PACKAGE", `Resolved ${kind} resource escapes the package root`);
				}
				return relative(packageRoot, absolute).split(sep).join("/");
			}));
		}
		return {
			preparedPackageId: randomUUID(),
			packageRoot,
			name: packageJson.name,
			version: packageJson.version,
			description: packageJson.description,
			digest: hash.digest("hex"),
			source,
			files,
			totalBytes,
			resources,
			capabilities: packageJson.capabilities,
			expiresAtMs: Date.now() + PREPARED_PACKAGE_TTL_MS,
		};
	}

	private publicValidation(prepared: PreparedPackage, state?: NativePackageState): NativePackageValidation {
		const entry = prepared.resources.extensions[0] ?? "";
		return {
			preparedPackageId: prepared.preparedPackageId,
			manifest: {
				schemaVersion: 1,
				id: prepared.name,
				name: prepared.name,
				version: prepared.version,
				description: prepared.description,
				entry,
				permissions: [],
				capabilities: [...prepared.capabilities],
			},
			digest: prepared.digest,
			files: [...prepared.files],
			totalBytes: prepared.totalBytes,
			resources: structuredClone(prepared.resources),
			capabilities: [...prepared.capabilities],
			source: { kind: sourceKind(prepared.source), requested: prepared.source, resolved: prepared.source },
			installPreview: {
				operation: state?.active.digest === prepared.digest ? "noop" : state ? "replace" : "install",
				enabledAfterInstall: state?.enabled ?? false,
			},
		};
	}

	async createDraft(input: {
		draftId: string;
		packageJson: unknown;
		files: Record<string, string>;
	}): Promise<{ draftId: string; sourcePath: string; package: { name: string; version: string } }> {
		await this.initialize();
		if (!DRAFT_ID_PATTERN.test(input.draftId)) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", "draftId must be a safe lowercase identifier");
		}
		const packageJson = requirePackageJson(input.packageJson);
		if (typeof input.files !== "object" || input.files === null || Array.isArray(input.files)) {
			throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", "files must be an object of UTF-8 package files");
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
		await mkdir(temporary, { recursive: false, mode: 0o700 });
		try {
			let totalBytes = 0;
			for (const [file, content] of Object.entries(input.files)) {
				const normalized = file.split("\\").join("/");
				const target = resolve(temporary, normalized);
				if (
					file !== normalized ||
					isAbsolute(normalized) ||
					normalized.split("/").some((part) => !part || part === "." || part === "..") ||
					!SAFE_DRAFT_FILE_PATTERN.test(normalized) ||
					!isInside(temporary, target) ||
					typeof content !== "string"
				) {
					throw new RuntimeProtocolError("INVALID_PLUGIN_DRAFT", `Unsafe Pi Package file: ${file}`);
				}
				totalBytes += Buffer.byteLength(content, "utf8");
				if (totalBytes > MAX_PACKAGE_BYTES) {
					throw new RuntimeProtocolError("PLUGIN_LIMIT_EXCEEDED", `Pi Package exceeds ${MAX_PACKAGE_BYTES} bytes`);
				}
				await mkdir(dirname(target), { recursive: true, mode: 0o700 });
				await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			}
			await writeFile(join(temporary, "package.json"), `${JSON.stringify(input.packageJson, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporary, draftRoot);
			return {
				draftId: input.draftId,
				sourcePath: draftRoot,
				package: { name: packageJson.name, version: packageJson.version },
			};
		} catch (error) {
			await rm(temporary, { recursive: true, force: true });
			throw error;
		}
	}

	async prepare(source: string): Promise<NativePackageValidation> {
		await this.initialize();
		if (!source.trim() || source.length > 4096) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "Pi Package source is required");
		}
		const prepared = await this.scanPackage(source.trim());
		const state = (await this.readState()).packages.find((entry) => entry.id === prepared.name);
		this.prune();
		this.prepared.set(prepared.preparedPackageId, prepared);
		return this.publicValidation(prepared, state);
	}

	private requirePrepared(preparedPackageId: string, expectedDigest: string): PreparedPackage {
		this.prune();
		const prepared = this.prepared.get(preparedPackageId);
		if (!prepared) {
			throw new RuntimeProtocolError("PLUGIN_PREPARE_REQUIRED", "Prepared Pi Package is missing or expired");
		}
		if (prepared.digest !== expectedDigest) {
			throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Prepared Pi Package digest changed");
		}
		return prepared;
	}

	private previewPayload(input: Omit<NativeInstallPreviewRecord, "payloadSha256" | "expiresAtMs">): string {
		return createHash("sha256").update(JSON.stringify(input)).digest("hex");
	}

	async previewInstall(input: {
		preparedPackageId: string;
		expectedDigest: string;
		enable?: boolean;
	}): Promise<NativePackageValidation & {
		previewToken: string;
		payloadSha256: string;
		requiredConfirm: "apply";
		expiresAtMs: number;
	}> {
		const prepared = this.requirePrepared(input.preparedPackageId, input.expectedDigest);
		const state = (await this.readState()).packages.find((entry) => entry.id === prepared.name);
		const bound = {
			preparedPackageId: prepared.preparedPackageId,
			packageId: prepared.name,
			expectedDigest: prepared.digest,
			enable: input.enable ?? state?.enabled ?? false,
			expectedActiveDigest: state?.active.digest,
			expectedEnabled: state?.enabled,
		};
		const payloadSha256 = this.previewPayload(bound);
		const previewToken = randomUUID();
		const expiresAtMs = Date.now() + INSTALL_PREVIEW_TTL_MS;
		this.previews.set(previewToken, { ...bound, payloadSha256, expiresAtMs });
		return {
			...this.publicValidation(prepared, state),
			previewToken,
			payloadSha256,
			requiredConfirm: "apply",
			expiresAtMs,
		};
	}

	private updateConfiguredPackage(previousSource: string | undefined, source: string, enabled: boolean): void {
		const current = this.settingsManager.getGlobalSettings().packages ?? [];
		const filtered = current.filter((entry) => {
			const value = packageSourceValue(entry);
			return value !== source && (!previousSource || value !== previousSource);
		});
		filtered.push(enabled ? source : disabledPackageSource(source));
		this.settingsManager.setPackages(filtered);
	}

	private async publishManagedPackage(prepared: PreparedPackage): Promise<string> {
		const packageKey = createHash("sha256").update(prepared.name).digest("hex").slice(0, 16);
		const packageRoot = join(this.managedPackagesRoot, packageKey);
		const destination = join(packageRoot, prepared.digest);
		await mkdir(packageRoot, { recursive: true, mode: 0o700 });
		let destinationExists = false;
		try {
			destinationExists = (await stat(destination)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (destinationExists) {
			const existing = await this.scanPackage(destination);
			if (existing.digest !== prepared.digest || existing.name !== prepared.name) {
				throw new RuntimeProtocolError(
					"PLUGIN_DIGEST_MISMATCH",
					"Managed Pi Package content does not match its content-addressed path",
				);
			}
			return await realpath(destination);
		}

		const temporary = join(packageRoot, `.${prepared.digest}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await cp(prepared.packageRoot, temporary, {
				recursive: true,
				force: false,
				errorOnExist: true,
				preserveTimestamps: false,
			});
			const copied = await this.scanPackage(temporary);
			if (copied.digest !== prepared.digest || copied.name !== prepared.name) {
				throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Copied Pi Package failed digest verification");
			}
			await rename(temporary, destination);
			return await realpath(destination);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async install(input: {
		preparedPackageId: string;
		expectedDigest: string;
		enable?: boolean;
		approvalToken?: string;
		previewToken?: string;
		payloadSha256?: string;
		confirmText?: string;
	}): Promise<NativeInstalledPackage> {
		this.requireApproval(input.approvalToken);
		const prepared = this.requirePrepared(input.preparedPackageId, input.expectedDigest);
		return this.withMutation(prepared.name, async () => {
			if (input.confirmText?.trim().toLowerCase() !== "apply") {
				throw new RuntimeProtocolError("PLUGIN_CONFIRMATION_REQUIRED", "Pi Package install requires confirmText=apply");
			}
			this.prune();
			const preview = input.previewToken ? this.previews.get(input.previewToken) : undefined;
			if (!preview) {
				throw new RuntimeProtocolError("PLUGIN_PREVIEW_REQUIRED", "Pi Package install requires a live host preview");
			}
			this.previews.delete(input.previewToken!);
			const stateFile = await this.readState();
			const previous = stateFile.packages.find((entry) => entry.id === prepared.name);
			const bound = {
				preparedPackageId: prepared.preparedPackageId,
				packageId: prepared.name,
				expectedDigest: prepared.digest,
				enable: input.enable ?? previous?.enabled ?? false,
				expectedActiveDigest: previous?.active.digest,
				expectedEnabled: previous?.enabled,
			};
			const payloadSha256 = this.previewPayload(bound);
			if (
				preview.payloadSha256 !== payloadSha256 ||
				input.payloadSha256 !== payloadSha256 ||
				preview.preparedPackageId !== prepared.preparedPackageId ||
				preview.packageId !== prepared.name ||
				preview.expectedDigest !== prepared.digest ||
				preview.enable !== bound.enable ||
				preview.expectedActiveDigest !== bound.expectedActiveDigest ||
				preview.expectedEnabled !== bound.expectedEnabled
			) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Pi Package changed after Runtime Host preview");
			}

			// Official Pi owns package resolution and installation. Re-resolve the
			// installed source and compare its full package digest before publishing
			// it into Pi's global package settings.
			await this.packageManager.install(prepared.source);
			const installedScan = await this.scanPackage(prepared.source);
			if (installedScan.digest !== prepared.digest) {
				throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Pi Package changed while being installed");
			}
			const managedSource = await this.publishManagedPackage(installedScan);
			this.updateConfiguredPackage(previous?.active.source, managedSource, bound.enable);
			const active: NativePackageInstallRecord = {
				name: prepared.name,
				version: prepared.version,
				description: prepared.description,
				digest: prepared.digest,
				source: managedSource,
				installedAt: new Date().toISOString(),
				resources: structuredClone(prepared.resources),
				capabilities: [...prepared.capabilities],
			};
			const history = previous ? [...previous.history] : [];
			if (previous && previous.active.digest !== active.digest) history.push(previous.active);
			const next: NativePackageState = { id: prepared.name, enabled: bound.enable, active, history };
			stateFile.packages = stateFile.packages.filter((entry) => entry.id !== prepared.name);
			stateFile.packages.push(next);
			await this.writeState(stateFile);
			this.prepared.delete(prepared.preparedPackageId);
			return this.publicInstalled(next);
		});
	}

	private publicInstalled(state: NativePackageState): NativeInstalledPackage {
		const versions = [...state.history, state.active];
		const rollback = state.history.at(-1);
		return {
			id: state.id,
			name: state.active.name,
			version: state.active.version,
			description: state.active.description,
			permissions: [],
			digest: state.active.digest,
			enabled: state.enabled,
			distribution: "pi_package",
			source: state.active.source,
			resources: structuredClone(state.active.resources),
			capabilities: [...(state.active.capabilities ?? [])],
			installedVersions: versions.map((record) => ({
				version: record.version,
				digest: record.digest,
				installedAt: record.installedAt,
				source: record.source,
			})),
			rollbackTarget: rollback
				? {
						version: rollback.version,
						digest: rollback.digest,
						installedAt: rollback.installedAt,
						source: rollback.source,
					}
				: undefined,
		};
	}

	async list(): Promise<NativeInstalledPackage[]> {
		return (await this.readState()).packages
			.map((state) => this.publicInstalled(state))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	async setEnabled(input: {
		packageId: string;
		enabled: boolean;
		expectedActiveDigest: string;
		expectedEnabled: boolean;
		approvalToken?: string;
	}): Promise<NativeInstalledPackage> {
		this.requireApproval(input.approvalToken);
		return this.withMutation(input.packageId, async () => {
			const stateFile = await this.readState();
			const state = stateFile.packages.find((entry) => entry.id === input.packageId);
			if (!state) throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Pi Package is not installed: ${input.packageId}`);
			if (state.active.digest !== input.expectedActiveDigest || state.enabled !== input.expectedEnabled) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Pi Package state changed after preview");
			}
			state.enabled = input.enabled;
			this.updateConfiguredPackage(state.active.source, state.active.source, state.enabled);
			await this.writeState(stateFile);
			return this.publicInstalled(state);
		});
	}

	async uninstall(input: {
		packageId: string;
		expectedActiveDigest: string;
		expectedEnabled: boolean;
		approvalToken?: string;
	}): Promise<NativeRemovedPackage> {
		this.requireApproval(input.approvalToken);
		return this.withMutation(input.packageId, async () => {
			const stateFile = await this.readState();
			const state = stateFile.packages.find((entry) => entry.id === input.packageId);
			if (!state) throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Pi Package is not installed: ${input.packageId}`);
			if (state.active.digest !== input.expectedActiveDigest || state.enabled !== input.expectedEnabled) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Pi Package state changed after uninstall preview");
			}
			// Let Pi remove both the configured PackageSource and any managed npm/git
			// checkout. Local packages are only detached; their source is never deleted.
			await this.packageManager.removeAndPersist(state.active.source);
			stateFile.packages = stateFile.packages.filter((entry) => entry.id !== input.packageId);
			await this.writeState(stateFile);
			return {
				id: input.packageId,
				digest: state.active.digest,
				distribution: "pi_package",
				removed: true,
			};
		});
	}

	async rollback(input: {
		packageId: string;
		expectedActiveDigest: string;
		targetDigest: string;
		approvalToken?: string;
	}): Promise<NativeInstalledPackage> {
		this.requireApproval(input.approvalToken);
		return this.withMutation(input.packageId, async () => {
			const stateFile = await this.readState();
			const state = stateFile.packages.find((entry) => entry.id === input.packageId);
			if (!state) throw new RuntimeProtocolError("PLUGIN_NOT_FOUND", `Pi Package is not installed: ${input.packageId}`);
			if (state.active.digest !== input.expectedActiveDigest) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Pi Package active version changed after preview");
			}
			const target = state.history.at(-1);
			if (!target || target.digest !== input.targetDigest) {
				throw new RuntimeProtocolError("PLUGIN_STATE_CHANGED", "Pi Package rollback target changed after preview");
			}
			await this.packageManager.install(target.source);
			const installedScan = await this.scanPackage(target.source);
			if (installedScan.digest !== target.digest) {
				throw new RuntimeProtocolError("PLUGIN_DIGEST_MISMATCH", "Rollback Pi Package digest changed");
			}
			this.updateConfiguredPackage(state.active.source, target.source, state.enabled);
			state.active = target;
			state.history.pop();
			await this.writeState(stateFile);
			return this.publicInstalled(state);
		});
	}
}
