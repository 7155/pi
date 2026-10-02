import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiProductSession, type PiSessionOpenOptions } from "../src/pi-session.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => { resolve = accept; });
	return { promise, resolve };
}

type Barrier = { entered(): void; release: Promise<void> };
const testGlobal = globalThis as typeof globalThis & { hostPreflightBarrier?: Barrier; hostCommandTailBarrier?: Barrier;
	hostNestedBarrier?: { outer: Barrier; inner: Barrier } };

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-host-preflight-"));
	const plugins = join(root, "plugins");
	await mkdir(plugins, { recursive: true });
	await writeFile(join(plugins, "barrier.mjs"), `export default function(pi) {
		pi.on('before_agent_start', async event => {
			const nested = globalThis.hostNestedBarrier;
			if (nested && event.prompt === 'outer-with-inner') {
				pi.sendUserMessage('inner-held');
				nested.outer.entered(); await nested.outer.release;
			} else if (nested && event.prompt === 'inner-held') {
				nested.inner.entered(); await nested.inner.release;
			}
			const barrier = globalThis.hostPreflightBarrier;
			if (barrier) { barrier.entered(); await barrier.release; }
		});
		pi.on('input', event => event.text === 'handled-no-run' ? { action: 'handled' } : { action: 'continue' });
		pi.registerCommand('write-local', { description: 'Write once', handler: async (_args, ctx) => {
			const fs = await import('node:fs/promises');
			await fs.appendFile(ctx.cwd + '/effects.txt', 'written\\n');
		}});
		pi.registerCommand('run-local', { description: 'Run the local provider', handler: async () => {
			const done = new Promise(resolve => {
				const unsubscribe = pi.on('agent_settled', () => { unsubscribe(); resolve(); });
			});
			pi.sendUserMessage('nested command run');
			await done;
			const tail = globalThis.hostCommandTailBarrier;
			if (tail) { tail.entered(); await tail.release; }
		}});
		pi.registerCommand('queue-and-return', { description: 'Start a nested prompt', handler: () => {
			pi.sendUserMessage('nested barrier task');
		}});
	}`);
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
	const faux = createFauxCore({ api: "faux:host-preflight", provider: "host-preflight", models: [{ id: "local" }] });
	const model = faux.getModel();
	let calls = 0;
	faux.setResponses([() => { calls++; return fauxAssistantMessage("local reply"); }]);
	modelRuntime.registerProvider("host-preflight", {
		name: "local-only test", baseUrl: "http://localhost.invalid", api: model.api,
		apiKey: "test-only", streamSimple: faux.streamSimple,
		models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
			input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
	});
	const events: Record<string, unknown>[] = [];
	const options: PiSessionOpenOptions = {
		externalSessionId: "host-preflight", cwd: root, agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"), activePluginDir: plugins,
		skillPaths: [], piSkillPaths: [], codexSkillPaths: [], modelRuntime,
		provider: "host-preflight", modelId: "local", codemodeMode: "off", toolManifest: [],
		noContextFiles: true, emitEvent: event => events.push(event as unknown as Record<string, unknown>),
	};
	const session = await PiProductSession.create(options);
	return { session, events, root, calls: () => calls, reopen: (sessionFile: string) => PiProductSession.create({ ...options, sessionFile }),
		close: async () => { await session.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("public Host prompt preflight", () => {
	it("does not settle a rejected outer preflight while its cancelled nested preflight is still pending", async () => {
		const outerEntered = deferred();
		const innerEntered = deferred();
		const outerRelease = deferred();
		const innerRelease = deferred();
		testGlobal.hostNestedBarrier = { outer: { entered: outerEntered.resolve, release: outerRelease.promise },
			inner: { entered: innerEntered.resolve, release: innerRelease.promise } };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		try {
			prompt = f.session.prompt({ message: "outer-with-inner", clientMessageId: "nested-stop" });
			const result = prompt.catch(error => error);
			await Promise.all([outerEntered.promise, innerEntered.promise]);
			const turn = f.session.controlState().activeTurn as { turnId: string };
			await f.session.abort({ clientMessageId: "nested-stop" });
			outerRelease.resolve();
			await setImmediate();
			expect(f.session.controlState()).toMatchObject({ isIdle: false, activeTurn: { turnId: turn.turnId } });
			expect(f.session.settlement(turn.turnId)).toBeUndefined();
			expect(f.events.filter(event => (event.payload as { type?: string }).type === "agent_settled")).toEqual([]);
			innerRelease.resolve();
			expect(await result).toMatchObject({ code: "PROMPT_ADMISSION_CANCELLED" });
			expect(f.session.settlement(turn.turnId)?.receipt).toMatchObject({ disposition: "aborted", pendingOperations: 0 });
			expect(f.calls()).toBe(0);
		} finally {
			outerRelease.resolve(); innerRelease.resolve(); await prompt?.catch(() => undefined);
			delete testGlobal.hostNestedBarrier; await f.close();
		}
	});
	it.each([false, true])("holds a command's fire-and-forget native preflight until it exits (Stop=%s)", async stop => {
		const entered = deferred();
		const release = deferred();
		testGlobal.hostPreflightBarrier = { entered: entered.resolve, release: release.promise };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		try {
			let acked = false;
			prompt = f.session.prompt({ message: "/queue-and-return", clientMessageId: "nested-client" }).then(ack => { acked = true; return ack; });
			await entered.promise;
			await setImmediate();
			expect(acked).toBe(false);
			expect(f.session.controlState()).toMatchObject({ isIdle: false, activeTurn: { clientMessageId: "nested-client" } });
			expect(f.calls()).toBe(0);
			if (stop) {
				const receipt = await f.session.abort({ clientMessageId: "nested-client" });
				expect(receipt.lifecycle).toMatchObject({ drained: false, pendingOperations: [expect.objectContaining({ kind: "prompt_preflight" })] });
			}
			release.resolve();
			const ack = await prompt as { turnId: string; disposition: string };
			expect(ack.disposition).toBe("handled");
			expect(f.calls()).toBe(stop ? 0 : 1);
			expect(f.session.settlement(ack.turnId)?.receipt).toMatchObject({ disposition: stop ? "aborted" : "completed",
				stopReason: stop ? "prompt_preflight_cancelled" : "stop" });
			expect(f.session.isIdle).toBe(true);
		} finally {
			release.resolve(); await prompt?.catch(() => undefined);
			delete testGlobal.hostPreflightBarrier; await f.close();
		}
	});
	it("publishes one terminal only after a handled command's real run and handler tail both exit", async () => {
		const entered = deferred();
		const release = deferred();
		testGlobal.hostCommandTailBarrier = { entered: entered.resolve, release: release.promise };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		try {
			prompt = f.session.prompt({ message: "/run-local", clientMessageId: "tail-command" });
			await entered.promise;
			await setImmediate();
			expect(f.calls()).toBe(1);
			expect(f.session.controlState()).toMatchObject({ isIdle: false, activeTurn: { clientMessageId: "tail-command" } });
			const terminals = () => f.events.filter(event => (event.payload as { type?: string }).type === "agent_settled");
			expect(terminals()).toEqual([]);
			release.resolve();
			const ack = await prompt as { turnId: string };
			expect(terminals()).toEqual([expect.objectContaining({ turnId: ack.turnId,
				payload: expect.objectContaining({ receipt: expect.objectContaining({ disposition: "completed", finalMessage: expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "local reply" }] }) }) }) })]);
			expect(f.session.isIdle).toBe(true);
		} finally {
			release.resolve(); await prompt?.catch(() => undefined);
			delete testGlobal.hostCommandTailBarrier; await f.close();
		}
	});
	it("holds a cancelled preflight until it exits and never enters the provider after Stop", async () => {
		const entered = deferred();
		const release = deferred();
		testGlobal.hostPreflightBarrier = { entered: entered.resolve, release: release.promise };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		try {
			prompt = f.session.prompt({ message: "barrier task", clientMessageId: "exact-client" });
			const result = prompt.then(value => ({ value }), error => ({ error }));
			await entered.promise;
			const before = f.session.controlState();
			const receipt = await f.session.abort({ clientMessageId: "exact-client" });
			expect(before.isIdle).toBe(false);
			expect(receipt.lifecycle).toMatchObject({ drained: false, idle: false,
				pendingOperations: [expect.objectContaining({ kind: "prompt_preflight" })] });
			expect(f.session.controlState().activeTurn).toEqual(before.activeTurn);
			await expect(f.session.prompt({ message: "replacement" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			await expect(f.session.dispatchRoom({ message: "replacement Room", dispatchId: "new-dispatch", rootId: "new-root",
				generation: 0, capabilityEpoch: 1, dispatchAttempt: 0, roomContext: "new context" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
			release.resolve();
			expect(await result).toMatchObject({ error: { code: "PROMPT_ADMISSION_CANCELLED" } });
			const turn = before.activeTurn as { turnId: string };
			await expect(f.session.awaitSettled(turn.turnId, { expectedClientMessageId: "exact-client" })).resolves.toMatchObject({
				receipt: { disposition: "aborted", stopReason: "prompt_preflight_cancelled", pendingOperations: 0 },
			});
			expect(f.calls()).toBe(0);
			expect(f.session.controlState()).toMatchObject({ isIdle: true, activeTurn: undefined });
		} finally {
			release.resolve();
			await prompt?.catch(() => undefined);
			delete testGlobal.hostPreflightBarrier;
			await f.close();
		}
	});

	it("preserves an extension command's actual Agent result instead of declaring a no-run settlement", async () => {
		const f = await fixture();
		try {
			const ack = await f.session.prompt({ message: "/run-local", clientMessageId: "run-command" });
			expect(ack.disposition).toBe("handled");
			expect(ack.settlement?.receipt).toMatchObject({ disposition: "completed", stopReason: "stop",
				finalMessage: { role: "assistant", content: [{ type: "text", text: "local reply" }] } });
			expect(f.calls()).toBe(1);
			expect(f.session.isIdle).toBe(true);
		} finally { await f.close(); }
	});

	it("waits for a preflight to exit during disposal and prevents later admission", async () => {
		const entered = deferred();
		const release = deferred();
		testGlobal.hostPreflightBarrier = { entered: entered.resolve, release: release.promise };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		let disposal: Promise<void> | undefined;
		try {
			prompt = f.session.prompt({ message: "dispose pending", clientMessageId: "dispose-client" });
			const result = prompt.catch(error => error);
			await entered.promise;
			let disposed = false;
			disposal = f.session.dispose().then(() => { disposed = true; });
			await Promise.resolve();
			expect(disposed).toBe(false);
			release.resolve();
			expect(await result).toMatchObject({ code: "PROMPT_ADMISSION_CANCELLED" });
			await disposal;
			expect(f.calls()).toBe(0);
			await expect(f.session.prompt({ message: "after disposal" })).rejects.toMatchObject({ code: "SESSION_BUSY" });
		} finally {
			release.resolve(); await prompt?.catch(() => undefined); await disposal;
			delete testGlobal.hostPreflightBarrier; await f.close();
		}
	});

	it("returns a durable handled settlement and permits the next real prompt", async () => {
		const f = await fixture();
		let reopened: PiProductSession | undefined;
		try {
			const ack = await f.session.prompt({ message: "handled-no-run", clientMessageId: "handled-client" });
			expect(ack).toMatchObject({ disposition: "handled", settlement: {
				turnId: ack.turnId, clientMessageId: "handled-client",
				receipt: { origin: "prompt_preflight", disposition: "completed", stopReason: "prompt_handled", pendingOperations: 0 },
			} });
			expect(ack.settlement?.receipt.finalMessage).toBeUndefined();
			expect(f.calls()).toBe(0);
			expect(f.session.controlState()).toMatchObject({ isIdle: true, activeTurn: undefined });
			expect(f.events).toContainEqual(expect.objectContaining({ turnId: ack.turnId, clientMessageId: "handled-client",
				payload: expect.objectContaining({ type: "agent_settled", receipt: expect.objectContaining({ stopReason: "prompt_handled" }) }) }));
			const file = f.session.snapshot().sessionFile as string;
			await f.session.dispose();
			reopened = await f.reopen(file);
			expect(reopened.settlement(ack.turnId, "handled-client")).toEqual(ack.settlement);
			expect(reopened.controlState().activeTurn).toBeUndefined();
			const next = await reopened.prompt({ message: "next", clientMessageId: "next-client" });
			await reopened.awaitSettled(next.turnId);
			expect(next.disposition).toBe("started");
			expect(f.calls()).toBe(1);
		} finally { await reopened?.dispose(); await f.close(); }
	});

	it("preserves a handled extension command's real local effect without starting a provider", async () => {
		const f = await fixture();
		try {
			const ack = await f.session.prompt({ message: "/write-local", clientMessageId: "command-client" });
			expect(ack.disposition).toBe("handled");
			expect(await readFile(join(f.root, "effects.txt"), "utf8")).toBe("written\n");
			expect(ack.settlement?.receipt.stopReason).toBe("prompt_handled");
			expect(f.calls()).toBe(0);
			expect(f.session.isIdle).toBe(true);
		} finally { await f.close(); }
	});

	it("settles an exact cancellation only after its preflight exits and cannot cancel a newer turn", async () => {
		const entered = deferred();
		const release = deferred();
		testGlobal.hostPreflightBarrier = { entered: entered.resolve, release: release.promise };
		const f = await fixture();
		let prompt: Promise<unknown> | undefined;
		try {
			prompt = f.session.prompt({ message: "old", clientMessageId: "old-client" });
			const result = prompt.catch(error => error);
			await entered.promise;
			const turn = f.session.controlState().activeTurn as { turnId: string };
			const cancel = { turnId: turn.turnId, clientMessageId: "old-client", cancelId: "exact-cancel" };
			expect(f.session.abortExact(cancel)).toMatchObject({ state: "accepted", phase: "requested" });
			await expect.poll(() => f.session.abortExact({ ...cancel, lookupOnly: true })).toMatchObject({
				phase: "requested", runtimeReceipt: { lifecycle: { drained: false } },
			});
			release.resolve();
			expect(await result).toMatchObject({ code: "PROMPT_ADMISSION_CANCELLED" });
			await expect.poll(() => f.session.abortExact({ ...cancel, lookupOnly: true })).toMatchObject({
				phase: "settled", runtimeReceipt: { lifecycle: { drained: true, pendingOperations: [] } },
			});
			const newEntered = deferred();
			const newRelease = deferred();
			testGlobal.hostPreflightBarrier = { entered: newEntered.resolve, release: newRelease.promise };
			prompt = f.session.prompt({ message: "new", clientMessageId: "new-client" });
			await newEntered.promise;
			try {
				const newTurn = f.session.controlState().activeTurn;
				expect(f.session.abortExact(cancel)).toMatchObject({ phase: "settled" });
				expect(() => f.session.abort({ clientMessageId: "old-client", turnId: turn.turnId })).toThrow("Requested Stop target is no longer active");
				expect(f.session.controlState().activeTurn).toEqual(newTurn);
			} finally { newRelease.resolve(); }
			const ack = await prompt as { turnId: string };
			await f.session.awaitSettled(ack.turnId);
			expect(f.calls()).toBe(1);
		} finally {
			release.resolve(); await prompt?.catch(() => undefined);
			delete testGlobal.hostPreflightBarrier; await f.close();
		}
	});
});
