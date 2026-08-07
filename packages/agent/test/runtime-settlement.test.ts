import { describe, expect, it } from "vitest";
import { type ContinuationEnvelope, createAgentSettledReceipt, RunScope } from "../src/index.ts";

function continuation(
	state: ContinuationEnvelope["state"],
	overrides: Partial<ContinuationEnvelope<string>> = {},
): ContinuationEnvelope<string> {
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
		...overrides,
	};
}

function settledScope(): RunScope {
	const scope = new RunScope({ scopeId: "scope-1", runId: "run-1", sessionId: "session-1", kind: "prompt" });
	scope.seal();
	return scope;
}

describe("AgentSettledReceiptV2", () => {
	it("marks a run suspended only when a continuation is delayed into the future", async () => {
		const scope = settledScope();
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			message: {
				content: [{ type: "text", text: "已安排后续" }],
				stopReason: "stop",
				timestamp: 200,
				usage: { input: 8, output: 3, cacheRead: 4, cacheWrite: 0 },
			},
			transcript: { messageCount: 2, entryCount: 2, leafId: "entry-2", lastEntryId: "entry-2" },
			continuations: [continuation("pending", { notBefore: 500 })],
			continuationGeneration: 0,
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

	it("fails closed when ready or leased continuation work remains", async () => {
		for (const item of [continuation("pending"), continuation("leased")]) {
			const receipt = await createAgentSettledReceipt({
				sessionId: "session-1",
				scope: settledScope().snapshot(),
				transcript: { messageCount: 1, entryCount: 1, lastEntryId: "entry-1" },
				continuations: [item],
				continuationGeneration: 0,
				settledAtMs: 300,
			});
			expect(receipt.disposition).toBe("failed");
			expect(receipt.stopReason).toBe("continuation_unsettled");
		}
	});

	it("never turns a settlement rejection into successful completion", async () => {
		const scope = settledScope();
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 1, entryCount: 1, lastEntryId: "entry-1" },
			continuations: [],
			continuationGeneration: 0,
			settleError: "Room commit missing",
		});
		expect(receipt.disposition).toBe("failed");
		expect(receipt.stopReason).toBe("settlement_rejected");
	});

	it("fails closed when a purported settled boundary still owns operations", async () => {
		const scope = new RunScope({ scopeId: "scope-1", sessionId: "session-1", kind: "prompt" });
		scope.register({ operationId: "tool-1", kind: "tool", cancel: () => undefined });
		scope.seal();
		const receipt = await createAgentSettledReceipt({
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 1, entryCount: 1, lastEntryId: "entry-1" },
			continuations: [],
			continuationGeneration: 0,
			operationCounts: { tool: 1 },
		});
		expect(receipt).toMatchObject({
			disposition: "failed",
			stopReason: "operations_pending",
			operations: { pending: 1, pendingByKind: { tool: 1 }, registeredByKind: { tool: 1 } },
		});
	});

	it("uses a stable receipt identity independent of observation time", async () => {
		const scope = settledScope();
		const input = {
			sessionId: "session-1",
			scope: scope.snapshot(),
			transcript: { messageCount: 100_000, entryCount: 100_000, leafId: "leaf", lastEntryId: "last" },
			continuations: [],
			continuationGeneration: 0,
		};
		const first = await createAgentSettledReceipt({ ...input, settledAtMs: 100 });
		const second = await createAgentSettledReceipt({ ...input, settledAtMs: 200 });
		expect(second.receiptId).toBe(first.receiptId);
		expect(second.settledAtMs).not.toBe(first.settledAtMs);
		expect(first.transcript.lineageHash).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("rejects an unsealed scope", async () => {
		const scope = new RunScope({ scopeId: "scope-unsealed", sessionId: "session-1", kind: "prompt" });
		await expect(
			createAgentSettledReceipt({
				sessionId: "session-1",
				scope: scope.snapshot(),
				transcript: { messageCount: 0, entryCount: 0 },
				continuations: [],
				continuationGeneration: 0,
			}),
		).rejects.toThrow("sealed");
	});
});
