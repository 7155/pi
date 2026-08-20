import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type AgentSettledReceiptV2,
	persistedTurnSettlement,
	TURN_SETTLEMENT_CUSTOM_TYPE,
	TurnSettlementTracker,
} from "../src/turn-settlement.ts";

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

	it("restores the exact settlement from the append-only JSONL Session journal", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-turn-settlement-journal-"));
		try {
			const manager = SessionManager.create(root, root);
			manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			const tracker = new TurnSettlementTracker("session-1", manager.getSessionId());
			const persisted = tracker.record(
				{ turnId: "turn-1", clientMessageId: "client-1" },
				{ ...receipt("terminal", "completed"), sessionId: manager.getSessionId() },
			);
			manager.appendCustomEntry(TURN_SETTLEMENT_CUSTOM_TYPE, persisted);
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeTruthy();

			const reopened = SessionManager.open(sessionFile!, root, root);
			const restored = new TurnSettlementTracker("session-1", reopened.getSessionId());
			for (const entry of reopened.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== TURN_SETTLEMENT_CUSTOM_TYPE) continue;
				const value = persistedTurnSettlement(entry.data);
				if (value) restored.restore(value);
			}

			expect(restored.get("turn-1", "client-1")).toEqual(persisted);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
