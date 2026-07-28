import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HANDLE_PREFIX = "tool-result://sha256/";
const HANDLE_PATTERN = /^tool-result:\/\/sha256\/([0-9a-f]{64})$/u;
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MIN_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const READ_SEGMENT_BYTES = 48 * 1024;

export interface ToolResultEvidence {
	evidenceHandle: string;
	evidenceSha256: string;
	evidenceBytes: number;
	evidenceAvailable: boolean;
}

interface ToolResultMetadata {
	schemaVersion: "rag-ime.tool-result-evidence.v1";
	handle: string;
	sha256: string;
	byteSize: number;
	createdAt: string;
	available: boolean;
	toolName?: string;
	evictedAt?: string;
}

export interface ToolResultEvidenceRead {
	handle: string;
	sha256: string;
	byteSize: number;
	available: boolean;
	content: string;
	segment: number;
	segmentCount: number;
	nextSegment?: number;
	evictedAt?: string;
}

/**
 * Session-owned content-addressed storage for model-visible tool evidence.
 *
 * Raw payloads are reclaimable, but metadata is not. A compacted conversation
 * can therefore retain a stable handle and later distinguish "payload evicted"
 * from "the tool was never called".
 */
export class ToolResultStore {
	private readonly root: string;
	private readonly maxPayloadBytes: number;

	constructor(root: string, maxPayloadBytes = configuredMaxPayloadBytes()) {
		this.root = root;
		this.maxPayloadBytes = clampMaxPayloadBytes(maxPayloadBytes);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}

	persist(content: string, toolName?: string): ToolResultEvidence {
		const encoded = Buffer.from(content, "utf8");
		const sha256 = createHash("sha256").update(encoded).digest("hex");
		const handle = `${HANDLE_PREFIX}${sha256}`;
		const payloadPath = this.payloadPath(sha256);
		const metadataPath = this.metadataPath(sha256);
		const previous = this.readMetadata(sha256);
		if (!existsSync(payloadPath)) this.atomicWrite(payloadPath, encoded);
		const metadata: ToolResultMetadata = {
			schemaVersion: "rag-ime.tool-result-evidence.v1",
			handle,
			sha256,
			byteSize: encoded.byteLength,
			createdAt: previous?.createdAt ?? new Date().toISOString(),
			available: true,
			...(toolName ? { toolName } : previous?.toolName ? { toolName: previous.toolName } : {}),
		};
		this.atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
		this.prunePayloads(sha256);
		const current = this.readMetadata(sha256) ?? metadata;
		return {
			evidenceHandle: handle,
			evidenceSha256: sha256,
			evidenceBytes: encoded.byteLength,
			evidenceAvailable: current.available,
		};
	}

	read(handle: string, segment = 1): ToolResultEvidenceRead {
		const sha256 = digestFromHandle(handle);
		const metadata = this.readMetadata(sha256);
		if (!metadata) throw new Error(`Unknown tool-result evidence handle: ${handle}`);
		if (!metadata.available || !existsSync(this.payloadPath(sha256))) {
			return {
				handle,
				sha256,
				byteSize: metadata.byteSize,
				available: false,
				content: [
					`[Tool result payload was reclaimed; evidence handle remains valid.]`,
					`handle=${handle}`,
					`sha256=${sha256}`,
					`originalBytes=${metadata.byteSize}`,
					metadata.evictedAt ? `evictedAt=${metadata.evictedAt}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				segment: 0,
				segmentCount: 0,
				...(metadata.evictedAt ? { evictedAt: metadata.evictedAt } : {}),
			};
		}
		const content = readFileSync(this.payloadPath(sha256), "utf8");
		const segments = splitUtf8(content, READ_SEGMENT_BYTES);
		const requested = Math.max(1, Math.min(segments.length, Math.trunc(segment) || 1));
		return {
			handle,
			sha256,
			byteSize: metadata.byteSize,
			available: true,
			content: segments[requested - 1] ?? "",
			segment: requested,
			segmentCount: segments.length,
			...(requested < segments.length ? { nextSegment: requested + 1 } : {}),
		};
	}

	private prunePayloads(currentSha256: string): void {
		const payloads = readdirSync(this.root)
			.filter((name) => name.endsWith(".result"))
			.map((name) => {
				const path = join(this.root, name);
				const stats = statSync(path);
				return {
					sha256: name.slice(0, -".result".length),
					path,
					bytes: stats.size,
					mtimeMs: stats.mtimeMs,
				};
			})
			.sort((left, right) => left.mtimeMs - right.mtimeMs);
		let total = payloads.reduce((sum, item) => sum + item.bytes, 0);
		for (const payload of payloads) {
			if (total <= this.maxPayloadBytes) break;
			// Keep the payload that completed this invocation. It may exceed the
			// budget by itself, but must remain readable for the current turn.
			if (payload.sha256 === currentSha256) continue;
			unlinkSync(payload.path);
			total -= payload.bytes;
			const metadata = this.readMetadata(payload.sha256);
			if (!metadata) continue;
			this.atomicWrite(
				this.metadataPath(payload.sha256),
				`${JSON.stringify(
					{
						...metadata,
						available: false,
						evictedAt: new Date().toISOString(),
					} satisfies ToolResultMetadata,
					null,
					2,
				)}\n`,
			);
		}
	}

	private readMetadata(sha256: string): ToolResultMetadata | undefined {
		const path = this.metadataPath(sha256);
		if (!existsSync(path)) return undefined;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolResultMetadata>;
			if (
				value.schemaVersion !== "rag-ime.tool-result-evidence.v1" ||
				value.sha256 !== sha256 ||
				value.handle !== `${HANDLE_PREFIX}${sha256}` ||
				typeof value.byteSize !== "number" ||
				typeof value.createdAt !== "string" ||
				typeof value.available !== "boolean"
			) {
				return undefined;
			}
			return value as ToolResultMetadata;
		} catch {
			return undefined;
		}
	}

	private payloadPath(sha256: string): string {
		return join(this.root, `${sha256}.result`);
	}

	private metadataPath(sha256: string): string {
		return join(this.root, `${sha256}.meta.json`);
	}

	private atomicWrite(path: string, content: string | Uint8Array): void {
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, content, { mode: 0o600 });
		renameSync(temporary, path);
	}
}

export function isToolResultHandle(value: unknown): value is string {
	return typeof value === "string" && HANDLE_PATTERN.test(value);
}

function digestFromHandle(handle: string): string {
	const match = HANDLE_PATTERN.exec(handle);
	if (!match) throw new Error(`Invalid tool-result evidence handle: ${handle}`);
	return match[1];
}

function configuredMaxPayloadBytes(): number {
	const parsed = Number.parseInt(process.env.RAG_IME_TOOL_RESULT_MAX_BYTES ?? "", 10);
	return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_PAYLOAD_BYTES;
}

function clampMaxPayloadBytes(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_PAYLOAD_BYTES;
	return Math.max(MIN_MAX_PAYLOAD_BYTES, Math.min(MAX_MAX_PAYLOAD_BYTES, Math.trunc(value)));
}

function splitUtf8(value: string, maxBytes: number): string[] {
	if (!value) return [""];
	const segments: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const codePoint of value) {
		const bytes = Buffer.byteLength(codePoint, "utf8");
		if (current && currentBytes + bytes > maxBytes) {
			segments.push(current);
			current = "";
			currentBytes = 0;
		}
		current += codePoint;
		currentBytes += bytes;
	}
	if (current || segments.length === 0) segments.push(current);
	return segments;
}
