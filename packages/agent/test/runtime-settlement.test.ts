import { describe, expect, it } from "vitest";
import { type ContinuationEnvelope, createAgentSettledReceipt, RunScope } from "../src/index.ts";

function continuation(state: ContinuationEnvelope["state"]): ContinuationEnvelope<string> {
	return {
		id: `continuation-${state}`,
		correlationId: "root-1",
		origin: "test",
		kind: "follow_up",
		payload: "continue",
		idempotencyKey: `key-${state}`,
		cancelGeneration: 0,
		createdAt: 100,
		priority: 0,
		attempt: state === "leased" ? 1 : 0,
		maxAttempts: 2,
		state,
		...(state === "leased" ? { leaseId: "lease-1", leasedAt: 100 } : {}),
	};
}

describe("AgentSettledReceiptV2", () => {
	it("marks a run suspended when a continuation remains", async () => {
		const scope = new RunScope({ scopeId: "scope-1", runId: "run-1", sessionId: "session-1", kind: "prompt" });
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			message: {
				content: [{ type: "text", text: "已安排后续" }],
				stopReason: "stop",
				timestamp: 200,
				usage: { input: 8, output: 3, cacheRead: 4, cacheWrite: 0 },
			},
			transcript: { messageCount: 2, entryIds: ["entry-1", "entry-2"], leafId: "entry-2" },
			continuations: [continuation("pending")],
			settledAtMs: 300,
		});
		expect(receipt).toMatchObject({
			schemaVersion: "pi.agent-settled.v2",
			runId: "run-1",
			disposition: "suspended",
			stopReason: "continuation_scheduled",
			aborted: false,
			finalMessage: { usage: { input: 8, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 15 } },
		});
	});

	it("never turns a settlement rejection into successful completion", async () => {
		const scope = new RunScope({ scopeId: "scope-1", sessionId: "session-1", kind: "prompt" });
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 1, entryIds: ["entry-1"] },
			continuations: [],
			settleError: "Room commit missing",
		});
		expect(receipt.disposition).toBe("failed");
		expect(receipt.stopReason).toBe("settlement_rejected");
	});

	it("fails closed when a purported settled boundary still owns operations", async () => {
		const scope = new RunScope({ scopeId: "scope-1", sessionId: "session-1", kind: "prompt" });
		scope.register({ operationId: "tool-1", kind: "tool", cancel: () => undefined });
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 1, entryIds: ["entry-1"] },
			continuations: [],
			operationCounts: { tool: 1 },
		});
		expect(receipt).toMatchObject({
			disposition: "failed",
			stopReason: "operations_pending",
			operations: { pending: 1, pendingByKind: { tool: 1 }, registeredByKind: { tool: 1 } },
		});
	});

	it("uses a stable receipt identity independent of observation time", async () => {
		const scope = new RunScope({ scopeId: "scope-1", sessionId: "session-1", kind: "prompt" });
		const input = {
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 1, entryIds: ["entry-1"] },
			continuations: [],
		};
		const first = await createAgentSettledReceipt({ ...input, settledAtMs: 100 });
		const second = await createAgentSettledReceipt({ ...input, settledAtMs: 200 });
		expect(second.receiptId).toBe(first.receiptId);
		expect(second.settledAtMs).not.toBe(first.settledAtMs);
	});
});
