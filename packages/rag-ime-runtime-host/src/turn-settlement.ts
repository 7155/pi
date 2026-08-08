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

export const TURN_SETTLEMENT_CUSTOM_TYPE = "rag-ime.pi-turn-settlement";

export function persistedTurnSettlement(value: unknown): PiTurnSettlementReceipt | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const receipt = source.receipt;
	if (
		source.schemaVersion !== "rag-ime.pi-turn-settlement.v1" ||
		typeof source.sessionId !== "string" ||
		typeof source.runtimeSessionId !== "string" ||
		typeof source.turnId !== "string" ||
		receipt === null ||
		typeof receipt !== "object" ||
		Array.isArray(receipt)
	) {
		return undefined;
	}
	return structuredClone(source) as unknown as PiTurnSettlementReceipt;
}

export interface WaitForTurnSettlementOptions {
	allowSuspended?: boolean;
	timeoutMs?: number;
	expectedClientMessageId?: string;
}

interface SettlementWaiter {
	allowSuspended: boolean;
	expectedClientMessageId?: string;
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
	private readonly maxWaiters: number;
	private readonly maxWaitersPerTurn: number;
	private readonly byTurnId = new Map<string, PiTurnSettlementReceipt>();
	private readonly waiters = new Map<string, Set<SettlementWaiter>>();
	private waiterCount = 0;
	private disposed = false;

	constructor(
		sessionId: string,
		runtimeSessionId: string,
		options: { limit?: number; maxWaiters?: number; maxWaitersPerTurn?: number } = {},
	) {
		this.sessionId = nonEmpty(sessionId, "sessionId");
		this.runtimeSessionId = nonEmpty(runtimeSessionId, "runtimeSessionId");
		this.limit = options.limit ?? 64;
		this.maxWaiters = options.maxWaiters ?? 128;
		this.maxWaitersPerTurn = options.maxWaitersPerTurn ?? 16;
		for (const [name, value, maximum] of [
			["limit", this.limit, 1_024],
			["maxWaiters", this.maxWaiters, 4_096],
			["maxWaitersPerTurn", this.maxWaitersPerTurn, 256],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
				throw new Error(`${name} must be between 1 and ${maximum}`);
			}
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
		const clientMessageId = identity.clientMessageId?.trim() || existing?.clientMessageId || undefined;
		if (existing?.clientMessageId && clientMessageId && existing.clientMessageId !== clientMessageId) {
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_MISMATCH",
				`turn settlement changed clientMessageId: ${turnId}`,
			);
		}
		if (existing && receipt.settledAtMs < existing.receipt.settledAtMs) {
			return structuredClone(existing);
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

	get(turnId: string, expectedClientMessageId?: string): PiTurnSettlementReceipt | undefined {
		const value = this.byTurnId.get(nonEmpty(turnId, "turnId"));
		if (value) this.assertClientMessageId(value, expectedClientMessageId?.trim() || undefined);
		return value ? structuredClone(value) : undefined;
	}

	latest(): PiTurnSettlementReceipt | undefined {
		const value = [...this.byTurnId.values()].at(-1);
		return value ? structuredClone(value) : undefined;
	}

	restore(value: PiTurnSettlementReceipt): PiTurnSettlementReceipt {
		if (value.sessionId !== this.sessionId || value.runtimeSessionId !== this.runtimeSessionId) {
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_MISMATCH",
				"persisted settlement belongs to another product or runtime Session",
			);
		}
		return this.record({ turnId: value.turnId, clientMessageId: value.clientMessageId }, value.receipt);
	}

	async wait(turnId: string, options: WaitForTurnSettlementOptions = {}): Promise<PiTurnSettlementReceipt> {
		if (this.disposed) throw new Error("settlement tracker is disposed");
		const normalizedTurnId = nonEmpty(turnId, "turnId");
		const allowSuspended = options.allowSuspended === true;
		const expectedClientMessageId = options.expectedClientMessageId?.trim() || undefined;
		const current = this.byTurnId.get(normalizedTurnId);
		if (current) {
			this.assertClientMessageId(current, expectedClientMessageId);
			if (allowSuspended || terminal(current.receipt)) return structuredClone(current);
		}
		const timeoutMs = options.timeoutMs ?? 120_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "timeoutMs must be between 1000 and 300000");
		}
		const turnWaiters = this.waiters.get(normalizedTurnId) ?? new Set<SettlementWaiter>();
		if (this.waiterCount >= this.maxWaiters || turnWaiters.size >= this.maxWaitersPerTurn) {
			throw new RuntimeProtocolError("SETTLEMENT_WAITER_LIMIT", "too many settlement waiters are active");
		}
		return await new Promise<PiTurnSettlementReceipt>((resolve, reject) => {
			const waiter: SettlementWaiter = {
				allowSuspended,
				expectedClientMessageId,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.removeWaiter(normalizedTurnId, waiter);
					reject(
						new RuntimeProtocolError("SETTLED_TIMEOUT", `Pi run did not settle in time: ${normalizedTurnId}`),
					);
				}, timeoutMs),
			};
			turnWaiters.add(waiter);
			this.waiterCount += 1;
			this.waiters.set(normalizedTurnId, turnWaiters);
		});
	}

	dispose(reason = "Pi Session disposed before settlement"): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [turnId, turnWaiters] of this.waiters) {
			for (const waiter of [...turnWaiters]) {
				clearTimeout(waiter.timer);
				this.removeWaiter(turnId, waiter);
				waiter.reject(new Error(reason));
			}
		}
		this.waiters.clear();
		this.waiterCount = 0;
	}

	private assertClientMessageId(value: PiTurnSettlementReceipt, expected: string | undefined): void {
		if (expected && value.clientMessageId !== expected) {
			throw new RuntimeProtocolError(
				"SETTLED_RECEIPT_MISMATCH",
				`turn settlement does not match clientMessageId: ${value.turnId}`,
			);
		}
	}

	private resolveWaiters(value: PiTurnSettlementReceipt): void {
		const turnWaiters = this.waiters.get(value.turnId);
		if (!turnWaiters) return;
		for (const waiter of [...turnWaiters]) {
			if (waiter.expectedClientMessageId && value.clientMessageId !== waiter.expectedClientMessageId) {
				clearTimeout(waiter.timer);
				this.removeWaiter(value.turnId, waiter);
				waiter.reject(
					new RuntimeProtocolError(
						"SETTLED_RECEIPT_MISMATCH",
						`turn settlement does not match clientMessageId: ${value.turnId}`,
					),
				);
				continue;
			}
			if (!waiter.allowSuspended && !terminal(value.receipt)) continue;
			clearTimeout(waiter.timer);
			this.removeWaiter(value.turnId, waiter);
			waiter.resolve(structuredClone(value));
		}
	}

	private removeWaiter(turnId: string, waiter: SettlementWaiter): void {
		const turnWaiters = this.waiters.get(turnId);
		if (!turnWaiters?.delete(waiter)) return;
		this.waiterCount = Math.max(0, this.waiterCount - 1);
		if (turnWaiters.size === 0) this.waiters.delete(turnId);
	}

	private trim(): void {
		while (this.byTurnId.size > this.limit) {
			const oldest = [...this.byTurnId.keys()].find((turnId) => !this.waiters.has(turnId));
			if (!oldest) return;
			this.byTurnId.delete(oldest);
		}
	}
}
