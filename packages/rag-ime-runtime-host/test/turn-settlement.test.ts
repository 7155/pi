import type { AgentSettledReceiptV2 } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { TurnSettlementTracker } from "../src/turn-settlement.ts";

function receipt(receiptId: string, disposition: AgentSettledReceiptV2["disposition"]): AgentSettledReceiptV2 {
	return {
		schemaVersion: "pi.agent-settled.v2",
		receiptId,
		sessionId: "session-1",
		runId: "run-1",
		scopeId: `scope:${receiptId}`,
		generation: 0,
		disposition,
		stopReason: disposition === "suspended" ? "continuation_scheduled" : "natural",
		transcript: { messageCount: 1, entryCount: 1, contentHash: "a".repeat(64) },
		continuations: {
			pendingIds: disposition === "suspended" ? ["continuation-1"] : [],
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
		const tracker = new TurnSettlementTracker("session-1");
		const terminal = tracker.wait("turn-1", { timeoutMs: 1_000 });
		tracker.record({ turnId: "turn-1", clientMessageId: "client-1" }, receipt("suspended", "suspended"));
		expect(tracker.get("turn-1")?.receipt.disposition).toBe("suspended");
		tracker.record({ turnId: "turn-1", clientMessageId: "client-1" }, receipt("terminal", "completed"));
		await expect(terminal).resolves.toMatchObject({
			turnId: "turn-1",
			clientMessageId: "client-1",
			receipt: { receiptId: "terminal", disposition: "completed" },
		});
	});

	it("can expose a suspended receipt to diagnostic callers", async () => {
		const tracker = new TurnSettlementTracker("session-1");
		tracker.record({ turnId: "turn-1" }, receipt("suspended", "suspended"));
		await expect(tracker.wait("turn-1", { allowSuspended: true, timeoutMs: 1_000 })).resolves.toMatchObject({
			receipt: { disposition: "suspended" },
		});
	});

	it("ignores a late suspended receipt after terminal settlement and rejects conflicting terminals", () => {
		const tracker = new TurnSettlementTracker("session-1");
		tracker.record({ turnId: "turn-1" }, receipt("terminal", "completed"));
		expect(tracker.record({ turnId: "turn-1" }, receipt("late", "suspended")).receipt.receiptId).toBe("terminal");
		expect(() => tracker.record({ turnId: "turn-1" }, receipt("other-terminal", "failed"))).toThrow(
			"different terminal settlement",
		);
	});

	it("fails closed when a receipt belongs to another Session", () => {
		const tracker = new TurnSettlementTracker("session-1");
		const mismatched = { ...receipt("terminal", "completed"), sessionId: "session-2" };
		expect(() => tracker.record({ turnId: "turn-1" }, mismatched)).toThrow("another Session");
	});

	it("fails closed when one product turn changes runtime run identity", () => {
		const tracker = new TurnSettlementTracker("session-1");
		tracker.record({ turnId: "turn-1" }, receipt("suspended", "suspended"));
		const mismatched = { ...receipt("terminal", "completed"), runId: "another-run" };
		expect(() => tracker.record({ turnId: "turn-1" }, mismatched)).toThrow("changed runId");
	});
});
