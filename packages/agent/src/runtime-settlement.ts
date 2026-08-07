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
	| "continuation_unsettled"
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
	lastEntryId?: string;
	lineageHash: string;
	/** Compatibility alias for the first V2 draft. */
	contentHash: string;
}

export interface AgentContinuationSettlement {
	generation: number;
	pendingIds: string[];
	readyIds: string[];
	scheduledIds: string[];
	leasedIds: string[];
	terminalIds: string[];
	terminalIdsOmitted: number;
	nextScheduledAt?: number;
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
		entryCount: number;
		leafId?: string;
		lastEntryId?: string;
	};
	continuations: ContinuationEnvelope<TPayload>[];
	continuationGeneration: number;
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
	options: { generation: number; settledAtMs: number },
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
	const readyIds: string[] = [];
	const scheduledIds: string[] = [];
	const leasedIds: string[] = [];
	const terminalIds: string[] = [];
	let nextScheduledAt: number | undefined;
	for (const item of items) {
		counts[item.state] += 1;
		if (item.state === "pending") {
			pendingIds.push(item.id);
			const staleGeneration = item.cancelGeneration !== options.generation;
			const deadlineExpired = item.deadline !== undefined && item.deadline < options.settledAtMs;
			const delayed = item.notBefore !== undefined && item.notBefore > options.settledAtMs;
			if (!staleGeneration && !deadlineExpired && delayed) {
				scheduledIds.push(item.id);
				if (nextScheduledAt === undefined || item.notBefore! < nextScheduledAt) nextScheduledAt = item.notBefore;
			} else {
				readyIds.push(item.id);
			}
		} else if (item.state === "leased") leasedIds.push(item.id);
		else terminalIds.push(item.id);
	}
	for (const values of [pendingIds, readyIds, scheduledIds, leasedIds, terminalIds]) values.sort();
	return {
		generation: options.generation,
		pendingIds: pendingIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		readyIds: readyIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		scheduledIds: scheduledIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		leasedIds: leasedIds.slice(0, CONTINUATION_ID_PREVIEW_LIMIT),
		terminalIds: terminalIds.slice(-CONTINUATION_ID_PREVIEW_LIMIT),
		terminalIdsOmitted: Math.max(0, terminalIds.length - CONTINUATION_ID_PREVIEW_LIMIT),
		nextScheduledAt,
		idsHash: await sha256(canonicalJson({ pendingIds, readyIds, scheduledIds, leasedIds, terminalIds })),
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
	if (!input.scope.sealed) throw new Error("run scope must be sealed before settlement");
	const runId = nonEmpty(input.runId?.trim() || input.scope.runId, "runId");
	const settledAtMs = input.settledAtMs ?? Date.now();
	if (!Number.isFinite(settledAtMs) || settledAtMs < 0) throw new Error("settledAtMs must be non-negative");

	const continuationGeneration = nonNegativeInteger(input.continuationGeneration, "continuationGeneration");
	const messageCount = nonNegativeInteger(input.transcript.messageCount, "transcript.messageCount");
	const entryCount = nonNegativeInteger(input.transcript.entryCount, "transcript.entryCount");
	const leafId = text(input.transcript.leafId);
	const lastEntryId = text(input.transcript.lastEntryId);
	const continuations = await continuationSettlement(input.continuations, {
		generation: continuationGeneration,
		settledAtMs,
	});
	const messageStopReason = text(input.message?.stopReason);
	const messageError = text(input.message?.errorMessage);
	const settleError = text(input.settleError);
	const pendingRuntimeOperations = flattenRunScopeOperations(input.scope);
	const pendingByKind = countsByKind(pendingRuntimeOperations);
	const registeredByKind = normalizedRegisteredCounts(pendingByKind, input.operationCounts);
	const pendingOperations = pendingRuntimeOperations.length;
	const continuationUnsettled = continuations.readyIds.length > 0 || continuations.leasedIds.length > 0;
	const suspended = continuations.scheduledIds.length > 0 && !continuationUnsettled;
	const aborted = input.scope.cancelled || messageStopReason === "aborted";
	const failed = Boolean(
		settleError || messageError || messageStopReason === "error" || pendingOperations > 0 || continuationUnsettled,
	);
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
				: continuationUnsettled
					? "continuation_unsettled"
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
	const lineageHash = await sha256(canonicalJson({ messageCount, entryCount, leafId, lastEntryId }));
	const transcript: AgentTranscriptReceipt = {
		messageCount,
		entryCount,
		leafId,
		lastEntryId,
		lineageHash,
		contentHash: lineageHash,
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
