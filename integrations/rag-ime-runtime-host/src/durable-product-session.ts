import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import type { ModelRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc, type AgentEvent, type AgentEventStream, type AgentState, type CommitPublication, type Conversation,
	createRegistry, defineDoc, defineExtension, defineTool, type EntryRecord, Harness, type InboxState,
	InboxDoc, type JsonObject, LiveDoc, type LiveState, type SubmissionId, type SubmissionRecord,
	type TaskId, type ToolRegistration, type Tx, watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { loadBackendTools, searchBackendTools } from "./discovery-tools.ts";
import type { ActiveTurn, PiExactTurnCancelReceipt, PiPromptReceipt, PiSessionAbortReceipt } from "./pi-session.ts";
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, RuntimeProtocolError } from "./protocol.ts";
import type { PooledSession } from "./session-pool.ts";
import { ToolArtifactBuffer } from "./tool-artifact-buffer.ts";
import {
	type BackendToolBridgeOptions, BackendToolRegistry, canonicalJson, executeGatewayTool,
	modelVisibleBackendToolParameters,
} from "./tool-bridge.ts";
import { ToolResultStore } from "./tool-result-store.ts";
import {
	type AgentSettledReceiptV2, type PiTurnSettlementReceipt, persistedTurnSettlement,
	TurnSettlementTracker, type WaitForTurnSettlementOptions,
} from "./turn-settlement.ts";

const context = BACKGROUND_CONTEXT;
const EXTENSION_NAME = "rag-ime.durable-product";
const RECENT_ENTRIES = 100;

export const DURABLE_ENGINE_CAPABILITIES = Object.freeze({
	gatewayTools: true, compaction: true, resume: true, exactAbort: true,
	nativeMcp: false, codemode: false, managedPlugins: false, conversationFork: false,
	conversationRewrite: false, commandCatalog: false, images: false,
});

type RequestBinding = {
	turnId: string;
	clientMessageId: string;
	fingerprint: string;
	message: string;
	sessionContext: string;
	transientContext: string;
	delivery: "prompt" | "steer" | "followUp";
	createdAtMs: number;
	submissionId?: number;
	entryId?: number;
	generationIds: number[];
	settlement?: JsonObject;
};

type ProductState = {
	externalSessionId: string;
	runtimeSessionId: string;
	cwd: string;
	systemPrompt: string;
	sessionContext: string;
	requests: Record<string, RequestBinding>;
	cancels: Record<string, JsonObject>;
};

const ProductDoc = defineDoc<ProductState>({
	kind: "rag-ime.durable-product", version: 1, scope: "session",
	initial: () => ({ externalSessionId: "", runtimeSessionId: "", cwd: "", systemPrompt: "", sessionContext: "", requests: {}, cancels: {} }),
});

export interface DurableSessionOpenOptions {
	externalSessionId: string;
	cwd: string;
	durableStoreRef: string;
	modelRuntime: ModelRuntime;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ModelThinkingLevel;
	toolManifest: unknown;
	toolGatewayUrl?: string;
	toolGatewayToken?: string;
	systemPrompt?: string;
	sessionContext?: string;
	emitEvent(event: RuntimeEventEnvelope): void;
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

function json(value: object): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function requestKey(clientMessageId: string): string {
	return hash(clientMessageId);
}

function identity(request: RequestBinding): { turnId: string; clientMessageId: string } {
	return { turnId: request.turnId, clientMessageId: request.clientMessageId };
}

function terminal(submission: SubmissionRecord): boolean {
	return submission.status === "done" || submission.status === "unanswered";
}

/** Thin product projection over one native Harness; it owns no model or tool loop. */
export class DurableProductSession implements PooledSession {
	readonly runtimeEngine = "durable" as const;
	readonly externalSessionId: string;
	readonly durableStoreRef: string;
	readonly harness: Harness;
	readonly conversation: Conversation;
	private readonly options: DurableSessionOpenOptions;
	private readonly releaseStorage: () => Promise<void>;
	private readonly tools: BackendToolRegistry;
	private readonly registry: ReturnType<typeof createRegistry>;
	private readonly settlements: TurnSettlementTracker;
	private readonly artifacts = new ToolArtifactBuffer();
	private state: ProductState;
	private live: LiveState = {};
	private inbox: InboxState = { items: [] };
	private agent: AgentState = {};
	private scheduling: "paused" | "running" | "closing" = "paused";
	private readonly generationInputs = new Map<number, readonly SubmissionId[]>();
	private readonly submissionRecords = new Map<number, SubmissionRecord>();
	private eventStream?: AgentEventStream;
	private eventDelivery: Promise<void> = Promise.resolve();
	private unsubscribeCommits?: () => void;
	private sequence = 0;
	private projectedInputs: readonly SubmissionId[] = [];
	private projectedGenerationId?: number;
	private readonly projectedGenerations = new Set<number>();
	private partialMessage?: AssistantMessage;
	private readonly emittedMessageIds = new Set<string>();
	private projectionWork: Promise<void> = Promise.resolve();
	private projectionScheduled = false;
	private projectionError?: unknown;
	private admission: Promise<void> = Promise.resolve();
	private admitting = 0;
	private readonly abortingInputs = new Set<number>();
	private readonly cancellationWork = new Set<Promise<unknown>>();
	private readonly cancelling = new Map<string, { turnId: string; clientMessageId: string; result: Promise<PiExactTurnCancelReceipt> }>();
	private disposePromise?: Promise<void>;
	private readonly pendingDecisions = new Map<string, { requestId: string; turn: ActiveTurn; finish(value: boolean): void }>();

	private constructor(options: DurableSessionOpenOptions, harness: Harness, conversation: Conversation,
		state: ProductState, releaseStorage: () => Promise<void>, registry: ReturnType<typeof createRegistry>, tools: BackendToolRegistry) {
		this.options = options;
		this.externalSessionId = options.externalSessionId;
		this.durableStoreRef = options.durableStoreRef;
		this.harness = harness;
		this.conversation = conversation;
		this.state = state;
		this.releaseStorage = releaseStorage;
		this.registry = registry;
		this.tools = tools;
		this.settlements = new TurnSettlementTracker(this.externalSessionId, state.runtimeSessionId);
		for (const request of Object.values(state.requests)) {
			const receipt = persistedTurnSettlement(request.settlement);
			if (receipt) this.settlements.restore(receipt);
		}
	}

	static async create(options: DurableSessionOpenOptions): Promise<DurableProductSession> {
		await mkdir(options.durableStoreRef, { recursive: true, mode: 0o700 });
		const directory = await realpath(resolve(options.durableStoreRef));
		if (directory !== options.durableStoreRef) throw new RuntimeProtocolError("SESSION_PATH_DENIED", "Durable storage must use its canonical owned directory");
		let release: () => Promise<void>;
		try { release = await lockfile.lock(directory, { realpath: false, retries: 0 }); }
		catch (error) { throw new RuntimeProtocolError("DURABLE_STORAGE_BUSY", "Durable storage is already owned by another Host", String(error)); }
		let harness: Harness | undefined;
		try {
			const registry = createRegistry();
			const tools = new BackendToolRegistry();
			tools.sync(options.toolManifest);
			let product: DurableProductSession | undefined;
			// The registry is empty until the one product adapter attaches. Opening never executes tools.
			harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
				models: options.modelRuntime, registry,
				onReport: error => product?.notice(error),
			}, context);
			let state = await harness.snapshot(ProductDoc, context);
			const fresh = !state;
			const initialModel = fresh ? (options.provider && options.modelId
				? options.modelRuntime.getModel(options.provider, options.modelId) : options.modelRuntime.getAvailableSnapshot()[0]) : undefined;
			if (fresh && (options.provider || options.modelId) && !initialModel) throw new RuntimeProtocolError("MODEL_NOT_FOUND", "Requested Durable model is unavailable");
			const root = await harness.root(context, { agent: { cwd: options.cwd, extensions: [], tools: [],
				...(initialModel ? { model: { provider: initialModel.provider, modelId: initialModel.id },
					thinkingLevel: clampThinkingLevel(initialModel, options.thinkingLevel ?? "off") } : {}) },
				init: async tx => {
					const doc = await tx.doc(ProductDoc);
					if (doc.runtimeSessionId) throw new RuntimeProtocolError("DURABLE_BINDING_MISMATCH", "Product binding exists without its original native root");
					Object.assign(doc, { externalSessionId: options.externalSessionId, runtimeSessionId: randomUUID(), cwd: options.cwd,
						systemPrompt: options.systemPrompt ?? "", sessionContext: options.sessionContext ?? "" });
				},
			});
			state = await harness.snapshot(ProductDoc, context);
			if (!state || state.externalSessionId !== options.externalSessionId || state.cwd !== options.cwd || !state.runtimeSessionId) {
				throw new RuntimeProtocolError("DURABLE_BINDING_MISMATCH", "Durable storage belongs to another Session or workspace");
			}
			product = new DurableProductSession(options, harness, root, structuredClone(state), release, registry, tools);
			product.live = (await harness.snapshot(LiveDoc, root.id, context)) ?? {};
			product.inbox = (await harness.snapshot(InboxDoc, root.id, context)) ?? { items: [] };
			product.agent = (await harness.snapshot(AgentDoc, root.id, context)) ?? {};
			if (Array.isArray(product.agent.tools)) {
				for (const name of product.agent.tools) if (tools.getDiscoverable(name)) tools.disclose(name);
			}
			if (product.live.run) product.generationInputs.set(product.live.run.taskId, product.live.run.inputs);
			product.projectedInputs = product.live.run?.inputs ?? [];
			product.projectedGenerationId = product.live.run?.taskId;
			if (product.projectedGenerationId !== undefined) product.projectedGenerations.add(product.projectedGenerationId);
			product.installTools();
			// Changes select only product Gateway tools and prompt sections, never CodingTools or TUI defaults.
			await root.configure({ extensions: [registry.snapshot().extension(EXTENSION_NAME)!],
				tools: fresh ? product.offeredTools() : undefined,
			}, context);
			product.unsubscribeCommits = harness.subscribeCommits(publication => product?.observeCommit(publication));
			await product.reconcile();
			product.eventStream = await watchEvents(harness, root.id, context);
			product.eventStream.start(events => {
				const delivery = (async () => { for (const event of events) await product?.projectEvent(event); })();
				if (product) product.eventDelivery = delivery;
				return delivery;
			});
			return product;
		} catch (error) {
			try { await harness?.close(context); } finally { await release(); }
			throw error;
		}
	}

	private installTools(): void {
		const registrations: ToolRegistration[] = this.tools.catalog().map(tool => defineTool({
			name: tool.name, description: tool.description, parameters: modelVisibleBackendToolParameters(tool) as ToolRegistration["parameters"],
			replay: "unsafe", executionMode: "parallel",
			execute: async (args, api, callContext) => {
				const task = await api.getTask(api.taskId, callContext);
				const owner = task?.owner;
				const bound = owner === undefined ? undefined : this.requestForGeneration(owner);
				if (!bound) throw new Error("Gateway tool has no admitted original input");
				const turn = identity(bound);
				const assistantId = task?.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input.assistant : undefined;
				const bridge: BackendToolBridgeOptions = {
					sessionId: this.externalSessionId, registry: this.tools,
					gatewayUrl: this.options.toolGatewayUrl, gatewayToken: this.options.toolGatewayToken,
					sourceLoopId: () => owner === undefined ? `durable:${assistantId}:0` : `durable:task:${owner}:assistant`,
					executionBinding: () => turn,
					resultStore: new ToolResultStore(join(this.durableStoreRef, "tool-results")),
					waitForDecision: (kind, target, details, signal) => this.waitForDecision(kind, target, details, turn, signal),
				};
				const result = await executeGatewayTool(bridge, tool, api.callId, args, callContext.abortSignal, this.artifacts);
				return { content: result.content, details: json(result.details as object), ...(result.terminate ? { control: { terminate: true as const } } : {}) };
			},
		}));
		registrations.push(defineTool({
			name: "tool_search", description: "Search the governed product tool catalog before loading schemas.",
			parameters: Type.Object({ query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
			replay: "safe", execute: async args => ({ content: [{ type: "text", text: JSON.stringify(searchBackendTools(this.tools.catalog(), args, this.tools.catalogRevision(), this.tools.disclosed().map(tool => tool.name))) }] }),
		}), defineTool({
			name: "tool_load", description: "Load one to four exact product tool schemas before direct calling.",
			parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })), names: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4 })) }),
			replay: "safe", execute: async args => {
				const loaded = loadBackendTools(this.tools, args);
				for (const item of loaded) this.tools.disclose(item.tool.name);
				return { content: [{ type: "text", text: JSON.stringify(loaded.map(item => item.result)) }], control: { addTools: loaded.map(item => item.tool.name) } };
			},
		}));
		this.registry.install(defineExtension({ name: EXTENSION_NAME, tools: registrations,
			sections: [{ key: "product_context", tag: false, render: async (input, renderContext) => {
				const state = await input.read.snapshot(ProductDoc, renderContext);
				const live = await input.read.snapshot(LiveDoc, input.conversationId, renderContext);
				const original = live?.run?.inputs[0];
				const submission = original === undefined ? undefined : this.submissionRecords.get(original);
				const request = Object.values(state?.requests ?? {}).find(item => original !== undefined && item.submissionId === original)
					?? (submission?.requestId ? state?.requests[submission.requestId] : undefined);
				return [state?.systemPrompt, request?.sessionContext ? `<session_context>\n${request.sessionContext}\n</session_context>` : "",
					request?.transientContext ? `<current_turn_context>\n${request.transientContext}\n</current_turn_context>` : ""].filter(Boolean).join("\n\n");
			} }],
		}));
	}

	private offeredTools(): ToolRegistration[] {
		const names = new Set(["tool_search", "tool_load", ...this.tools.disclosed().map(tool => tool.name)]);
		return this.registry.snapshot().tools().map(item => item.tool).filter(tool => names.has(tool.name));
	}

	private currentRequest(): RequestBinding | undefined {
		const first = this.live.run?.inputs[0];
		const submission = first === undefined ? undefined : this.submissionRecords.get(first);
		return (submission?.requestId ? this.state.requests[submission.requestId] : undefined)
			?? Object.values(this.state.requests).find(request => first !== undefined && request.submissionId === first && !request.settlement)
			?? Object.values(this.state.requests).find(request => request.submissionId !== undefined && !request.settlement);
	}

	private requestForGeneration(id: number): RequestBinding | undefined {
		const first = this.generationInputs.get(id)?.[0];
		if (first !== undefined) {
			const direct = Object.values(this.state.requests).find(request => request.submissionId === first);
			const submission = this.submissionRecords.get(first);
			return direct ?? (submission?.requestId ? this.state.requests[submission.requestId] : undefined);
		}
		return Object.values(this.state.requests).find(request => request.generationIds.includes(id));
	}

	get isIdle(): boolean {
		return !this.disposePromise && this.admitting === 0 && !this.live.run && !this.live.compactions?.length &&
			!Object.values(this.state.requests).some(request => request.submissionId !== undefined && !request.settlement);
	}

	private observeCommit(publication: CommitPublication): void {
		const previous = this.live.run;
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === ProductDoc.definition.kind && change.value) this.state = structuredClone(change.value) as ProductState;
			if (change.type === "document" && change.conversationId === this.conversation.id) {
				if (change.record.kind === LiveDoc.definition.kind) this.live = (change.value ?? {}) as LiveState;
				if (change.record.kind === InboxDoc.definition.kind) this.inbox = (change.value ?? { items: [] }) as InboxState;
				if (change.record.kind === "pi.agent") this.agent = (change.value ?? {}) as AgentState;
			}
			if (change.type === "submission") this.submissionRecords.set(change.value.id, change.value);
		}
		if (previous) this.generationInputs.set(previous.taskId, previous.inputs);
		if (this.live.run) this.generationInputs.set(this.live.run.taskId, this.live.run.inputs);
		// Record only here. Session APIs run after the publication's synchronous observer returns.
		if (publication.changes.some(change => change.type !== "document" || change.record.kind !== ProductDoc.definition.kind)) this.scheduleProjection();
	}

	private scheduleProjection(): void {
		if (this.projectionScheduled || this.disposePromise) return;
		this.projectionScheduled = true;
		setImmediate(() => {
			this.projectionScheduled = false;
			if (this.disposePromise) return;
			this.projectionWork = this.projectionWork.then(() => this.reconcile()).catch(error => { this.projectionError = error; this.notice(error); });
		});
	}

	private async flushProjection(): Promise<void> {
		await this.projectionWork;
		if (this.projectionError) throw this.projectionError;
		await this.reconcile();
	}

	private async reconcile(): Promise<void> {
		const published = await this.harness.commit(async tx => {
			const state = await tx.doc(ProductDoc);
			const newlySettled: { receipt: PiTurnSettlementReceipt; presented: boolean }[] = [];
			const live = await tx.doc(LiveDoc, this.conversation.id);
			for (const request of Object.values(state.requests)) {
				if (request.settlement) continue;
				const submission = await tx.submissionByRequest(this.conversation.id, requestKey(request.clientMessageId));
				if (!submission) continue; // A prepared intent is not a native admission.
				request.submissionId = submission.id;
				if (submission.entry !== undefined) request.entryId = submission.entry;
				for (const [id, inputs] of this.generationInputs) if (inputs.includes(submission.id) && !request.generationIds.includes(id)) request.generationIds.push(id);
				if (live.run?.inputs.includes(submission.id) && !request.generationIds.includes(live.run.taskId)) request.generationIds.push(live.run.taskId);
				if (!terminal(submission)) continue;
				const answer = submission.status === "done" && submission.type === "input" ? await tx.entry(submission.answer) : undefined;
				if (answer?.byTaskId !== undefined && !request.generationIds.includes(answer.byTaskId)) request.generationIds.push(answer.byTaskId);
				// Native terminal task state proves its ordinary owned subtree drained. A run end and a done input alone do not.
				if (request.generationIds.length === 0 && submission.entry !== undefined) {
					// A crash can leave native outcome tables ahead of the product projection. A passive, atomic quiescence read repairs that gap;
					// it neither waits for nor cancels unrelated work, and unfinished native tasks keep the receipt pending.
					const active = await Promise.all((["pending", "running", "waiting", "completing"] as const)
						.map(status => tx.scanTasks({ status, background: false }, 1)));
					if (active.some(page => page.items.length > 0)) continue;
				}
				const tasks = await Promise.all(request.generationIds.map(id => tx.task(id as TaskId)));
				if (tasks.some(task => task?.state.status !== "terminal")) continue;
				const receipt = await this.createSettlement(tx, request, submission, answer);
				request.settlement = json(receipt);
				// Queued or steering inputs have their own exact receipts, but only the original execution input ends the public Agent scope.
				newlySettled.push({ receipt, presented: request.generationIds.some(id => this.requestForGeneration(id)?.turnId === request.turnId) });
			}
			return newlySettled;
		}, context);
		for (const { receipt, presented } of published) {
			this.settlements.restore(receipt);
			if (!presented) continue;
			const final = receipt.receipt.finalMessage;
			if (final) this.emitMessageEnd(final, receipt);
			this.emit({ type: "agent_settled", receipt: receipt.receipt }, receipt);
		}
	}

	private async createSettlement(tx: Tx, request: RequestBinding, submission: SubmissionRecord, answer?: EntryRecord): Promise<PiTurnSettlementReceipt> {
		const head = await tx.latestHeadMarker(this.conversation.id);
		const entries: EntryRecord[] = [];
		let cursor;
		do {
			const page = await tx.scanEntries({ conversationId: this.conversation.id, ...(head ? { minEntryId: head.head } : {}) }, 256, cursor);
			entries.push(...page.items); cursor = page.next;
		} while (cursor);
		entries.reverse();
		const messages = entries.flatMap(entry => entry.model ?? []);
		const finalMessage = answer?.model?.find(message => message.role === "assistant");
		const aborted = submission.status === "unanswered" && submission.reason === "aborted";
		const disposition = aborted ? "aborted" : submission.status === "unanswered" || finalMessage?.stopReason === "error" ? "failed" : "completed";
		const terminalIds = request.generationIds.map(id => `durable:task:${id}`);
		const receipt: AgentSettledReceiptV2 = {
			schemaVersion: "pi.agent-settled.v2", receiptId: `pi-settled:durable:${hash([this.state.runtimeSessionId, request.turnId, submission.id])}`,
			sessionId: this.state.runtimeSessionId, runId: request.turnId, scopeId: `${this.state.runtimeSessionId}:${request.turnId}`,
			generation: request.generationIds.length, disposition,
			stopReason: submission.status === "unanswered" ? submission.reason : finalMessage?.stopReason ?? "native_submission_done",
			transcript: { messageCount: messages.length, entryCount: entries.length, lineageHash: hash(entries.map(entry => entry.id)), contentHash: hash(messages) },
			continuations: { generation: request.generationIds.length, pendingIds: [], readyIds: [], scheduledIds: [], leasedIds: [],
				terminalIds: terminalIds.slice(0, 256), terminalIdsOmitted: Math.max(0, terminalIds.length - 256), idsHash: hash(terminalIds),
				counts: { pending: 0, leased: 0, completed: disposition === "completed" ? terminalIds.length : 0,
					cancelled: aborted ? terminalIds.length : 0, expired: 0, failed: disposition === "failed" ? terminalIds.length : 0 } },
			operations: { pending: 0, pendingByKind: {}, registeredByKind: { nativeGeneration: terminalIds.length } },
			settledAtMs: Date.now(), aborted, pendingOperations: 0, operationCounts: { nativeGeneration: terminalIds.length },
			...(finalMessage ? { finalMessage: this.projectMessage(answer!, finalMessage, 0, request) } : {}),
		};
		return { schemaVersion: "rag-ime.pi-turn-settlement.v1", sessionId: this.externalSessionId, runtimeSessionId: this.state.runtimeSessionId, ...identity(request), receipt };
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.admission.then(operation);
		this.admission = result.then(() => undefined, () => undefined);
		return result;
	}

	async prompt(options: { message: string; clientMessageId?: string; images?: PromptOptions["images"]; sessionContext?: string; transientContext?: string }): Promise<PiPromptReceipt> {
		return this.serial(() => this.admit(options, "prompt"));
	}

	private async admit(options: { message: string; clientMessageId?: string; images?: PromptOptions["images"]; sessionContext?: string; transientContext?: string }, delivery: RequestBinding["delivery"]): Promise<PiPromptReceipt> {
		if (this.disposePromise) throw new RuntimeProtocolError("SESSION_CLOSED", "Durable Session is closing");
		if (options.images?.length) throw new RuntimeProtocolError("ENGINE_FEATURE_UNAVAILABLE", "Durable currently accepts text inputs only");
		const clientMessageId = options.clientMessageId?.trim();
		if (!clientMessageId) throw new RuntimeProtocolError("INVALID_PARAMS", "Durable admission requires clientMessageId");
		const key = requestKey(clientMessageId);
		const fingerprint = hash({ message: options.message, delivery, sessionContext: options.sessionContext ?? null, transientContext: options.transientContext ?? "" });
		await this.flushProjection();
		let request = this.state.requests[key];
		if (request && request.fingerprint !== fingerprint) throw new RuntimeProtocolError("PROMPT_IDENTITY_MISMATCH", "clientMessageId was already admitted with different arguments");
		if (request?.submissionId !== undefined) return { ...identity(request), disposition: request.delivery === "prompt" ? "started" : "queued", settlement: persistedTurnSettlement(request.settlement) };
		if (!request) {
			const running = this.live.run;
			const nativeTask = running ? await this.harness.getTask(running.taskId, context) : undefined;
			if (this.abortingInputs.size > 0 || nativeTask?.abortRequested) throw new RuntimeProtocolError("SESSION_ABORTING", "Stop is draining its original input; retry the new input after it settles", { clientMessageId });
			if (delivery === "prompt" && !this.isIdle) throw new RuntimeProtocolError("SESSION_BUSY", "Durable Session already has unfinished admitted work");
			if (delivery !== "prompt" && !this.currentRequest()) throw new RuntimeProtocolError("SESSION_IDLE", "Durable Session has no active turn");
			request = { turnId: randomUUID(), clientMessageId, fingerprint, message: options.message,
				sessionContext: options.sessionContext ?? this.state.sessionContext, transientContext: options.transientContext ?? "",
				delivery, createdAtMs: Date.now(), generationIds: [] };
			const prepared = request;
			await this.harness.commit(async tx => {
				const state = await tx.doc(ProductDoc); state.requests[key] = prepared;
				if (options.sessionContext !== undefined) state.sessionContext = options.sessionContext;
			}, context);
		}
		this.admitting++;
		try {
			const submission = await this.conversation.submit({ requestId: key, type: "input", content: request.message,
				whenBusy: delivery === "prompt" ? "reject" : delivery }, context);
			this.scheduling = "running";
			await this.harness.commit(async tx => { const state = await tx.doc(ProductDoc); state.requests[key].submissionId = submission.id; }, context);
			await this.flushProjection();
			return { ...identity(this.state.requests[key]), disposition: delivery === "prompt" ? "started" : "queued", settlement: this.settlements.get(request.turnId, clientMessageId) };
		} finally { this.admitting--; }
	}

	async queueMessage(options: { delivery: "steer" | "followUp"; message: string; clientMessageId?: string; images?: PromptOptions["images"] }): Promise<Record<string, unknown>> {
		return this.serial(async () => {
			const parentTurnId = this.currentRequest()?.turnId;
			const ack = await this.admit(options, options.delivery);
			return { ...ack, accepted: true, queued: true, delivery: options.delivery, parentTurnId,
				continuationId: options.clientMessageId, messageQueue: this.messageQueue() };
		});
	}

	async resume(turnId: string, clientMessageId: string): Promise<Record<string, unknown>> {
		return this.serial(async () => {
			await this.flushProjection();
			const request = this.state.requests[requestKey(clientMessageId)];
			if (!request || request.turnId !== turnId || request.submissionId === undefined) throw new RuntimeProtocolError("RESUME_TARGET_MISMATCH", "Resume target is not the exact admitted input");
			const settlement = persistedTurnSettlement(request.settlement);
			if (!settlement && this.currentRequest()?.turnId !== turnId) throw new RuntimeProtocolError("RESUME_TARGET_MISMATCH", "Resume target is no longer the current input");
			if (!settlement) { this.harness.resume(); this.scheduling = "running"; }
			return { schemaVersion: "rag-ime.pi-session-resume.v1", accepted: true, runtimeEngine: "durable", turnId, clientMessageId,
				resumed: !settlement, ...(settlement ? { settlement } : {}), state: await this.controlState() };
		});
	}

	private async inspect(): Promise<void> {
		this.scheduling = (await this.harness.inspect(context)).scheduling;
	}

	private metadata(): Record<string, unknown> {
		const request = this.currentRequest();
		const model = this.agent.model ? this.options.modelRuntime.getModel(this.agent.model.provider, this.agent.model.modelId) : undefined;
		return { sessionId: this.externalSessionId, runtimeEngine: "durable", piSessionId: this.state.runtimeSessionId,
			durableStoreRef: this.durableStoreRef, durableConversationId: String(this.conversation.id), cwd: this.options.cwd,
			engineCapabilities: DURABLE_ENGINE_CAPABILITIES, paused: this.scheduling === "paused",
			recoverable: this.scheduling === "paused" && !!request, isIdle: this.isIdle, isCompacting: !!this.live.compactions?.length,
			activeTurn: request ? identity(request) : undefined, sequence: this.sequence, codemodeMode: "off", thinkingLevel: this.agent.thinkingLevel ?? "off",
			model: model ? { provider: model.provider, id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
				input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevels: getSupportedThinkingLevels(model) } : null,
			messageQueue: this.messageQueue(), turnSettlement: this.settlements.latest(), toolManifest: this.tools.list(),
			toolCatalogRevision: this.tools.catalogRevision(), nativeCapabilities: this.nativeCapabilities() };
	}

	async controlState(): Promise<Record<string, unknown>> {
		await this.flushProjection(); await this.inspect();
		return { schemaVersion: "rag-ime.pi-session-control-state.v1", projectionCurrent: true, ...this.metadata() };
	}

	async openSnapshot(): Promise<Record<string, unknown>> {
		await this.flushProjection(); await this.inspect();
		const latest = await this.conversation.entries({}, 1, undefined, context);
		return { ...this.metadata(), leafId: latest.items[0] ? `durable:${latest.items[0].id}` : null };
	}

	async snapshot(view?: string): Promise<Record<string, unknown>> {
		await this.flushProjection(); await this.inspect();
		let entries: readonly EntryRecord[];
		let cursor;
		if (view === "recent") {
			const page = await this.conversation.entries({}, RECENT_ENTRIES, undefined, context);
			entries = [...page.items].reverse(); cursor = page.next;
		} else if (view === undefined || view === "full") {
			const history: EntryRecord[] = [];
			let historyCursor;
			do {
				const page = await this.conversation.entries({}, 256, historyCursor, context);
				history.push(...page.items); historyCursor = page.next;
			} while (historyCursor);
			entries = history.reverse();
		}
		else throw new RuntimeProtocolError("INVALID_PARAMS", "Durable snapshot view must be recent or full");
		const messages = (await Promise.all(entries.map(entry => this.projectEntry(entry)))).flat();
		return { ...this.metadata(), projectionCurrent: true, partial: cursor !== undefined, historyCursor: cursor,
			messages, messageCount: messages.length, leafId: entries.at(-1) ? `durable:${entries.at(-1)!.id}` : null,
			entries: messages.map(message => ({ type: "message", id: message.id, message })) };
	}

	private projectMessage(entry: EntryRecord, message: NonNullable<EntryRecord["model"]>[number], index: number, request?: RequestBinding): Record<string, unknown> {
		const id = message.role === "assistant" && entry.byTaskId !== undefined ? `durable:task:${entry.byTaskId}:assistant` : `durable:${entry.id}:${index}`;
		return { ...message, id, ...(request ? { _ragImeTurnId: request.turnId, clientMessageId: request.clientMessageId } : {}) };
	}

	private async requestForEntry(entry: EntryRecord): Promise<RequestBinding | undefined> {
		const requests = Object.values(this.state.requests);
		const placed = requests.find(request => request.entryId === entry.id) ?? [...this.submissionRecords.values()]
			.filter(submission => submission.entry === entry.id && submission.requestId)
			.map(submission => this.state.requests[submission.requestId!])[0];
		if (placed) return placed;
		let taskId = entry.byTaskId;
		while (taskId !== undefined) {
			const bound = requests.find(request => request.generationIds.includes(taskId!));
			if (bound) return bound;
			const task = await this.harness.getTask(taskId, context);
			taskId = task?.owner;
		}
		return undefined;
	}

	private async projectEntry(entry: EntryRecord): Promise<Record<string, unknown>[]> {
		const request = await this.requestForEntry(entry);
		return (entry.model ?? []).map((message, index) => this.projectMessage(entry, message, index, request));
	}

	private presentationRequest(): RequestBinding | undefined {
		const submission = this.submissionRecords.get(this.projectedInputs[0]);
		return Object.values(this.state.requests).find(request => request.submissionId === this.projectedInputs[0])
			?? (submission?.requestId ? this.state.requests[submission.requestId] : undefined);
	}

	private emitMessageEnd(message: Record<string, unknown>, turn?: ActiveTurn): void {
		const id = String(message.id);
		if (this.emittedMessageIds.has(id)) return;
		this.emittedMessageIds.add(id);
		this.emit({ type: "message_end", message }, turn);
	}

	private async projectEvent(event: AgentEvent): Promise<void> {
		if (event.type === "submission") { await this.flushProjection(); return; }
		if (event.type === "run_start") this.projectedInputs = event.inputs;
		const request = this.presentationRequest();
		const turn = request ? identity(request) : undefined;
		switch (event.type) {
			case "message_end":
				for (const message of await this.projectEntry(event.entry)) this.emitMessageEnd(message, turn ?? await this.requestForEntry(event.entry));
				this.partialMessage = undefined;
				break;
			case "turn_start": {
				const ids = [...this.generationInputs].filter(([, inputs]) => inputs[0] === this.projectedInputs[0]).map(([id]) => id).sort((a, b) => a - b);
				this.projectedGenerationId = ids.find(id => !this.projectedGenerations.has(id)) ?? this.projectedGenerationId;
				if (this.projectedGenerationId !== undefined) this.projectedGenerations.add(this.projectedGenerationId);
				this.emit({ type: "turn_start" }, turn); break;
			}
			case "message_update": {
				if (!this.partialMessage) break;
				for (const change of event.changes) {
					let update: Record<string, unknown> = { ...change };
					if (change.type === "message") this.partialMessage = structuredClone(change.message);
					else if (change.type === "text_delta" || change.type === "thinking_delta") {
						const block = this.partialMessage.content[change.contentIndex];
						if (block?.type === "text" && change.type === "text_delta") block.text += change.delta;
						if (block?.type === "thinking" && change.type === "thinking_delta") block.thinking += change.delta;
					} else if (change.type === "block" || change.type.endsWith("_start")) {
						if ("block" in change) {
							this.partialMessage.content[change.contentIndex] = structuredClone(change.block);
							if (change.type === "block") update = { type: `${change.block.type === "toolCall" ? "toolcall" : change.block.type}_end`, contentIndex: change.contentIndex };
						}
					}
					this.partialMessage.usage = structuredClone(event.usage);
					this.emit({ type: "message_update", assistantMessageEvent: update, message: { ...this.partialMessage,
						id: `durable:task:${this.projectedGenerationId}:assistant` } }, turn);
				}
				break;
			}
			case "message_start": {
				const message = event.message.role === "assistant" ? { ...event.message, id: `durable:task:${this.projectedGenerationId}:assistant` } : event.message;
				if (event.message.role === "assistant") this.partialMessage = structuredClone(event.message);
				this.emit({ type: "message_start", message }, turn); break;
			}
			case "tool_execution_end": {
				const message = event.entry?.model?.find(item => item.role === "toolResult");
				this.emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
					result: message ? { content: message.content, details: message.details } : undefined, isError: message?.isError ?? true }, turn); break;
			}
			case "tool_execution_update": this.emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
				partialResult: { content: [{ type: "text", text: event.output && "set" in event.output ? event.output.set : event.output && "append" in event.output ? event.output.append ?? "" : "" }], details: event.details } }, turn); break;
			case "run_start": this.emit({ type: "agent_start" }, turn); break;
			case "run_end": break; // Native run end is presentation, never physical-drain proof.
			case "inbox_update": this.emit({ type: "queue_update", ...this.messageQueue(event.items) }, turn); break;
			case "snapshot": this.emit({ type: "durable_snapshot", projectionCurrent: true,
				messages: (await Promise.all(event.entries.slice(-RECENT_ENTRIES).map(entry => this.projectEntry(entry)))).flat() }, turn); break;
			case "entry_appended": break;
			default: this.emit({ ...event }, turn);
		}
	}

	settlement(turnId: string, clientMessageId?: string): PiTurnSettlementReceipt | undefined {
		const stored = Object.values(this.state.requests).find(request => request.turnId === turnId && (!clientMessageId || request.clientMessageId === clientMessageId));
		const receipt = persistedTurnSettlement(stored?.settlement);
		return receipt ?? this.settlements.get(turnId, clientMessageId);
	}

	async awaitSettled(turnId: string, options: WaitForTurnSettlementOptions = {}): Promise<PiTurnSettlementReceipt> {
		await this.flushProjection();
		const receipt = this.settlement(turnId, options.expectedClientMessageId);
		return receipt ?? this.settlements.wait(turnId, options);
	}

	private trackCancellation<T>(work: Promise<T>): Promise<T> {
		this.cancellationWork.add(work);
		void work.then(() => this.cancellationWork.delete(work), () => this.cancellationWork.delete(work));
		return work;
	}

	abort(expected?: { turnId?: string; clientMessageId: string }): Promise<PiSessionAbortReceipt> {
		return this.trackCancellation(this.abortInternal(expected));
	}

	private async abortInternal(expected?: { turnId?: string; clientMessageId: string }): Promise<PiSessionAbortReceipt> {
		if (this.disposePromise) throw new RuntimeProtocolError("SESSION_CLOSED", "Durable Session is closing");
		if (!expected?.clientMessageId) throw new RuntimeProtocolError("ABORT_TARGET_MISMATCH", "Durable Stop requires the original client identity");
		await this.flushProjection();
		const request = this.state.requests[requestKey(expected.clientMessageId)];
		if (!request || (expected.turnId !== undefined && request.turnId !== expected.turnId) || request.submissionId === undefined || request.settlement) throw new RuntimeProtocolError("ABORT_TARGET_MISMATCH", "Stop target is no longer active");
		this.abortingInputs.add(request.submissionId);
		try {
			const result = await this.conversation.abortRun(request.submissionId as SubmissionId, context);
			if (result !== "aborted") throw new RuntimeProtocolError("ABORT_TARGET_MISMATCH", "Stop target is no longer the current unmarked run");
			this.scheduling = "running";
			await this.flushProjection();
			return this.abortReceipt(request);
		} finally { this.abortingInputs.delete(request.submissionId); }
	}

	private abortReceipt(request: RequestBinding): PiSessionAbortReceipt {
		return { schemaVersion: "rag-ime.pi-session-abort-receipt.v1", sessionId: this.externalSessionId, turnId: request.turnId,
			cancelledDecisionIds: [], cancelledUIRequestIds: [], lifecycle: { schemaVersion: "pi.agent-abort-receipt.v1",
				scopeId: `${this.state.runtimeSessionId}:${request.turnId}`, generation: request.generationIds.length, reason: "user_abort",
				cancelledContinuationIds: [], cancelledOperationIds: request.generationIds.map(id => `durable:task:${id}`), failedOperationIds: [],
				operations: [], pendingOperations: [], drained: true, idle: this.isIdle, source: "runtime_host_adapter" } };
	}

	abortExact(options: { turnId: string; clientMessageId: string; cancelId: string; lookupOnly?: boolean; recoverRetiredOnly?: boolean; recoverInterruptedOnly?: boolean }): Promise<PiExactTurnCancelReceipt> {
		const existing = this.cancelling.get(options.cancelId);
		if (existing && !options.lookupOnly) {
			if (existing.turnId !== options.turnId || existing.clientMessageId !== options.clientMessageId) return Promise.reject(new RuntimeProtocolError("CANCEL_IDENTITY_MISMATCH", "Cancel identity belongs to another turn"));
			return existing.result;
		}
		const result = this.trackCancellation(this.abortExactInternal(options));
		if (!options.lookupOnly) {
			this.cancelling.set(options.cancelId, { turnId: options.turnId, clientMessageId: options.clientMessageId, result });
			void result.then(() => this.cancelling.delete(options.cancelId), () => this.cancelling.delete(options.cancelId));
		}
		return result;
	}

	private async abortExactInternal(options: { turnId: string; clientMessageId: string; cancelId: string; lookupOnly?: boolean; recoverRetiredOnly?: boolean; recoverInterruptedOnly?: boolean }): Promise<PiExactTurnCancelReceipt> {
		if (this.disposePromise) throw new RuntimeProtocolError("SESSION_CLOSED", "Durable Session is closing");
		await this.flushProjection();
		const key = hash(options.cancelId);
		let prior = this.state.cancels[key] as unknown as PiExactTurnCancelReceipt | undefined;
		if (prior) {
			if (prior.turnId !== options.turnId || prior.clientMessageId !== options.clientMessageId) throw new RuntimeProtocolError("CANCEL_IDENTITY_MISMATCH", "Cancel identity belongs to another turn");
			prior = structuredClone(prior);
			if (prior.state !== "rejected" && prior.phase !== "settled") {
				const request = this.state.requests[requestKey(options.clientMessageId)];
				if (request?.turnId === options.turnId && request.submissionId !== undefined) {
					const submission = await (await this.harness.submission(request.submissionId as SubmissionId, context))?.status(context);
					const tasks = await Promise.all(request.generationIds.map(id => this.harness.getTask(id as TaskId, context)));
					if ((submission?.status === "unanswered" && submission.reason === "aborted") || tasks.some(task => task?.abortRequested)) {
						prior.state = "accepted"; prior.phase = request.settlement ? "settled" : "requested";
						if (request.settlement) prior.runtimeReceipt = this.abortReceipt(request);
						const repaired = prior;
						await this.harness.commit(async tx => { (await tx.doc(ProductDoc)).cancels[key] = json(repaired); }, context);
					}
				}
			}
			if (prior.state !== "unknown" || options.lookupOnly) return prior;
		}
		const receipt: PiExactTurnCancelReceipt = prior ?? { schemaVersion: "rag-ime.pi-exact-turn-cancel.v1", sessionId: this.externalSessionId,
			turnId: options.turnId, clientMessageId: options.clientMessageId, cancelId: options.cancelId, state: "unknown" };
		if (options.lookupOnly) return receipt;
		if (options.recoverRetiredOnly || options.recoverInterruptedOnly) throw new RuntimeProtocolError("ENGINE_FEATURE_UNAVAILABLE", "Durable recovery uses exact session.resume or native Stop; classic retirement repair is unavailable");
		receipt.receiptId = `pi-exact-cancel:durable:${hash([this.state.runtimeSessionId, options.cancelId])}`;
		// Persist the caller's intent before native signalling; only native marks or a drained exact receipt confirm acceptance.
		await this.harness.commit(async tx => { (await tx.doc(ProductDoc)).cancels[key] = json(receipt); }, context);
		try {
			receipt.runtimeReceipt = await this.abort({ turnId: options.turnId, clientMessageId: options.clientMessageId });
			receipt.state = "accepted"; receipt.phase = "settled";
		} catch (error) {
			if (!(error instanceof RuntimeProtocolError) || error.code !== "ABORT_TARGET_MISMATCH") throw error;
			receipt.state = "rejected"; receipt.reason = "requested_input_is_not_current";
		}
		await this.harness.commit(async tx => { const state = await tx.doc(ProductDoc); state.cancels[key] = json(receipt); }, context);
		return receipt;
	}

	async compact(instructions?: string): Promise<Record<string, unknown>> {
		const id = await this.conversation.compact(instructions, context);
		this.scheduling = "running";
		const task = await this.harness.waitForTask(id, context);
		await this.flushProjection();
		return { taskId: `durable:task:${id}`, outcome: task.state.outcome, state: await this.controlState() };
	}

	async setModel(provider: string, modelId: string, maxTokens?: number): Promise<Record<string, unknown>> {
		if (maxTokens !== undefined) throw new RuntimeProtocolError("ENGINE_FEATURE_UNAVAILABLE", "Durable maxTokens overrides are unavailable");
		return this.serial(async () => {
			if (!this.isIdle) throw new RuntimeProtocolError("SESSION_BUSY", "Model selection requires an idle Durable Session");
			const model = this.options.modelRuntime.getModel(provider, modelId);
			if (!model) throw new RuntimeProtocolError("MODEL_NOT_FOUND", "Requested model is unavailable");
			await this.conversation.configure({ model: { provider, modelId }, thinkingLevel: clampThinkingLevel(model, this.agent.thinkingLevel ?? "off") }, context);
			return this.openSnapshot();
		});
	}

	async setThinkingLevel(level: ModelThinkingLevel): Promise<Record<string, unknown>> {
		return this.serial(async () => {
			if (!this.isIdle) throw new RuntimeProtocolError("SESSION_BUSY", "Thinking selection requires an idle Durable Session");
			const model = this.agent.model && this.options.modelRuntime.getModel(this.agent.model.provider, this.agent.model.modelId);
			await this.conversation.configure({ thinkingLevel: model ? clampThinkingLevel(model, level) : level }, context);
			return this.openSnapshot();
		});
	}

	listTools(): ReturnType<BackendToolRegistry["list"]> { return this.tools.list(); }
	nativeCapabilities(): Record<string, unknown> { return { runtimeEngine: "durable", ...DURABLE_ENGINE_CAPABILITIES }; }
	async syncTools(manifest: unknown, nativeMcpExecutionAllowed = false): Promise<ReturnType<BackendToolRegistry["list"]>> {
		return this.serial(async () => {
			if (nativeMcpExecutionAllowed) throw new RuntimeProtocolError("ENGINE_FEATURE_UNAVAILABLE", "Durable native MCP is unavailable");
			if (!this.isIdle) throw new RuntimeProtocolError("SESSION_BUSY", "Tools require an idle Durable Session");
			this.tools.sync(manifest); this.installTools();
			await this.conversation.configure({ tools: this.offeredTools() }, context);
			return this.tools.list();
		});
	}

	private messageQueue(queued: readonly { id: SubmissionId; mode: string }[] = this.inbox.items): Record<string, unknown> {
		const items = queued.flatMap(item => {
			const submission = this.submissionRecords.get(item.id);
			const request = Object.values(this.state.requests).find(request => request.submissionId === item.id)
				?? (submission?.requestId ? this.state.requests[submission.requestId] : undefined);
			return request ? [{ message: request.message, delivery: item.mode }] : [];
		});
		return { steering: items.filter(item => item.delivery === "steer").map(item => item.message),
			followUp: items.filter(item => item.delivery === "followUp").map(item => item.message) };
	}

	private waitForDecision(kind: "approval" | "review", targetId: string, details: Record<string, unknown>, turn: ActiveTurn, signal?: AbortSignal): Promise<boolean> {
		const key = `${kind}:${targetId}`;
		if (this.pendingDecisions.has(key)) throw new RuntimeProtocolError("DECISION_ALREADY_PENDING", "Decision is already pending");
		return new Promise(resolveDecision => {
			const requestId = randomUUID();
			const onAbort = () => finish(false);
			const finish = (value: boolean) => { this.pendingDecisions.delete(key); signal?.removeEventListener("abort", onAbort); resolveDecision(value); };
			this.pendingDecisions.set(key, { requestId, turn, finish });
			if (signal?.aborted) { finish(false); return; }
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit({ type: "extension_ui_request", id: requestId, method: "confirm",
				title: `${kind === "approval" ? "RAG-IME-APPROVAL" : "RAG-IME-REVIEW"}:${targetId}`, message: "请在控制中心核对并决定是否继续。", details }, turn);
		});
	}

	resolveDecision(kind: "approval" | "review", targetId: string, approved: boolean): string {
		const decision = this.pendingDecisions.get(`${kind}:${targetId}`);
		if (!decision) throw new RuntimeProtocolError("DECISION_NOT_PENDING", "Decision is not pending");
		decision.finish(approved); return decision.requestId;
	}

	resolveUI(requestId: string, response: Record<string, unknown>): Record<string, unknown> {
		const decision = [...this.pendingDecisions.values()].find(decision => decision.requestId === requestId);
		if (!decision) throw new RuntimeProtocolError("UI_REQUEST_NOT_PENDING", "UI request is not pending");
		if (response.cancelled !== true && typeof response.confirmed !== "boolean") throw new RuntimeProtocolError("INVALID_UI_RESPONSE", "Confirm response requires confirmed or cancelled");
		decision.finish(response.confirmed === true && response.cancelled !== true); return { requestId, resolved: true };
	}

	private emit(payload: Record<string, unknown>, turn?: ActiveTurn): void {
		this.options.emitEvent({ protocolVersion: PROTOCOL_VERSION, event: "agent.event", sessionId: this.externalSessionId,
			...turn, sequence: ++this.sequence, payload });
	}
	private notice(error: unknown): void {
		this.options.emitEvent({ protocolVersion: PROTOCOL_VERSION, event: "runtime.notice", sessionId: this.externalSessionId,
			sequence: ++this.sequence, payload: { type: "durable_projection_error", message: error instanceof Error ? error.message : String(error) } });
	}

	dispose(): Promise<void> {
		return this.disposePromise ??= this.disposeInternal();
	}
	private async disposeInternal(): Promise<void> {
		this.scheduling = "closing";
		try {
			await this.admission;
			await Promise.allSettled([...this.cancellationWork]);
			await this.projectionWork;
			await this.reconcile();
		} finally {
			await this.eventStream?.stop();
			try { await this.eventDelivery; }
			finally {
				this.unsubscribeCommits?.();
				this.settlements.dispose("Durable Host detached before settlement; admitted input remains recoverable");
				// Harness.close cancels invocations without native abort marks, preserving checkpoints for explicit resume.
				try { await this.harness.close(context); } finally { await this.releaseStorage(); }
			}
		}
	}
}
