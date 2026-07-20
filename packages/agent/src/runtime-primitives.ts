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
	items: ContinuationEnvelope<TPayload>[];
}

export interface ContinuationCancelReceipt {
	cancelledIds: string[];
}

function validateEnvelope<TPayload>(envelope: ContinuationEnvelope<TPayload>): void {
	for (const [name, value] of [
		["id", envelope.id],
		["correlationId", envelope.correlationId],
		["origin", envelope.origin],
		["kind", envelope.kind],
		["idempotencyKey", envelope.idempotencyKey],
	] as const) {
		if (!value.trim()) throw new Error(`${name} must be a non-empty string`);
	}
	if (!Number.isInteger(envelope.cancelGeneration) || envelope.cancelGeneration < 0) {
		throw new Error("cancelGeneration must be a non-negative integer");
	}
	if (!Number.isInteger(envelope.attempt) || envelope.attempt < 0) {
		throw new Error("attempt must be a non-negative integer");
	}
	if (!Number.isInteger(envelope.maxAttempts) || envelope.maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive integer");
	}
	if (envelope.state !== "pending") throw new Error("new continuations must be pending");
	if (envelope.deadline !== undefined && envelope.notBefore !== undefined && envelope.deadline < envelope.notBefore) {
		throw new Error("deadline cannot be earlier than notBefore");
	}
}

/**
 * In-memory continuation admission and leasing primitive.
 *
 * Persistence remains a runtime concern. This class owns deterministic
 * deduplication, eligibility, attempt, deadline, and cancellation-generation
 * rules so products do not have to encode them in prompt text.
 */
export class ContinuationQueue<TPayload = unknown> {
	private readonly items = new Map<string, ContinuationEnvelope<TPayload>>();
	private readonly idempotencyIndex = new Map<string, string>();

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

		eligible.sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);
		return eligible.slice(0, options.limit).map((item) => {
			item.state = "leased";
			item.attempt += 1;
			return { ...item };
		});
	}

	complete(id: string): boolean {
		const item = this.items.get(id);
		if (!item || item.state !== "leased") return false;
		item.state = "completed";
		return true;
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
		return { items: [...this.items.values()].map((item) => ({ ...item })) };
	}

	private cancelWhere(
		predicate: (item: ContinuationEnvelope<TPayload>) => boolean,
		reason: string,
	): ContinuationCancelReceipt {
		if (!reason.trim()) throw new Error("cancel reason must be a non-empty string");
		const cancelledIds: string[] = [];
		for (const item of this.items.values()) {
			if (!predicate(item) || (item.state !== "pending" && item.state !== "leased")) continue;
			item.state = "cancelled";
			item.terminalReason = reason;
			cancelledIds.push(item.id);
		}
		return { cancelledIds };
	}
}

export interface CancelOperationRegistration {
	operationId: string;
	kind: string;
	cancel(reason: string): void | Promise<void>;
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

	register(operation: CancelOperationRegistration): () => void {
		if (this.signal.aborted) throw new Error("cannot register an operation on a cancelled scope");
		if (!operation.operationId.trim() || !operation.kind.trim()) {
			throw new Error("operationId and kind must be non-empty strings");
		}
		if (this.operations.has(operation.operationId))
			throw new Error(`operation already registered: ${operation.operationId}`);

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
				await operation.cancel(this.cancelReason ?? reason);
				cancelledOperationIds.push(operation.operationId);
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
