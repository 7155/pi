import type { AgentSettledReceiptV2 } from "@earendil-works/pi-coding-agent";
import { RuntimeProtocolError } from "./protocol.ts";

export interface TurnSettlementIdentity {
	turnId: string;
	clientMessageId?: string;
}

export interface PiTurnSettlementReceipt {
	schemaVersion: "rag-ime.pi-turn-settlement.v1";
	sessionId: string;
	runtimeSessionId: string;
	turnId: string;
	clientMessageId?: string;
	receipt: AgentSettledReceiptV2;
}

export interface WaitForTurnSettlementOptions {
	allowSuspended?: boolean;
	timeoutMs?: number;
}

interface SettlementWaiter {
	allowSuspended: boolean;
	resolve(value: PiTurnSettlementReceipt): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

function nonEmpty(value: string, name: string): string {
	const result = value.trim();
	if (!result) throw new RuntimeProtocolError("INVALID_PARAMS", `${name} must be a non-empty string`);
	return result;
}

function terminal(receipt: AgentSettledReceiptV2): boolean {
	return receipt.disposition !== "suspended";
}

/**
 * Binds Pi runtime settlement to an exact product turn without interpreting it
 * as Room completion. One turn may emit several suspended receipts before one
 * terminal receipt; a terminal receipt can never be replaced by late activity.
 */
export class TurnSettlementTracker {
	private readonly sessionId: string;
	private readonly runtimeSessionId: string;
	private readonly limit: number;
	private readonly byTurnId = new Map<string, PiTurnSettlementReceipt>();
	private readonly waiters = new Map<string, Set<SettlementWaiter>>();
	private disposed = false;

	constructor(sessionId: string, runtimeSessionId: string, options: { limit?: number } = {}) {
		this.sessionId = nonEmpty(sessionId, "sessionId");
		this.runtimeSessionId = nonEmpty(runtimeSessionId, "runtimeSessionId");
		this.limit = options.limit ?? 32;
		if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 1_024) {
			throw new Error("settlement tracker limit must be between 1 and 1024");
		}
	}

	record(identity: TurnSettlementIdentity, receipt: AgentSettledReceiptV2): PiTurnSettlementReceipt {
		if (this.disposed) throw new Error("settlement tracker is disposed");
		const turnId = nonEmpty(identity.turnId, "turnId");
		if (receipt.sessionId !== this.runtimeSessionId) {
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_MISMATCH",
				"settled receipt belongs to another runtime Session",
			);
		}
		const existing = this.byTurnId.get(turnId);
		const clientMessageId = identity.clientMessageId?.trim() || undefined;
		if (existing?.clientMessageId && clientMessageId && existing.clientMessageId !== clientMessageId) {
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_MISMATCH",
				`turn settlement changed clientMessageId: ${turnId}`,
			);
		}
		if (existing && existing.receipt.runId !== receipt.runId) {
			throw new RuntimeProtocolError("SETTLED_RECEIPT_MISMATCH", `turn settlement changed runId: ${turnId}`, {
				existingRunId: existing.receipt.runId,
				receivedRunId: receipt.runId,
			});
		}
		if (existing?.receipt.receiptId === receipt.receiptId) return structuredClone(existing);
		if (existing && terminal(existing.receipt)) {
			if (!terminal(receipt)) return structuredClone(existing);
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_CONFLICT",
				`turn already has a different terminal settlement: ${turnId}`,
				{
					existingReceiptId: existing.receipt.receiptId,
					receivedReceiptId: receipt.receiptId,
				},
			);
		}

		const value: PiTurnSettlementReceipt = {
			schemaVersion: "rag-ime.pi-turn-settlement.v1",
			sessionId: this.sessionId,
			runtimeSessionId: this.runtimeSessionId,
			turnId,
			clientMessageId,
			receipt: structuredClone(receipt),
		};
		this.byTurnId.delete(turnId);
		this.byTurnId.set(turnId, value);
		this.trim();
		this.resolveWaiters(value);
		return structuredClone(value);
	}

	get(turnId: string): PiTurnSettlementReceipt | undefined {
		const value = this.byTurnId.get(turnId);
		return value ? structuredClone(value) : undefined;
	}

	latest(): PiTurnSettlementReceipt | undefined {
		const value = [...this.byTurnId.values()].at(-1);
		return value ? structuredClone(value) : undefined;
	}

	async wait(turnId: string, options: WaitForTurnSettlementOptions = {}): Promise<PiTurnSettlementReceipt> {
		if (this.disposed) throw new Error("settlement tracker is disposed");
		const normalizedTurnId = nonEmpty(turnId, "turnId");
		const allowSuspended = options.allowSuspended === true;
		const current = this.byTurnId.get(normalizedTurnId);
		if (current && (allowSuspended || terminal(current.receipt))) return structuredClone(current);
		const timeoutMs = options.timeoutMs ?? 600_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_100_000) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "timeoutMs must be between 1000 and 1100000");
		}
		return await new Promise<PiTurnSettlementReceipt>((resolve, reject) => {
			const turnWaiters = this.waiters.get(normalizedTurnId) ?? new Set<SettlementWaiter>();
			const waiter: SettlementWaiter = {
				allowSuspended,
				resolve,
				reject,
				timer: setTimeout(() => {
					turnWaiters.delete(waiter);
					if (turnWaiters.size === 0) this.waiters.delete(normalizedTurnId);
					reject(
						new RuntimeProtocolError("SETTLED_TIMEOUT", `Pi run did not settle in time: ${normalizedTurnId}`),
					);
				}, timeoutMs),
			};
			turnWaiters.add(waiter);
			this.waiters.set(normalizedTurnId, turnWaiters);
		});
	}

	dispose(reason = "Pi Session disposed before settlement"): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const turnWaiters of this.waiters.values()) {
			for (const waiter of turnWaiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(reason));
			}
		}
		this.waiters.clear();
	}

	private resolveWaiters(value: PiTurnSettlementReceipt): void {
		const turnWaiters = this.waiters.get(value.turnId);
		if (!turnWaiters) return;
		for (const waiter of [...turnWaiters]) {
			if (!waiter.allowSuspended && !terminal(value.receipt)) continue;
			clearTimeout(waiter.timer);
			turnWaiters.delete(waiter);
			waiter.resolve(structuredClone(value));
		}
		if (turnWaiters.size === 0) this.waiters.delete(value.turnId);
	}

	private trim(): void {
		while (this.byTurnId.size > this.limit) {
			const oldest = this.byTurnId.keys().next().value as string | undefined;
			if (!oldest) return;
			this.byTurnId.delete(oldest);
		}
	}
}
