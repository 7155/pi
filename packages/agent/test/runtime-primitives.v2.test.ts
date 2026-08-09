import { describe, expect, it, vi } from "vitest";
import { type ContinuationEnvelope, ContinuationQueue, RunScope } from "../src/index.ts";

function continuation(overrides: Partial<ContinuationEnvelope<string>> = {}): ContinuationEnvelope<string> {
	return {
		id: "continuation-1",
		correlationId: "root-1",
		origin: "test",
		kind: "follow-up",
		payload: "continue",
		idempotencyKey: "dispatch-1",
		cancelGeneration: 0,
		createdAt: 100,
		priority: 0,
		attempt: 0,
		maxAttempts: 2,
		state: "pending",
		...overrides,
	};
}

describe("ContinuationQueue v2 leases", () => {
	it("does not complete a continuation merely because it was drained", () => {
		const queue = new ContinuationQueue<string>({ createLeaseId: () => "lease-1", now: () => 100 });
		queue.enqueue(continuation());
		const [leased] = queue.drain({ now: 100, cancelGeneration: 0, limit: 1 });
		expect(leased?.leaseId).toBe("lease-1");
		expect(leased).toMatchObject({ state: "leased", leaseId: "lease-1", attempt: 1 });
		expect(queue.snapshot().items[0]).toMatchObject({ state: "leased", leaseId: "lease-1" });
		expect(queue.complete(leased!.id, "wrong-lease")).toBe(false);
		expect(queue.complete(leased!.id, leased!.leaseId!)).toBe(true);
	});

	it("releases a failed run back to pending while budget remains", () => {
		const queue = new ContinuationQueue<string>({ createLeaseId: () => "lease-1" });
		queue.enqueue(continuation());
		const [leased] = queue.drain({ now: 100, cancelGeneration: 0, limit: 1 });
		expect(leased?.leaseId).toBe("lease-1");
		expect(queue.release(leased!.id, leased!.leaseId!, "provider_failed")).toEqual({
			released: true,
			terminal: false,
			state: "pending",
		});
		expect(queue.snapshot().items[0]).toMatchObject({ state: "pending", attempt: 1, lastFailure: "provider_failed" });
	});

	it("rejects ID-only or stale lease settlement", () => {
		const queue = new ContinuationQueue<string>({ createLeaseId: () => "lease-current" });
		queue.enqueue(continuation());
		const [leased] = queue.drain({ now: 100, cancelGeneration: 0, limit: 1 });
		expect(() => queue.complete(leased!.id, undefined as unknown as string)).toThrow("leaseId");
		expect(() => queue.release(leased!.id, undefined as unknown as string, "late_worker")).toThrow("leaseId");
		expect(queue.snapshot().items[0]).toMatchObject({ state: "leased", leaseId: "lease-current" });
	});

	it("restores a persisted leased continuation and recovers an abandoned lease once", () => {
		const original = new ContinuationQueue<string>({ createLeaseId: () => "lease-1", now: () => 100 });
		original.enqueue(continuation());
		original.drain({ now: 100, cancelGeneration: 0, limit: 1 });
		const restored = new ContinuationQueue<string>({ snapshot: original.snapshot(), now: () => 1000 });
		expect(restored.recoverExpiredLeases({ now: 1000, leaseTimeoutMs: 500 })).toEqual(["continuation-1"]);
		expect(restored.recoverExpiredLeases({ now: 1000, leaseTimeoutMs: 500 })).toEqual([]);
		expect(restored.snapshot().items[0]?.state).toBe("pending");
	});

	it("recovers an unstarted lease without consuming its only attempt", () => {
		const original = new ContinuationQueue<string>({ createLeaseId: () => "lease-1", now: () => 100 });
		original.enqueue(continuation({ maxAttempts: 1 }));
		original.drain({ now: 100, cancelGeneration: 0, limit: 1 });

		const restored = new ContinuationQueue<string>({ snapshot: original.snapshot(), now: () => 1000 });
		expect(
			restored.recoverExpiredLeases({
				now: 1000,
				leaseTimeoutMs: 0,
				reason: "runtime_restarted",
				consumeAttempt: false,
			}),
		).toEqual(["continuation-1"]);
		expect(restored.snapshot().items[0]).toMatchObject({
			state: "pending",
			attempt: 0,
			lastFailure: "runtime_restarted",
		});
		expect(restored.drain({ now: 1001, cancelGeneration: 0, limit: 1 })[0]).toMatchObject({
			id: "continuation-1",
			state: "leased",
			attempt: 1,
		});
	});

	it("distinguishes scheduled work from work that is ready now", () => {
		const queue = new ContinuationQueue<string>();
		queue.enqueue(continuation({ notBefore: 500 }));
		expect(queue.hasPending(0)).toBe(true);
		expect(queue.hasReady({ now: 100, cancelGeneration: 0 })).toBe(false);
		expect(queue.nextEligibleAt(0)).toBe(500);
	});

	it("preserves FIFO order for continuations with the same priority and timestamp", () => {
		let leaseSequence = 0;
		const queue = new ContinuationQueue<string>({ createLeaseId: () => `lease-${++leaseSequence}` });
		queue.enqueue(continuation({ id: "b", idempotencyKey: "b" }));
		queue.enqueue(continuation({ id: "a", idempotencyKey: "a" }));
		expect(queue.drain({ now: 100, cancelGeneration: 0, limit: 2 }).map((item) => item.id)).toEqual(["b", "a"]);
	});

	it("validates every generated lease before mutating any selected continuation", () => {
		const leaseIds = ["lease-1", ""];
		const queue = new ContinuationQueue<string>({ createLeaseId: () => leaseIds.shift() ?? "" });
		queue.enqueue(continuation({ id: "first", idempotencyKey: "first" }));
		queue.enqueue(continuation({ id: "second", idempotencyKey: "second" }));

		expect(() => queue.drain({ now: 100, cancelGeneration: 0, limit: 2 })).toThrow("empty leaseId");
		expect(queue.snapshot().items).toEqual([
			expect.objectContaining({ id: "first", state: "pending", attempt: 0 }),
			expect.objectContaining({ id: "second", state: "pending", attempt: 0 }),
		]);
	});
});

describe("RunScope", () => {
	it("inherits one run identity and cancellation generation across child scopes", () => {
		const room = new RunScope({
			scopeId: "room-run",
			runId: "run-17",
			sessionId: "room-session",
			generation: 4,
			kind: "prompt",
		});
		const tool = room.child({ scopeId: "room-tool", kind: "tool" });
		expect(tool.snapshot()).toMatchObject({
			sessionId: "room-session",
			runId: "run-17",
			generation: 4,
			parentScopeId: "room-run",
		});
	});

	it("cancels a child operation without touching a sibling top-level scope", async () => {
		const room = new RunScope({ scopeId: "room-run", sessionId: "room-session", kind: "prompt" });
		const tool = room.child({ scopeId: "room-tool", kind: "tool" });
		const memory = new RunScope({ scopeId: "memory-run", sessionId: "memory-session", kind: "background" });
		const cancelTool = vi.fn();
		const cancelMemory = vi.fn();
		tool.register({ operationId: "process", kind: "process", cancel: cancelTool });
		memory.register({ operationId: "maintenance", kind: "job", cancel: cancelMemory });
		const receipt = await room.cancel("room_cancel");
		expect(cancelTool).toHaveBeenCalledWith("room_cancel");
		expect(cancelMemory).not.toHaveBeenCalled();
		expect(receipt.cancelledOperationIds).toEqual(["process"]);
		expect(room.snapshot()).toMatchObject({
			schemaVersion: "pi.run-scope.v1",
			sessionId: "room-session",
			children: [{ scopeId: "room-tool", kind: "tool", cancelled: true }],
		});
	});

	it("rejects a child that attempts to change Session or run identity", () => {
		const parent = new RunScope({ scopeId: "parent", runId: "run-1", sessionId: "session-1", kind: "prompt" });
		expect(
			() =>
				new RunScope({
					scopeId: "child",
					runId: "run-2",
					sessionId: "session-1",
					kind: "tool",
					parent,
				}),
		).toThrow("parent runId");
		expect(
			() =>
				new RunScope({
					scopeId: "child-2",
					sessionId: "session-2",
					kind: "tool",
					parent,
				}),
		).toThrow("parent Session");
	});

	it("seals settlement against late operations and ghost children", () => {
		const parent = new RunScope({ scopeId: "parent", sessionId: "session-1", kind: "prompt" });
		(parent as RunScope & { seal(): void }).seal();

		expect(() => parent.register({ operationId: "late", kind: "tool", cancel: () => undefined })).toThrow(
			"sealed scope",
		);
		expect(() => parent.child({ scopeId: "ghost", kind: "tool" })).toThrow("sealed scope");
		expect(parent.snapshot().children).toEqual([]);
	});
});
