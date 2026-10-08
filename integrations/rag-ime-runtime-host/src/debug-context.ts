import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface DebugTurnIdentity {
	turnId: string;
	clientMessageId?: string;
}

export interface PiDebugProviderExchange {
	index: number;
	capturedAtMs: number;
	payload?: unknown;
	status?: number;
	headers?: Record<string, unknown>;
}

export interface PiDebugContextDelta {
	omitted?: boolean;
	baseCallIndex?: number;
	commonPrefixMessages: number;
	removedMessageCount: number;
	addedMessageCount: number;
	addedMessages: unknown[];
	prefixBytes: number;
	prefixSha256: string;
	currentBytes: number;
	deltaBytes: number;
	duplicateBytes: number;
}

export interface PiProviderRequestReceipt {
	schemaVersion: "rag-ime.provider-request-receipt.v1";
	index: number;
	capturedAtMs: number;
	model: Record<string, unknown>;
	streamOptions: unknown;
	payload?: unknown;
	usage?: Record<string, number>;
}

export interface PiDebugModelCall {
	index: number;
	runtimeTurnIndex?: number;
	capturedAtMs: number;
	updatedAtMs: number;
	completedAtMs?: number;
	contextMessages: unknown;
	providerContext?: unknown;
	contextDelta: PiDebugContextDelta;
	providerExchanges: PiDebugProviderExchange[];
	assistantMessage?: unknown;
}

export interface PiDebugToolExecution {
	toolCallId: string;
	toolName: string;
	modelCallIndex?: number;
	runtimeTurnIndex?: number;
	startedAtMs: number;
	endedAtMs?: number;
	startSequence: number;
	endSequence?: number;
	args: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "completed" | "failed";
	updates: Array<{ capturedAtMs: number; partialResult: unknown }>;
}

export interface PiDebugToolBatch {
	id: string;
	modelCallIndex?: number;
	runtimeTurnIndex?: number;
	stage: number;
	executionMode: "parallel" | "serial";
	startedAtMs: number;
	endedAtMs?: number;
	status: "running" | "completed" | "failed";
	toolCallIds: string[];
}

export interface PiDebugContextRecord {
	schemaVersion: "rag-ime.context-inspection.v2";
	sessionId: string;
	turnId: string;
	clientMessageId: string;
	lifecycle?: {
		kind: "compaction";
		reason?: string;
		status: "running" | "completed" | "failed" | "aborted";
		error?: string;
	};
	capturedAtMs: number;
	updatedAtMs: number;
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: unknown;
	model?: Record<string, unknown>;
	activeTools: string[];
	toolSchemas: Array<Record<string, unknown>>;
	skillCatalog: Array<Record<string, unknown>>;
	loadedSkillReceipts: Array<Record<string, unknown>>;
	contributionRefs: Array<Record<string, unknown>>;
	contextWindows: Array<{ index: number; capturedAtMs: number; messages: unknown }>;
	providerRequests: Array<{ index: number; capturedAtMs: number; payload: unknown }>;
	providerRequestReceipts: PiProviderRequestReceipt[];
	cacheEvidence: Array<{
		requestIndex: number;
		prefixSha256: string;
		prefixBytes: number;
		deltaBytes: number;
		duplicateBytes: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		capability: "reported" | "unsupported";
		cacheHitProven: boolean;
	}>;
	modelCalls: PiDebugModelCall[];
	toolExecutions: PiDebugToolExecution[];
	toolBatches: PiDebugToolBatch[];
	inspectionOmissions?: PiDebugContextOmission[];
}

export interface PiDebugContextOmission {
	reason: string;
	limitBytes: number;
	path?: string;
	turnId?: string;
	bytes?: number;
}

export interface PiDebugContextSummary {
	turnId: string;
	clientMessageId: string;
	capturedAtMs: number;
	updatedAtMs: number;
	modelCallCount: number;
	providerRequestCount: number;
	toolCallCount: number;
	runningToolCount: number;
	omitted?: boolean;
}

export interface PiDebugContextStorageOptions {
	directory?: string;
	maxBytes?: number;
	maxCallsPerTurn?: number;
	contributionRefs?: Array<Record<string, unknown>>;
}

export interface PiDebugContextStorageStatus {
	persistent: boolean;
	directory: string;
	maxBytes: number;
	usedBytes: number;
	fileCount: number;
	lastPersistedAtMs?: number;
	error?: string;
	limits: { captureBytes: number; snapshotBytes: number; retainedBytes: number };
	retainedBytes: number;
	omissions: PiDebugContextOmission[];
	omissionCount: number;
}

const MAX_TURNS = 8;
const MAX_CALLS_PER_TURN = 12;
const MAX_CONFIGURED_CALLS_PER_TURN = 256;
const MAX_TOOLS_PER_TURN = 96;
const MAX_TOOL_UPDATES = 12;
// The archive quota is not a heap budget. Count repeated references and object
// overhead before cloning/serializing; a multi-GiB archive must stay lazy.
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_INSPECTION_NODES = 65_536;
const MAX_INSPECTION_DEPTH = 64;
const MAX_OMISSIONS = 32;
const DEFAULT_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_STORAGE_BYTES = 64 * 1024 * 1024 * 1024;
let storageTaskQueue: Promise<void> = Promise.resolve();

/**
 * Captures the final extension/provider boundary for local debugging and can
 * mirror bounded snapshots to a private directory. Records never enter Pi JSONL
 * or the product observation database.
 */
export class PiDebugContextRecorder {
	private readonly records = new Map<string, PiDebugContextRecord>();
	private readonly sessionId: string;
	private readonly activeTurn: () => DebugTurnIdentity | undefined;
	private readonly storageDirectory: string;
	private readonly storageMaxBytes: number;
	private readonly maxCallsPerTurn: number;
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingPersistence: Promise<void> = Promise.resolve();
	private storageUsedBytes = 0;
	private storageFileCount = 0;
	private storageError = "";
	private lastPersistedAtMs: number | undefined;
	private runtimeTurnIndex: number | undefined;
	private eventSequence = 0;
	private providerCallSequence = 0;
	private previousContextMessages: unknown;
	private lifecycleTurnId: string | undefined;
	private lifecycleSequence = 0;
	private readonly contributionRefs: Array<Record<string, unknown>>;
	private readonly omissions: PiDebugContextOmission[] = [];
	private readonly deferredSnapshots = new Set<string>();
	private omissionCount = 0;
	private retainedBytes = 0;
	private readonly pendingRecords = new Map<string, PiDebugContextRecord>();
	private persistenceQueued = false;

	constructor(
		sessionId: string,
		activeTurn: () => DebugTurnIdentity | undefined,
		storage: PiDebugContextStorageOptions = {},
	) {
		this.sessionId = sessionId;
		this.activeTurn = activeTurn;
		this.storageDirectory = storage.directory?.trim() ?? "";
		const requestedMax = Number.isFinite(storage.maxBytes) ? Math.floor(storage.maxBytes ?? 0) : 0;
		this.storageMaxBytes = Math.min(MAX_STORAGE_BYTES, Math.max(1, requestedMax || DEFAULT_STORAGE_BYTES));
		const requestedCalls = Number.isFinite(storage.maxCallsPerTurn) ? Math.floor(storage.maxCallsPerTurn ?? 0) : 0;
		this.maxCallsPerTurn = Math.min(MAX_CONFIGURED_CALLS_PER_TURN, Math.max(1, requestedCalls || MAX_CALLS_PER_TURN));
		this.contributionRefs = inspectionRecords(storage.contributionRefs ?? []);
		this.pendingPersistence = this.queueStorageTask(() => this.restorePersistedRecords());
	}

	extension(): ExtensionFactory {
		return (pi) => {
			const refreshToolSurface = (record: PiDebugContextRecord): void => {
				const activeTools = pi.getActiveTools();
				const activeSet = new Set(activeTools);
				record.activeTools = stringArray(cloneForInspection(activeTools));
				record.toolSchemas = inspectionRecords(
					pi
						.getAllTools()
						.filter((tool) => activeSet.has(tool.name))
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
							promptGuidelines: tool.promptGuidelines,
						})),
				);
			};
			pi.on("before_agent_start", (event, context) => {
				const identity = this.activeTurn();
				if (!identity?.turnId) return;
				const now = Date.now();
				const activeTools = pi.getActiveTools();
				this.runtimeTurnIndex = undefined;
				this.eventSequence = 0;
				this.records.delete(identity.turnId);
				const promptOptions = event.systemPromptOptions;
				this.records.set(identity.turnId, {
					schemaVersion: "rag-ime.context-inspection.v2",
					sessionId: this.sessionId,
					turnId: identity.turnId,
					clientMessageId: identity.clientMessageId ?? "",
					capturedAtMs: now,
					updatedAtMs: now,
					prompt: inspectionText(event.prompt),
					systemPrompt: inspectionText(event.systemPrompt),
					systemPromptOptions: cloneForInspection(event.systemPromptOptions),
					model: context.model
						? {
								provider: context.model.provider,
								id: context.model.id,
								name: context.model.name,
								api: context.model.api,
								contextWindow: context.model.contextWindow,
								maxTokens: context.model.maxTokens,
							}
						: undefined,
					activeTools: stringArray(cloneForInspection(activeTools)),
					toolSchemas: [],
					skillCatalog: inspectionRecords(
						(promptOptions?.skills ?? []).map((skill) => ({
							name: String(skill.name ?? ""),
							description: String(skill.description ?? ""),
							source: skill.sourceInfo,
						})),
					),
					loadedSkillReceipts: [],
					contributionRefs: structuredClone(this.contributionRefs),
					contextWindows: [],
					providerRequests: [],
					providerRequestReceipts: [],
					cacheEvidence: [],
					modelCalls: [],
					toolExecutions: [],
					toolBatches: [],
				});
				const record = this.records.get(identity.turnId);
				if (record) refreshToolSurface(record);
				this.trim();
			});

			pi.on("turn_start", (event) => {
				this.runtimeTurnIndex = event.turnIndex;
				this.touch();
			});

			pi.on("context", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const messages = this.capture(event.messages);
				const previousIndex = this.providerCallSequence || undefined;
				const index = ++this.providerCallSequence;
				record.contextWindows.push({ index, capturedAtMs: now, messages });
				if (record.contextWindows.length > this.maxCallsPerTurn) record.contextWindows.shift();
				record.modelCalls.push({
					index,
					runtimeTurnIndex: this.runtimeTurnIndex,
					capturedAtMs: now,
					updatedAtMs: now,
					contextMessages: messages,
					contextDelta: contextDelta(this.previousContextMessages, messages, previousIndex),
					providerExchanges: [],
				});
				this.previousContextMessages = messages;
				if (record.modelCalls.length > this.maxCallsPerTurn) record.modelCalls.shift();
				record.updatedAtMs = now;
				this.trim();
			});

			pi.on("provider_context_inspection", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const call = record.lifecycle
					? this.startModelCall(record, now, event.context.messages)
					: this.ensureModelCall(record, now);
				call.providerContext = this.capture(event.context);
				call.updatedAtMs = now;
				if (record.lifecycle) {
					const messages = plainRecord(call.providerContext)?.messages;
					record.systemPrompt = Array.isArray(messages)
						? inspectionText(getCurrentSystemPrompt(messages as typeof event.context.messages))
						: "[diagnostic provider context omitted]";
					record.model = {
						provider: event.model.provider,
						id: event.model.id,
						name: event.model.name,
						api: event.model.api,
						contextWindow: event.model.contextWindow,
						maxTokens: event.model.maxTokens,
					};
				}
				record.updatedAtMs = now;
				this.trim();
			});

			pi.on("before_provider_request", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				refreshToolSurface(record);
				const index = (record.providerRequestReceipts.at(-1)?.index ?? 0) + 1;
				const payload = this.capture(event.payload);
				record.providerRequestReceipts.push({
					schemaVersion: "rag-ime.provider-request-receipt.v1",
					index,
					capturedAtMs: now,
					model: structuredClone(record.model ?? {}),
					streamOptions: {},
					payload,
				});
				if (record.providerRequestReceipts.length > this.maxCallsPerTurn) {
					record.providerRequestReceipts.shift();
				}
				record.providerRequests.push({ index, capturedAtMs: now, payload });
				if (record.providerRequests.length > this.maxCallsPerTurn) record.providerRequests.shift();
				const call = this.ensureModelCall(record, now);
				call.providerExchanges.push({ index, capturedAtMs: now, payload });
				if (call.providerExchanges.length > this.maxCallsPerTurn) call.providerExchanges.shift();
				call.updatedAtMs = now;
				record.updatedAtMs = now;
				this.trim();
			});

			pi.on("after_provider_response", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const call = this.ensureModelCall(record, now);
				let exchange = call.providerExchanges.at(-1);
				if (!exchange || exchange.status !== undefined) {
					exchange = {
						index: (record.providerRequests.at(-1)?.index ?? 0) + 1,
						capturedAtMs: now,
					};
					call.providerExchanges.push(exchange);
					if (call.providerExchanges.length > this.maxCallsPerTurn) call.providerExchanges.shift();
				}
				exchange.status = event.status;
				exchange.headers = this.capture(event.headers) as Record<string, unknown>;
				call.updatedAtMs = now;
				record.updatedAtMs = now;
				this.schedulePersist(250);
			});

			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const call = this.ensureModelCall(record, now);
				call.assistantMessage = this.capture(event.message);
				const usage = numericUsage((event.message as { usage?: unknown }).usage);
				const request = record.providerRequestReceipts.at(-1);
				if (request) request.usage = usage;
				const delta = call.contextDelta;
				record.cacheEvidence.push({
					requestIndex: request?.index ?? call.index,
					prefixSha256: delta.prefixSha256,
					prefixBytes: delta.prefixBytes,
					deltaBytes: delta.deltaBytes,
					duplicateBytes: delta.duplicateBytes,
					inputTokens: usage.input ?? 0,
					outputTokens: usage.output ?? 0,
					cacheReadTokens: usage.cacheRead ?? 0,
					cacheWriteTokens: usage.cacheWrite ?? 0,
					capability:
						(usage.totalTokens ?? 0) > 0 ||
						(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0
							? "reported"
							: "unsupported",
					cacheHitProven: (usage.cacheRead ?? 0) > 0,
				});
				if (record.cacheEvidence.length > this.maxCallsPerTurn) record.cacheEvidence.shift();
				call.updatedAtMs = now;
				record.updatedAtMs = now;
				this.schedulePersist(250);
			});

			pi.on("tool_execution_start", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const call = record.modelCalls.at(-1);
				record.toolExecutions.push({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					modelCallIndex: call?.index,
					runtimeTurnIndex: this.runtimeTurnIndex,
					startedAtMs: now,
					startSequence: ++this.eventSequence,
					args: this.capture(event.args),
					status: "running",
					updates: [],
				});
				if (record.toolExecutions.length > MAX_TOOLS_PER_TURN) record.toolExecutions.shift();
				this.refreshToolBatches(record, now);
			});

			pi.on("tool_execution_update", (event) => {
				const record = this.current();
				const tool = record?.toolExecutions.find((item) => item.toolCallId === event.toolCallId);
				if (!record || !tool) return;
				const now = Date.now();
				tool.updates.push({ capturedAtMs: now, partialResult: this.capture(event.partialResult) });
				if (tool.updates.length > MAX_TOOL_UPDATES) tool.updates.shift();
				this.refreshToolBatches(record, now);
			});

			pi.on("tool_execution_end", (event) => {
				const record = this.current();
				const tool = record?.toolExecutions.find((item) => item.toolCallId === event.toolCallId);
				if (!record || !tool) return;
				const now = Date.now();
				tool.endedAtMs = now;
				tool.endSequence = ++this.eventSequence;
				tool.result = this.capture(event.result);
				tool.isError = event.isError;
				tool.status = event.isError ? "failed" : "completed";
				if (event.toolName === "skill_load" && !event.isError) {
					const details = (event.result as { details?: unknown } | undefined)?.details;
					const receipt = this.capture(details);
					if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
						record.loadedSkillReceipts.push(receipt as Record<string, unknown>);
					}
				}
				this.refreshToolBatches(record, now);
				this.schedulePersist(250);
			});

			pi.on("turn_end", () => {
				const record = this.current();
				const call = record?.modelCalls.at(-1);
				if (!record || !call) return;
				const now = Date.now();
				call.completedAtMs = now;
				call.updatedAtMs = now;
				this.refreshToolBatches(record, now);
				this.schedulePersist(10);
			});
		};
	}

	get(turnId?: string): PiDebugContextRecord | undefined {
		this.trim();
		const record = turnId ? this.records.get(turnId) : [...this.records.values()].at(-1);
		// trim() enforces the whole-record budget before allocating the UI copy.
		return record ? structuredClone(record) : undefined;
	}

	/** Read-only candidate for a compact Runtime response. The complete reader
	 * remains get(); callers need a complete-history path before using this view. */
	getRuntimeProjection(turnId?: string): PiDebugContextRecord | undefined {
		const record = turnId ? this.records.get(turnId) : [...this.records.values()].at(-1);
		if (!record) return undefined;
		let omitted = false;
		const omit = (value: unknown, path: string): unknown => {
			if (value === undefined || plainRecord(value)?.omitted === true || (Array.isArray(value) && !value.length))
				return value;
			omitted = true;
			return { omitted: true, reason: "runtime_projection", limitBytes: 0, path, turnId: record.turnId };
		};
		const latestCall = record.modelCalls.at(-1);
		const projection: PiDebugContextRecord = {
			...record,
			contextWindows: record.contextWindows.map((window, position) => ({
				...window,
				messages: omit(window.messages, `contextWindows.${position}.messages`),
			})),
			providerRequests: record.providerRequests.map((request, position) => ({
				...request,
				payload: omit(request.payload, `providerRequests.${position}.payload`),
			})),
			providerRequestReceipts: record.providerRequestReceipts.map((request, position) => ({
				...request,
				payload: omit(request.payload, `providerRequestReceipts.${position}.payload`),
			})),
			modelCalls: record.modelCalls.map((call, position) => {
				if (call.contextDelta.addedMessages.length) omitted = true;
				return {
					...call,
					// These boundaries can differ after Provider transformations. Keep
					// both latest bodies rather than substitute one as exact evidence.
					contextMessages:
						call === latestCall
							? call.contextMessages
							: omit(call.contextMessages, `modelCalls.${position}.contextMessages`),
					providerContext:
						call === latestCall
							? call.providerContext
							: omit(call.providerContext, `modelCalls.${position}.providerContext`),
					contextDelta: {
						...call.contextDelta,
						addedMessages: [],
						...(call.contextDelta.addedMessages.length ? { omitted: true } : {}),
					},
					assistantMessage: omit(call.assistantMessage, `modelCalls.${position}.assistantMessage`),
					providerExchanges: call.providerExchanges.map((exchange, exchangePosition) => ({
						...exchange,
						payload: omit(
							exchange.payload,
							`modelCalls.${position}.providerExchanges.${exchangePosition}.payload`,
						),
					})),
				};
			}),
			toolExecutions: record.toolExecutions.map((tool, position) => ({
				...tool,
				result: omit(tool.result, `toolExecutions.${position}.result`),
				updates: tool.updates.map((update, updatePosition) => ({
					...update,
					partialResult: omit(
						update.partialResult,
						`toolExecutions.${position}.updates.${updatePosition}.partialResult`,
					),
				})),
			})),
		};
		if (omitted)
			projection.inspectionOmissions = [
				...(record.inspectionOmissions ?? []),
				{ reason: "runtime_projection", limitBytes: 0, turnId: record.turnId },
			];
		return structuredClone(projection);
	}

	beginLifecycle(kind: "compaction", details: { reason?: string } = {}): string {
		const now = Date.now();
		const turnId = `lifecycle:${kind}:${now}:${++this.lifecycleSequence}`;
		this.lifecycleTurnId = turnId;
		this.runtimeTurnIndex = undefined;
		this.eventSequence = 0;
		this.records.set(turnId, {
			schemaVersion: "rag-ime.context-inspection.v2",
			sessionId: this.sessionId,
			turnId,
			clientMessageId: "",
			lifecycle: {
				kind,
				reason: details.reason === undefined ? undefined : inspectionText(details.reason),
				status: "running",
			},
			capturedAtMs: now,
			updatedAtMs: now,
			prompt: "",
			systemPrompt: "",
			systemPromptOptions: {},
			activeTools: [],
			toolSchemas: [],
			skillCatalog: [],
			loadedSkillReceipts: [],
			contributionRefs: structuredClone(this.contributionRefs),
			contextWindows: [],
			providerRequests: [],
			providerRequestReceipts: [],
			cacheEvidence: [],
			modelCalls: [],
			toolExecutions: [],
			toolBatches: [],
		});
		this.trim();
		return turnId;
	}

	endLifecycle(kind: "compaction", status: "completed" | "failed" | "aborted", error?: string): void {
		const turnId = this.lifecycleTurnId;
		const record = turnId ? this.records.get(turnId) : undefined;
		if (!record || record.lifecycle?.kind !== kind) return;
		const now = Date.now();
		record.lifecycle.status = status;
		record.lifecycle.error = error === undefined ? undefined : inspectionText(error);
		record.updatedAtMs = now;
		const call = record.modelCalls.at(-1);
		if (call && call.completedAtMs === undefined) {
			call.completedAtMs = now;
			call.updatedAtMs = now;
		}
		this.queuePersist(record);
		this.lifecycleTurnId = undefined;
	}

	list(): PiDebugContextSummary[] {
		this.trim();
		return [...this.records.values()].reverse().map((record) => ({
			turnId: record.turnId,
			clientMessageId: record.clientMessageId,
			capturedAtMs: record.capturedAtMs,
			updatedAtMs: record.updatedAtMs,
			modelCallCount: record.modelCalls.length,
			providerRequestCount: record.providerRequests.length,
			toolCallCount: record.toolExecutions.length,
			runningToolCount: record.toolExecutions.filter((tool) => tool.status === "running").length,
			...(record.inspectionOmissions?.length ? { omitted: true } : {}),
		}));
	}

	loadedSkillRecoveryReceipts(): Array<Record<string, unknown>> {
		const receipts = new Map<string, Record<string, unknown>>();
		for (const record of this.records.values()) {
			for (const receipt of record.loadedSkillReceipts) {
				const name = typeof receipt.name === "string" ? receipt.name.trim() : "";
				const revision = typeof receipt.contentRevision === "string" ? receipt.contentRevision.trim() : "";
				if (!name || !revision) continue;
				receipts.set(`${name}\u001f${revision}`, structuredClone(receipt));
			}
		}
		return [...receipts.values()].sort((left, right) =>
			String(left.name ?? "").localeCompare(String(right.name ?? "")),
		);
	}

	storage(): PiDebugContextStorageStatus {
		return {
			persistent: Boolean(this.storageDirectory) && !this.storageError,
			directory: this.storageDirectory,
			maxBytes: this.storageMaxBytes,
			usedBytes: this.storageUsedBytes,
			fileCount: this.storageFileCount,
			limits: {
				captureBytes: MAX_CAPTURE_BYTES,
				snapshotBytes: Math.min(MAX_SNAPSHOT_BYTES, this.storageMaxBytes),
				retainedBytes: MAX_RETAINED_BYTES,
			},
			retainedBytes: this.retainedBytes,
			omissions: this.omissions.map((item) => ({ ...item })),
			omissionCount: this.omissionCount,
			lastPersistedAtMs: this.lastPersistedAtMs,
			...(this.storageError ? { error: this.storageError } : {}),
		};
	}

	clear(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		this.queuePersist([...this.records.values()].at(-1));
		this.records.clear();
		this.retainedBytes = 0;
		this.runtimeTurnIndex = undefined;
		this.eventSequence = 0;
		this.providerCallSequence = 0;
		this.previousContextMessages = undefined;
		this.lifecycleTurnId = undefined;
		this.lifecycleSequence = 0;
	}

	async flush(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
			this.queuePersist([...this.records.values()].at(-1));
		}
		await this.pendingPersistence;
	}

	private current(): PiDebugContextRecord | undefined {
		if (this.lifecycleTurnId) {
			return this.records.get(this.lifecycleTurnId);
		}
		const identity = this.activeTurn();
		return identity?.turnId ? this.records.get(identity.turnId) : undefined;
	}

	private ensureModelCall(record: PiDebugContextRecord, now: number): PiDebugModelCall {
		const current = record.modelCalls.at(-1);
		if (current) return current;
		return this.startModelCall(record, now, []);
	}

	private startModelCall(record: PiDebugContextRecord, now: number, messages: unknown): PiDebugModelCall {
		const previousIndex = this.providerCallSequence || undefined;
		const index = ++this.providerCallSequence;
		const contextMessages = this.capture(messages);
		const call: PiDebugModelCall = {
			index,
			runtimeTurnIndex: this.runtimeTurnIndex,
			capturedAtMs: now,
			updatedAtMs: now,
			contextMessages,
			contextDelta: contextDelta(this.previousContextMessages, contextMessages, previousIndex),
			providerExchanges: [],
		};
		this.previousContextMessages = contextMessages;
		record.modelCalls.push(call);
		if (record.modelCalls.length > this.maxCallsPerTurn) record.modelCalls.shift();
		return call;
	}

	private touch(): void {
		const record = this.current();
		if (record) record.updatedAtMs = Date.now();
	}

	private refreshToolBatches(record: PiDebugContextRecord, now: number): void {
		record.toolBatches = buildToolBatches(record.toolExecutions);
		record.updatedAtMs = now;
		this.trim();
	}

	private schedulePersist(delayMs: number): void {
		this.trim();
		if (!this.storageDirectory) return;
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.queuePersist([...this.records.values()].at(-1));
		}, delayMs);
		this.persistTimer.unref?.();
	}

	private queuePersist(record: PiDebugContextRecord | undefined): void {
		if (!record || !this.storageDirectory) return;
		this.trim();
		// Coalesce repeated checkpoints. A slow disk must not retain an unbounded
		// chain of closures holding retired Session records.
		this.pendingRecords.set(record.turnId, record);
		while (this.pendingRecords.size > MAX_TURNS) {
			const oldest = this.pendingRecords.keys().next().value;
			if (!oldest) break;
			this.pendingRecords.delete(oldest);
			this.noteOmission({ reason: "persistence_queue_budget", turnId: oldest, limitBytes: MAX_RETAINED_BYTES });
		}
		let queuedBytes = 0;
		for (const pending of [...this.pendingRecords.values()].reverse()) {
			const measured = inspectionSize(pending, MAX_SNAPSHOT_BYTES);
			queuedBytes += measured.bytes;
			if (measured.reason || queuedBytes > MAX_RETAINED_BYTES) {
				this.pendingRecords.delete(pending.turnId);
				this.noteOmission({
					reason: "persistence_queue_budget",
					turnId: pending.turnId,
					limitBytes: MAX_RETAINED_BYTES,
				});
			}
		}
		if (this.persistenceQueued) return;
		this.persistenceQueued = true;
		this.pendingPersistence = this.queueStorageTask(async () => {
			try {
				while (this.pendingRecords.size) {
					const next = this.pendingRecords.values().next().value;
					if (!next) break;
					this.pendingRecords.delete(next.turnId);
					await this.persistRecord(next);
				}
			} finally {
				this.persistenceQueued = false;
			}
		});
	}

	private queueStorageTask(task: () => Promise<void>): Promise<void> {
		const pending = storageTaskQueue
			.catch(() => undefined)
			.then(task)
			.catch((error: unknown) => {
				this.storageError = error instanceof Error ? error.message : String(error);
			});
		storageTaskQueue = pending;
		return pending;
	}

	private async persistRecord(record: PiDebugContextRecord): Promise<void> {
		let temporary = "";
		try {
			const limit = Math.min(MAX_SNAPSHOT_BYTES, this.storageMaxBytes);
			const measured = inspectionSize(record, limit - 1);
			if (measured.reason) {
				this.noteOmission({ reason: "serialization_budget", turnId: record.turnId, limitBytes: limit });
				return;
			}
			const serialized = `${JSON.stringify(record)}\n`;
			const size = Buffer.byteLength(serialized);
			if (size > this.storageMaxBytes) {
				throw new Error(`debug context snapshot exceeds storage cap (${size} bytes)`);
			}
			const sessionDirectory = join(this.storageDirectory, safePathSegment(this.sessionId));
			await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
			const target = join(sessionDirectory, `${record.capturedAtMs}-${safePathSegment(record.turnId)}.json`);
			await this.pruneStorage(size);
			temporary = `${target}.tmp-${process.pid}`;
			await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, target);
			this.lastPersistedAtMs = Date.now();
			this.storageError = "";
			await this.refreshStorageUsage();
		} catch (error) {
			if (temporary) {
				try {
					await unlink(temporary);
				} catch {
					// Keep the original persistence error.
				}
			}
			this.storageError = error instanceof Error ? error.message : String(error);
		}
	}

	private async pruneStorage(incomingBytes: number): Promise<void> {
		const files = await storedDebugFiles(this.storageDirectory);
		let used = files.reduce((total, item) => total + item.size, 0);
		for (const file of files.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)) {
			if (used + incomingBytes <= this.storageMaxBytes) break;
			// Deferring an unsafe historical input is not permission to erase it on
			// the next checkpoint. The archive may instead become temporarily full.
			if (file.size > Math.min(MAX_SNAPSHOT_BYTES, this.storageMaxBytes) || this.deferredSnapshots.has(file.path))
				continue;
			try {
				await unlink(file.path);
				used -= file.size;
			} catch {
				// A concurrent reader may already have removed the oldest snapshot.
			}
		}
		if (used + incomingBytes > this.storageMaxBytes) {
			throw new Error("debug context storage cannot be pruned below its configured cap");
		}
	}

	private async restorePersistedRecords(): Promise<void> {
		if (!this.storageDirectory) return;
		try {
			const sessionDirectory = join(this.storageDirectory, safePathSegment(this.sessionId));
			const latest = (await storedDebugFiles(sessionDirectory))
				.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
				.slice(0, MAX_TURNS);
			const restored: PiDebugContextRecord[] = [];
			const snapshotLimit = Math.min(MAX_SNAPSHOT_BYTES, this.storageMaxBytes);
			const restoreLimit = Math.min(MAX_RETAINED_BYTES, this.storageMaxBytes);
			let readBytes = 0;
			let retainedBytes = 0;
			for (const file of latest) {
				const remaining = restoreLimit - Math.max(readBytes, retainedBytes);
				if (file.size > Math.min(snapshotLimit, remaining)) {
					this.noteOmission({
						reason: file.size > snapshotLimit ? "snapshot_byte_budget" : "restore_byte_budget",
						path: file.path,
						bytes: file.size,
						limitBytes: file.size > snapshotLimit ? snapshotLimit : restoreLimit,
					});
					continue;
				}
				try {
					const loaded = await readDebugSnapshot(file.path, Math.min(snapshotLimit, remaining));
					readBytes += loaded.bytes;
					if (loaded.text === undefined) {
						this.noteOmission({
							reason: "snapshot_changed_or_oversized",
							path: file.path,
							bytes: loaded.bytes,
							limitBytes: snapshotLimit,
						});
						continue;
					}
					const parsed = JSON.parse(loaded.text) as unknown;
					const measured = inspectionSize(parsed, Math.min(snapshotLimit, restoreLimit - retainedBytes));
					if (measured.reason) {
						this.noteOmission({
							reason: `restore_${measured.reason}`,
							path: file.path,
							bytes: loaded.bytes,
							limitBytes: restoreLimit,
						});
						continue;
					}
					const normalized = normalizeDebugContextRecord(parsed, this.maxCallsPerTurn);
					if (normalized?.sessionId !== this.sessionId) continue;
					const normalizedSize = inspectionSize(normalized, Math.min(snapshotLimit, restoreLimit - retainedBytes));
					if (normalizedSize.reason) {
						this.noteOmission({
							reason: "restore_byte_budget",
							path: file.path,
							bytes: loaded.bytes,
							limitBytes: restoreLimit,
						});
						continue;
					}
					retainedBytes += normalizedSize.bytes;
					restored.push(normalized);
				} catch {
					this.noteOmission({
						reason: "snapshot_unavailable",
						path: file.path,
						bytes: file.size,
						limitBytes: snapshotLimit,
					});
				}
			}
			const merged = [...restored, ...this.records.values()].sort(
				(left, right) => left.capturedAtMs - right.capturedAtMs,
			);
			this.records.clear();
			for (const record of merged) this.records.set(record.turnId, record);
			this.trim();
			await this.refreshStorageUsage();
			this.storageError = "";
		} catch (error) {
			this.storageError = error instanceof Error ? error.message : String(error);
		}
	}

	private async refreshStorageUsage(): Promise<void> {
		const files = await storedDebugFiles(this.storageDirectory);
		this.storageUsedBytes = files.reduce((total, item) => total + item.size, 0);
		this.storageFileCount = files.length;
	}

	private trim(): void {
		while (this.records.size > MAX_TURNS) {
			const oldest = this.records.keys().next().value;
			if (typeof oldest !== "string") break;
			this.records.delete(oldest);
		}
		const sizes = new Map<string, number>();
		for (const record of this.records.values()) {
			let measured = inspectionSize(record, MAX_SNAPSHOT_BYTES);
			if (measured.reason) {
				this.omitRecordBodies(record);
				measured = inspectionSize(record, MAX_SNAPSHOT_BYTES);
			}
			if (measured.reason) {
				this.records.delete(record.turnId);
				this.noteOmission({
					reason: "retained_record_budget",
					turnId: record.turnId,
					limitBytes: MAX_SNAPSHOT_BYTES,
				});
				continue;
			}
			sizes.set(record.turnId, measured.bytes);
		}
		let retained = [...sizes.values()].reduce((sum, size) => sum + size, 0);
		for (const record of this.records.values()) {
			if (retained <= MAX_RETAINED_BYTES) break;
			retained -= sizes.get(record.turnId) ?? 0;
			this.omitRecordBodies(record);
			const measured = inspectionSize(record, MAX_SNAPSHOT_BYTES);
			if (measured.reason) {
				this.records.delete(record.turnId);
				this.noteOmission({
					reason: "retained_session_budget",
					turnId: record.turnId,
					limitBytes: MAX_RETAINED_BYTES,
				});
			} else {
				retained += measured.bytes;
				sizes.set(record.turnId, measured.bytes);
			}
		}
		for (const record of this.records.values()) {
			if (retained <= MAX_RETAINED_BYTES) break;
			this.records.delete(record.turnId);
			retained -= sizes.get(record.turnId) ?? 0;
			this.noteOmission({
				reason: "retained_session_budget",
				turnId: record.turnId,
				limitBytes: MAX_RETAINED_BYTES,
			});
		}
		this.retainedBytes = retained;
	}

	private omitRecordBodies(record: PiDebugContextRecord): void {
		const receipt = { omitted: true, reason: "retained_byte_budget", limitBytes: MAX_SNAPSHOT_BYTES };
		for (const window of record.contextWindows) window.messages = receipt;
		for (const request of record.providerRequests) request.payload = receipt;
		for (const request of record.providerRequestReceipts) request.payload = receipt;
		for (const call of record.modelCalls) {
			if (this.previousContextMessages === call.contextMessages) this.previousContextMessages = receipt;
			call.contextMessages = receipt;
			call.providerContext = receipt;
			call.contextDelta = { ...call.contextDelta, addedMessages: [], omitted: true };
			if (call.assistantMessage !== undefined) call.assistantMessage = receipt;
			for (const exchange of call.providerExchanges) {
				if (exchange.payload !== undefined) exchange.payload = receipt;
			}
		}
		for (const tool of record.toolExecutions) {
			tool.args = receipt;
			if (tool.result !== undefined) tool.result = receipt;
			for (const update of tool.updates) update.partialResult = receipt;
		}
		// Keep load receipts: their existing consumer supplies skill recovery metadata.
		if (!record.inspectionOmissions?.some((item) => item.reason === receipt.reason)) {
			record.inspectionOmissions = [
				...(record.inspectionOmissions ?? []),
				{ reason: receipt.reason, limitBytes: receipt.limitBytes },
			].slice(-MAX_OMISSIONS);
		}
		this.noteOmission({ reason: receipt.reason, turnId: record.turnId, limitBytes: receipt.limitBytes });
	}

	private noteOmission(omission: PiDebugContextOmission): void {
		if (omission.path) this.deferredSnapshots.add(omission.path);
		this.omissionCount += 1;
		this.omissions.push(omission);
		if (this.omissions.length > MAX_OMISSIONS) this.omissions.shift();
	}

	private capture(value: unknown): unknown {
		const captured = cloneForInspection(value);
		const receipt = plainRecord(captured);
		if (receipt?.omitted === true && typeof receipt.reason === "string") {
			const record = this.current();
			const omission = { reason: receipt.reason, limitBytes: MAX_CAPTURE_BYTES };
			if (record && !record.inspectionOmissions?.some((item) => item.reason === omission.reason)) {
				record.inspectionOmissions = [...(record.inspectionOmissions ?? []), omission].slice(-MAX_OMISSIONS);
			}
			this.noteOmission({ ...omission, turnId: record?.turnId });
		}
		return captured;
	}
}

async function readDebugSnapshot(path: string, maxBytes: number): Promise<{ text?: string; bytes: number }> {
	const file = await open(path, "r");
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size > maxBytes) return { bytes: 0 };
		// A bounded read also handles a file growing or being replaced after stat.
		const buffer = Buffer.alloc(metadata.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const result = await file.read(buffer, used, buffer.length - used, used);
			if (!result.bytesRead) break;
			used += result.bytesRead;
		}
		return used > metadata.size ? { bytes: used } : { bytes: used, text: buffer.toString("utf8", 0, used) };
	} finally {
		await file.close();
	}
}

interface StoredDebugFile {
	path: string;
	size: number;
	modifiedAtMs: number;
}

async function storedDebugFiles(directory: string): Promise<StoredDebugFile[]> {
	if (!directory) return [];
	const files: StoredDebugFile[] = [];
	const visit = async (current: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if (isMissingPathError(error)) return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const metadata = await stat(path);
				files.push({ path, size: metadata.size, modifiedAtMs: metadata.mtimeMs });
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
			}
		}
	};
	await visit(directory);
	return files;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 180) || "unknown";
}

function normalizeDebugContextRecord(
	value: unknown,
	maxCallsPerTurn = MAX_CALLS_PER_TURN,
): PiDebugContextRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		(record.schemaVersion !== "rag-ime.context-inspection.v2" &&
			record.schemaVersion !== "rag-ime.pi-debug-context.v1") ||
		typeof record.sessionId !== "string" ||
		typeof record.turnId !== "string" ||
		typeof record.capturedAtMs !== "number"
	) {
		return undefined;
	}

	const modelCalls = normalizeModelCalls(record.modelCalls, record.capturedAtMs, maxCallsPerTurn);
	const toolExecutions = normalizeToolExecutions(record.toolExecutions, record.capturedAtMs);
	return {
		schemaVersion: "rag-ime.context-inspection.v2",
		sessionId: record.sessionId,
		turnId: record.turnId,
		clientMessageId: typeof record.clientMessageId === "string" ? record.clientMessageId : "",
		lifecycle:
			record.lifecycle &&
			typeof record.lifecycle === "object" &&
			!Array.isArray(record.lifecycle) &&
			(record.lifecycle as Record<string, unknown>).kind === "compaction"
				? {
						kind: "compaction",
						reason:
							typeof (record.lifecycle as Record<string, unknown>).reason === "string"
								? String((record.lifecycle as Record<string, unknown>).reason)
								: undefined,
						status: normalizeLifecycleStatus((record.lifecycle as Record<string, unknown>).status),
						error:
							typeof (record.lifecycle as Record<string, unknown>).error === "string"
								? String((record.lifecycle as Record<string, unknown>).error)
								: undefined,
					}
				: undefined,
		capturedAtMs: record.capturedAtMs,
		updatedAtMs: finiteNumber(record.updatedAtMs, record.capturedAtMs),
		prompt: typeof record.prompt === "string" ? record.prompt : "",
		systemPrompt: typeof record.systemPrompt === "string" ? record.systemPrompt : "",
		systemPromptOptions: record.systemPromptOptions ?? {},
		model: plainRecord(record.model),
		activeTools: stringArray(record.activeTools),
		toolSchemas: recordArray(record.toolSchemas),
		skillCatalog: recordArray(record.skillCatalog),
		loadedSkillReceipts: recordArray(record.loadedSkillReceipts),
		contributionRefs: recordArray(record.contributionRefs),
		contextWindows: recordArray(record.contextWindows).slice(
			-maxCallsPerTurn,
		) as PiDebugContextRecord["contextWindows"],
		providerRequests: recordArray(record.providerRequests).slice(
			-maxCallsPerTurn,
		) as PiDebugContextRecord["providerRequests"],
		providerRequestReceipts: recordArray(record.providerRequestReceipts).slice(
			-maxCallsPerTurn,
		) as unknown as PiProviderRequestReceipt[],
		cacheEvidence: recordArray(record.cacheEvidence).slice(-maxCallsPerTurn) as PiDebugContextRecord["cacheEvidence"],
		modelCalls,
		toolExecutions,
		toolBatches: buildToolBatches(toolExecutions),
		inspectionOmissions: recordArray(record.inspectionOmissions)
			.slice(-MAX_OMISSIONS)
			.map((item) => ({
				reason: typeof item.reason === "string" ? item.reason.slice(0, 128) : "historical_omission",
				limitBytes: finiteNumber(item.limitBytes, MAX_SNAPSHOT_BYTES),
			})),
	};
}

function normalizeLifecycleStatus(value: unknown): "running" | "completed" | "failed" | "aborted" {
	return value === "completed" || value === "failed" || value === "aborted" ? value : "running";
}

function normalizeModelCalls(
	value: unknown,
	capturedAtMs: number,
	maxCallsPerTurn = MAX_CALLS_PER_TURN,
): PiDebugModelCall[] {
	let previousMessages: unknown;
	let previousIndex: number | undefined;
	return recordArray(value)
		.slice(-maxCallsPerTurn)
		.map((call, position) => {
			const index = finiteNumber(call.index, position + 1);
			const contextMessages = call.contextMessages ?? [];
			const fallbackDelta = contextDelta(previousMessages, contextMessages, previousIndex);
			const contextDeltaRecord = plainRecord(call.contextDelta);
			const normalized: PiDebugModelCall = {
				index,
				runtimeTurnIndex: optionalFiniteNumber(call.runtimeTurnIndex),
				capturedAtMs: finiteNumber(call.capturedAtMs, capturedAtMs),
				updatedAtMs: finiteNumber(call.updatedAtMs, capturedAtMs),
				completedAtMs: optionalFiniteNumber(call.completedAtMs),
				contextMessages,
				providerContext: call.providerContext,
				contextDelta: {
					...(contextDeltaRecord?.omitted === true || fallbackDelta.omitted ? { omitted: true } : {}),
					baseCallIndex: optionalFiniteNumber(contextDeltaRecord?.baseCallIndex),
					commonPrefixMessages: finiteNumber(
						contextDeltaRecord?.commonPrefixMessages,
						fallbackDelta.commonPrefixMessages,
					),
					removedMessageCount: finiteNumber(
						contextDeltaRecord?.removedMessageCount,
						fallbackDelta.removedMessageCount,
					),
					addedMessageCount: finiteNumber(contextDeltaRecord?.addedMessageCount, fallbackDelta.addedMessageCount),
					addedMessages: Array.isArray(contextDeltaRecord?.addedMessages)
						? contextDeltaRecord.addedMessages
						: fallbackDelta.addedMessages,
					prefixBytes: finiteNumber(contextDeltaRecord?.prefixBytes, fallbackDelta.prefixBytes),
					prefixSha256:
						typeof contextDeltaRecord?.prefixSha256 === "string"
							? contextDeltaRecord.prefixSha256
							: fallbackDelta.prefixSha256,
					currentBytes: finiteNumber(contextDeltaRecord?.currentBytes, fallbackDelta.currentBytes),
					deltaBytes: finiteNumber(contextDeltaRecord?.deltaBytes, fallbackDelta.deltaBytes),
					duplicateBytes: finiteNumber(contextDeltaRecord?.duplicateBytes, fallbackDelta.duplicateBytes),
				},
				providerExchanges: recordArray(call.providerExchanges) as unknown as PiDebugProviderExchange[],
				assistantMessage: call.assistantMessage,
			};
			previousMessages = contextMessages;
			previousIndex = index;
			return normalized;
		});
}

function normalizeToolExecutions(value: unknown, capturedAtMs: number): PiDebugToolExecution[] {
	return recordArray(value)
		.slice(-MAX_TOOLS_PER_TURN)
		.filter((tool) => typeof tool.toolCallId === "string" && typeof tool.toolName === "string")
		.map((tool, position) => ({
			toolCallId: String(tool.toolCallId),
			toolName: String(tool.toolName),
			modelCallIndex: optionalFiniteNumber(tool.modelCallIndex),
			runtimeTurnIndex: optionalFiniteNumber(tool.runtimeTurnIndex),
			startedAtMs: finiteNumber(tool.startedAtMs, capturedAtMs),
			endedAtMs: optionalFiniteNumber(tool.endedAtMs),
			startSequence: finiteNumber(tool.startSequence, position + 1),
			endSequence: optionalFiniteNumber(tool.endSequence),
			args: tool.args,
			result: tool.result,
			isError: typeof tool.isError === "boolean" ? tool.isError : undefined,
			status:
				tool.status === "running" || tool.status === "failed" || tool.status === "completed"
					? tool.status
					: "completed",
			updates: recordArray(tool.updates)
				.slice(-MAX_TOOL_UPDATES)
				.map((update) => ({
					capturedAtMs: finiteNumber(update.capturedAtMs, capturedAtMs),
					partialResult: update.partialResult,
				})),
		}));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value)
		? value.filter((item): item is Record<string, unknown> => Boolean(plainRecord(item)))
		: [];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function buildToolBatches(tools: PiDebugToolExecution[]): PiDebugToolBatch[] {
	const batches: PiDebugToolBatch[] = [];
	const byCall = new Map<string, PiDebugToolExecution[]>();
	for (const tool of tools) {
		const key = `${tool.modelCallIndex ?? "unknown"}:${tool.runtimeTurnIndex ?? "unknown"}`;
		const values = byCall.get(key) ?? [];
		values.push(tool);
		byCall.set(key, values);
	}
	for (const group of byCall.values()) {
		const ordered = [...group].sort((left, right) => left.startSequence - right.startSequence);
		const stages: PiDebugToolExecution[][] = [];
		let stageEnd = -1;
		for (const tool of ordered) {
			const end = tool.endSequence ?? Number.POSITIVE_INFINITY;
			if (!stages.length || tool.startSequence >= stageEnd) {
				stages.push([tool]);
				stageEnd = end;
			} else {
				stages.at(-1)?.push(tool);
				stageEnd = Math.max(stageEnd, end);
			}
		}
		stages.forEach((stageTools, stageIndex) => {
			const running = stageTools.some((tool) => tool.status === "running");
			const failed = stageTools.some((tool) => tool.status === "failed");
			const ended = stageTools.map((tool) => tool.endedAtMs).filter((value): value is number => value !== undefined);
			batches.push({
				id: `call-${stageTools[0]?.modelCallIndex ?? "unknown"}-turn-${stageTools[0]?.runtimeTurnIndex ?? "unknown"}-stage-${stageIndex + 1}`,
				modelCallIndex: stageTools[0]?.modelCallIndex,
				runtimeTurnIndex: stageTools[0]?.runtimeTurnIndex,
				stage: stageIndex + 1,
				executionMode: stageTools.length > 1 ? "parallel" : "serial",
				startedAtMs: Math.min(...stageTools.map((tool) => tool.startedAtMs)),
				endedAtMs: running || !ended.length ? undefined : Math.max(...ended),
				status: running ? "running" : failed ? "failed" : "completed",
				toolCallIds: stageTools.map((tool) => tool.toolCallId),
			});
		});
	}
	return batches.sort((left, right) => left.startedAtMs - right.startedAtMs || left.stage - right.stage);
}

function contextDelta(previousValue: unknown, currentValue: unknown, baseCallIndex?: number): PiDebugContextDelta {
	if (!Array.isArray(currentValue) || (previousValue !== undefined && !Array.isArray(previousValue))) {
		return {
			omitted: true,
			baseCallIndex,
			commonPrefixMessages: 0,
			removedMessageCount: 0,
			addedMessageCount: 0,
			addedMessages: [],
			prefixBytes: 0,
			prefixSha256: "",
			currentBytes: 0,
			deltaBytes: 0,
			duplicateBytes: 0,
		};
	}
	const previous = Array.isArray(previousValue) ? previousValue : [];
	const current = Array.isArray(currentValue) ? currentValue : [];
	let commonPrefixMessages = 0;
	while (
		commonPrefixMessages < previous.length &&
		commonPrefixMessages < current.length &&
		stableJson(previous[commonPrefixMessages]) === stableJson(current[commonPrefixMessages])
	) {
		commonPrefixMessages += 1;
	}
	const previousBytes = Buffer.from(stableJson(previous));
	const currentBytes = Buffer.from(stableJson(current));
	let prefixBytes = 0;
	while (
		prefixBytes < previousBytes.length &&
		prefixBytes < currentBytes.length &&
		previousBytes[prefixBytes] === currentBytes[prefixBytes]
	) {
		prefixBytes += 1;
	}
	const prefixSha256 = createHash("sha256").update(currentBytes.subarray(0, prefixBytes)).digest("hex");
	return {
		baseCallIndex,
		commonPrefixMessages,
		removedMessageCount: previous.length - commonPrefixMessages,
		addedMessageCount: current.length - commonPrefixMessages,
		addedMessages: current.slice(commonPrefixMessages),
		prefixBytes,
		prefixSha256,
		currentBytes: currentBytes.length,
		deltaBytes: currentBytes.length - prefixBytes,
		duplicateBytes: prefixBytes,
	};
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function numericUsage(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, number> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		const item = (value as Record<string, unknown>)[key];
		if (typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
	}
	return result;
}

function redactInspectionString(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [credential omitted]")
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "[credential omitted]");
}

function safeReasoningInspectionValue(value: unknown): unknown {
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["effort", "summary"] as const) {
		const item = source[key];
		if (item === null && key === "summary") {
			result[key] = null;
			continue;
		}
		if (typeof item === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(item)) {
			result[key] = item;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

function cloneForInspection(value: unknown): unknown {
	if (value === undefined) return undefined;
	const measured = inspectionSize(value, MAX_CAPTURE_BYTES);
	if (measured.reason) {
		return { omitted: true, truncated: true, reason: `capture_${measured.reason}`, limitBytes: MAX_CAPTURE_BYTES };
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value, function inspectionReplacer(key, item) {
			if (
				/^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|secret)$/iu.test(
					key,
				)
			) {
				return "[credential omitted]";
			}
			if (/^reasoning$/iu.test(key)) {
				return safeReasoningInspectionValue(item);
			}
			if (/^(?:thinking|analysis|encrypted[_-]?content)$/iu.test(key)) {
				return undefined;
			}
			if (
				item &&
				typeof item === "object" &&
				/^(?:thinking|reasoning|analysis|redacted_reasoning)$/iu.test(
					String((item as { type?: unknown }).type ?? ""),
				)
			) {
				return { type: String((item as { type?: unknown }).type ?? "hidden"), omitted: true };
			}
			if (typeof item === "bigint") return item.toString();
			if (typeof item === "string" && /^data:[^;]+;base64,/iu.test(item)) {
				return `[binary data omitted: ${item.length} chars]`;
			}
			if (typeof item === "string") return redactInspectionString(item);
			return item;
		});
	} catch (error) {
		return { unavailable: true, error: (error instanceof Error ? error.message : String(error)).slice(0, 256) };
	}
	if (serialized === undefined) return undefined;
	if (Buffer.byteLength(serialized) > MAX_CAPTURE_BYTES) {
		return {
			omitted: true,
			truncated: true,
			reason: "capture_byte_budget",
			limitBytes: MAX_CAPTURE_BYTES,
		};
	}
	return JSON.parse(serialized) as unknown;
}

function inspectionText(value: string): string {
	const cloned = cloneForInspection(value);
	return typeof cloned === "string" ? cloned : `[diagnostic body omitted: ${JSON.stringify(cloned)}]`;
}

function inspectionRecords(value: unknown[]): Array<Record<string, unknown>> {
	const cloned = cloneForInspection(value);
	return Array.isArray(cloned) ? recordArray(cloned) : [plainRecord(cloned) ?? { omitted: true }];
}

/** Conservative serialized bytes plus container/key overhead, without cloning,
 * invoking getters/toJSON, or allocating an unbounded serialized intermediate. */
function inspectionSize(value: unknown, limit: number): { bytes: number; reason?: string } {
	let bytes = 0;
	let nodes = 0;
	let reason: string | undefined;
	const ancestors = new Set<object>();
	const add = (count: number): void => {
		bytes += count;
		if (bytes > limit) throw new Error("byte_budget");
	};
	const stringBytes = (text: string): void => {
		if (text.length > limit - bytes) throw new Error("byte_budget");
		add(Buffer.byteLength(text) + 2);
		const escapes = /["\\\u0000-\u001f\uD800-\uDFFF]/gu;
		for (let match = escapes.exec(text); match; match = escapes.exec(text)) {
			const code = match[0].charCodeAt(0);
			add(code >= 0xd800 ? 3 : code < 0x20 ? 5 : 1);
		}
	};
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > MAX_INSPECTION_NODES || depth > MAX_INSPECTION_DEPTH) throw new Error("structure_budget");
		if (typeof item === "string") {
			stringBytes(item);
			return;
		}
		if (!item || typeof item !== "object") {
			if (typeof item === "bigint") {
				if (item > 2n ** 4096n || item < -(2n ** 4096n)) throw new Error("structure_budget");
				stringBytes(item.toString());
				return;
			}
			add(32);
			return;
		}
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
			throw new Error("unsupported_value");
		}
		const toJSON = Object.getOwnPropertyDescriptor(item, "toJSON");
		if (toJSON && (!Object.hasOwn(toJSON, "value") || typeof toJSON.value === "function")) {
			throw new Error("unsupported_value");
		}
		if (ancestors.has(item)) throw new Error("unsupported_value");
		ancestors.add(item);
		add(64);
		if (Array.isArray(item)) {
			if (item.length > MAX_INSPECTION_NODES - nodes) throw new Error("structure_budget");
			for (let index = 0; index < item.length; index += 1) {
				add(32);
				const property = Object.getOwnPropertyDescriptor(item, String(index));
				if (property && !Object.hasOwn(property, "value")) throw new Error("unsupported_value");
				visit(property?.value, depth + 1);
			}
		} else
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				const property = Object.getOwnPropertyDescriptor(item, key);
				if (!property || !Object.hasOwn(property, "value")) throw new Error("unsupported_value");
				add(32);
				stringBytes(key);
				visit(property.value, depth + 1);
			}
		ancestors.delete(item);
	};
	try {
		visit(value, 0);
	} catch (error) {
		reason = error instanceof Error ? error.message : "unsupported_value";
	}
	return { bytes: reason ? Math.max(limit + 1, bytes) : bytes, ...(reason ? { reason } : {}) };
}
