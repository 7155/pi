export type ContinuationState = "pending" | "leased" | "completed" | "cancelled" | "expired" | "failed";

/** Product-neutral metadata for work that may continue after the current agent turn. */
export interface ContinuationEnvelope<TPayload = unknown> {
	id: string;
	correlationId: string;
	parentContinuationId?: string;
	origin: string;
	kind: string;
	payload: TPayload;
	idempotencyKey: string;
	cancelGeneration: number;
	createdAt: number;
	notBefore?: number;
	deadline?: number;
	priority: number;
	attempt: number;
	maxAttempts: number;
	state: ContinuationState;
	leaseId?: string;
	leasedAt?: number;
	lastFailure?: string;
	terminalReason?: string;
}

export interface ContinuationEnqueueResult {
	accepted: boolean;
	reason?: "duplicate";
	existingId?: string;
}

export interface ContinuationDrainOptions {
	now: number;
	cancelGeneration: number;
	limit: number;
}

export interface ContinuationQueueSnapshot<TPayload> {
	schemaVersion: "pi.continuation-queue.v2";
	capturedAt: number;
	items: ContinuationEnvelope<TPayload>[];
}

export interface ContinuationCancelReceipt {
	cancelledIds: string[];
}

export interface ContinuationReleaseReceipt {
	released: boolean;
	terminal: boolean;
	state?: ContinuationState;
}

export interface ContinuationReleaseOptions {
	/** Set false only when the lease owner disappeared before execution began. */
	consumeAttempt?: boolean;
}

export interface ContinuationQueueOptions<TPayload> {
	snapshot?: Pick<ContinuationQueueSnapshot<TPayload>, "items">;
	createLeaseId?: () => string;
	now?: () => number;
}

function validateEnvelope<TPayload>(
	envelope: ContinuationEnvelope<TPayload>,
	options: { restoring?: boolean } = {},
): void {
	for (const [name, value] of [
		["id", envelope.id],
		["correlationId", envelope.correlationId],
		["origin", envelope.origin],
		["kind", envelope.kind],
		["idempotencyKey", envelope.idempotencyKey],
	] as const) {
		if (!value.trim()) throw new Error(`${name} must be a non-empty string`);
	}
	if (envelope.parentContinuationId !== undefined && !envelope.parentContinuationId.trim()) {
		throw new Error("parentContinuationId must be omitted or non-empty");
	}
	if (!Number.isSafeInteger(envelope.cancelGeneration) || envelope.cancelGeneration < 0) {
		throw new Error("cancelGeneration must be a non-negative safe integer");
	}
	if (!Number.isFinite(envelope.createdAt) || envelope.createdAt < 0) {
		throw new Error("createdAt must be a non-negative finite timestamp");
	}
	for (const [name, value] of [
		["notBefore", envelope.notBefore],
		["deadline", envelope.deadline],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`${name} must be a non-negative finite timestamp`);
		}
	}
	if (!Number.isSafeInteger(envelope.priority)) throw new Error("priority must be a safe integer");
	if (!Number.isSafeInteger(envelope.attempt) || envelope.attempt < 0) {
		throw new Error("attempt must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(envelope.maxAttempts) || envelope.maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive safe integer");
	}
	if (envelope.attempt > envelope.maxAttempts) throw new Error("attempt cannot exceed maxAttempts");
	if (!options.restoring && envelope.state !== "pending") {
		throw new Error("new continuations must be pending");
	}
	if (envelope.deadline !== undefined && envelope.notBefore !== undefined && envelope.deadline < envelope.notBefore) {
		throw new Error("deadline cannot be earlier than notBefore");
	}
	if (envelope.state === "leased") {
		if (!envelope.leaseId?.trim() || envelope.leasedAt === undefined) {
			throw new Error("leased continuations require leaseId and leasedAt");
		}
		if (!Number.isFinite(envelope.leasedAt) || envelope.leasedAt < 0) {
			throw new Error("leasedAt must be a non-negative finite timestamp");
		}
		if (envelope.attempt < 1) throw new Error("leased continuations require at least one attempt");
	} else if (envelope.leaseId !== undefined || envelope.leasedAt !== undefined) {
		throw new Error("only leased continuations may carry lease metadata");
	}
}

function activeContinuation(state: ContinuationState): boolean {
	return state === "pending" || state === "leased";
}

/**
 * Deterministic continuation admission and leasing primitive.
 *
 * The queue is still storage-agnostic, but its snapshots can be persisted and
 * restored by a Runtime Host. A lease is not marked complete until its owner
 * acknowledges the run that consumed it. This removes the old crash window in
 * which `drain()` completed a continuation before the Provider run began.
 */
export class ContinuationQueue<TPayload = unknown> {
	private readonly items = new Map<string, ContinuationEnvelope<TPayload>>();
	private readonly idempotencyIndex = new Map<string, string>();
	private readonly createLeaseId: () => string;
	private readonly now: () => number;

	constructor(options: ContinuationQueueOptions<TPayload> = {}) {
		this.createLeaseId = options.createLeaseId ?? (() => crypto.randomUUID());
		this.now = options.now ?? (() => Date.now());
		for (const item of options.snapshot?.items ?? []) {
			validateEnvelope(item, { restoring: true });
			if (this.items.has(item.id)) throw new Error(`duplicate restored continuation id: ${item.id}`);
			if (this.idempotencyIndex.has(item.idempotencyKey)) {
				throw new Error(`duplicate restored idempotency key: ${item.idempotencyKey}`);
			}
			this.items.set(item.id, { ...item });
			this.idempotencyIndex.set(item.idempotencyKey, item.id);
		}
	}

	enqueue(envelope: ContinuationEnvelope<TPayload>): ContinuationEnqueueResult {
		validateEnvelope(envelope);
		const existingId = this.idempotencyIndex.get(envelope.idempotencyKey);
		if (existingId) return { accepted: false, reason: "duplicate", existingId };
		if (this.items.has(envelope.id)) throw new Error(`continuation id already exists: ${envelope.id}`);

		this.items.set(envelope.id, { ...envelope });
		this.idempotencyIndex.set(envelope.idempotencyKey, envelope.id);
		return { accepted: true };
	}

	drain(options: ContinuationDrainOptions): ContinuationEnvelope<TPayload>[] {
		if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("limit must be a positive integer");
		const eligible: ContinuationEnvelope<TPayload>[] = [];
		for (const item of this.items.values()) {
			if (item.state !== "pending") continue;
			if (item.cancelGeneration !== options.cancelGeneration) {
				item.state = "cancelled";
				item.terminalReason = "stale_generation";
				continue;
			}
			if (item.deadline !== undefined && item.deadline < options.now) {
				item.state = "expired";
				item.terminalReason = "deadline_exceeded";
				continue;
			}
			if (item.attempt >= item.maxAttempts) {
				item.state = "failed";
				item.terminalReason = "attempts_exhausted";
				continue;
			}
			if (item.notBefore !== undefined && item.notBefore > options.now) continue;
			eligible.push(item);
		}

		// Array sorting is stable, so equal-priority continuations created in the
		// same clock tick retain the queue's insertion order. Random continuation
		// IDs are identity, not scheduling policy, and must not reorder user input.
		eligible.sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);
		const selected = eligible.slice(0, options.limit);
		const generatedLeaseIds = new Set<string>();
		const leaseIds = selected.map((item) => {
			const leaseId = this.createLeaseId().trim();
			if (!leaseId) throw new Error(`lease generator returned an empty leaseId for ${item.id}`);
			if (generatedLeaseIds.has(leaseId)) {
				throw new Error(`lease generator returned a duplicate leaseId: ${leaseId}`);
			}
			generatedLeaseIds.add(leaseId);
			return leaseId;
		});
		return selected.map((item, index) => {
			item.state = "leased";
			item.attempt += 1;
			item.leaseId = leaseIds[index]!;
			item.leasedAt = options.now;
			item.lastFailure = undefined;
			return { ...item };
		});
	}

	complete(id: string, leaseId: string): boolean {
		if (!leaseId?.trim()) throw new Error("leaseId must be a non-empty string");
		const item = this.items.get(id);
		if (!item || item.state !== "leased" || item.leaseId !== leaseId) return false;
		item.state = "completed";
		item.leaseId = undefined;
		item.leasedAt = undefined;
		item.lastFailure = undefined;
		item.terminalReason = undefined;
		return true;
	}

	/**
	 * Release a lease after the consuming run failed before safe acknowledgement.
	 * The continuation returns to pending while budget remains; otherwise it
	 * becomes terminally failed. The same idempotency key remains authoritative.
	 */
	release(
		id: string,
		leaseId: string,
		reason: string,
		options: ContinuationReleaseOptions = {},
	): ContinuationReleaseReceipt {
		if (!leaseId?.trim()) throw new Error("leaseId must be a non-empty string");
		if (!reason.trim()) throw new Error("release reason must be a non-empty string");
		const item = this.items.get(id);
		if (!item || item.state !== "leased" || item.leaseId !== leaseId) {
			return { released: false, terminal: false, state: item?.state };
		}
		item.lastFailure = reason;
		item.leaseId = undefined;
		item.leasedAt = undefined;
		if (options.consumeAttempt === false) item.attempt = Math.max(0, item.attempt - 1);
		if (item.attempt >= item.maxAttempts) {
			item.state = "failed";
			item.terminalReason = "attempts_exhausted";
			return { released: true, terminal: true, state: item.state };
		}
		item.state = "pending";
		item.terminalReason = undefined;
		return { released: true, terminal: false, state: item.state };
	}

	/** Recover leases from a persisted snapshot after their owner disappeared. */
	recoverExpiredLeases(options: {
		now: number;
		leaseTimeoutMs: number;
		reason?: string;
		consumeAttempt?: boolean;
	}): string[] {
		if (!Number.isFinite(options.now) || options.now < 0) throw new Error("now must be non-negative");
		if (!Number.isFinite(options.leaseTimeoutMs) || options.leaseTimeoutMs < 0) {
			throw new Error("leaseTimeoutMs must be non-negative");
		}
		const recovered: string[] = [];
		for (const item of this.items.values()) {
			if (item.state !== "leased" || item.leasedAt === undefined || !item.leaseId) continue;
			if (item.leasedAt + options.leaseTimeoutMs > options.now) continue;
			if (
				this.release(item.id, item.leaseId, options.reason ?? "lease_owner_lost", {
					consumeAttempt: options.consumeAttempt,
				}).released
			) {
				recovered.push(item.id);
			}
		}
		return recovered;
	}

	hasPending(cancelGeneration?: number): boolean {
		return [...this.items.values()].some(
			(item) =>
				item.state === "pending" && (cancelGeneration === undefined || item.cancelGeneration === cancelGeneration),
		);
	}

	hasReady(options: { now: number; cancelGeneration: number }): boolean {
		return [...this.items.values()].some(
			(item) =>
				item.state === "pending" &&
				item.cancelGeneration === options.cancelGeneration &&
				(item.notBefore === undefined || item.notBefore <= options.now) &&
				(item.deadline === undefined || item.deadline >= options.now) &&
				item.attempt < item.maxAttempts,
		);
	}

	nextEligibleAt(cancelGeneration: number): number | undefined {
		let next: number | undefined;
		for (const item of this.items.values()) {
			if (item.state !== "pending" || item.cancelGeneration !== cancelGeneration) continue;
			const candidate = item.notBefore ?? this.now();
			if (next === undefined || candidate < next) next = candidate;
		}
		return next;
	}

	cancelById(id: string, reason: string): ContinuationCancelReceipt {
		return this.cancelWhere((item) => item.id === id, reason);
	}

	cancelCorrelation(correlationId: string, reason: string): ContinuationCancelReceipt {
		return this.cancelWhere((item) => item.correlationId === correlationId, reason);
	}

	cancelGeneration(generation: number, reason: string): ContinuationCancelReceipt {
		return this.cancelWhere((item) => item.cancelGeneration === generation, reason);
	}

	snapshot(): ContinuationQueueSnapshot<TPayload> {
		return {
			schemaVersion: "pi.continuation-queue.v2",
			capturedAt: this.now(),
			items: [...this.items.values()].map((item) => ({ ...item })),
		};
	}

	private cancelWhere(
		predicate: (item: ContinuationEnvelope<TPayload>) => boolean,
		reason: string,
	): ContinuationCancelReceipt {
		if (!reason.trim()) throw new Error("cancel reason must be a non-empty string");
		const cancelledIds: string[] = [];
		for (const item of this.items.values()) {
			if (!predicate(item) || !activeContinuation(item.state)) continue;
			item.state = "cancelled";
			item.leaseId = undefined;
			item.leasedAt = undefined;
			item.terminalReason = reason;
			cancelledIds.push(item.id);
		}
		return { cancelledIds };
	}
}

export interface CancelOperationRegistration {
	operationId: string;
	kind: string;
	cancel(reason: string): void | CancelReceipt | Promise<void> | Promise<CancelReceipt | undefined>;
}

export interface CancelOperationSnapshot {
	operationId: string;
	kind: string;
	registeredAt: number;
}

export interface CancelScopeSnapshot {
	scopeId: string;
	generation: number;
	cancelled: boolean;
	sealed: boolean;
	reason?: string;
	operations: CancelOperationSnapshot[];
}

export interface CancelReceipt {
	scopeId: string;
	generation: number;
	reason: string;
	cancelledOperationIds: string[];
	failedOperationIds: string[];
}

export interface CancelScopeOptions {
	scopeId: string;
	generation?: number;
}

type RegisteredCancelOperation = CancelOperationRegistration & { registeredAt: number };

/** One abort signal and operation registry for a runtime-owned unit of work. */
export class CancelScope {
	readonly scopeId: string;
	private currentGeneration: number;
	private controller = new AbortController();
	private cancelReason?: string;
	private cancelPromise?: Promise<CancelReceipt>;
	private readonly operations = new Map<string, RegisteredCancelOperation>();
	private drainWaiters = new Set<() => void>();
	private scopeSealed = false;

	constructor(options: CancelScopeOptions) {
		if (!options.scopeId.trim()) throw new Error("scopeId must be a non-empty string");
		const generation = options.generation ?? 0;
		if (!Number.isInteger(generation) || generation < 0) throw new Error("generation must be a non-negative integer");
		this.scopeId = options.scopeId;
		this.currentGeneration = generation;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get generation(): number {
		return this.currentGeneration;
	}

	get sealed(): boolean {
		return this.scopeSealed;
	}

	/** Freeze the operation set before a settlement receipt is measured. */
	seal(): void {
		this.scopeSealed = true;
	}

	register(operation: CancelOperationRegistration): () => void {
		if (this.signal.aborted) throw new Error("cannot register an operation on a cancelled scope");
		if (this.scopeSealed) throw new Error("cannot register an operation on a sealed scope");
		if (!operation.operationId.trim() || !operation.kind.trim()) {
			throw new Error("operationId and kind must be non-empty strings");
		}
		if (this.operations.has(operation.operationId)) {
			throw new Error(`operation already registered: ${operation.operationId}`);
		}

		this.operations.set(operation.operationId, { ...operation, registeredAt: Date.now() });
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			this.operations.delete(operation.operationId);
			this.resolveDrainWaiters();
		};
	}

	cancel(reason: string): Promise<CancelReceipt> {
		if (!reason.trim()) throw new Error("cancel reason must be a non-empty string");
		if (this.cancelPromise) return this.cancelPromise;
		this.seal();
		this.cancelReason = reason;
		this.currentGeneration += 1;
		this.controller.abort(reason);
		this.cancelPromise = this.cancelOperations(reason);
		return this.cancelPromise;
	}

	private async cancelOperations(reason: string): Promise<CancelReceipt> {
		const cancelledOperationIds: string[] = [];
		const failedOperationIds: string[] = [];
		for (const operation of this.operations.values()) {
			try {
				const nested = await operation.cancel(this.cancelReason ?? reason);
				if (nested) {
					cancelledOperationIds.push(...nested.cancelledOperationIds);
					failedOperationIds.push(...nested.failedOperationIds);
				} else {
					cancelledOperationIds.push(operation.operationId);
				}
			} catch {
				failedOperationIds.push(operation.operationId);
			}
		}
		return {
			scopeId: this.scopeId,
			generation: this.currentGeneration,
			reason: this.cancelReason ?? reason,
			cancelledOperationIds,
			failedOperationIds,
		};
	}

	async awaitDrained(deadlineMs: number): Promise<boolean> {
		if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new Error("deadlineMs must be non-negative");
		if (this.operations.size === 0) return true;
		return await new Promise<boolean>((resolve) => {
			const drained = () => {
				clearTimeout(timer);
				this.drainWaiters.delete(drained);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.drainWaiters.delete(drained);
				resolve(false);
			}, deadlineMs);
			this.drainWaiters.add(drained);
		});
	}

	snapshot(): CancelScopeSnapshot {
		return {
			scopeId: this.scopeId,
			generation: this.currentGeneration,
			cancelled: this.signal.aborted,
			sealed: this.scopeSealed,
			reason: this.cancelReason,
			operations: [...this.operations.values()].map(({ operationId, kind, registeredAt }) => ({
				operationId,
				kind,
				registeredAt,
			})),
		};
	}

	private resolveDrainWaiters(): void {
		if (this.operations.size !== 0) return;
		for (const resolve of this.drainWaiters) resolve();
		this.drainWaiters.clear();
	}
}

export type RunScopeKind = "prompt" | "continuation" | "provider" | "tool" | "compaction" | "background" | "other";

export interface RunScopeOptions extends CancelScopeOptions {
	sessionId: string;
	runId?: string;
	kind: RunScopeKind;
	parent?: RunScope;
}

export interface RunScopeSnapshot extends CancelScopeSnapshot {
	schemaVersion: "pi.run-scope.v1";
	sessionId: string;
	runId: string;
	kind: RunScopeKind;
	parentScopeId?: string;
	children: RunScopeSnapshot[];
}

/** Flatten real leaf operations while keeping the scope tree as the authority. */
export function flattenRunScopeOperations(scope: RunScopeSnapshot): CancelOperationSnapshot[] {
	return [...scope.operations, ...scope.children.flatMap((child) => flattenRunScopeOperations(child))];
}

/**
 * Product-neutral hierarchical runtime scope.
 *
 * Room, Memory, and stateless completion remain separate top-level scopes in
 * the host. Provider, Tool, compaction, and background operations may become
 * children of one run without leaking product workflow into Pi Core.
 */
export class RunScope extends CancelScope {
	readonly sessionId: string;
	readonly runId: string;
	readonly kind: RunScopeKind;
	readonly parent?: RunScope;
	private readonly children = new Map<string, RunScope>();
	private detachFromParent?: () => void;

	constructor(options: RunScopeOptions) {
		const sessionId = options.sessionId.trim();
		if (!sessionId) throw new Error("sessionId must be a non-empty string");
		const generation = options.generation ?? options.parent?.generation ?? 0;
		if (options.parent && options.parent.sessionId !== sessionId) {
			throw new Error("child scope must use the parent Session");
		}
		if (options.parent && generation !== options.parent.generation) {
			throw new Error("child scope must use the parent cancellation generation");
		}
		const inheritedRunId = options.parent?.runId;
		const runId = options.runId?.trim() || inheritedRunId || options.scopeId;
		if (inheritedRunId && runId !== inheritedRunId) {
			throw new Error("child scope must use the parent runId");
		}

		super({ scopeId: options.scopeId, generation });
		this.sessionId = sessionId;
		this.runId = runId;
		this.kind = options.kind;
		this.parent = options.parent;
		if (this.parent) {
			if (this.parent.children.has(this.scopeId)) throw new Error(`child scope already exists: ${this.scopeId}`);
			const unregister = this.parent.register({
				operationId: `scope:${this.scopeId}`,
				kind: `scope:${this.kind}`,
				cancel: async (reason) => {
					return await this.cancel(reason);
				},
			});
			this.parent.children.set(this.scopeId, this);
			this.detachFromParent = () => {
				unregister();
				this.parent?.children.delete(this.scopeId);
				this.detachFromParent = undefined;
			};
		}
	}

	child(options: Omit<RunScopeOptions, "sessionId" | "runId" | "generation" | "parent">): RunScope {
		return new RunScope({
			...options,
			sessionId: this.sessionId,
			runId: this.runId,
			generation: this.generation,
			parent: this,
		});
	}

	/** Detach a quiescent child after its owner has persisted settlement. */
	settle(): void {
		this.seal();
		if (this.snapshot().operations.length > 0) throw new Error("cannot settle a scope with active operations");
		if (this.children.size > 0) throw new Error("cannot settle a scope with active child scopes");
		this.detachFromParent?.();
	}

	override snapshot(): RunScopeSnapshot {
		const base = super.snapshot();
		const childScopeOperationIds = new Set([...this.children.keys()].map((scopeId) => `scope:${scopeId}`));
		return {
			...base,
			operations: base.operations.filter((operation) => !childScopeOperationIds.has(operation.operationId)),
			schemaVersion: "pi.run-scope.v1",
			sessionId: this.sessionId,
			runId: this.runId,
			kind: this.kind,
			parentScopeId: this.parent?.scopeId,
			children: [...this.children.values()].map((child) => child.snapshot()),
		};
	}
}
