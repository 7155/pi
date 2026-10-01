import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";
import { RagImeRuntimeHost, RUNTIME_PRIMITIVE_CAPABILITIES } from "../src/runtime-host.ts";
import { persistedTurnSettlement, TURN_SETTLEMENT_CUSTOM_TYPE, TurnSettlementTracker } from "../src/turn-settlement.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { turnId: "turn", clientMessageId: "dispatch" };
const binding = { schemaVersion: "rag-ime.pi-turn-binding.v1", ...identity };
const request = { ...identity, cancelId: "recovery", recoverRetiredOnly: true };

async function fixture(manager?: SessionManager) {
	if (!manager) {
		const root = await mkdtemp(join(tmpdir(), "pi-retired-turn-")); roots.push(root);
		manager = SessionManager.create(root, root);
		manager.appendCustomEntry("rag-ime.pi-turn-binding", binding);
		manager.appendCustomEntry("rag-ime.pi-turn-binding", { ...binding, state: "retired", reason: "explicit_abort", retiredAtMs: 100 });
		manager.flushPendingEntries();
	}
	const tracker = new TurnSettlementTracker("session", manager.getSessionId());
	for (const entry of manager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== TURN_SETTLEMENT_CUSTOM_TYPE) continue;
		const value = persistedTurnSettlement(entry.data); if (value) tracker.restore(value);
	}
	const runtime = {
		sessionId: manager.getSessionId(), sessionManager: manager, messages: [],
		isIdle: true, isStreaming: false, isRetrying: false, isCompacting: false, isBashRunning: false,
		pendingMessageCount: 0, agent: { state: { isStreaming: false, pendingToolCalls: new Set<string>() }, hasQueuedMessages: () => false },
		abort: vi.fn(), clearQueue: vi.fn(),
	};
	const state = {
		externalSessionId: "session", session: runtime, turnSettlements: tracker, settlementGeneration: 0, abortGeneration: 0,
		pendingDecisions: new Map(), pendingUIRequests: new Map(), roomContinuationIds: new Set<string>(),
	};
	const session = Object.assign(Object.create(PiProductSession.prototype), state) as PiProductSession;
	return { session, runtime, manager, state };
}

describe("retired exact turn settlement recovery", () => {
	it("recovers one durable aborted settlement and replays it after reopening without executing or cancelling", async () => {
		const f = await fixture();
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		const waiter = f.session.awaitSettled("turn", { expectedClientMessageId: "dispatch", timeoutMs: 1000 });
		const cancelled = f.session.abortExact(request);
		expect(cancelled).toMatchObject({ state: "accepted", phase: "settled", runtimeReceipt: { lifecycle: { drained: true } } });
		const settlement = await waiter;
		expect(settlement).toMatchObject({ ...identity, receipt: { disposition: "aborted", aborted: true, pendingOperations: 0, stopReason: "retired_turn_recovered" } });
		expect(settlement.receipt.finalMessage).toBeUndefined();
		expect(f.runtime.abort).not.toHaveBeenCalled();
		expect(f.runtime.clearQueue).not.toHaveBeenCalled();
		expect(f.session.abortExact(request)).toEqual(cancelled);
		const restored = await fixture(SessionManager.open(f.manager.getSessionFile()!, f.manager.getSessionDir(), f.manager.getCwd()));
		expect(restored.session.abortExact({ ...request, lookupOnly: true })).toEqual(cancelled);
		expect(restored.session.settlement("turn", "dispatch")).toEqual(settlement);
		expect(restored.session.abortExact({ ...request, cancelId: "another-recovery" }).state).toBe("accepted");
		expect(restored.session.settlement("turn", "dispatch")).toEqual(settlement);
		expect(restored.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TURN_SETTLEMENT_CUSTOM_TYPE)).toHaveLength(1);
	});

	it("keeps lookup reads side effect free and rejects wrong dispatch and turn binding", async () => {
		const f = await fixture();
		const before = f.manager.getEntries().length;
		expect(f.session.abortExact({ ...request, lookupOnly: true }).state).toBe("unknown");
		expect(f.manager.getEntries()).toHaveLength(before);
		for (const mismatch of [{ turnId: "other" }, { clientMessageId: "other" }]) {
			expect(f.session.abortExact({ ...request, ...mismatch, cancelId: JSON.stringify(mismatch) }).state).toBe("rejected");
		}
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		expect(f.runtime.abort).not.toHaveBeenCalled();
	});

	it("retries the same recovery identity once actual resources drain without caching a rejection", async () => {
		const f = await fixture();
		f.runtime.agent.state.pendingToolCalls.add("pending");
		const before = f.manager.getEntries().length;
		expect(f.session.abortExact(request)).toMatchObject({ state: "rejected", reason: "retired_turn_resources_not_drained" });
		expect(f.manager.getEntries()).toHaveLength(before);
		f.runtime.agent.state.pendingToolCalls.clear();
		expect(f.session.abortExact(request)).toMatchObject({ state: "accepted", phase: "settled" });
		expect(f.session.settlement("turn", "dispatch")?.receipt.disposition).toBe("aborted");
	});

	it("does not resolve a waiter before the recovered journal entry is flushed", async () => {
		const f = await fixture();
		const flush = vi.spyOn(f.manager, "flushPendingEntries").mockImplementationOnce(() => { throw new Error("disk full"); });
		expect(() => f.session.abortExact(request)).toThrow("disk full");
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		flush.mockRestore();
		expect(f.session.abortExact(request).state).toBe("accepted");
		expect(f.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TURN_SETTLEMENT_CUSTOM_TYPE)).toHaveLength(1);
		const restored = await fixture(SessionManager.open(f.manager.getSessionFile()!, f.manager.getSessionDir(), f.manager.getCwd()));
		expect(restored.session.settlement("turn", "dispatch")).toEqual(f.session.settlement("turn", "dispatch"));
	});

	it("never falls back to ordinary abort for the same active unretired identity", async () => {
		const f = await fixture();
		f.manager.appendCustomEntry("rag-ime.pi-turn-binding", binding);
		Object.assign(f.session, { activeTurn: identity });
		expect(f.session.abortExact(request).state).toBe("rejected");
		expect(f.runtime.abort).not.toHaveBeenCalled();
		expect(Reflect.get(f.session, "activeTurn")).toEqual(identity);
	});

	it.each(["activeTurn", "activeRoom", "streaming", "nativeStreaming", "retry", "compaction", "bash", "messages", "nativeQueue", "tool", "continuation", "decision", "ui", "reload", "dispose"])("refuses recovery while %s resources remain", async (resource) => {
		const f = await fixture();
		switch (resource) {
			case "activeTurn": Object.assign(f.session, { activeTurn: { turnId: "new", clientMessageId: "new-dispatch" } }); break;
			case "activeRoom": Object.assign(f.session, { activeRoom: { runtimeTurnId: "new" } }); break;
			case "streaming": f.runtime.isIdle = false; f.runtime.isStreaming = true; break;
			case "nativeStreaming": f.runtime.agent.state.isStreaming = true; break;
			case "retry": f.runtime.isRetrying = true; break;
			case "compaction": f.runtime.isCompacting = true; break;
			case "bash": f.runtime.isBashRunning = true; break;
			case "messages": f.runtime.pendingMessageCount = 1; break;
			case "nativeQueue": f.runtime.agent.hasQueuedMessages = () => true; break;
			case "tool": f.runtime.agent.state.pendingToolCalls.add("tool"); break;
			case "continuation": f.state.roomContinuationIds.add("continuation"); break;
			case "decision": f.state.pendingDecisions.set("decision", {}); break;
			case "ui": f.state.pendingUIRequests.set("ui", {}); break;
			case "reload": Object.assign(f.session, { pluginReloadInFlight: Promise.resolve() }); break;
			case "dispose": Object.assign(f.session, { disposePromise: Promise.resolve() }); break;
		}
		expect(f.session.abortExact(request).state).toBe("rejected");
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		expect(f.runtime.abort).not.toHaveBeenCalled();
		expect(f.runtime.clearQueue).not.toHaveBeenCalled();
	});

	it("does not recover an older retired binding after a newer durable turn even if currently idle", async () => {
		const f = await fixture();
		f.manager.appendCustomEntry("rag-ime.pi-turn-binding", { ...binding, turnId: "new-turn" });
		expect(f.session.abortExact(request).state).toBe("rejected");
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		expect(f.runtime.abort).not.toHaveBeenCalled();
	});

	it("routes explicit recovery at the real Host boundary and requires exact fields", async () => {
		const f = await fixture();
		const host = Object.assign(Object.create(RagImeRuntimeHost.prototype) as RagImeRuntimeHost, { sessions: { get: () => f.session } });
		expect(Reflect.get(RUNTIME_PRIMITIVE_CAPABILITIES, "sessionRetiredTurnRecovery")).toBe(true);
		await expect(host.handle({ protocolVersion: "2", id: "missing", method: "session.abort", params: { sessionId: "session", recoverRetiredOnly: true } })).rejects.toThrow();
		const result = await host.handle({ protocolVersion: "2", id: "recover", method: "session.abort", params: { sessionId: "session", expectedTurnId: "turn", clientMessageId: "dispatch", cancelId: "recovery", recoverRetiredOnly: true } });
		expect(result).toMatchObject({ state: "accepted", phase: "settled" });
		expect(f.runtime.abort).not.toHaveBeenCalled();
	});
});

describe("cold interrupted exact turn retirement", () => {
	async function cold() {
		const f = await fixture();
		f.manager.appendCustomEntry("rag-ime.pi-turn-binding", binding);
		f.manager.flushPendingEntries();
		const latest = f.manager.getBranch().at(-1)!;
		Object.assign(f.session, { activeTurn: identity, recoveredTurnBindingId: latest.id,
			providerContextJournal: { clearTurnContext: vi.fn() } });
		return f;
	}
	const interrupted = { ...identity, cancelId: "interrupted", recoverInterruptedOnly: true };
	it("retires only the cold idle binding, then separately settles it without calling any abort control", async () => {
		const f = await cold();
		const host = Object.assign(Object.create(RagImeRuntimeHost.prototype) as RagImeRuntimeHost, { sessions: { get: () => f.session } });
		expect(Reflect.get(RUNTIME_PRIMITIVE_CAPABILITIES, "sessionInterruptedTurnRecovery")).toBe(true);
		const result = await host.handle({ protocolVersion: "2", id: "retire", method: "session.abort", params: {
			sessionId: "session", expectedTurnId: "turn", clientMessageId: "dispatch", cancelId: "interrupted", recoverInterruptedOnly: true } });
		expect(result).toMatchObject({ state: "accepted", phase: "settled", runtimeReceipt: { lifecycle: { reason: "interrupted_turn_recovery", idle: true, drained: true } } });
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		expect(f.session.abortExact(interrupted)).toEqual(result);
		expect(f.session.abortExact(request)).toMatchObject({ state: "accepted", phase: "settled" });
		expect(f.session.settlement("turn", "dispatch")?.receipt.disposition).toBe("aborted");
		expect(f.runtime.abort).not.toHaveBeenCalled();
		expect(f.runtime.clearQueue).not.toHaveBeenCalled();
		const restored = await fixture(SessionManager.open(f.manager.getSessionFile()!, f.manager.getSessionDir(), f.manager.getCwd()));
		expect(restored.session.abortExact({ ...interrupted, lookupOnly: true })).toEqual(result);
	});
	it("invalidates cold provenance if the same native turn resumes, even when it later looks idle", async () => {
		const f = await cold();
		Object.assign(f.session, { emitEvent: vi.fn(), telemetry: () => ({}), sequence: 0 });
		Reflect.get(f.session, "onSessionEvent").call(f.session, { type: "agent_start" });
		expect(f.runtime.isIdle).toBe(true);
		expect(f.session.abortExact(interrupted)).toMatchObject({ state: "rejected", reason: "requested_turn_is_not_the_cold_recovered_binding" });
		expect(f.runtime.abort).not.toHaveBeenCalled();
	});
	it.each(["notCold", "newBinding", "newTurn", "wrongDispatch", "activeRoom", "notIdle", "streaming", "nativeStreaming", "retry", "compaction", "bash", "messages", "nativeQueue", "tool", "continuation", "decision", "ui", "reload", "dispose"])("refuses %s without persisting rejection or cancelling", async resource => {
		const f = await cold();
		let options = interrupted;
		switch (resource) {
			case "notCold": Object.assign(f.session, { recoveredTurnBindingId: undefined }); break;
			case "newBinding": f.manager.appendCustomEntry("rag-ime.pi-turn-binding", { ...binding, turnId: "new" }); break;
			case "newTurn": Object.assign(f.session, { activeTurn: { turnId: "new", clientMessageId: "new" } }); break;
			case "wrongDispatch": options = { ...interrupted, clientMessageId: "wrong" }; break;
			case "activeRoom": Object.assign(f.session, { activeRoom: { runtimeTurnId: "turn" } }); break;
			case "notIdle": f.runtime.isIdle = false; break;
			case "streaming": f.runtime.isStreaming = true; break;
			case "nativeStreaming": f.runtime.agent.state.isStreaming = true; break;
			case "retry": f.runtime.isRetrying = true; break;
			case "compaction": f.runtime.isCompacting = true; break;
			case "bash": f.runtime.isBashRunning = true; break;
			case "messages": f.runtime.pendingMessageCount = 1; break;
			case "nativeQueue": f.runtime.agent.hasQueuedMessages = () => true; break;
			case "tool": f.runtime.agent.state.pendingToolCalls.add("tool"); break;
			case "continuation": f.state.roomContinuationIds.add("continuation"); break;
			case "decision": f.state.pendingDecisions.set("decision", {}); break;
			case "ui": f.state.pendingUIRequests.set("ui", {}); break;
			case "reload": Object.assign(f.session, { pluginReloadInFlight: Promise.resolve() }); break;
			case "dispose": Object.assign(f.session, { disposePromise: Promise.resolve() }); break;
		}
		const before = f.manager.getEntries().length;
		expect(f.session.abortExact(options).state).toBe("rejected");
		expect(f.manager.getEntries()).toHaveLength(before);
		expect(f.session.settlement("turn", "dispatch")).toBeUndefined();
		expect(f.runtime.abort).not.toHaveBeenCalled();
	});
});
