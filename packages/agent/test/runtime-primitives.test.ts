import { describe, expect, it, vi } from "vitest";
import { CancelScope, type ContinuationEnvelope, ContinuationQueue } from "../src/index.ts";

function continuation(overrides: Partial<ContinuationEnvelope<string>> = {}): ContinuationEnvelope<string> {
	return {
		id: "continuation-1",
		correlationId: "correlation-1",
		origin: "test",
		kind: "follow-up",
		payload: "continue",
		idempotencyKey: "dedupe-1",
		cancelGeneration: 0,
		createdAt: 100,
		priority: 0,
		attempt: 0,
		maxAttempts: 1,
		state: "pending",
		...overrides,
	};
}

describe("ContinuationQueue", () => {
	it("deduplicates an idempotency key without replacing the original envelope", () => {
		const queue = new ContinuationQueue<string>();

		expect(queue.enqueue(continuation())).toMatchObject({ accepted: true });
		expect(queue.enqueue(continuation({ id: "continuation-2", payload: "duplicate" }))).toEqual({
			accepted: false,
			reason: "duplicate",
			existingId: "continuation-1",
		});
		expect(queue.snapshot().items).toHaveLength(1);
		expect(queue.snapshot().items[0]?.payload).toBe("continue");
	});

	it("drains only eligible work for the active cancellation generation", () => {
		const queue = new ContinuationQueue<string>();
		queue.enqueue(continuation({ id: "later", idempotencyKey: "later", notBefore: 500 }));
		queue.enqueue(continuation({ id: "stale", idempotencyKey: "stale", cancelGeneration: 0 }));
		queue.enqueue(
			continuation({
				id: "high-priority",
				idempotencyKey: "high-priority",
				cancelGeneration: 1,
				priority: 10,
			}),
		);

		const drained = queue.drain({ now: 200, cancelGeneration: 1, limit: 10 });

		expect(drained.map((item) => item.id)).toEqual(["high-priority"]);
		expect(queue.snapshot().items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "later", state: "cancelled", terminalReason: "stale_generation" }),
				expect.objectContaining({ id: "stale", state: "cancelled", terminalReason: "stale_generation" }),
				expect.objectContaining({ id: "high-priority", state: "leased", attempt: 1 }),
			]),
		);
	});

	it("expires deadlines and enforces maximum attempts", () => {
		const queue = new ContinuationQueue<string>();
		queue.enqueue(continuation({ id: "expired", idempotencyKey: "expired", deadline: 99 }));
		queue.enqueue(
			continuation({
				id: "exhausted",
				idempotencyKey: "exhausted",
				attempt: 1,
				maxAttempts: 1,
			}),
		);

		expect(queue.drain({ now: 100, cancelGeneration: 0, limit: 10 })).toEqual([]);
		expect(queue.snapshot().items).toEqual([
			expect.objectContaining({ id: "expired", state: "expired", terminalReason: "deadline_exceeded" }),
			expect.objectContaining({ id: "exhausted", state: "failed", terminalReason: "attempts_exhausted" }),
		]);
	});

	it("cancels all pending work for one correlation without touching another", () => {
		const queue = new ContinuationQueue<string>();
		queue.enqueue(continuation());
		queue.enqueue(continuation({ id: "other", correlationId: "correlation-2", idempotencyKey: "other" }));

		expect(queue.cancelCorrelation("correlation-1", "user_stop").cancelledIds).toEqual(["continuation-1"]);
		expect(queue.drain({ now: 100, cancelGeneration: 0, limit: 10 }).map((item) => item.id)).toEqual(["other"]);
	});

	it("completes leases exactly once and supports selective cancellation", () => {
		const queue = new ContinuationQueue<string>();
		queue.enqueue(continuation());
		queue.enqueue(continuation({ id: "same-generation", idempotencyKey: "same-generation" }));
		const [leased] = queue.drain({ now: 100, cancelGeneration: 0, limit: 1 });

		expect(queue.complete(leased!.id, leased!.leaseId!)).toBe(true);
		expect(queue.complete(leased!.id, leased!.leaseId!)).toBe(false);
		expect(queue.cancelById(leased!.id, "too_late").cancelledIds).toEqual([]);
		expect(queue.cancelGeneration(0, "generation_stopped").cancelledIds).toEqual(["same-generation"]);
	});
});

describe("CancelScope", () => {
	it("propagates one abort generation to every registered operation", async () => {
		const firstCancel = vi.fn();
		const secondCancel = vi.fn(async () => undefined);
		const scope = new CancelScope({ scopeId: "run-1" });
		scope.register({ operationId: "provider-1", kind: "provider", cancel: firstCancel });
		scope.register({ operationId: "tool-1", kind: "tool", cancel: secondCancel });

		const receipt = await scope.cancel("user_stop");

		expect(scope.signal.aborted).toBe(true);
		expect(scope.generation).toBe(1);
		expect(firstCancel).toHaveBeenCalledWith("user_stop");
		expect(secondCancel).toHaveBeenCalledWith("user_stop");
		expect(receipt).toMatchObject({
			scopeId: "run-1",
			generation: 1,
			reason: "user_stop",
			cancelledOperationIds: ["provider-1", "tool-1"],
			failedOperationIds: [],
		});
	});

	it("fences late registrations and reports cancellation failures", async () => {
		const scope = new CancelScope({ scopeId: "run-2", generation: 4 });
		scope.register({
			operationId: "broken",
			kind: "timer",
			cancel: () => {
				throw new Error("cannot cancel");
			},
		});

		const receipt = await scope.cancel("shutdown");

		expect(receipt.failedOperationIds).toEqual(["broken"]);
		expect(() => scope.register({ operationId: "late", kind: "tool", cancel: () => undefined })).toThrow(
			"cancelled scope",
		);
	});

	it("returns the first receipt when cancellation is requested more than once", async () => {
		const cancel = vi.fn();
		const scope = new CancelScope({ scopeId: "run-idempotent" });
		scope.register({ operationId: "provider", kind: "provider", cancel });

		const first = await scope.cancel("user_stop");
		const second = await scope.cancel("late_shutdown");

		expect(second).toEqual(first);
		expect(second.reason).toBe("user_stop");
		expect(second.generation).toBe(1);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("awaits operation drain without treating unregister as cancellation", async () => {
		const scope = new CancelScope({ scopeId: "run-3" });
		const unregister = scope.register({ operationId: "provider", kind: "provider", cancel: () => undefined });
		let drained = false;
		const wait = scope.awaitDrained(1_000).then((value) => {
			drained = value;
		});

		await Promise.resolve();
		expect(drained).toBe(false);
		unregister();
		await wait;

		expect(drained).toBe(true);
		expect(scope.snapshot().operations).toEqual([]);
	});
});
