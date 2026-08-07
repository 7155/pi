import type { AgentSettledReceiptV2 } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { TurnSettlementTracker } from "../src/turn-settlement.ts";

function receipt(receiptId: string, disposition: AgentSettledReceiptV2["disposition"]): AgentSettledReceiptV2 {
	return {
		schemaVersion: "pi.agent-settled.v2",
		receiptId,
		sessionId: "pi-session-1",
		runId: "run-1",
		scopeId: `scope:${receiptId}`,
		generation: 0,
		disposition,
		stopReason: disposition === "suspended" ? "continuation_scheduled" : "natural",
		transcript: { messageCount: 1, entryCount: 1, lineageHash: "a".repeat(64), contentHash: "a".repeat(64) },
		continuations: {
			generation: 0,
			pendingIds: disposition === "suspended" ? ["continuation-1"] : [],
			readyIds: [],
			scheduledIds: disposition === "suspended" ? ["continuation-1"] : [],
			leasedIds: [],
			terminalIds: [],
			terminalIdsOmitted: 0,
			idsHash: "b".repeat(64),
			counts: {
				pending: disposition === "suspended" ? 1 : 0,
				leased: 0,
				completed: 0,
				cancelled: 0,
				expired: 0,
				failed: 0,
			},
		},
		operations: { pending: 0, pendingByKind: {}, registeredByKind: {} },
		settledAtMs: 1,
		aborted: false,
		pendingOperations: 0,
		operationCounts: {},
	};
}

describe("TurnSettlementTracker", () => {
	it("waits through suspended runtime boundaries until the same turn is terminal", async () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		const terminal = tracker.wait("turn-1", { timeoutMs: 1_000 });
		tracker.record({ turnId: "turn-1", clientMessageId: "client-1" }, receipt("suspended", "suspended"));
		expect(tracker.get("turn-1")?.receipt.disposition).toBe("suspended");
		tracker.record({ turnId: "turn-1", clientMessageId: "client-1" }, receipt("terminal", "completed"));
		await expect(terminal).resolves.toMatchObject({
			sessionId: "session-1",
			runtimeSessionId: "pi-session-1",
			turnId: "turn-1",
			clientMessageId: "client-1",
			receipt: { receiptId: "terminal", disposition: "completed" },
		});
	});

	it("can expose a suspended receipt to diagnostic callers", async () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		tracker.record({ turnId: "turn-1" }, receipt("suspended", "suspended"));
		await expect(tracker.wait("turn-1", { allowSuspended: true, timeoutMs: 1_000 })).resolves.toMatchObject({
			receipt: { disposition: "suspended" },
		});
	});

	it("ignores a late suspended receipt after terminal settlement and rejects conflicting terminals", () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		tracker.record({ turnId: "turn-1" }, receipt("terminal", "completed"));
		expect(tracker.record({ turnId: "turn-1" }, receipt("late", "suspended")).receipt.receiptId).toBe("terminal");
		expect(() => tracker.record({ turnId: "turn-1" }, receipt("other-terminal", "failed"))).toThrow(
			"different terminal settlement",
		);
	});

	it("fails closed when a receipt belongs to another Session", () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		const mismatched = { ...receipt("terminal", "completed"), sessionId: "pi-session-2" };
		expect(() => tracker.record({ turnId: "turn-1" }, mismatched)).toThrow("another runtime Session");
	});

	it("fails closed when one product turn changes runtime run identity", () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		tracker.record({ turnId: "turn-1" }, receipt("suspended", "suspended"));
		const mismatched = { ...receipt("terminal", "completed"), runId: "another-run" };
		expect(() => tracker.record({ turnId: "turn-1" }, mismatched)).toThrow("changed runId");
	});

	it("ignores an older reconnect replay and validates the client message identity", () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1");
		tracker.record(
			{ turnId: "turn-1", clientMessageId: "client-1" },
			{ ...receipt("newer", "suspended"), settledAtMs: 20 },
		);
		const value = tracker.record(
			{ turnId: "turn-1", clientMessageId: "client-1" },
			{ ...receipt("older", "completed"), settledAtMs: 10 },
		);
		expect(value.receipt.receiptId).toBe("newer");
		expect(() => tracker.get("turn-1", "client-2")).toThrow("clientMessageId");
	});

	it("caps settlement waiters", async () => {
		const tracker = new TurnSettlementTracker("session-1", "pi-session-1", {
			maxWaiters: 2,
			maxWaitersPerTurn: 1,
		});
		const first = tracker.wait("turn-1", { timeoutMs: 1_000 });
		await expect(tracker.wait("turn-1", { timeoutMs: 1_000 })).rejects.toThrow("too many");
		tracker.record({ turnId: "turn-1" }, receipt("terminal", "completed"));
		await expect(first).resolves.toMatchObject({ receipt: { receiptId: "terminal" } });
	});
});
