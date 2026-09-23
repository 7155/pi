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
const MAX_OBSERVATIONS_PER_PAYLOAD = 8;

export interface ToolResultEvidence {
	evidenceHandle: string;
	evidenceToolName?: string;
	evidenceStatus?: ToolResultEvidenceStatus;
	evidenceRequest?: Record<string, unknown>;
	evidenceSummary?: string;
	evidenceFacts?: Record<string, unknown>;
	evidenceSha256: string;
	evidenceBytes: number;
	evidenceAvailable: boolean;
	evidenceAvailability: "available_at_capture" | "reclaimed_at_capture";
}

export type ToolResultEvidenceStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface ToolResultEvidenceDescriptor {
	toolName?: string;
	status?: ToolResultEvidenceStatus;
	requestSummary?: Record<string, unknown>;
	resultSummary?: string;
	resultFacts?: Record<string, unknown>;
}

export interface ToolResultObservation {
	toolName?: string;
	status: ToolResultEvidenceStatus;
	requestSummary?: Record<string, unknown>;
	resultSummary?: string;
	resultFacts?: Record<string, unknown>;
	firstObservedAt: string;
	lastObservedAt: string;
	observationCount: number;
}

interface ToolResultMetadata {
	schemaVersion: "rag-ime.tool-result-evidence.v1" | "rag-ime.tool-result-evidence.v2";
	handle: string;
	sha256: string;
	byteSize: number;
	createdAt: string;
	available: boolean;
	observations?: ToolResultObservation[];
	omittedObservationCount?: number;
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
	observations: ToolResultObservation[];
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

	persist(content: string, descriptorOrToolName?: ToolResultEvidenceDescriptor | string): ToolResultEvidence {
		const encoded = Buffer.from(content, "utf8");
		const sha256 = createHash("sha256").update(encoded).digest("hex");
		const handle = `${HANDLE_PREFIX}${sha256}`;
		const payloadPath = this.payloadPath(sha256);
		const metadataPath = this.metadataPath(sha256);
		const previous = this.readMetadata(sha256);
		const descriptor = normalizeDescriptor(descriptorOrToolName);
		const observedAt = new Date().toISOString();
		const observations = mergeObservations(
			metadataObservations(previous),
			descriptor,
			observedAt,
			previous?.omittedObservationCount ?? 0,
		);
		if (!existsSync(payloadPath)) this.atomicWrite(payloadPath, encoded);
		const metadata: ToolResultMetadata = {
			schemaVersion: "rag-ime.tool-result-evidence.v2",
			handle,
			sha256,
			byteSize: encoded.byteLength,
			createdAt: previous?.createdAt ?? observedAt,
			available: true,
			...(observations.items.length > 0 ? { observations: observations.items } : {}),
			...(observations.omitted > 0 ? { omittedObservationCount: observations.omitted } : {}),
		};
		this.atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
		this.prunePayloads(sha256);
		const current = this.readMetadata(sha256) ?? metadata;
		return {
			evidenceHandle: handle,
			...(descriptor.toolName ? { evidenceToolName: descriptor.toolName } : {}),
			...(descriptor.status ? { evidenceStatus: descriptor.status } : {}),
			...(descriptor.requestSummary ? { evidenceRequest: descriptor.requestSummary } : {}),
			...(descriptor.resultSummary ? { evidenceSummary: descriptor.resultSummary } : {}),
			...(descriptor.resultFacts ? { evidenceFacts: descriptor.resultFacts } : {}),
			evidenceSha256: sha256,
			evidenceBytes: encoded.byteLength,
			evidenceAvailable: current.available,
			evidenceAvailability: current.available ? "available_at_capture" : "reclaimed_at_capture",
		};
	}

	read(handle: string, segment = 1): ToolResultEvidenceRead {
		const sha256 = digestFromHandle(handle);
		const metadata = this.readMetadata(sha256);
		if (!metadata) throw new Error(`Unknown tool-result evidence handle: ${handle}`);
		const observations = metadataObservations(metadata);
		if (!metadata.available || !existsSync(this.payloadPath(sha256))) {
			return {
				handle,
				sha256,
				byteSize: metadata.byteSize,
				available: false,
				content: [
					`[Tool result payload was reclaimed; durable evidence metadata remains.]`,
					`handle=${handle}`,
					`sha256=${sha256}`,
					`originalBytes=${metadata.byteSize}`,
					`rawPayloadAvailable=false`,
					...observationLines(observations, metadata.omittedObservationCount ?? 0),
					metadata.evictedAt ? `evictedAt=${metadata.evictedAt}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				segment: 0,
				segmentCount: 0,
				...(metadata.evictedAt ? { evictedAt: metadata.evictedAt } : {}),
				observations,
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
			observations,
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
				(value.schemaVersion !== "rag-ime.tool-result-evidence.v1" &&
					value.schemaVersion !== "rag-ime.tool-result-evidence.v2") ||
				value.sha256 !== sha256 ||
				value.handle !== `${HANDLE_PREFIX}${sha256}` ||
				typeof value.byteSize !== "number" ||
				typeof value.createdAt !== "string" ||
				typeof value.available !== "boolean"
			) {
				return undefined;
			}
			if (value.observations !== undefined && !validObservations(value.observations)) return undefined;
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

function normalizeDescriptor(value: ToolResultEvidenceDescriptor | string | undefined): ToolResultEvidenceDescriptor {
	if (typeof value === "string") return { toolName: boundedText(value, 128) };
	if (!value) return {};
	const toolName = boundedText(value.toolName, 128);
	const resultSummary = boundedText(value.resultSummary, 2_048);
	return {
		...(toolName ? { toolName } : {}),
		...(isEvidenceStatus(value.status) ? { status: value.status } : {}),
		...(value.requestSummary ? { requestSummary: boundedRecord(value.requestSummary) } : {}),
		...(resultSummary ? { resultSummary } : {}),
		...(value.resultFacts ? { resultFacts: boundedRecord(value.resultFacts) } : {}),
	};
}

function metadataObservations(metadata: ToolResultMetadata | undefined): ToolResultObservation[] {
	if (!metadata) return [];
	if (metadata.observations) return metadata.observations.map((item) => structuredClone(item));
	if (!metadata.toolName) return [];
	return [
		{
			toolName: metadata.toolName,
			status: "unknown",
			resultSummary: "Legacy evidence record; raw payload identity was retained.",
			firstObservedAt: metadata.createdAt,
			lastObservedAt: metadata.createdAt,
			observationCount: 1,
		},
	];
}

function mergeObservations(
	previous: ToolResultObservation[],
	descriptor: ToolResultEvidenceDescriptor,
	observedAt: string,
	previousOmitted: number,
): { items: ToolResultObservation[]; omitted: number } {
	if (Object.keys(descriptor).length === 0) {
		return { items: previous, omitted: previousOmitted };
	}
	const candidate: ToolResultObservation = {
		...(descriptor.toolName ? { toolName: descriptor.toolName } : {}),
		status: descriptor.status ?? "unknown",
		...(descriptor.requestSummary ? { requestSummary: descriptor.requestSummary } : {}),
		...(descriptor.resultSummary ? { resultSummary: descriptor.resultSummary } : {}),
		...(descriptor.resultFacts ? { resultFacts: descriptor.resultFacts } : {}),
		firstObservedAt: observedAt,
		lastObservedAt: observedAt,
		observationCount: 1,
	};
	const fingerprint = observationFingerprint(candidate);
	const items = previous.map((item) => structuredClone(item));
	const existingIndex = items.findIndex((item) => observationFingerprint(item) === fingerprint);
	if (existingIndex >= 0) {
		const existing = items[existingIndex];
		items[existingIndex] = {
			...existing,
			lastObservedAt: observedAt,
			observationCount: existing.observationCount + 1,
		};
		return { items, omitted: previousOmitted };
	}
	items.push(candidate);
	if (items.length <= MAX_OBSERVATIONS_PER_PAYLOAD) {
		return { items, omitted: previousOmitted };
	}
	return {
		items: items.slice(items.length - MAX_OBSERVATIONS_PER_PAYLOAD),
		omitted: previousOmitted + 1,
	};
}

function observationFingerprint(value: ToolResultObservation): string {
	return JSON.stringify({
		toolName: value.toolName,
		status: value.status,
		requestSummary: value.requestSummary,
		resultSummary: value.resultSummary,
		resultFacts: value.resultFacts,
	});
}

function observationLines(observations: ToolResultObservation[], omitted: number): string[] {
	if (observations.length === 0) return ["observations=0 (legacy metadata did not retain semantic evidence)"];
	const selected = observations.slice(-3);
	const lines = [
		`observations=${observations.length}${omitted > 0 ? ` (+${omitted} older descriptors omitted)` : ""}`,
	];
	for (const [index, observation] of selected.entries()) {
		const label = `observation${observations.length - selected.length + index + 1}`;
		lines.push(`${label}.tool=${observation.toolName ?? "unknown"}`);
		lines.push(`${label}.status=${observation.status}`);
		if (observation.requestSummary) {
			lines.push(`${label}.request=${JSON.stringify(observation.requestSummary)}`);
		}
		if (observation.resultSummary) {
			lines.push(`${label}.summary=${JSON.stringify(observation.resultSummary)}`);
		}
		if (observation.resultFacts) {
			lines.push(`${label}.facts=${JSON.stringify(observation.resultFacts)}`);
		}
		lines.push(`${label}.observed=${observation.observationCount}x; last=${observation.lastObservedAt}`);
	}
	return lines;
}

function validObservations(value: unknown): value is ToolResultObservation[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_OBSERVATIONS_PER_PAYLOAD &&
		value.every(
			(item) =>
				isRecord(item) &&
				isEvidenceStatus(item.status) &&
				typeof item.firstObservedAt === "string" &&
				typeof item.lastObservedAt === "string" &&
				typeof item.observationCount === "number" &&
				item.observationCount >= 1,
		)
	);
}

function isEvidenceStatus(value: unknown): value is ToolResultEvidenceStatus {
	return value === "completed" || value === "failed" || value === "cancelled" || value === "unknown";
}

function boundedRecord(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).slice(0, 32)) {
		if (typeof item === "string") {
			result[key] = boundedText(item, 1_024);
		} else if (typeof item === "number" || typeof item === "boolean" || item === null) {
			result[key] = item;
		} else if (Array.isArray(item) && depth < 2) {
			result[key] = item.slice(0, 16).map((entry) => {
				if (isRecord(entry)) return boundedRecord(entry, depth + 1);
				if (typeof entry === "string") return boundedText(entry, 512);
				if (typeof entry === "number" || typeof entry === "boolean" || entry === null) return entry;
				return `[${typeof entry}]`;
			});
		} else if (isRecord(item) && depth < 2) {
			result[key] = boundedRecord(item, depth + 1);
		}
	}
	return result;
}

function boundedText(value: unknown, maxBytes: number): string {
	if (typeof value !== "string") return "";
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return `${encoded.subarray(0, end).toString("utf8")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
