import {
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@earendil-works/pi-ai/compat";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { type ContinuationCancelReceipt, type ContinuationEnvelope, ContinuationQueue } from "./runtime-primitives.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
	/** Resolve an undisclosed tool for execution without adding its schema to Provider context. */
	resolveToolForExecution?: (name: string) => AgentTool<any> | undefined;
}

export interface ContinuationOptions {
	id?: string;
	correlationId?: string;
	parentContinuationId?: string;
	origin?: string;
	idempotencyKey?: string;
	cancelGeneration?: number;
	notBefore?: number;
	deadline?: number;
	priority?: number;
	maxAttempts?: number;
}

export type AgentContinuation = ContinuationEnvelope<AgentMessage>;

class PendingMessageQueue {
	private queue = new ContinuationQueue<AgentMessage>();
	private readonly activeLeases = new Map<string, { leaseId: string; message: AgentMessage }>();
	private readonly leaseByMessage = new WeakMap<object, { id: string; leaseId: string }>();
	private timer?: ReturnType<typeof setTimeout>;
	public mode: QueueMode;
	private readonly kind: "steer" | "follow_up";
	private readonly getGeneration: () => number;
	private readonly wake: () => void;
	private readonly onLease: (continuations: AgentContinuation[]) => void;

	constructor(
		mode: QueueMode,
		kind: "steer" | "follow_up",
		getGeneration: () => number,
		wake: () => void,
		onLease: (continuations: AgentContinuation[]) => void,
	) {
		this.mode = mode;
		this.kind = kind;
		this.getGeneration = getGeneration;
		this.wake = wake;
		this.onLease = onLease;
	}

	enqueue(message: AgentMessage, options: ContinuationOptions = {}): AgentContinuation {
		const now = Date.now();
		const id = options.id ?? crypto.randomUUID();
		const cancelGeneration = this.getGeneration();
		if (options.cancelGeneration !== undefined && options.cancelGeneration !== cancelGeneration) {
			throw new Error(
				`continuation cancelGeneration ${options.cancelGeneration} does not match current generation ${cancelGeneration}`,
			);
		}
		const envelope: AgentContinuation = {
			id,
			correlationId: options.correlationId ?? id,
			parentContinuationId: options.parentContinuationId,
			origin: options.origin ?? "agent_api",
			kind: this.kind,
			payload: message,
			idempotencyKey: options.idempotencyKey ?? id,
			cancelGeneration,
			createdAt: now,
			notBefore: options.notBefore,
			deadline: options.deadline,
			priority: options.priority ?? 0,
			attempt: 0,
			maxAttempts: options.maxAttempts ?? 1,
			state: "pending",
		};
		const result = this.queue.enqueue(envelope);
		const accepted = result.accepted
			? envelope
			: this.queue.snapshot().items.find((item) => item.id === result.existingId);
		if (!accepted) throw new Error("deduplicated continuation is missing from the queue");
		this.schedule();
		return accepted;
	}

	hasItems(): boolean {
		return this.queue.snapshot().items.some((item) => item.state === "pending");
	}

	drain(): AgentMessage[] {
		const leased = this.queue.drain({
			now: Date.now(),
			cancelGeneration: this.getGeneration(),
			limit: this.mode === "all" ? Number.MAX_SAFE_INTEGER : 1,
		});
		for (const item of leased) {
			if (!item.leaseId) throw new Error(`leased continuation is missing leaseId: ${item.id}`);
			this.activeLeases.set(item.id, { leaseId: item.leaseId, message: item.payload });
			this.leaseByMessage.set(item.payload as object, { id: item.id, leaseId: item.leaseId });
		}
		if (leased.length > 0) this.onLease(leased);
		this.schedule();
		return leased.map((item) => item.payload);
	}

	clear(): void {
		const cancelledIds: string[] = [];
		for (const item of this.queue.snapshot().items) {
			cancelledIds.push(...this.queue.cancelById(item.id, "queue_cleared").cancelledIds);
		}
		this.forgetLeases(cancelledIds);
		this.schedule();
	}

	snapshot(): AgentContinuation[] {
		return this.queue.snapshot().items;
	}

	restore(items: AgentContinuation[]): void {
		this.activeLeases.clear();
		this.queue = new ContinuationQueue<AgentMessage>({
			snapshot: {
				items: items.map((item) => ({ ...item })),
			},
		});
		this.queue.recoverExpiredLeases({
			now: Date.now(),
			leaseTimeoutMs: 0,
			reason: "runtime_restarted",
			consumeAttempt: false,
		});
	}

	resume(): void {
		this.schedule();
	}

	hasReady(now = Date.now()): boolean {
		return this.queue.hasReady({ now, cancelGeneration: this.getGeneration() });
	}

	acknowledgeMessage(message: AgentMessage): boolean {
		const lease = this.leaseByMessage.get(message as object);
		if (!lease) return false;
		this.leaseByMessage.delete(message as object);
		this.activeLeases.delete(lease.id);
		const completed = this.queue.complete(lease.id, lease.leaseId);
		this.schedule();
		return completed;
	}

	releaseUnacknowledged(reason: string): void {
		for (const [id, lease] of this.activeLeases) {
			this.queue.release(id, lease.leaseId, reason);
			this.leaseByMessage.delete(lease.message as object);
		}
		this.activeLeases.clear();
		this.schedule();
	}

	cancelById(id: string, reason: string): ContinuationCancelReceipt {
		const receipt = this.queue.cancelById(id, reason);
		this.forgetLeases(receipt.cancelledIds);
		this.schedule();
		return receipt;
	}

	cancelCorrelation(correlationId: string, reason: string): ContinuationCancelReceipt {
		const receipt = this.queue.cancelCorrelation(correlationId, reason);
		this.forgetLeases(receipt.cancelledIds);
		this.schedule();
		return receipt;
	}

	cancelGeneration(generation: number, reason: string): ContinuationCancelReceipt {
		const receipt = this.queue.cancelGeneration(generation, reason);
		this.forgetLeases(receipt.cancelledIds);
		this.schedule();
		return receipt;
	}

	private forgetLeases(ids: readonly string[]): void {
		for (const id of ids) {
			const lease = this.activeLeases.get(id);
			if (lease) this.leaseByMessage.delete(lease.message as object);
			this.activeLeases.delete(id);
		}
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const now = Date.now();
		const next = this.queue
			.snapshot()
			.items.filter((item) => item.state === "pending" && item.cancelGeneration === this.getGeneration())
			.sort((left, right) => (left.notBefore ?? now) - (right.notBefore ?? now))[0];
		if (!next) return;
		const delay = Math.max(0, (next.notBefore ?? now) - now);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.wake();
		}, delay);
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private continuationGeneration = 0;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Graceful product/runtime stop policy evaluated after a completed turn. */
	public shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	/** Optional execution-only resolver for runtimes that separate capability from schema disclosure. */
	public resolveToolForExecution?: (name: string) => AgentTool<any> | undefined;
	/** Runtime hook used to start a due continuation through its owning session lifecycle. */
	public onContinuationReady?: () => void;
	/** Runtime hook invoked after exact continuation envelopes are leased, before Provider context is captured. */
	public onContinuationsLeased?: (continuations: AgentContinuation[]) => void;
	/** Coding Agent switches this to explicit so SessionManager persistence owns acknowledgement. */
	public continuationAcknowledgementMode: "after_listeners" | "explicit" = "after_listeners";

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		const wake = () => {
			if (this.activeRun || !this.hasQueuedMessages()) return;
			if (this.onContinuationReady) this.onContinuationReady();
			else void this.continue().catch(() => undefined);
		};
		this.steeringQueue = new PendingMessageQueue(
			options.steeringMode ?? "one-at-a-time",
			"steer",
			() => this.continuationGeneration,
			wake,
			(continuations) => this.onContinuationsLeased?.(continuations),
		);
		this.followUpQueue = new PendingMessageQueue(
			options.followUpMode ?? "one-at-a-time",
			"follow_up",
			() => this.continuationGeneration,
			wake,
			(continuations) => this.onContinuationsLeased?.(continuations),
		);
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.resolveToolForExecution = options.resolveToolForExecution;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	get currentContinuationGeneration(): number {
		return this.continuationGeneration;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage, options?: ContinuationOptions): AgentContinuation {
		return this.steeringQueue.enqueue(message, options);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage, options?: ContinuationOptions): AgentContinuation {
		return this.followUpQueue.enqueue(message, options);
	}

	listContinuations(): AgentContinuation[] {
		return [...this.steeringQueue.snapshot(), ...this.followUpQueue.snapshot()].sort(
			(left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
		);
	}

	restoreContinuationState(generation: number, continuations: AgentContinuation[]): void {
		if (!Number.isSafeInteger(generation) || generation < 0) {
			throw new Error("continuation generation must be a non-negative safe integer");
		}
		if (this.activeRun) throw new Error("cannot restore continuations while an Agent run is active");
		this.continuationGeneration = generation;
		this.steeringQueue.restore(continuations.filter((item) => item.kind === "steer"));
		this.followUpQueue.restore(continuations.filter((item) => item.kind === "follow_up"));
	}

	resumeRestoredContinuations(): void {
		this.steeringQueue.resume();
		this.followUpQueue.resume();
	}

	continuationForMessage(message: AgentMessage): AgentContinuation | undefined {
		return this.listContinuations().find((item) => item.payload === message);
	}

	acknowledgeContinuationMessage(message: AgentMessage): boolean {
		return this.steeringQueue.acknowledgeMessage(message) || this.followUpQueue.acknowledgeMessage(message);
	}

	releaseUnacknowledgedContinuations(reason: string): void {
		this.steeringQueue.releaseUnacknowledged(reason);
		this.followUpQueue.releaseUnacknowledged(reason);
	}

	cancelContinuation(
		selector: { id?: string; correlationId?: string; generation?: number },
		reason: string,
	): ContinuationCancelReceipt {
		const selected = [selector.id, selector.correlationId, selector.generation].filter(
			(value) => value !== undefined,
		);
		if (selected.length !== 1) throw new Error("exactly one continuation cancellation selector is required");
		if (selector.generation !== undefined) {
			if (!Number.isSafeInteger(selector.generation) || selector.generation < 0) {
				throw new Error("continuation cancellation generation must be a non-negative safe integer");
			}
			if (selector.generation > this.continuationGeneration) {
				throw new Error(
					`cannot cancel future continuation generation ${selector.generation}; current generation is ${this.continuationGeneration}`,
				);
			}
			if (selector.generation === this.continuationGeneration) {
				this.continuationGeneration += 1;
			}
		}
		const cancel = (queue: PendingMessageQueue) =>
			selector.id !== undefined
				? queue.cancelById(selector.id, reason)
				: selector.correlationId !== undefined
					? queue.cancelCorrelation(selector.correlationId, reason)
					: queue.cancelGeneration(selector.generation!, reason);
		const cancelledIds = [...cancel(this.steeringQueue).cancelledIds, ...cancel(this.followUpQueue).cancelledIds];
		return { cancelledIds };
	}

	cancelActiveContinuationGeneration(reason: string): ContinuationCancelReceipt {
		return this.cancelContinuation({ generation: this.continuationGeneration }, reason);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains scheduled messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Returns true only when a queued continuation may run at this instant. */
	hasReadyQueuedMessages(now = Date.now()): boolean {
		return this.steeringQueue.hasReady(now) || this.followUpQueue.hasReady(now);
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			resolveToolForExecution: this.resolveToolForExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: this.shouldStopAfterTurn,
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			prepareQueuedTurn: (context) => ({
				context: {
					...context,
					systemPrompt: this._state.systemPrompt,
					tools: this._state.tools.slice(),
				},
				model: this._state.model,
				thinkingLevel: this._state.thinkingLevel,
			}),
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		let failureReason: string | undefined;
		try {
			await executor(abortController.signal);
		} catch (error) {
			failureReason = abortController.signal.aborted ? "run_aborted" : "run_failed";
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.releaseUnacknowledgedContinuations(failureReason ?? "continuation_not_persisted");
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
		if (event.type === "message_end" && this.continuationAcknowledgementMode === "after_listeners") {
			this.acknowledgeContinuationMessage(event.message);
		}
	}
}
