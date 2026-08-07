import type {
	CancelOperationSnapshot,
	ContinuationEnvelope,
	ContinuationState,
	RunScopeSnapshot,
} from "./runtime-primitives.ts";
import { flattenRunScopeOperations } from "./runtime-primitives.ts";

export type AgentRunDisposition = "completed" | "failed" | "aborted" | "suspended";
export type AgentRunStopReason =
	| "natural"
	| "error"
	| "cancelled"
	| "continuation_scheduled"
	| "settlement_rejected"
	| "operations_pending";

export interface AgentUsageReceipt {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface AgentFinalMessageReceipt {
	contentHash: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
	usage?: AgentUsageReceipt;
}

export interface AgentTranscriptReceipt {
	messageCount: number;
	entryCount: number;
	leafId?: string;
	sessionFile?: string;
	contentHash: string;
}

export interface AgentContinuationSettlement {
	pendingIds: string[];
	leasedIds: string[];
	terminalIds: string[];
	terminalIdsOmitted: number;
	idsHash: string;
	counts: Record<ContinuationState, number>;
}

export interface AgentOperationSettlement {
	pending: number;
	pendingByKind: Record<string, number>;
	registeredByKind: Record<string, number>;
}

/**
 * Product-neutral proof that one Pi run reached a stable runtime boundary.
 *
 * It proves Pi lifecycle only. A product may bind it to a Room Dispatch, but it
 * never declares a RoomTask, Root, Goal, review, or final user delivery complete.
 */
export interface AgentSettledReceiptV2 {
	schemaVersion: "pi.agent-settled.v2";
	receiptId: string;
	sessionId: string;
	runId: string;
	scopeId: string;
	generation: number;
	disposition: AgentRunDisposition;
	stopReason: AgentRunStopReason;
	finalMessage?: AgentFinalMessageReceipt;
	transcript: AgentTranscriptReceipt;
	continuations: AgentContinuationSettlement;
	operations: AgentOperationSettlement;
	settledAtMs: number;

	/** Compatibility fields retained for existing product consumers. */
	aborted: boolean;
	pendingOperations: number;
	operationCounts: Record<string, number>;
}

export interface AgentSettlementMessageInput {
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	timestamp?: unknown;
	usage?: unknown;
}

export interface CreateAgentSettledReceiptInput<TPayload = unknown> {
	sessionId: string;
	runId?: string;
	scope: RunScopeSnapshot;
	message?: AgentSettlementMessageInput;
	transcript: {
		messageCount: number;
		entryIds: string[];
		leafId?: string;
		sessionFile?: string;
	};
	continuations: ContinuationEnvelope<TPayload>[];
	/** Total registrations observed during the run, not only operations still pending. */
	operationCounts?: Record<string, number>;
	settleError?: string;
	settledAtMs?: number;
}

const CONTINUATION_ID_PREVIEW_LIMIT = 64;

function nonEmpty(value: string, name: string): string {
	const result = value.trim();
	if (!result) throw new Error(`${name} must be a non-empty string`);
	return result;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return value;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

async function continuationSettlement<TPayload>(
	items: readonly ContinuationEnvelope<TPayload>[],
): Promise<AgentContinuationSettlement> {
	const counts: Record<ContinuationState, number> = {
		pending: 0,
		leased: 0,
		completed: 0,
		cancelled: 0,
		expired: 0,
		failed: 0,
	};
	const pendingIds: string[] = [];
	const leasedIds: string[] = [];
	const terminalIds: string[] = [];
	for (const item of items) {
		counts[item.state] += 1;
		if (item.state === "pending") pendingIds.push(item.id);
		else if (item.state === "leased") leasedIds.push(item.id);
		else terminalIds.push(item.id);
	}
	pendingIds.sort();
	leasedIds.sort();
	terminalIds.sort();
	return {
		pendingIds: pendingIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		leasedIds: leasedIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		terminalIds: terminalIds.slice(-CONTINUATION_ID_PREVIEW_LIMIT),
		terminalIdsOmitted: Math.max(0, terminalIds.length - CONTINUATION_ID_PREVIEW_LIMIT),
		idsHash: await sha256(canonicalJson({ pendingIds, leasedIds, terminalIds })),
		counts,
	};
}

function countsByKind(operations: readonly CancelOperationSnapshot[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const operation of operations) counts[operation.kind] = (counts[operation.kind] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedRegisteredCounts(
	pendingByKind: Record<string, number>,
	explicit: Record<string, number> | undefined,
): Record<string, number> {
	if (!explicit) return { ...pendingByKind };
	const result: Record<string, number> = {};
	for (const [kind, count] of Object.entries(explicit)) {
		const normalizedKind = nonEmpty(kind, "operation kind");
		result[normalizedKind] = nonNegativeInteger(count, `operation count for ${normalizedKind}`);
	}
	for (const [kind, pending] of Object.entries(pendingByKind)) {
		if ((result[kind] ?? 0) < pending) {
			throw new Error(`registered operation count for ${kind} is lower than pending count`);
		}
	}
	return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedUsage(value: unknown): AgentUsageReceipt | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const input = Math.max(0, finiteNumber(source.input) ?? 0);
	const output = Math.max(0, finiteNumber(source.output) ?? 0);
	const cacheRead = Math.max(0, finiteNumber(source.cacheRead) ?? 0);
	const cacheWrite = Math.max(0, finiteNumber(source.cacheWrite) ?? 0);
	const reportedTotal = finiteNumber(source.totalTokens);
	const totalTokens = Math.max(0, reportedTotal ?? input + output + cacheRead + cacheWrite);
	if (input + output + cacheRead + cacheWrite + totalTokens === 0) return undefined;
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

export async function createAgentSettledReceipt<TPayload = unknown>(
	input: CreateAgentSettledReceiptInput<TPayload>,
): Promise<AgentSettledReceiptV2> {
	const sessionId = nonEmpty(input.sessionId, "sessionId");
	if (input.scope.sessionId !== sessionId) throw new Error("run scope belongs to a different Session");
	const runId = nonEmpty(input.runId?.trim() || input.scope.runId, "runId");
	const settledAtMs = input.settledAtMs ?? Date.now();
	if (!Number.isFinite(settledAtMs) || settledAtMs < 0) throw new Error("settledAtMs must be non-negative");

	const messageCount = nonNegativeInteger(input.transcript.messageCount, "transcript.messageCount");
	const entryIds = input.transcript.entryIds.map((id) => nonEmpty(id, "transcript entry id"));
	if (new Set(entryIds).size !== entryIds.length) throw new Error("transcript entry IDs must be unique");
	const continuations = await continuationSettlement(input.continuations);
	const messageStopReason = text(input.message?.stopReason);
	const messageError = text(input.message?.errorMessage);
	const settleError = text(input.settleError);
	const pendingRuntimeOperations = flattenRunScopeOperations(input.scope);
	const pendingByKind = countsByKind(pendingRuntimeOperations);
	const registeredByKind = normalizedRegisteredCounts(pendingByKind, input.operationCounts);
	const pendingOperations = pendingRuntimeOperations.length;
	const suspended = continuations.counts.pending > 0 || continuations.counts.leased > 0;
	const aborted = input.scope.cancelled || messageStopReason === "aborted";
	const failed = Boolean(settleError || messageError || messageStopReason === "error" || pendingOperations > 0);
	const disposition: AgentRunDisposition = aborted
		? "aborted"
		: failed
			? "failed"
			: suspended
				? "suspended"
				: "completed";
	const stopReason: AgentRunStopReason = settleError
		? "settlement_rejected"
		: aborted
			? "cancelled"
			: pendingOperations > 0
				? "operations_pending"
				: messageError || messageStopReason === "error"
					? "error"
					: suspended
						? "continuation_scheduled"
						: "natural";

	const finalMessage = input.message
		? {
				contentHash: await sha256(canonicalJson(input.message.content ?? null)),
				provider: text(input.message.provider),
				model: text(input.message.model),
				stopReason: messageStopReason,
				errorMessage: messageError ?? settleError,
				timestamp: finiteNumber(input.message.timestamp),
				usage: normalizedUsage(input.message.usage),
			}
		: undefined;
	const transcript: AgentTranscriptReceipt = {
		messageCount,
		entryCount: entryIds.length,
		leafId: text(input.transcript.leafId),
		sessionFile: text(input.transcript.sessionFile),
		contentHash: await sha256(
			canonicalJson({
				messageCount,
				entryIds,
				leafId: text(input.transcript.leafId),
			}),
		),
	};
	const operations: AgentOperationSettlement = {
		pending: pendingOperations,
		pendingByKind,
		registeredByKind,
	};
	const receiptIdentity = {
		schemaVersion: "pi.agent-settled.v2" as const,
		sessionId,
		runId,
		scopeId: input.scope.scopeId,
		generation: input.scope.generation,
		disposition,
		stopReason,
		finalMessage,
		transcript,
		continuations,
		operations,
	};
	return {
		...receiptIdentity,
		receiptId: `pi-settled:${await sha256(canonicalJson(receiptIdentity))}`,
		settledAtMs,
		aborted,
		pendingOperations,
		operationCounts: registeredByKind,
	};
}
