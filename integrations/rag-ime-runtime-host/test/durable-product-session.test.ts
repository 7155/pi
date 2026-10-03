import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, defineTask, Harness, type JsonObject, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DurableProductSession } from "../src/durable-product-session.ts";
import type { RuntimeEventEnvelope, RuntimeMethod } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";
import { TRANSIENT_CONTEXT_ENVELOPE_PREFIX } from "../src/transient-context.ts";

function record(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

function deferred() {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function gated(text: string) {
	const entered = deferred();
	const release = deferred();
	let signal: AbortSignal | undefined;
	return {
		entered: entered.promise, release: release.resolve, signalled: () => signal?.aborted === true,
		step: async (_request: unknown, options?: { signal?: AbortSignal }) => {
			signal = options?.signal;
			entered.resolve();
			await new Promise<void>((resolveWait, reject) => {
				release.promise.then(resolveWait);
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
			});
			return fauxAssistantMessage(text);
		},
	};
}

async function fixture(fauxOptions: Partial<RegisterFauxProviderOptions> = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-host-durable-")));
	const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "test-auth.json"), modelsPath: null, allowModelNetwork: false });
	const faux = createFauxCore({ api: "faux:host-durable", provider: "host-durable", models: [{ id: "local" }], ...fauxOptions });
	const model = faux.getModel();
	let calls = 0;
	faux.setResponses([() => { calls++; return fauxAssistantMessage("local durable reply"); }]);
	modelRuntime.registerProvider(model.provider, {
		name: "offline Durable fixture", baseUrl: "http://localhost.invalid", api: model.api,
		apiKey: "test-only", streamSimple: faux.streamSimple,
		models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
			input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
	});
	const events: RuntimeEventEnvelope[] = [];
	const options = { agentDir: join(directory, "agent"), sessionDir: join(directory, "sessions"),
		pluginsRoot: join(directory, "plugins"), pluginInbox: join(directory, "inbox"), maxSessions: 4,
		allowedWorkspaceRoots: [directory], toolGatewayUrl: "http://gateway.invalid/tool/execute", modelRuntime, emitEvent: (event: RuntimeEventEnvelope) => events.push(event) };
	const hosts: RagImeRuntimeHost[] = [];
	const createHost = async (overrides: Partial<typeof options> = {}) => { const host = await RagImeRuntimeHost.create({ ...options, ...overrides }); hosts.push(host); return host; };
	const host = await createHost();
	let request = 0;
	const invoke = async (method: RuntimeMethod, params: Record<string, unknown>, target = host) =>
		record(await target.handle({ protocolVersion: "2", id: `test:${++request}`, method, params }));
	const openParams = { sessionId: "agent:durable-test", cwd: directory, runtimeEngine: "durable",
		durableStoreRef: join(options.sessionDir, "durable", "agent:durable-test"),
		provider: model.provider, modelId: model.id, thinkingLevel: "off", codemodeMode: "off", toolManifest: [] };
	const open = async (target = host, extra: Record<string, unknown> = {}) => record((await invoke("session.open", { ...openParams, ...extra }, target)).snapshot);
	const turn = async (message = "hello", clientMessageId = "client:one", target = host) =>
		invoke("session.prompt", { sessionId: openParams.sessionId, message, clientMessageId }, target);
	const settled = async (ack: Record<string, unknown>, target = host) =>
		invoke("session.await_settled", { sessionId: openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId, timeoutMs: 5_000 }, target);
	return { directory, host, createHost, invoke, openParams, open, turn, settled, events, faux, modelRuntime, calls: () => calls,
		close: async () => { await Promise.all(hosts.map(target => target.dispose())); await rm(directory, { recursive: true, force: true }); } };
}

describe("public RuntimeHost Durable engine", () => {
	it("accepts a canonical binding through an owned-root alias and rejects a per-Session symlink", async () => {
		const f = await fixture();
		try {
			const sessionDir = join(f.directory, "sessions");
			const alias = join(f.directory, "sessions-alias");
			await symlink(sessionDir, alias);
			const host = await f.createHost({ sessionDir: alias });
			const opened = await f.open(host);
			expect(opened).toMatchObject({ durableStoreRef: f.openParams.durableStoreRef, paused: true });
			const foreign = join(f.directory, "foreign-storage");
			await mkdir(foreign);
			const denied = join(sessionDir, "durable", "agent:symlink-denied");
			await symlink(foreign, denied);
			await expect(f.open(host, { sessionId: "agent:symlink-denied", durableStoreRef: denied })).rejects.toMatchObject({ code: "SESSION_PATH_DENIED" });
			expect(f.calls()).toBe(0);
		} finally { await f.close(); }
	});

	it("renders the prepared original context for the first native model request and persists later Session context", async () => {
		const f = await fixture();
		const contexts: string[] = [];
		f.faux.setResponses([request => { contexts.push(JSON.stringify(request.messages.filter(message => message.role === "system").at(-1))); return fauxAssistantMessage("first context reply"); },
			request => { contexts.push(JSON.stringify(request.messages.filter(message => message.role === "system").at(-1))); return fauxAssistantMessage("later context reply"); }]);
		try {
			await f.open(f.host, { systemPrompt: "owned-persona", sessionContext: "initial-memory" });
			const first = await f.invoke("session.prompt", { sessionId: f.openParams.sessionId, clientMessageId: "context:first", message:
				TRANSIENT_CONTEXT_ENVELOPE_PREFIX + JSON.stringify({ schemaVersion: "rag-ime.runtime-prompt.v1", message: "original question",
					sessionContext: "updated-memory", transientContext: "original-tool-context" }) });
			await f.settled(first);
			expect(contexts[0]).toContain("owned-persona");
			expect(contexts[0]).toContain("updated-memory");
			expect(contexts[0]).toContain("original-tool-context");
			const second = await f.turn("later question", "context:second"); await f.settled(second);
			expect(contexts[1]).toContain("updated-memory");
			expect(contexts[1]).not.toContain("original-tool-context");
		} finally { await f.close(); }
	});

	it("opens the owned native SQLite engine passively and projects its committed messages", async () => {
		const f = await fixture();
		try {
			const opened = await f.open();
			expect(opened).toMatchObject({ runtimeEngine: "durable", durableStoreRef: f.openParams.durableStoreRef,
				paused: true, recoverable: false, isIdle: true, engineCapabilities: { gatewayTools: true, nativeMcp: false, codemode: false, resume: true } });
			expect(opened.sessionFile).toBeUndefined();
			expect(opened.piSessionId).toMatch(/^[0-9a-f-]{36}$/u);
			expect(f.calls()).toBe(0);
			const ack = await f.turn();
			expect(ack).toMatchObject({ clientMessageId: "client:one", disposition: "started" });
			const receipt = await f.settled(ack);
			expect(record(receipt.receipt)).toMatchObject({ disposition: "completed", pendingOperations: 0 });
			const snapshot = await f.invoke("session.snapshot", { sessionId: f.openParams.sessionId, view: "recent" });
			expect(snapshot).toMatchObject({ runtimeEngine: "durable", projectionCurrent: true, isIdle: true });
			expect(snapshot.messages).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "hello", id: expect.stringMatching(/^durable:/u), _ragImeTurnId: ack.turnId, clientMessageId: "client:one" }),
				expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "local durable reply" }], _ragImeTurnId: ack.turnId }),
			]));
			expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ turnId: ack.turnId, payload: expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "assistant" }) }) })]));
		} finally { await f.close(); }
	});

	it("recovers a lost admission ACK without replay and rejects changed original arguments before native dedup", async () => {
		const f = await fixture();
		try {
			await f.open();
			const original = await f.turn();
			const originalReceipt = await f.settled(original);
			await f.host.dispose();
			const reopenedHost = await f.createHost();
			const reopened = await f.open(reopenedHost);
			expect(reopened).toMatchObject({ paused: true, recoverable: false });
			const replay = await f.turn("hello", "client:one", reopenedHost);
			expect(replay).toMatchObject({ turnId: original.turnId, clientMessageId: original.clientMessageId });
			expect(f.calls()).toBe(1);
			await expect(f.turn("changed", "client:one", reopenedHost)).rejects.toMatchObject({ code: "PROMPT_IDENTITY_MISMATCH" });
			expect(f.calls()).toBe(1);
			expect(record(await f.settled(original, reopenedHost)).receipt).toEqual(originalReceipt.receipt);
		} finally { await f.close(); }
	});

	it("holds one storage lease across Hosts and explicitly rejects classic-only features", async () => {
		const f = await fixture();
		try {
			await f.open();
			const contender = await f.createHost();
			await expect(f.open(contender)).rejects.toMatchObject({ code: "DURABLE_STORAGE_BUSY" });
			for (const method of ["session.commands", "session.fork.candidates", "session.codemode.set"] as const) {
				await expect(f.invoke(method, { sessionId: f.openParams.sessionId, mode: "on" })).rejects.toMatchObject({ code: "ENGINE_FEATURE_UNAVAILABLE" });
			}
			await f.invoke("session.close", { sessionId: f.openParams.sessionId });
			const opened = await f.open(contender);
			expect(opened).toMatchObject({ runtimeEngine: "durable", paused: true });
			await setImmediate();
			expect(f.calls()).toBe(0);
		} finally { await f.close(); }
	});

	it("reopens an unfinished original input paused and resumes it explicitly without another user entry", async () => {
		const f = await fixture();
		const interrupted = gated("interrupted response");
		f.faux.setResponses([interrupted.step]);
		try {
			const first = await f.open();
			const ack = await f.turn();
			await interrupted.entered;
			await f.host.dispose();
			expect(interrupted.signalled()).toBe(true);
			expect(f.events.filter(event => event.payload.type === "agent_settled")).toEqual([]);
			f.faux.setResponses([fauxAssistantMessage("resumed original response")]);
			const host = await f.createHost();
			const opened = await f.open(host);
			expect(opened).toMatchObject({ paused: true, recoverable: true, isIdle: false, piSessionId: first.piSessionId,
				activeTurn: { turnId: ack.turnId, clientMessageId: ack.clientMessageId } });
			for (const method of ["session.snapshot", "session.control_state", "session.settlement.get"] as const) {
				await f.invoke(method, { sessionId: f.openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId, view: "recent" }, host);
			}
			await setImmediate();
			expect(f.faux.state.callCount).toBe(1);
			await expect(f.invoke("session.resume", { sessionId: f.openParams.sessionId, turnId: "wrong", clientMessageId: ack.clientMessageId }, host)).rejects.toMatchObject({ code: "RESUME_TARGET_MISMATCH" });
			const resume = await f.invoke("session.resume", { sessionId: f.openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId }, host);
			expect(resume).toMatchObject({ schemaVersion: "rag-ime.pi-session-resume.v1", accepted: true, resumed: true,
				runtimeEngine: "durable", turnId: ack.turnId, clientMessageId: ack.clientMessageId });
			const receipt = await f.settled(ack, host);
			expect(record(receipt.receipt)).toMatchObject({ disposition: "completed" });
			const snapshot = await f.invoke("session.snapshot", { sessionId: f.openParams.sessionId }, host);
			expect((snapshot.messages as Record<string, unknown>[]).filter(message => message.role === "user")).toHaveLength(1);
			expect(f.faux.state.callCount).toBe(2);
			const already = await f.invoke("session.resume", { sessionId: f.openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId }, host);
			expect(already).toMatchObject({ resumed: false, settlement: receipt });
		} finally { interrupted.release(); await f.close(); }
	});

	it("recovers an interrupted Gateway effect once and preserves the original authority and tool evidence", async () => {
		const f = await fixture();
		const entered = deferred();
		const requests: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			entered.resolve();
			await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
			return Response.json({ ok: true, result: { summary: "effect complete" } });
		}));
		const manifest = [{ name: "unsafe_effect", description: "Governed offline effect", parameters: { type: "object", properties: {}, additionalProperties: false }, alwaysAvailable: true }];
		f.faux.setResponses([fauxAssistantMessage([fauxToolCall("unsafe_effect", {}, { id: "effect:one" })], { stopReason: "toolUse" })]);
		try {
			await f.open(f.host, { toolManifest: manifest });
			const ack = await f.turn();
			await entered.promise;
			expect(requests).toEqual([expect.objectContaining({ toolCallId: "effect:one", executionBinding: { turnId: ack.turnId, clientMessageId: ack.clientMessageId } })]);
			await f.host.dispose();
			f.faux.setResponses([fauxAssistantMessage("continued after interruption")]);
			const host = await f.createHost();
			const paused = await f.open(host, { toolManifest: manifest });
			expect(paused).toMatchObject({ recoverable: true, paused: true, isIdle: false });
			await f.invoke("session.resume", { sessionId: f.openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId }, host);
			await f.settled(ack, host);
			expect(requests).toHaveLength(1);
			const snapshot = await f.invoke("session.snapshot", { sessionId: f.openParams.sessionId, view: "recent" }, host);
			expect(snapshot.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolCallId: "effect:one", isError: true, _ragImeTurnId: ack.turnId })]));
			expect(f.events.filter(event => event.payload.type === "tool_execution_start")).toEqual(expect.arrayContaining([expect.objectContaining({ turnId: ack.turnId })]));
		} finally { vi.unstubAllGlobals(); await f.close(); }
	});

	it("uses native generation handoff for exact Stop and never adopts a successor on late or repeated Stop", async () => {
		const f = await fixture();
		const successor = gated("successor after tool");
		const next = gated("new input answer");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { summary: "tool done" } })));
		const manifest = [{ name: "finish_tool", description: "Offline governed tool", parameters: { type: "object", properties: {} }, alwaysAvailable: true }];
		f.faux.setResponses([fauxAssistantMessage([fauxToolCall("finish_tool", {}, { id: "tool:handoff" })], { stopReason: "toolUse" }), successor.step, next.step]);
		try {
			await f.open(f.host, { toolManifest: manifest });
			const old = await f.turn("old", "old:client");
			const session = f.host.sessions.get(f.openParams.sessionId);
			if (!(session instanceof DurableProductSession)) throw new Error("Expected the actual Durable engine");
			const initialTask = (await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT))?.run?.taskId;
			await successor.entered;
			const laterTask = (await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT))?.run?.taskId;
			expect(laterTask).not.toBe(initialTask);
			const stopped = await f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: old.turnId, expectedClientMessageId: old.clientMessageId });
			expect(record(stopped.lifecycle)).toMatchObject({ drained: true });
			expect(successor.signalled()).toBe(true);
			expect(record((await f.settled(old)).receipt)).toMatchObject({ disposition: "aborted" });
			const fresh = await f.turn("new", "new:client");
			await next.entered;
			for (let repeat = 0; repeat < 2; repeat++) {
				await expect(f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: old.turnId, expectedClientMessageId: old.clientMessageId })).rejects.toMatchObject({ code: "ABORT_TARGET_MISMATCH" });
			}
			expect(next.signalled()).toBe(false);
			const state = await f.invoke("session.control_state", { sessionId: f.openParams.sessionId });
			expect(state.activeTurn).toMatchObject({ turnId: fresh.turnId, clientMessageId: fresh.clientMessageId });
			next.release(); await f.settled(fresh);
		} finally { successor.release(); next.release(); vi.unstubAllGlobals(); await f.close(); }
	});

	it("projects only committed streaming deltas with the same stable message identity as final history", async () => {
		const f = await fixture({ tokensPerSecond: 60, tokenSize: { min: 1, max: 1 } });
		f.faux.setResponses([fauxAssistantMessage("committed streamed text ".repeat(8))]);
		try {
			await f.open();
			const ack = await f.turn();
			await vi.waitFor(() => expect(f.events.some(event => record(event.payload.assistantMessageEvent).type === "text_delta")).toBe(true));
			await f.settled(ack);
			const updates = f.events.filter(event => event.payload.type === "message_update");
			const final = f.events.find(event => event.payload.type === "message_end" && record(event.payload.message).role === "assistant");
			expect(updates.length).toBeGreaterThan(0);
			expect(updates.every(event => event.turnId === ack.turnId && record(event.payload.message).id === record(final?.payload.message).id)).toBe(true);
			expect(f.events.indexOf(final!)).toBeLessThan(f.events.findIndex(event => event.payload.type === "agent_settled"));
		} finally { await f.close(); }
	});

	it("compacts with the native task and reopens both current and older committed history passively", async () => {
		const f = await fixture();
		const long = "old durable context ".repeat(5_000).trim();
		f.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply"), fauxAssistantMessage("native compact summary")]);
		try {
			await f.open();
			const first = await f.turn(long, "long:client"); await f.settled(first);
			const second = await f.turn(`${long}latest input`, "latest:client"); await f.settled(second);
			const compact = await f.invoke("session.compact", { sessionId: f.openParams.sessionId, instructions: "retain facts" });
			expect(compact).toMatchObject({ outcome: { status: "completed" } });
			const current = await f.invoke("session.snapshot", { sessionId: f.openParams.sessionId });
			expect(JSON.stringify(current.messages)).toContain("native compact summary");
			expect((current.messages as Record<string, unknown>[]).some(message => message.role === "user" && message.content === long && message._ragImeTurnId === first.turnId)).toBe(true);
			await f.host.dispose();
			const host = await f.createHost(); await f.open(host);
			const recent = await f.invoke("session.snapshot", { sessionId: f.openParams.sessionId, view: "recent" }, host);
			expect(JSON.stringify(recent.messages)).toContain(long);
			expect(JSON.stringify(recent.messages)).toContain("native compact summary");
			expect(record((await f.settled(first, host)).receipt)).toMatchObject({ disposition: "completed" });
			expect(f.faux.state.callCount).toBe(3);
		} finally { await f.close(); }
	});

	it("does not publish a done input while its native generation outcome is held by ordinary owned work", async () => {
		const f = await fixture();
		const reply = gated("answer before owner drain");
		f.faux.setResponses([reply.step]);
		try {
			await f.open(); const ack = await f.turn(); await reply.entered;
			const session = f.host.sessions.get(f.openParams.sessionId);
			if (!(session instanceof DurableProductSession)) throw new Error("Expected the native Durable adapter");
			const run = (await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT))!.run!;
			// The public native API creates an ordinary child with no installed implementation. It blocks until native cancellation.
			const parked = defineTask<Record<string, never>, { phase: "parked" }, null, Record<string, never>>({
				name: "offline.held-child", version: 1, initial: () => ({ phase: "parked" }),
				phases: { parked: async () => { throw new Error("unregistered task must never execute"); } },
				abort: async (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
			});
			const child = await session.conversation.commit(tx => tx.createTask(parked, {}, { ownership: { kind: "task", taskId: run.taskId } }), BACKGROUND_CONTEXT);
			reply.release();
			await vi.waitFor(async () => expect((await session.harness.getTask(run.taskId, BACKGROUND_CONTEXT))?.state.status).toBe("completing"));
			const native = await session.harness.submission(run.inputs[0], BACKGROUND_CONTEXT);
			expect(await native!.status(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
			expect(await f.invoke("session.settlement.get", { sessionId: f.openParams.sessionId, turnId: ack.turnId, clientMessageId: ack.clientMessageId })).toMatchObject({ settlement: undefined });
			expect(f.events.filter(event => event.payload.type === "agent_settled" && event.turnId === ack.turnId)).toEqual([]);
			await session.harness.abortTask(child, BACKGROUND_CONTEXT);
			const receipt = await f.settled(ack);
			expect(record(receipt.receipt)).toMatchObject({ disposition: "completed", pendingOperations: 0 });
			expect((await session.harness.getTask(child, BACKGROUND_CONTEXT))?.state.status).toBe("terminal");
		} finally { reply.release(); await f.close(); }
	});

	it("repairs a terminal native input whose Host receipt projection was interrupted without replaying it", async () => {
		const f = await fixture();
		const reply = gated("original pending response");
		f.faux.setResponses([reply.step]);
		try {
			await f.open(); const ack = await f.turn(); await reply.entered;
			await f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: ack.turnId, expectedClientMessageId: ack.clientMessageId });
			const session = f.host.sessions.get(f.openParams.sessionId);
			if (!(session instanceof DurableProductSession)) throw new Error("Expected the native Durable adapter");
			// Inject the committed projection shape left by a crash before Host bookkeeping; native input/tasks remain untouched.
			const projection = defineDoc<{ requests: Record<string, { generationIds: number[]; settlement?: JsonObject }> }>({
				kind: "rag-ime.durable-product", version: 1, scope: "session", initial: () => ({ requests: {} }),
			});
			await f.host.dispose();
			const native = await Harness.open(await openNodeSqliteStorage(join(f.openParams.durableStoreRef, "session.sqlite")), { models: f.modelRuntime, registry: createRegistry() }, BACKGROUND_CONTEXT);
			try {
				await native.commit(async tx => {
					for (const request of Object.values((await tx.doc(projection)).requests)) { request.generationIds = []; delete request.settlement; }
				}, BACKGROUND_CONTEXT);
			} finally { await native.close(BACKGROUND_CONTEXT); }
			const reopened = await f.createHost();
			expect(await f.open(reopened)).toMatchObject({ paused: true, recoverable: false, isIdle: true });
			expect(record((await f.settled(ack, reopened)).receipt)).toMatchObject({ disposition: "aborted", pendingOperations: 0 });
			expect(f.faux.state.callCount).toBe(1);
		} finally { reply.release(); await f.close(); }
	});

	it("withdraws only the matched run's queued input, rejects admission during drain, and preserves later inputs", async () => {
		const f = await fixture();
		const entered = deferred();
		const aborted = deferred();
		const release = deferred();
		const successor = gated("successor stays active");
		const calls: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			entered.resolve();
			init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await release.promise; // Deliberately ignores cancellation while the owned HTTP invocation cleans up.
			if (init?.signal?.aborted) throw init.signal.reason;
			return Response.json({ ok: true, result: {} });
		}));
		f.faux.setResponses([fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "slow:one" })], { stopReason: "toolUse" }), successor.step]);
		try {
			await f.open(f.host, { toolManifest: [{ name: "slow_tool", description: "Slow governed effect", parameters: { type: "object", properties: {} }, alwaysAvailable: true }] });
			const old = await f.turn("old effect", "old:effect"); await entered.promise;
			const withdrawn = await f.invoke("session.follow_up", { sessionId: f.openParams.sessionId, message: "withdraw me", clientMessageId: "old:queued" });
			await vi.waitFor(() => expect(f.events).toEqual(expect.arrayContaining([
				expect.objectContaining({ payload: expect.objectContaining({ type: "queue_update", followUp: ["withdraw me"] }) }),
			])));
			await expect(f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: "wrong", expectedClientMessageId: old.clientMessageId })).rejects.toMatchObject({ code: "ABORT_TARGET_MISMATCH" });
			const exactCancel = { sessionId: f.openParams.sessionId, expectedTurnId: old.turnId, clientMessageId: old.clientMessageId, cancelId: "cancel:old-effect" };
			const stop = f.invoke("session.abort", exactCancel);
			void stop.catch(() => undefined); // Keep the owned request observed if an assertion exits before cleanup drains.
			await vi.waitFor(() => expect(calls).toHaveLength(1));
			await Promise.race([aborted.promise, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Exact native Stop did not signal its owned HTTP task")), 3_000))]);
			expect(await f.invoke("session.abort", { ...exactCancel, lookupOnly: true })).toMatchObject({ state: "accepted", phase: "requested" });
			const duplicateStop = f.invoke("session.abort", exactCancel);
			void duplicateStop.catch(() => undefined);
			await expect(f.invoke("session.follow_up", { sessionId: f.openParams.sessionId, message: "keep this successor", clientMessageId: "new:queued" })).rejects.toMatchObject({ code: "SESSION_ABORTING", details: { clientMessageId: "new:queued" } });
			await expect(f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: old.turnId, expectedClientMessageId: old.clientMessageId })).rejects.toMatchObject({ code: "ABORT_TARGET_MISMATCH" });
			expect(record((await f.invoke("session.settlement.get", { sessionId: f.openParams.sessionId, turnId: old.turnId, clientMessageId: old.clientMessageId })).settlement)).toEqual({});
			expect(f.events.filter(event => event.payload.type === "agent_settled" && event.turnId === withdrawn.turnId)).toEqual([]);
			await vi.waitFor(() => expect(f.events).toEqual(expect.arrayContaining([
				expect.objectContaining({ payload: expect.objectContaining({ type: "queue_update", followUp: [] }) }),
			])));
			release.resolve();
			const cancelReceipt = await stop;
			expect(await duplicateStop).toEqual(cancelReceipt);
			expect(cancelReceipt).toMatchObject({ state: "accepted", phase: "settled" });
			expect(record(record(cancelReceipt.runtimeReceipt).lifecycle)).toMatchObject({ drained: true, idle: true });
			expect(record((await f.settled(withdrawn)).receipt)).toMatchObject({ disposition: "aborted" });
			expect(f.events.filter(event => event.payload.type === "agent_settled" && event.turnId === withdrawn.turnId)).toEqual([]);
			expect(record((await f.settled(old)).receipt)).toMatchObject({ disposition: "aborted" });
			expect(calls).toHaveLength(1);
			expect(record(calls[0].executionBinding)).toEqual({ turnId: old.turnId, clientMessageId: old.clientMessageId });
			const later = await f.turn("keep this successor", "new:queued");
			await successor.entered;
			expect(await f.invoke("session.abort", { ...exactCancel, lookupOnly: true })).toEqual(cancelReceipt);
			await expect(f.invoke("session.abort", { sessionId: f.openParams.sessionId, expectedTurnId: old.turnId, expectedClientMessageId: old.clientMessageId })).rejects.toMatchObject({ code: "ABORT_TARGET_MISMATCH" });
			expect(successor.signalled()).toBe(false);
			expect(record((await f.invoke("session.control_state", { sessionId: f.openParams.sessionId })).activeTurn)).toMatchObject({ turnId: later.turnId, clientMessageId: later.clientMessageId });
			successor.release(); await f.settled(later);
			await f.host.dispose();
			const reopened = await f.createHost(); await f.open(reopened);
			expect(await f.invoke("session.abort", exactCancel, reopened)).toEqual(cancelReceipt);
		} finally { release.resolve(); successor.release(); vi.unstubAllGlobals(); await f.close(); }
	});
});
