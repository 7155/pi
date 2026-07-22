import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
}

const MAX_TURNS = 8;
const MAX_CALLS_PER_TURN = 12;
const MAX_CONFIGURED_CALLS_PER_TURN = 256;
const MAX_TOOLS_PER_TURN = 96;
const MAX_TOOL_UPDATES = 12;
const MAX_SERIALIZED_CHARS = 6_000_000;
const MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
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
	private readonly contributionRefs: Array<Record<string, unknown>>;

	constructor(
		sessionId: string,
		activeTurn: () => DebugTurnIdentity | undefined,
		storage: PiDebugContextStorageOptions = {},
	) {
		this.sessionId = sessionId;
		this.activeTurn = activeTurn;
		this.storageDirectory = storage.directory?.trim() ?? "";
		const requestedMax = Number.isFinite(storage.maxBytes) ? Math.floor(storage.maxBytes ?? 0) : 0;
		this.storageMaxBytes = Math.min(MAX_STORAGE_BYTES, Math.max(1, requestedMax || MAX_STORAGE_BYTES));
		const requestedCalls = Number.isFinite(storage.maxCallsPerTurn) ? Math.floor(storage.maxCallsPerTurn ?? 0) : 0;
		this.maxCallsPerTurn = Math.min(MAX_CONFIGURED_CALLS_PER_TURN, Math.max(1, requestedCalls || MAX_CALLS_PER_TURN));
		this.contributionRefs = cloneForInspection(storage.contributionRefs ?? []) as Array<Record<string, unknown>>;
		this.pendingPersistence = this.queueStorageTask(() => this.restorePersistedRecords());
	}

	extension(): ExtensionFactory {
		return (pi) => {
			const refreshToolSurface = (record: PiDebugContextRecord): void => {
				const activeTools = pi.getActiveTools();
				const activeSet = new Set(activeTools);
				record.activeTools = [...activeTools];
				record.toolSchemas = pi
					.getAllTools()
					.filter((tool) => activeSet.has(tool.name))
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: cloneForInspection(tool.parameters),
						promptGuidelines: tool.promptGuidelines,
					}));
			};
			pi.on("before_agent_start", (event, context) => {
				const identity = this.activeTurn();
				if (!identity?.turnId) return;
				const now = Date.now();
				const activeTools = pi.getActiveTools();
				this.runtimeTurnIndex = undefined;
				this.eventSequence = 0;
				this.records.delete(identity.turnId);
				const promptOptions = event.systemPromptOptions as { skills?: Array<Record<string, unknown>> } | undefined;
				this.records.set(identity.turnId, {
					schemaVersion: "rag-ime.context-inspection.v2",
					sessionId: this.sessionId,
					turnId: identity.turnId,
					clientMessageId: identity.clientMessageId ?? "",
					capturedAtMs: now,
					updatedAtMs: now,
					prompt: cloneForInspection(event.prompt) as string,
					systemPrompt: cloneForInspection(event.systemPrompt) as string,
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
					activeTools: [...activeTools],
					toolSchemas: [],
					skillCatalog: (promptOptions?.skills ?? []).map((skill) => ({
						name: String(skill.name ?? ""),
						description: String(skill.description ?? ""),
						source: cloneForInspection(skill.sourceInfo),
					})),
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
				const messages = cloneForInspection(event.messages);
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
			});

			(
				pi as unknown as {
					on(name: string, handler: (event: { context: unknown }) => void): void;
				}
			).on("provider_context_inspection", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const call = this.ensureModelCall(record, now);
				call.providerContext = cloneForInspection(event.context);
				call.updatedAtMs = now;
				record.updatedAtMs = now;
			});

			pi.on("before_provider_request", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				refreshToolSurface(record);
				const index = (record.providerRequestReceipts.at(-1)?.index ?? 0) + 1;
				record.providerRequestReceipts.push({
					schemaVersion: "rag-ime.provider-request-receipt.v1",
					index,
					capturedAtMs: now,
					model: structuredClone(record.model ?? {}),
					streamOptions: {},
					payload: cloneForInspection(event.payload),
				});
				if (record.providerRequestReceipts.length > this.maxCallsPerTurn) {
					record.providerRequestReceipts.shift();
				}
				const payload = cloneForInspection(event.payload);
				record.providerRequests.push({ index, capturedAtMs: now, payload });
				if (record.providerRequests.length > this.maxCallsPerTurn) record.providerRequests.shift();
				const call = this.ensureModelCall(record, now);
				call.providerExchanges.push({ index, capturedAtMs: now, payload });
				call.updatedAtMs = now;
				record.updatedAtMs = now;
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
				}
				exchange.status = event.status;
				exchange.headers = cloneForInspection(event.headers) as Record<string, unknown>;
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
				call.assistantMessage = cloneForInspection(event.message);
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
					args: cloneForInspection(event.args),
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
				tool.updates.push({ capturedAtMs: now, partialResult: cloneForInspection(event.partialResult) });
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
				tool.result = cloneForInspection(event.result);
				tool.isError = event.isError;
				tool.status = event.isError ? "failed" : "completed";
				if (event.toolName === "skill_load" && !event.isError) {
					const details = (event.result as { details?: unknown } | undefined)?.details;
					const receipt = cloneForInspection(details);
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
		const record = turnId ? this.records.get(turnId) : [...this.records.values()].at(-1);
		// Every field is sanitized when captured. Preserve the record contract here:
		// cloneForInspection() may replace a large value with a truncation receipt.
		return record ? structuredClone(record) : undefined;
	}

	list(): PiDebugContextSummary[] {
		return [...this.records.values()].reverse().map((record) => ({
			turnId: record.turnId,
			clientMessageId: record.clientMessageId,
			capturedAtMs: record.capturedAtMs,
			updatedAtMs: record.updatedAtMs,
			modelCallCount: record.modelCalls.length,
			providerRequestCount: record.providerRequests.length,
			toolCallCount: record.toolExecutions.length,
			runningToolCount: record.toolExecutions.filter((tool) => tool.status === "running").length,
		}));
	}

	storage(): PiDebugContextStorageStatus {
		return {
			persistent: Boolean(this.storageDirectory) && !this.storageError,
			directory: this.storageDirectory,
			maxBytes: this.storageMaxBytes,
			usedBytes: this.storageUsedBytes,
			fileCount: this.storageFileCount,
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
		this.runtimeTurnIndex = undefined;
		this.eventSequence = 0;
		this.providerCallSequence = 0;
		this.previousContextMessages = undefined;
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
		const identity = this.activeTurn();
		return identity?.turnId ? this.records.get(identity.turnId) : undefined;
	}

	private ensureModelCall(record: PiDebugContextRecord, now: number): PiDebugModelCall {
		const current = record.modelCalls.at(-1);
		if (current) return current;
		const call: PiDebugModelCall = {
			index: 1,
			runtimeTurnIndex: this.runtimeTurnIndex,
			capturedAtMs: now,
			updatedAtMs: now,
			contextMessages: [],
			contextDelta: contextDelta(undefined, []),
			providerExchanges: [],
		};
		record.modelCalls.push(call);
		return call;
	}

	private touch(): void {
		const record = this.current();
		if (record) record.updatedAtMs = Date.now();
	}

	private refreshToolBatches(record: PiDebugContextRecord, now: number): void {
		record.toolBatches = buildToolBatches(record.toolExecutions);
		record.updatedAtMs = now;
	}

	private schedulePersist(delayMs: number): void {
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
		this.pendingPersistence = this.queueStorageTask(() => this.persistRecord(record));
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
				.slice(0, MAX_TURNS)
				.reverse();
			const restored: PiDebugContextRecord[] = [];
			for (const file of latest) {
				try {
					const parsed = JSON.parse(await readFile(file.path, "utf8")) as unknown;
					const normalized = normalizeDebugContextRecord(parsed, this.maxCallsPerTurn);
					if (normalized?.sessionId === this.sessionId) restored.push(normalized);
				} catch {
					// A damaged snapshot must not hide the remaining usable history.
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
	};
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

function cloneForInspection(value: unknown): unknown {
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
			if (/^(?:thinking|reasoning|analysis|encrypted[_-]?content)$/iu.test(key)) {
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
		return { unavailable: true, error: error instanceof Error ? error.message : String(error) };
	}
	if (serialized.length > MAX_SERIALIZED_CHARS) {
		return {
			truncated: true,
			originalChars: serialized.length,
			jsonPreview: serialized.slice(0, MAX_SERIALIZED_CHARS),
		};
	}
	return JSON.parse(serialized) as unknown;
}
