import { createHash } from "node:crypto";
import type { ToolResultEvidenceDescriptor, ToolResultEvidenceStatus, ToolResultStore } from "./tool-result-store.ts";

const MAX_ARTIFACT_BLOCKS = 16;
export const MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES = 50 * 1024;
const MEDIA_ID_PATTERN = /^media_[A-Za-z0-9_-]{12,80}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ROOM_DELIVERY_TOOLS: Record<string, true> = { room_post: true, room_commit: true };
const ROOM_LIFECYCLE_TOOLS: Record<string, true> = {
	room_state: true,
	room_define: true,
	room_post: true,
	room_collaborate: true,
	room_commit: true,
};
const INTERNAL_ROOM_RECEIPT_KEYS = new Set([
	"invocationReceipt",
	"executionReceipt",
	"roomInvocationReceipt",
	"roomExecutionReceipt",
]);
const MODEL_HIDDEN_TOOL_RESULT_KEYS = new Set([
	...INTERNAL_ROOM_RECEIPT_KEYS,
	"agentBlocks",
	"approval",
	"approvalId",
	"auditId",
	"memoryCheckpoint",
]);

export interface PreparedToolArguments {
	arguments: unknown;
	deliveryKeys: string[];
}

/**
 * Owns the short-lived handoff from a product tool result to a governed Room
 * post. The model never has to copy opaque media receipts into another call.
 */
export class ToolArtifactBuffer {
	private readonly pending = new Map<string, Record<string, unknown>>();

	capture(...values: unknown[]): Record<string, unknown>[] {
		const captured: Record<string, unknown>[] = [];
		for (const block of toolAgentBlocks(...values)) {
			const key = artifactKey(block);
			if (!key || this.pending.has(key) || this.pending.size >= MAX_ARTIFACT_BLOCKS) continue;
			const copy = structuredClone(block);
			this.pending.set(key, copy);
			captured.push(structuredClone(copy));
		}
		return captured;
	}

	prepare(toolName: string, args: unknown): PreparedToolArguments {
		if (ROOM_DELIVERY_TOOLS[toolName] !== true || this.pending.size === 0 || !isRecord(args)) {
			return { arguments: args, deliveryKeys: [] };
		}
		if (args.blocks !== undefined && (!Array.isArray(args.blocks) || args.blocks.some((block) => !isRecord(block)))) {
			return { arguments: args, deliveryKeys: [] };
		}
		const existing = Array.isArray(args.blocks) ? args.blocks.map((block) => structuredClone(block)) : [];
		const seen = new Set(existing.map(artifactKey).filter(Boolean));
		const deliveryKeys: string[] = [];
		for (const [key, block] of this.pending) {
			if (seen.has(key)) {
				deliveryKeys.push(key);
				continue;
			}
			if (existing.length >= MAX_ARTIFACT_BLOCKS) break;
			existing.push(structuredClone(block));
			seen.add(key);
			deliveryKeys.push(key);
		}
		if (deliveryKeys.length === 0) return { arguments: args, deliveryKeys: [] };
		return {
			arguments: { ...structuredClone(args), blocks: existing },
			deliveryKeys,
		};
	}

	acknowledge(deliveryKeys: readonly string[]): void {
		for (const key of deliveryKeys) this.pending.delete(key);
	}

	clear(): void {
		this.pending.clear();
	}

	size(): number {
		return this.pending.size;
	}
}

export function toolAgentBlocks(...values: unknown[]): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const identities = new Set<string>();
	const visited = new Set<object>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 5 || !isRecord(value) || visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value.agentBlocks)) {
			for (const candidate of value.agentBlocks) {
				if (!isManagedFileBlock(candidate)) continue;
				const key = artifactKey(candidate);
				if (!key || identities.has(key) || result.length >= MAX_ARTIFACT_BLOCKS) continue;
				identities.add(key);
				result.push(structuredClone(candidate));
			}
		}
		for (const key of ["details", "result", "approval", "receipt"] as const) {
			visit(value[key], depth + 1);
		}
	};
	for (const value of values) visit(value, 0);
	return result;
}

/**
 * Remove opaque UI receipts and bound a result before it enters model context.
 *
 * Large evidence is content-addressed before it is shortened. The handle is
 * deliberately the first field so Pi compaction retains proof that the call
 * happened even when the raw payload is later reclaimed.
 */
export function modelVisibleResult(
	value: unknown,
	store?: ToolResultStore,
	toolName?: string,
	args?: unknown,
): unknown {
	const projected = stripAgentBlocks(value);
	const serialized = JSON.stringify(projected) ?? String(projected);
	const originalBytes = Buffer.byteLength(serialized, "utf8");
	if (originalBytes <= MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES) return projected;

	const readable =
		typeof projected === "string" ? projected : (JSON.stringify(projected, null, 2) ?? String(projected));
	const preview = semanticPreview(projected, readable);
	const evidence = store?.persist(readable, evidenceDescriptor(projected, readable, preview, toolName, args));
	return {
		...(evidence ?? {}),
		...(evidence
			? {
					continuation: {
						tool: "read",
						path: evidence.evidenceHandle,
						offset: 1,
						limit: 1,
					},
				}
			: {}),
		...preview,
		truncated: true,
		modelResultTruncated: true,
		truncatedBy: "model_result_bytes",
		originalBytes,
		maxBytes: MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES,
	};
}

/**
 * Keep governance receipts in ToolResult.details while giving the model only
 * the short successful evidence ref it may cite in room_commit.
 */
export function modelVisibleToolGatewayResult(
	value: unknown,
	store?: ToolResultStore,
	toolName?: string,
	args?: unknown,
): unknown {
	const evidenceRef = successfulProductEvidenceRef(value);
	const stripped = stripToolGatewayAuditFields(value);
	const projected = evidenceRef && isRecord(stripped) ? evidenceFirst(stripped, evidenceRef) : stripped;
	return modelVisibleResult(projected, store, toolName, args);
}

function semanticPreview(projected: unknown, readable: string): Record<string, unknown> {
	const preview: Record<string, unknown> = {};
	if (isRecord(projected)) {
		const retained: Record<string, unknown> = {};
		const collectionSizes: Record<string, number> = {};
		for (const [key, item] of Object.entries(projected)) {
			if (
				[
					"evidenceHandle",
					"evidenceSha256",
					"evidenceBytes",
					"evidenceAvailable",
					"continuation",
					"truncated",
					"modelResultTruncated",
					"truncatedBy",
					"originalBytes",
					"maxBytes",
					"preview",
					"previewHead",
					"previewTail",
				].includes(key)
			) {
				continue;
			}
			if (
				Object.keys(retained).length < 24 &&
				(typeof item === "number" || typeof item === "boolean" || item === null)
			) {
				retained[key] = item;
			} else if (
				Object.keys(retained).length < 24 &&
				typeof item === "string" &&
				Buffer.byteLength(item, "utf8") <= 1024
			) {
				retained[key] = item;
			} else if (Object.keys(collectionSizes).length < 32 && Array.isArray(item)) {
				collectionSizes[key] = item.length;
			} else if (Object.keys(collectionSizes).length < 32 && isRecord(item)) {
				collectionSizes[key] = Object.keys(item).length;
			}
		}
		Object.assign(preview, retained);
		if (Object.keys(collectionSizes).length > 0) preview.collectionSizes = collectionSizes;
		const keys = Object.keys(projected);
		preview.resultKeys = keys.length <= 64 ? keys : [...keys.slice(0, 64), `... ${keys.length - 64} more`];
	} else if (Array.isArray(projected)) {
		preview.resultItems = projected.length;
	}
	const head = sliceUtf8(readable, 0, 8 * 1024);
	const tail = sliceUtf8(readable, Math.max(0, Buffer.byteLength(readable, "utf8") - 4 * 1024), 4 * 1024);
	preview.previewHead = head;
	if (tail && tail !== head) preview.previewTail = tail;
	return preview;
}

const SAFE_EVIDENCE_ARGUMENT_KEYS = new Set([
	"op",
	"path",
	"paths",
	"query",
	"pattern",
	"glob",
	"mode",
	"offset",
	"limit",
	"depth",
	"recursive",
	"caseSensitive",
	"fixedStrings",
	"context",
	"cwd",
	"timeout",
	"timeoutSeconds",
	"allowNetwork",
	"encoding",
	"line",
	"startLine",
	"endLine",
	"file",
	"targetId",
	"bookId",
	"draftId",
	"proposalId",
	"runId",
]);
const DIGESTED_EVIDENCE_ARGUMENT_KEYS = new Set([
	"content",
	"text",
	"body",
	"payload",
	"data",
	"oldText",
	"newText",
	"replacement",
	"patch",
]);
const SENSITIVE_ARGUMENT_KEY = /(api.?key|token|secret|password|cookie|authorization|credential|capability)/iu;

function evidenceDescriptor(
	projected: unknown,
	readable: string,
	preview: Record<string, unknown>,
	toolName?: string,
	args?: unknown,
): ToolResultEvidenceDescriptor {
	const requestSummary = evidenceRequestSummary(args);
	const resultFacts = evidenceResultFacts(preview);
	return {
		...(toolName ? { toolName } : {}),
		status: evidenceStatus(projected, readable),
		...(requestSummary ? { requestSummary } : {}),
		resultSummary: evidenceResultSummary(projected, readable),
		...(resultFacts ? { resultFacts } : {}),
	};
}

function evidenceRequestSummary(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const summary: Record<string, unknown> = {};
	const omitted: string[] = [];
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_ARGUMENT_KEY.test(key)) {
			summary[key] = "[redacted]";
			continue;
		}
		if (key === "command" && typeof item === "string") {
			summary.commandPreview = boundedEvidenceText(redactEvidenceText(item), 1_024);
			summary.commandSha256 = digestText(item);
			summary.commandBytes = Buffer.byteLength(item, "utf8");
			continue;
		}
		if (DIGESTED_EVIDENCE_ARGUMENT_KEYS.has(key) && typeof item === "string") {
			summary[`${key}Sha256`] = digestText(item);
			summary[`${key}Bytes`] = Buffer.byteLength(item, "utf8");
			continue;
		}
		if (SAFE_EVIDENCE_ARGUMENT_KEYS.has(key)) {
			const safe = evidenceArgumentValue(item);
			if (safe !== undefined) summary[key] = safe;
			continue;
		}
		omitted.push(key);
	}
	if (omitted.length > 0) summary.omittedArgumentKeys = omitted.slice(0, 32);
	return Object.keys(summary).length > 0 ? summary : undefined;
}

function evidenceArgumentValue(value: unknown): unknown {
	if (typeof value === "string") return boundedEvidenceText(redactEvidenceText(value), 1_024);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value.slice(0, 16).map((item) => {
			if (typeof item === "string") return boundedEvidenceText(redactEvidenceText(item), 512);
			if (typeof item === "number" || typeof item === "boolean" || item === null) return item;
			return `[${Array.isArray(item) ? "array" : typeof item}]`;
		});
	}
	return undefined;
}

function evidenceStatus(projected: unknown, readable: string): ToolResultEvidenceStatus {
	if (isRecord(projected)) {
		const status = typeof projected.status === "string" ? projected.status.toLowerCase() : "";
		const approvalState = typeof projected.approvalState === "string" ? projected.approvalState.toLowerCase() : "";
		if (status.includes("cancel") || status.includes("abort") || approvalState.includes("cancel")) {
			return "cancelled";
		}
		if (
			projected.ok === false ||
			projected.success === false ||
			typeof projected.error === "string" ||
			["failed", "error", "rejected", "expired"].some(
				(value) => status.includes(value) || approvalState.includes(value),
			) ||
			(typeof projected.exitCode === "number" && projected.exitCode !== 0)
		) {
			return "failed";
		}
		return "completed";
	}
	const exitCode = /\[exit code:\s*(-?\d+)\]/iu.exec(readable);
	if (exitCode) return Number(exitCode[1]) === 0 ? "completed" : "failed";
	return "completed";
}

function evidenceResultSummary(projected: unknown, readable: string): string {
	if (isRecord(projected)) {
		for (const key of ["summary", "message", "error", "reason"] as const) {
			if (typeof projected[key] === "string" && projected[key].trim()) {
				return boundedEvidenceText(redactEvidenceText(projected[key]), 2_048);
			}
		}
	}
	const redacted = redactEvidenceText(readable);
	const head = sliceUtf8(redacted, 0, 1_280);
	if (Buffer.byteLength(redacted, "utf8") <= 1_280) return head;
	const tail = sliceUtf8(redacted, Math.max(0, Buffer.byteLength(redacted, "utf8") - 512), 512);
	return `${head}\n[... raw evidence omitted ...]\n${tail}`;
}

function evidenceResultFacts(preview: Record<string, unknown>): Record<string, unknown> | undefined {
	const facts = Object.fromEntries(
		Object.entries(preview).filter(([key]) => key !== "previewHead" && key !== "previewTail"),
	);
	return Object.keys(facts).length > 0 ? facts : undefined;
}

function redactEvidenceText(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(
			/\b(api[_-]?key|token|secret|password|cookie|authorization)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
			"$1=[redacted]",
		)
		.replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/giu, "$1[redacted]");
}

function digestText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedEvidenceText(value: string, maxBytes: number): string {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return `${encoded.subarray(0, end).toString("utf8")}…`;
}

function sliceUtf8(value: string, startByte: number, maxBytes: number): string {
	const encoded = Buffer.from(value, "utf8");
	let start = Math.max(0, Math.min(encoded.length, startByte));
	while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
	let end = Math.min(encoded.length, start + maxBytes);
	while (end > start && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return encoded.subarray(start, end).toString("utf8");
}

function stripAgentBlocks(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripAgentBlocks);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "agentBlocks")
			.map(([key, item]) => [key, stripAgentBlocks(item)]),
	);
}

function stripToolGatewayAuditFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripToolGatewayAuditFields);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !MODEL_HIDDEN_TOOL_RESULT_KEYS.has(key))
			.map(([key, item]) => [key, stripToolGatewayAuditFields(item)]),
	);
}

function evidenceFirst(value: Record<string, unknown>, evidenceRef: string): Record<string, unknown> {
	return {
		evidenceRef,
		...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "evidenceRef")),
	};
}

export function successfulProductEvidenceRef(value: unknown, depth = 0): string {
	if (!isRecord(value) || depth > 5) return "";
	for (const key of ["roomExecutionReceipt", "executionReceipt"] as const) {
		const receipt = value[key];
		if (!isRecord(receipt)) continue;
		const toolName = text(receipt.toolName);
		const receiptId = text(receipt.executionReceiptId);
		if (receipt.status === "applied" && receiptId && toolName && ROOM_LIFECYCLE_TOOLS[toolName] !== true) {
			return receiptId;
		}
	}
	for (const key of ["result", "details", "approval", "receipt"] as const) {
		const nested = successfulProductEvidenceRef(value[key], depth + 1);
		if (nested) return nested;
	}
	return "";
}

function isManagedFileBlock(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || typeof value.id !== "string" || value.type !== "file" || !isRecord(value.data)) {
		return false;
	}
	const data = value.data;
	const mediaId = text(data.mediaId);
	const sessionId = text(data.sessionId);
	const sha256 = text(data.sha256).toLowerCase();
	const receiptUrl = text(data.receiptUrl);
	return (
		MEDIA_ID_PATTERN.test(mediaId) &&
		SESSION_ID_PATTERN.test(sessionId) &&
		SHA256_PATTERN.test(sha256) &&
		text(data.fileName).length > 0 &&
		text(data.mimeType).length > 0 &&
		typeof data.byteSize === "number" &&
		Number.isSafeInteger(data.byteSize) &&
		data.byteSize > 0 &&
		receiptUrl ===
			`/api/agent/media/${encodeURIComponent(mediaId)}/content?sessionId=${encodeURIComponent(sessionId)}`
	);
}

function artifactKey(value: Record<string, unknown>): string {
	if (!isRecord(value.data)) return "";
	const mediaId = text(value.data.mediaId);
	const sha256 = text(value.data.sha256).toLowerCase();
	return MEDIA_ID_PATTERN.test(mediaId) && SHA256_PATTERN.test(sha256) ? `${mediaId}:${sha256}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
