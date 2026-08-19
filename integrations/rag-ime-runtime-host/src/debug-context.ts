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
}

export interface PiDebugModelCall {
	index: number;
	runtimeTurnIndex?: number;
	capturedAtMs: number;
	updatedAtMs: number;
	completedAtMs?: number;
	contextMessages: unknown;
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
	schemaVersion: "rag-ime.pi-debug-context.v1";
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
	contextWindows: Array<{ index: number; capturedAtMs: number; messages: unknown }>;
	providerRequests: Array<{ index: number; capturedAtMs: number; payload: unknown }>;
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
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingPersistence: Promise<void> = Promise.resolve();
	private storageUsedBytes = 0;
	private storageFileCount = 0;
	private storageError = "";
	private lastPersistedAtMs: number | undefined;
	private runtimeTurnIndex: number | undefined;
	private eventSequence = 0;

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
		this.pendingPersistence = this.queueStorageTask(() => this.restorePersistedRecords());
	}

	extension(): ExtensionFactory {
		return (pi) => {
			pi.on("before_agent_start", (event, context) => {
				const identity = this.activeTurn();
				if (!identity?.turnId) return;
				const now = Date.now();
				const activeTools = pi.getActiveTools();
				const activeSet = new Set(activeTools);
				const toolSchemas = pi
					.getAllTools()
					.filter((tool) => activeSet.has(tool.name))
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: cloneForDebug(tool.parameters),
						promptGuidelines: tool.promptGuidelines,
					}));
				this.runtimeTurnIndex = undefined;
				this.eventSequence = 0;
				this.records.delete(identity.turnId);
				this.records.set(identity.turnId, {
					schemaVersion: "rag-ime.pi-debug-context.v1",
					sessionId: this.sessionId,
					turnId: identity.turnId,
					clientMessageId: identity.clientMessageId ?? "",
					capturedAtMs: now,
					updatedAtMs: now,
					prompt: event.prompt,
					systemPrompt: event.systemPrompt,
					systemPromptOptions: cloneForDebug(event.systemPromptOptions),
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
					toolSchemas,
					contextWindows: [],
					providerRequests: [],
					modelCalls: [],
					toolExecutions: [],
					toolBatches: [],
				});
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
				const messages = cloneForDebug(event.messages);
				const previous = record.modelCalls.at(-1);
				const index = (previous?.index ?? 0) + 1;
				record.contextWindows.push({ index, capturedAtMs: now, messages });
				if (record.contextWindows.length > MAX_CALLS_PER_TURN) record.contextWindows.shift();
				record.modelCalls.push({
					index,
					runtimeTurnIndex: this.runtimeTurnIndex,
					capturedAtMs: now,
					updatedAtMs: now,
					contextMessages: messages,
					contextDelta: contextDelta(previous?.contextMessages, messages, previous?.index),
					providerExchanges: [],
				});
				if (record.modelCalls.length > MAX_CALLS_PER_TURN) record.modelCalls.shift();
				record.updatedAtMs = now;
			});

			pi.on("before_provider_request", (event) => {
				const record = this.current();
				if (!record) return;
				const now = Date.now();
				const payload = cloneForDebug(event.payload);
				const index = (record.providerRequests.at(-1)?.index ?? 0) + 1;
				record.providerRequests.push({ index, capturedAtMs: now, payload });
				if (record.providerRequests.length > MAX_CALLS_PER_TURN) record.providerRequests.shift();
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
				exchange.headers = cloneForDebug(event.headers) as Record<string, unknown>;
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
				call.assistantMessage = cloneForDebug(event.message);
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
					args: cloneForDebug(event.args),
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
				tool.updates.push({ capturedAtMs: now, partialResult: cloneForDebug(event.partialResult) });
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
				tool.result = cloneForDebug(event.result);
				tool.isError = event.isError;
				tool.status = event.isError ? "failed" : "completed";
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
		return record ? (cloneForDebug(record) as PiDebugContextRecord) : undefined;
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
					if (isDebugContextRecord(parsed) && parsed.sessionId === this.sessionId) restored.push(parsed);
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

function isDebugContextRecord(value: unknown): value is PiDebugContextRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === "rag-ime.pi-debug-context.v1" &&
		typeof record.sessionId === "string" &&
		typeof record.turnId === "string" &&
		typeof record.capturedAtMs === "number"
	);
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
	return {
		baseCallIndex,
		commonPrefixMessages,
		removedMessageCount: previous.length - commonPrefixMessages,
		addedMessageCount: current.length - commonPrefixMessages,
		addedMessages: current.slice(commonPrefixMessages),
	};
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function cloneForDebug(value: unknown): unknown {
	let serialized: string;
	try {
		serialized = JSON.stringify(value, function debugReplacer(key, item) {
			if (
				/^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie)$/iu.test(
					key,
				)
			) {
				return "[credential omitted]";
			}
			if (typeof item === "bigint") return item.toString();
			if (typeof item === "string" && /^data:[^;]+;base64,/iu.test(item)) {
				return `[binary data omitted: ${item.length} chars]`;
			}
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
