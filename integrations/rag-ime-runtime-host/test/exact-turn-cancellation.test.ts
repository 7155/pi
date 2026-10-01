import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";
import { RagImeRuntimeHost, RUNTIME_PRIMITIVE_CAPABILITIES } from "../src/runtime-host.ts";

function fixture() {
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	let finish!: () => void;
	const abort = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
	const session = Object.create(PiProductSession.prototype) as PiProductSession;
	const state = {
		externalSessionId: "session",
		activeTurn: { turnId: "turn", clientMessageId: "dispatch" },
		pendingDecisions: new Map(), pendingUIRequests: new Map(), roomContinuationIds: new Set(),
		abortGeneration: 0,
		providerContextJournal: { clearTurnContext: vi.fn() },
		session: {
			sessionId: "native-session", isStreaming: true, isIdle: false,
			isRetrying: false, isCompacting: false, isBashRunning: false,
			clearQueue: vi.fn(), abortBash: vi.fn(), abortCompaction: vi.fn(),
			abortBranchSummary: vi.fn(), abortRetry: vi.fn(), abort,
			waitForIdle: vi.fn(async () => undefined),
			sessionManager: {
				getEntries: () => entries,
				flushPendingEntries: vi.fn(),
				appendCustomEntry: vi.fn((customType: string, data: unknown) => {
					entries.push({ type: "custom", customType, data: structuredClone(data) });
				}),
			},
		},
	};
	Object.assign(session, state);
	const request = { turnId: "turn", clientMessageId: "dispatch", cancelId: "cancel" };
	return { session, state, request, abort, entries, finish: () => finish() };
}

describe("exact turn cancellation", () => {
	it("retires a drained recovered binding and persists its tombstone", async () => {
		const f = fixture();
		f.state.session.isStreaming = false;
		f.state.session.isIdle = true;
		const pending = f.session.abort();
		f.finish();
		expect(await pending).toMatchObject({ turnId: "turn", lifecycle: { drained: true, idle: true } });
		expect(f.state.session.sessionManager.flushPendingEntries).toHaveBeenCalled();
		expect(f.entries.at(-1)).toMatchObject({ customType: "rag-ime.pi-turn-binding", data: { turnId: "turn", state: "retired" } });
		expect(Reflect.get(f.session, "activeTurn")).toBeUndefined();
	});
	it("does not retire a replacement turn while an earlier abort drains", async () => {
		const f = fixture();
		const pending = f.session.abort();
		Object.assign(f.session, { activeTurn: { turnId: "replacement" } });
		f.state.session.isStreaming = false;
		f.state.session.isIdle = true;
		f.finish();
		await pending;
		expect(Reflect.get(f.session, "activeTurn")).toEqual({ turnId: "replacement" });
		expect(f.entries).toEqual([]);
	});
	it("accepts only the exact active identity and separates acceptance from drain", async () => {
		const f = fixture();
		const accepted = f.session.abortExact(f.request);
		expect(accepted).toMatchObject({ state: "accepted", phase: "requested", turnId: "turn" });
		expect(accepted.runtimeReceipt).toBeUndefined();
		expect(f.abort).toHaveBeenCalledTimes(1);
		f.state.session.isStreaming = false;
		f.state.session.isIdle = true;
		f.finish();
		await vi.waitFor(() => {
			expect(f.session.abortExact({ ...f.request, lookupOnly: true })).toMatchObject({
				state: "accepted", phase: "settled", runtimeReceipt: { turnId: "turn", lifecycle: { drained: true } },
			});
		});
	});

	it("rejects stale turn and command identities without touching any live resource", () => {
		for (const change of [{ turnId: "old-turn" }, { clientMessageId: "old-dispatch" }]) {
			const f = fixture();
			expect(f.session.abortExact({ ...f.request, ...change })).toMatchObject({ state: "rejected" });
			expect(f.abort).not.toHaveBeenCalled();
			expect(f.state.session.clearQueue).not.toHaveBeenCalled();
		}
	});

	it("replays the cancellation receipt after Session reuse without cancelling the new turn", () => {
		const f = fixture();
		const accepted = f.session.abortExact(f.request);
		Object.assign(f.session, { activeTurn: { turnId: "new-turn", clientMessageId: "new-dispatch" } });
		expect(f.session.abortExact(f.request)).toEqual(accepted);
		expect(f.abort).toHaveBeenCalledTimes(1);
		expect(() => f.session.abortExact({ ...f.request, turnId: "new-turn" })).toThrow("different turn");
	});

	it("queries absent receipts without initiating a cancellation", () => {
		const f = fixture();
		expect(f.session.abortExact({ ...f.request, lookupOnly: true })).toMatchObject({ state: "unknown" });
		expect(f.abort).not.toHaveBeenCalled();
	});

	it("restores an actual persisted acceptance after a lost response", () => {
		const f = fixture();
		const receipt = f.session.abortExact(f.request);
		const restored = Object.create(PiProductSession.prototype) as PiProductSession;
		Object.assign(restored, { ...f.state, activeTurn: { turnId: "new-turn", clientMessageId: "new-dispatch" } });
		expect(restored.abortExact({ ...f.request, lookupOnly: true })).toEqual(receipt);
		expect(f.abort).toHaveBeenCalledTimes(1);
	});

	it("keeps accepted cancellation when later receipt persistence fails", async () => {
		const f = fixture();
		const receipt = f.session.abortExact(f.request);
		f.state.session.sessionManager.appendCustomEntry.mockImplementation(() => { throw new Error("disk full"); });
		f.finish();
		await vi.waitFor(() => expect(f.session.abortExact({ ...f.request, lookupOnly: true }).phase).toBe("settled"));
		expect(f.session.abortExact({ ...f.request, lookupOnly: true }).receiptId).toBe(receipt.receiptId);
	});

	it("negotiates and routes exact fields at the real Host boundary", async () => {
		const f = fixture();
		const host = Object.create(RagImeRuntimeHost.prototype) as RagImeRuntimeHost;
		Object.assign(host, { sessions: { get: () => f.session } });
		expect(RUNTIME_PRIMITIVE_CAPABILITIES.sessionExactTurnCancel).toBe(true);
		const result = await host.handle({ protocolVersion: "2", id: "cancel-request", method: "session.abort",
			params: { sessionId: "session", expectedTurnId: "turn", clientMessageId: "dispatch", cancelId: "cancel" } });
		expect(result).toMatchObject({ state: "accepted", cancelId: "cancel", clientMessageId: "dispatch" });
		expect(f.abort).toHaveBeenCalledTimes(1);
	});
});
