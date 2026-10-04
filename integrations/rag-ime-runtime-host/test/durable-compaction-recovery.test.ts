import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CompactionTask, defineTask, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { parseCompactionTarget } from "../src/compaction-target.ts";
import { DurableProductSession } from "../src/durable-product-session.ts";
import type { RuntimeEventEnvelope, RuntimeMethod } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

function record(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

function gated(text: string) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	return {
		entered: entered.promise,
		release: release.resolve,
		signalled: () => signal?.aborted === true,
		step: async (_request: unknown, options?: { signal?: AbortSignal }) => {
			signal = options?.signal;
			entered.resolve();
			await new Promise<void>((resolveWait, reject) => {
				void release.promise.then(resolveWait);
				if (options?.signal?.aborted) reject(options.signal.reason);
				else options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
			return fauxAssistantMessage(text);
		},
	};
}

async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-compaction-reopen-repro-")));
	const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "test-auth.json"), modelsPath: null, allowModelNetwork: false });
	const faux = createFauxCore({ api: "faux:compaction-reopen", provider: "compaction-reopen", models: [{ id: "local" }] });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		name: "offline compaction reproduction", baseUrl: "http://localhost.invalid", api: model.api,
		apiKey: "test-only", streamSimple: faux.streamSimple,
		models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
			input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
	});
	const hosts: RagImeRuntimeHost[] = [];
	const events: RuntimeEventEnvelope[] = [];
	const createHost = async () => {
		const host = await RagImeRuntimeHost.create({ agentDir: join(directory, "agent"), sessionDir: join(directory, "sessions"),
			pluginsRoot: join(directory, "plugins"), pluginInbox: join(directory, "inbox"), maxSessions: 4,
			allowedWorkspaceRoots: [directory], modelRuntime, emitEvent: event => events.push(event) });
		hosts.push(host);
		return host;
	};
	let request = 0;
	const sessionId = "agent:compaction-reopen";
	const invoke = async (host: RagImeRuntimeHost, method: RuntimeMethod, params: Record<string, unknown> = {}) =>
		record(await host.handle({ protocolVersion: "2", id: `repro:${++request}`, method, params: { sessionId, ...params } }));
	const open = async (host: RagImeRuntimeHost) => record((await invoke(host, "session.open", {
		cwd: directory, runtimeEngine: "durable", durableStoreRef: join(directory, "sessions", "durable", sessionId),
		provider: model.provider, modelId: model.id, thinkingLevel: "off", codemodeMode: "off", toolManifest: [],
	})).snapshot);
	const interrupted = gated("interrupted summary");
	faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"), interrupted.step]);
	const host = await createHost();
	await open(host);
	let latest: Record<string, unknown> = {};
	for (let i = 1; i <= 2; i++) {
		latest = await invoke(host, "session.prompt", { message: `history ${i} ` + "old durable context ".repeat(5_000), clientMessageId: `input:${i}` });
		await invoke(host, "session.await_settled", { turnId: latest.turnId, clientMessageId: latest.clientMessageId, timeoutMs: 5_000 });
	}
	const compact = invoke(host, "session.compact", { instructions: "retain facts" });
	const compactResult = compact.then(value => ({ value }), error => ({ error }));
	await interrupted.entered;
	const session = host.sessions.get(sessionId);
	if (!(session instanceof DurableProductSession)) throw new Error("Expected actual Durable engine");
	const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
	expect(live?.run).toBeUndefined();
	expect(live?.compactions).toHaveLength(1);
	const taskId = live!.compactions![0].taskId;
	await host.dispose();
	expect(await compactResult).toHaveProperty("error");
	const reopened = await createHost();
	const snapshot = await open(reopened);
	const nativeSession = (target = reopened) => {
		const session = target.sessions.get(sessionId);
		if (!(session instanceof DurableProductSession)) throw new Error("Expected actual Durable engine");
		return session;
	};
	return { invoke, open, reopened, createHost, snapshot, latest, taskId, faux, sessionId, nativeSession, modelRuntime, events,
		close: async () => { interrupted.release(); await Promise.all(hosts.map(item => item.dispose())); await rm(directory, { recursive: true, force: true }); } };
}

// Regression: 7155/personal-agent-workbench#134.
describe("standalone native compaction recovery", () => {
	it("requires a complete task set in canonical string order across digit lengths", () => {
		const target = { kind: "compaction", runtimeSessionId: "runtime-session", taskIds: ["durable:task:10", "durable:task:2"] };
		expect(parseCompactionTarget(target)).toEqual(target);
		expect(() => parseCompactionTarget({ ...target, taskIds: [...target.taskIds].reverse() })).toThrow("sorted unique");
	});
	it("publishes the original compaction identity without activating scheduling on open or reads", async () => {
		const f = await fixture();
		try {
			expect(f.snapshot).toMatchObject({ paused: true, recoverable: true, isIdle: false, isCompacting: true,
				compactionTarget: { kind: "compaction", runtimeSessionId: f.snapshot.piSessionId, taskIds: [`durable:task:${f.taskId}`] },
				engineCapabilities: { compactionRecovery: true } });
			expect(await f.invoke(f.reopened, "hello")).toMatchObject({ capabilities: { sessionCompactionRecovery: true } });
			expect(f.snapshot.activeTurn).toBeUndefined();
			const started = f.events.find(event => event.payload.type === "compaction_start" && event.payload.taskId === f.taskId);
			expect(started).toBeDefined();
			expect(started?.turnId).toBeUndefined();
			expect(started?.clientMessageId).toBeUndefined();
			expect(f.faux.state.callCount).toBe(3);
			await f.invoke(f.reopened, "session.snapshot");
			await f.invoke(f.reopened, "session.control_state");
			await f.invoke(f.reopened, "session.settlement.get", { turnId: f.latest.turnId, clientMessageId: f.latest.clientMessageId });
			const resumed = await f.invoke(f.reopened, "session.resume", { turnId: f.latest.turnId, clientMessageId: f.latest.clientMessageId });
			expect(resumed).toMatchObject({ accepted: true, resumed: false, settlement: { receipt: { disposition: "completed" } } });
			await expect(f.invoke(f.reopened, "session.resume", { taskId: `durable:task:${f.taskId}` })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
			await expect(f.invoke(f.reopened, "session.prompt", { message: "next input", clientMessageId: "new:input" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			await expect(f.invoke(f.reopened, "session.abort", { expectedTurnId: f.latest.turnId, expectedClientMessageId: f.latest.clientMessageId })).rejects.toMatchObject({ code: "ABORT_TARGET_MISMATCH" });
			await setImmediate();
			expect(f.faux.state.callCount).toBe(3);
			expect(await f.invoke(f.reopened, "session.control_state")).toMatchObject({ paused: true, recoverable: true, isIdle: false, isCompacting: true });
		} finally { await f.close(); }
	});

	it("rejects a duplicate compact admission and resumes only the original task", async () => {
		const f = await fixture();
		const recovered = gated("recovered original summary");
		try {
			f.faux.setResponses([recovered.step]);
			await expect(f.invoke(f.reopened, "session.compact", { instructions: "retain facts" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			expect(f.faux.state.callCount).toBe(3);
			const resumed = await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			expect(resumed).toMatchObject({ schemaVersion: "rag-ime.pi-compaction-resume.v1", accepted: true, runtimeEngine: "durable", resumed: true,
				compactionTarget: f.snapshot.compactionTarget });
			await recovered.entered;
			await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			const session = f.reopened.sessions.get(f.sessionId);
			if (!(session instanceof DurableProductSession)) throw new Error("Expected actual Durable engine");
			const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
			expect(live?.compactions).toHaveLength(1);
			expect(live?.compactions?.map(item => item.taskId)).toContain(f.taskId);
			expect(f.faux.state.callCount).toBe(4);
			recovered.release();
			const task = await session.harness.waitForTask(f.taskId, BACKGROUND_CONTEXT);
			expect(task.state.outcome.status).toBe("completed");
			const repeated = await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			expect(repeated).toMatchObject({ resumed: false, state: { isIdle: true, isCompacting: false, paused: false, recoverable: false } });
			await vi.waitFor(() => expect(f.events.filter(event => event.payload.type === "compaction_settled")).toHaveLength(1));
			expect(f.events.find(event => event.payload.type === "compaction_settled")).toMatchObject({
				payload: { compactionTarget: f.snapshot.compactionTarget, state: { projectionCurrent: true, isIdle: true, isCompacting: false } } });
			expect(f.faux.state.callCount).toBe(4);
		} finally { recovered.release(); await f.close(); }
	});

	it("stops the original pending compaction and keeps terminal retries bound when a newer input runs", async () => {
		const f = await fixture();
		const successor = gated("new input answer");
		try {
			const target = f.snapshot.compactionTarget;
			const result = await f.invoke(f.reopened, "session.abort", { compactionTarget: target });
			expect(result).toMatchObject({ schemaVersion: "rag-ime.pi-compaction-abort.v1", accepted: true, runtimeEngine: "durable",
				compactionTarget: target, drained: true, outcomes: [{ taskId: `durable:task:${f.taskId}`, status: "aborted" }],
				state: { isIdle: true, isCompacting: false, paused: false, recoverable: false } });
			expect(f.faux.state.callCount).toBe(3);
			await f.reopened.dispose();
			const reopened = await f.createHost();
			await f.open(reopened);
			// A terminal repeat on a passively reopened Harness must not start its scheduler.
			expect(await f.invoke(reopened, "session.abort", { compactionTarget: target })).toMatchObject({ outcomes: result.outcomes, drained: true });
			expect((await f.nativeSession(reopened).harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
			f.faux.setResponses([successor.step]);
			const next = await f.invoke(reopened, "session.prompt", { message: "new input", clientMessageId: "successor" });
			await successor.entered;
			for (let count = 0; count < 2; count++) {
				expect(await f.invoke(reopened, "session.abort", { compactionTarget: target })).toMatchObject({ outcomes: result.outcomes,
					state: { isIdle: false, activeTurn: { turnId: next.turnId, clientMessageId: next.clientMessageId } } });
				expect(await f.invoke(reopened, "session.resume", { compactionTarget: target })).toMatchObject({ resumed: false });
			}
			expect(successor.signalled()).toBe(false);
			expect(f.faux.state.callCount).toBe(4);
			successor.release();
			await f.invoke(reopened, "session.await_settled", { turnId: next.turnId, clientMessageId: next.clientMessageId, timeoutMs: 5_000 });
		} finally { successor.release(); await f.close(); }
	});

	it("rejects malformed or mixed target forms and foreign, missing or wrong-kind task identities without scheduling", async () => {
		const f = await fixture();
		try {
			const target = record(f.snapshot.compactionTarget);
			const originalId = `durable:task:${f.taskId}`;
			for (const method of ["session.resume", "session.abort"] as const) {
				for (const invalid of [null, {}, { ...target, kind: "input" }, { ...target, taskIds: [] },
					{ ...target, taskIds: [originalId, originalId] }, { ...target, taskIds: ["durable:task:2", "durable:task:1"] },
					{ ...target, taskIds: ["durable:task:0"] }, { ...target, taskIds: ["durable:task:01"] },
					{ ...target, taskIds: ["durable:task:9007199254740992"] }, { ...target, extra: true }]) {
					await expect(f.invoke(f.reopened, method, { compactionTarget: invalid })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
				}
				for (const key of ["turnId", "clientMessageId", "expectedTurnId", "expectedClientMessageId", "cancelId", "lookupOnly", "recoverRetiredOnly", "recoverInterruptedOnly"]) {
					await expect(f.invoke(f.reopened, method, { compactionTarget: target, [key]: "mixed" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
				}
				for (const invalid of [{ ...target, runtimeSessionId: "foreign-runtime" }, { ...target, taskIds: ["durable:task:9999999"] },
					{ ...target, taskIds: record(record(record(f.snapshot.turnSettlement).receipt).continuations).terminalIds }]) {
					await expect(f.invoke(f.reopened, method, { compactionTarget: invalid })).rejects.toMatchObject({ code: "COMPACTION_TARGET_MISMATCH" });
				}
			}
			expect(f.faux.state.callCount).toBe(3);
			expect((await f.nativeSession().harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
		} finally { await f.close(); }
	});

	it("refuses an owned-child or foreign-conversation compaction target and unrelated work before global resume", async () => {
		const f = await fixture();
		try {
			const session = f.nativeSession();
			const child = await session.conversation.commit(tx => tx.createTask(CompactionTask, { reason: "manual" },
				{ ownership: { kind: "task", taskId: f.taskId } }), BACKGROUND_CONTEXT);
			const foreign = await session.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
			const other = await foreign.commit(tx => tx.createTask(CompactionTask, { reason: "manual" },
				{ ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
			for (const method of ["session.resume", "session.abort"] as const) {
				for (const id of [child, other]) {
					await expect(f.invoke(f.reopened, method, { compactionTarget: { ...record(f.snapshot.compactionTarget), taskIds: [`durable:task:${id}`] } }))
						.rejects.toMatchObject({ code: "COMPACTION_TARGET_MISMATCH" });
				}
				await expect(f.invoke(f.reopened, method, { compactionTarget: f.snapshot.compactionTarget })).rejects.toMatchObject({ code: "COMPACTION_TARGET_MISMATCH" });
			}
			const state = await f.invoke(f.reopened, "session.control_state");
			expect(state).toMatchObject({ isIdle: false, paused: true, recoverable: false });
			expect(state.compactionTarget).toBeUndefined();
			expect(f.faux.state.callCount).toBe(3);
			expect((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
		} finally { await f.close(); }
	});

	it("refuses compaction-only recovery when an unfinished native input exists", async () => {
		const f = await fixture();
		try {
			const session = f.nativeSession();
			await session.conversation.commit(tx => tx.createSubmission({ conversationId: session.conversation.id,
				type: "input", status: "queued", requestId: "unrelated-native-input" }), BACKGROUND_CONTEXT);
			for (const method of ["session.resume", "session.abort"] as const) {
				await expect(f.invoke(f.reopened, method, { compactionTarget: f.snapshot.compactionTarget })).rejects.toMatchObject({ code: "COMPACTION_TARGET_MISMATCH" });
			}
			expect((await f.invoke(f.reopened, "session.control_state")).compactionTarget).toBeUndefined();
			expect(f.faux.state.callCount).toBe(3);
		} finally { await f.close(); }
	});

	it("recovers the complete surviving native compaction set and marks all exact tasks before paused Stop schedules", async () => {
		const f = await fixture();
		try {
			const session = f.nativeSession();
			// Older Hosts could admit this duplicate. Use native state, without admitting another public compact.
			const second = await session.conversation.commit(async tx => {
				const id = await tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" }, background: false });
				(await tx.doc(LiveDoc, session.conversation.id)).compactions!.push({ taskId: id, reason: "manual", blocking: false, attempt: 1 });
				return id;
			}, BACKGROUND_CONTEXT);
			const taskIds = [f.taskId, second].map(id => `durable:task:${id}`).sort();
			const state = await f.invoke(f.reopened, "session.control_state");
			const target = state.compactionTarget;
			expect(target).toEqual({ kind: "compaction", runtimeSessionId: f.snapshot.piSessionId, taskIds });
			for (const method of ["session.resume", "session.abort"] as const) {
				await expect(f.invoke(f.reopened, method, { compactionTarget: f.snapshot.compactionTarget })).rejects.toMatchObject({ code: "COMPACTION_TARGET_MISMATCH" });
			}
			expect((await session.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
			const result = await f.invoke(f.reopened, "session.abort", { compactionTarget: target });
			expect(result).toMatchObject({ compactionTarget: target, drained: true,
				outcomes: taskIds.map(taskId => ({ taskId, status: "aborted" })), state: { isIdle: true, isCompacting: false } });
			expect(f.faux.state.callCount).toBe(3);
			expect(await f.invoke(f.reopened, "session.abort", { compactionTarget: target })).toMatchObject({ outcomes: result.outcomes });
		} finally { await f.close(); }
	});

	it("holds Stop and disposal for actual provider drain without blocking admission checks", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const summarize = vi.spyOn(f.modelRuntime, "completeSimple").mockImplementationOnce(async (_model, _context, options) => {
			entered.resolve();
			options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await release.promise; // Deliberately non-cooperative cleanup must remain owned.
			if (options?.signal?.aborted) throw options.signal.reason;
			return fauxAssistantMessage("delayed summary");
		});
		try {
			await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			await entered.promise;
			let stopped = false;
			const stop = f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget }).then(value => { stopped = true; return value; });
			void stop.catch(() => undefined);
			await aborted.promise;
			expect(await f.invoke(f.reopened, "session.control_state")).toMatchObject({ isIdle: false, isCompacting: true });
			await expect(f.invoke(f.reopened, "session.compact")).rejects.toMatchObject({ code: "SESSION_BUSY" });
			await expect(f.invoke(f.reopened, "session.prompt", { message: "too soon", clientMessageId: "too-soon" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			const repeat = f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget });
			void repeat.catch(() => undefined);
			let disposed = false;
			const dispose = f.reopened.dispose().then(() => { disposed = true; });
			await setImmediate();
			expect(stopped).toBe(false);
			expect(disposed).toBe(false);
			release.resolve();
			const result = await stop;
			expect(result).toMatchObject({ drained: true, outcomes: [{ taskId: `durable:task:${f.taskId}`, status: "aborted" }] });
			expect(await repeat).toMatchObject({ drained: true, outcomes: result.outcomes });
			await dispose;
		} finally { release.resolve(); summarize.mockRestore(); await f.close(); }
	});

	it("retains a completing compaction target after LiveDoc clears it, including passive reopen and exact Stop", async () => {
		const f = await fixture();
		const recovered = gated("summary before owned child drains");
		try {
			const session = f.nativeSession();
			const parked = defineTask<Record<string, never>, { phase: "parked" }, null, Record<string, never>>({
				name: "offline.compaction-held-child", version: 1, initial: () => ({ phase: "parked" }),
				phases: { parked: async () => { throw new Error("Unregistered task must not run"); } },
				abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
			});
			const child = await session.conversation.commit(tx => tx.createTask(parked, {}, { ownership: { kind: "task", taskId: f.taskId } }), BACKGROUND_CONTEXT);
			f.faux.setResponses([recovered.step]);
			await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			await recovered.entered;
			recovered.release();
			await vi.waitFor(async () => expect((await session.harness.getTask(f.taskId, BACKGROUND_CONTEXT))?.state.status).toBe("completing"));
			expect((await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT))?.compactions).toBeUndefined();
			expect(f.events.filter(event => event.payload.type === "compaction_settled")).toEqual([]);
			expect(await f.invoke(f.reopened, "session.control_state")).toMatchObject({ isIdle: false, isCompacting: true, compactionTarget: f.snapshot.compactionTarget });
			await expect(f.invoke(f.reopened, "session.prompt", { message: "not drained", clientMessageId: "not-drained" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			await f.reopened.dispose();
			const reopened = await f.createHost();
			expect(await f.open(reopened)).toMatchObject({ paused: true, recoverable: true, isIdle: false, isCompacting: true,
				compactionTarget: f.snapshot.compactionTarget });
			const stop = await f.invoke(reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget });
			expect(stop).toMatchObject({ drained: true, outcomes: [{ taskId: `durable:task:${f.taskId}`, status: "completed" }], state: { isIdle: true } });
			expect((await f.nativeSession(reopened).harness.getTask(child as TaskId, BACKGROUND_CONTEXT))?.state.status).toBe("terminal");
			await vi.waitFor(() => expect(f.events.filter(event => event.payload.type === "compaction_settled")).toHaveLength(1));
			expect(f.faux.state.callCount).toBe(4);
		} finally { recovered.release(); await f.close(); }
	});

	it("resumes every task of an existing multi-compaction set without admitting replacements", async () => {
		const f = await fixture();
		const first = gated("first recovered summary");
		const second = gated("second recovered summary");
		try {
			const session = f.nativeSession();
			const added = await session.conversation.commit(async tx => {
				const id = await tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" }, background: false });
				(await tx.doc(LiveDoc, session.conversation.id)).compactions!.push({ taskId: id, reason: "manual", blocking: false, attempt: 1 });
				return id;
			}, BACKGROUND_CONTEXT);
			const target = (await f.invoke(f.reopened, "session.control_state")).compactionTarget;
			f.faux.setResponses([first.step, second.step]);
			const resumed = await f.invoke(f.reopened, "session.resume", { compactionTarget: target });
			expect(resumed).toMatchObject({ resumed: true, compactionTarget: target });
			await Promise.all([first.entered, second.entered]);
			expect((await session.harness.inspect(BACKGROUND_CONTEXT)).tasks.map(task => task.record.id).sort()).toEqual([f.taskId, added].sort());
			expect(f.faux.state.callCount).toBe(5);
			first.release(); second.release();
			await Promise.all([f.taskId, added].map(id => session.harness.waitForTask(id, BACKGROUND_CONTEXT)));
			expect(await f.invoke(f.reopened, "session.resume", { compactionTarget: target })).toMatchObject({ resumed: false, state: { isIdle: true } });
			await vi.waitFor(() => expect(f.events.filter(event => event.payload.type === "compaction_settled")).toHaveLength(1));
		} finally { first.release(); second.release(); await f.close(); }
	});

	it("returns a failed native outcome instead of claiming successful compaction or replaying it", async () => {
		const f = await fixture();
		try {
			f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "permanent summarization failure" })]);
			await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget });
			await f.nativeSession().harness.waitForTask(f.taskId, BACKGROUND_CONTEXT);
			expect(await f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget })).toMatchObject({ drained: true,
				outcomes: [{ taskId: `durable:task:${f.taskId}`, status: "failed" }], state: { isIdle: true } });
			expect(await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget })).toMatchObject({ resumed: false });
			expect(f.faux.state.callCount).toBe(4);
		} finally { await f.close(); }
	});

	it("does not stop or resume a newer compaction when the original target is retried", async () => {
		const f = await fixture();
		const next = gated("new compaction summary");
		try {
			const stopped = await f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget });
			f.faux.setResponses([next.step]);
			const compact = f.invoke(f.reopened, "session.compact", { instructions: "new request" });
			void compact.catch(() => undefined);
			await next.entered;
			const current = await f.invoke(f.reopened, "session.control_state");
			expect(current.compactionTarget).not.toEqual(f.snapshot.compactionTarget);
			await expect(f.invoke(f.reopened, "session.compact")).rejects.toMatchObject({ code: "SESSION_BUSY" });
			expect(await f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget })).toMatchObject({ outcomes: stopped.outcomes,
				state: { isIdle: false, isCompacting: true, compactionTarget: current.compactionTarget } });
			expect(await f.invoke(f.reopened, "session.resume", { compactionTarget: f.snapshot.compactionTarget })).toMatchObject({ resumed: false });
			expect(next.signalled()).toBe(false);
			expect(f.faux.state.callCount).toBe(4);
			next.release();
			expect(await compact).toMatchObject({ outcome: { status: "completed" } });
		} finally { next.release(); await f.close(); }
	});

	it("preserves manual compaction during an already-running input but never uses it to resume paused input", async () => {
		const f = await fixture();
		const input = gated("live input answer");
		const summary = gated("concurrent manual summary");
		try {
			await f.invoke(f.reopened, "session.abort", { compactionTarget: f.snapshot.compactionTarget });
			f.faux.setResponses([input.step, summary.step]);
			const next = await f.invoke(f.reopened, "session.prompt", { message: "new live input", clientMessageId: "live-input" });
			await input.entered;
			const compact = f.invoke(f.reopened, "session.compact", { instructions: "manual while running" });
			void compact.catch(() => undefined);
			await summary.entered;
			const both = await f.invoke(f.reopened, "session.control_state");
			expect(both).toMatchObject({ isIdle: false, isCompacting: true, activeTurn: { turnId: next.turnId } });
			expect(both.compactionTarget).toBeUndefined();
			summary.release();
			await compact;
			await vi.waitFor(() => expect(f.events.some(event => event.payload.type === "compaction_end" && event.payload.taskId !== f.taskId)).toBe(true));
			for (const event of f.events.filter(event => ["compaction_start", "compaction_end"].includes(String(event.payload.type)))) {
				expect(event.turnId).toBeUndefined();
				expect(event.clientMessageId).toBeUndefined();
			}
			await f.reopened.dispose();
			const reopened = await f.createHost();
			expect(await f.open(reopened)).toMatchObject({ paused: true, recoverable: true, activeTurn: { turnId: next.turnId } });
			await expect(f.invoke(reopened, "session.compact")).rejects.toMatchObject({ code: "SESSION_BUSY" });
			expect((await f.nativeSession(reopened).harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
			expect(f.faux.state.callCount).toBe(5);
		} finally { input.release(); summary.release(); await f.close(); }
	});
});
