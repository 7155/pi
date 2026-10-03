import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type ConversationHandle,
	defineTask,
	defineTool,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Submission,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createBashTool } from "../src/tools/index.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, deferred, settled } from "./task-support.ts";

const harnesses = new Set<Harness>();
const environments = new Set<NodeExecutionEnv>();
const directories = new Set<string>();

afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	for (const env of environments) await env.cleanup(context);
	environments.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

/** A real faux-provider request held until release or its native invocation is signalled. */
function gated(message: AssistantMessage) {
	const reached = deferred();
	const release = deferred();
	let signal: AbortSignal | undefined;
	return {
		step: async (_request: unknown, options?: { signal?: AbortSignal }) => {
			signal = options!.signal!;
			reached.resolve();
			await Promise.race([release.promise, aborted(signal)]);
			return message;
		},
		reached: reached.promise,
		release: () => release.resolve(),
		signalled: () => signal?.aborted ?? false,
	};
}

describe("exact run abort", () => {
	it("targets the original input across a genuine tool-round generation handoff", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "finish_tool",
				description: "Finishes a tool round",
				parameters: Type.Object({}),
				execute: async () => ({ content: [] }),
			}),
		);
		const first = gated(
			fauxAssistantMessage([fauxToolCall("finish_tool", {}, { id: "c1" })], { stopReason: "toolUse" }),
		);
		const successor = gated(fauxAssistantMessage("later answer"));
		setup.faux.setResponses([first.step, successor.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.add(harness);
		const input = await root.submit({ type: "input", content: "work" }, context);
		await first.reached;
		const originalTask = (await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId;
		first.release();
		await successor.reached;
		const next = (await harness.snapshot(LiveDoc, root.id, context))!.run!;
		expect(next.taskId).not.toBe(originalTask);
		expect(next.inputs).toEqual([input.id]);
		expect((await allEntries(root)).some((entry) => entry.kind === "pi.tool-result")).toBe(true);
		expect(await root.abortRun(input.id, context)).toBe("aborted");
		expect(successor.signalled()).toBe(true);
		expect(await input.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
	});

	it("checks the input on the Session line after an earlier answer and a successor admission", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		const first = gated(fauxAssistantMessage("first answer"));
		const next = gated(fauxAssistantMessage("next answer"));
		setup.faux.setResponses([first.step, next.step]);
		const { harness, root } = await openChat(storage, setup);
		harnesses.add(harness);
		const old = await root.submit({ type: "input", content: "old" }, context);
		await first.reached;
		const held = storage.holdCommits();
		try {
			first.release();
			await held.entered;
			const admitted = root.submit({ type: "input", content: "new" }, context);
			const stop = root.abortRun(old.id, context);
			held.release();
			const input = await admitted;
			expect(await stop).toBe("not_running");
			await next.reached;
			expect(next.signalled()).toBe(false);
			expect((await input.status(context)).status).toBe("placed");
			expect((await old.status(context)).status).toBe("done");
		} finally {
			held.release();
		}
	});

	it("does not withdraw a new run's queued follow-up on a late or repeated old Stop", async () => {
		const setup = chatSetup();
		const current = gated(fauxAssistantMessage("current answer"));
		setup.faux.setResponses([fauxAssistantMessage("old answer"), current.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.add(harness);
		const old = await root.submit({ type: "input", content: "old" }, context);
		await old.wait(context);
		const input = await root.submit({ type: "input", content: "current" }, context);
		await current.reached;
		const followUp = await root.submit({ type: "input", content: "next" }, context);
		expect(await root.abortRun(old.id, context)).toBe("not_running");
		expect(await root.abortRun(old.id, context)).toBe("not_running");
		expect(current.signalled()).toBe(false);
		expect((await input.status(context)).status).toBe("placed");
		expect((await followUp.status(context)).status).toBe("queued");
	});

	it("withdraws captured follow-ups only on a match and preserves input queued during the matched drain", async () => {
		const setup = chatSetup();
		const started = deferred();
		const signalled = deferred();
		const drained = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "slow_tool",
				description: "Waits for its native cancellation and physical drain",
				parameters: Type.Object({}),
				execute: async (_args, _api, ctx) => {
					started.resolve();
					try {
						return await aborted(ctx.abortSignal!);
					} finally {
						signalled.resolve();
						await drained.promise;
					}
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.add(harness);
		try {
			const input = await root.submit({ type: "input", content: "work" }, context);
			await started.promise;
			const captured = await root.submit({ type: "input", content: "old follow-up" }, context);
			expect(await root.abortRun(99_999 as SubmissionId, context)).toBe("not_running");
			expect((await captured.status(context)).status).toBe("queued");
			const stopping = root.abortRun(input.id, context);
			await signalled.promise;
			expect(await captured.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(await settled(stopping)).toBe(false);
			const newer = await root.submit({ type: "input", content: "after Stop" }, context);
			expect(await root.abortRun(input.id, context)).toBe("not_running");
			expect((await newer.status(context)).status).toBe("queued");
			drained.resolve();
			expect(await stopping).toBe("aborted");
			expect((await newer.status(context)).status).toBe("queued");
		} finally {
			drained.resolve();
		}
	});

	it("waits only for captured work and neither aborts nor joins a later input", async () => {
		const setup = chatSetup();
		const abortStarted = deferred();
		const cleanup = deferred();
		const SlowCleanup = defineTask<null, { phase: "run" }, null>({
			name: "test.slow-cleanup",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async (_task, runtime) => aborted(runtime.signal) },
			abort: async (_task, runtime, ctx) => {
				abortStarted.resolve();
				await cleanup.promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, SlowCleanup);
		const first = gated(fauxAssistantMessage("first"));
		const next = gated(fauxAssistantMessage("next"));
		setup.faux.setResponses([first.step, next.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.add(harness);
		try {
			const input = await root.submit({ type: "input", content: "old" }, context);
			await first.reached;
			await root.commit((tx) => tx.createTask(SlowCleanup, null, { ownership: { kind: "conversation" } }), context);
			const stopping = root.abortRun(input.id, context);
			await abortStarted.promise;
			await input.wait(context);
			expect(await settled(stopping)).toBe(false);
			const later = await root.submit({ type: "input", content: "new" }, context);
			await next.reached;
			cleanup.resolve();
			expect(await stopping).toBe("aborted");
			expect(next.signalled()).toBe(false);
			expect((await later.status(context)).status).toBe("placed");
			expect(await root.abortRun(input.id, context)).toBe("not_running");
		} finally {
			cleanup.resolve();
		}
	});

	it("exposes the same operation on an invocation-bound child handle and rejects it after the call ends", async () => {
		const setup = chatSetup();
		let handle: ConversationHandle | undefined;
		let childInput: Submission | undefined;
		const child = gated(fauxAssistantMessage("child"));
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Runs and stops a child",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					const id = await api.commit(
						async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id,
						ctx,
					);
					handle = (await api.conversation(id, ctx))!;
					childInput = await handle.submit({ type: "input", content: "child" }, ctx);
					await child.reached;
					expect(await handle.abortRun(childInput.id, ctx)).toBe("aborted");
					return { content: [] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			child.step,
			fauxAssistantMessage("parent"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.add(harness);
		expect((await (await root.submit({ type: "input", content: "delegate" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(child.signalled()).toBe(true);
		await expect(handle!.abortRun(childInput!.id, context)).rejects.toThrow("invocation has ended");
	});

	it("cancels and physically drains a native bash call for the exact input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-abort-run-"));
		directories.add(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		environments.add(env);
		const setup = chatSetup();
		addTool(setup.registry, createBashTool());
		setup.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "printf 'pid:%s\\n' \"$$\"; while :; do sleep 1; done" }, { id: "c1" })],
				{ stopReason: "toolUse" },
			),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
		harnesses.add(harness);
		const input = await root.submit({ type: "input", content: "run local command" }, context);
		let pid: number | undefined;
		await waitFor(async () => {
			const output = (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.output ?? "";
			const match = /pid:(\d+)/u.exec(output);
			pid = match === null ? undefined : Number(match[1]);
			return pid !== undefined;
		});
		process.kill(pid!, 0);
		expect(await root.abortRun(input.id, context)).toBe("aborted");
		expect(() => process.kill(pid!, 0)).toThrow();
		expect(await input.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const result = (await allEntries(root)).find((entry) => entry.kind === "pi.tool-result");
		expect(result?.model?.[0]).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
	});
});
