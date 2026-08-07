import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function createWaitTool(released: Promise<void>): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait until released",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

describe("regression #6363: agent settled event and idle waiting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits one agent_settled event after automatic retry finishes", async () => {
		const extensionEvents: string[] = [];
		const publicEvents: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						extensionEvents.push("agent_end");
					});
					pi.on("agent_settled", (_event, ctx) => {
						extensionEvents.push(`agent_settled:${ctx.isIdle()}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				publicEvents.push("agent_settled");
			}
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")[0]?.receipt).toMatchObject({
			aborted: false,
			pendingOperations: 0,
			operationCounts: { provider: 1, retry_sleep: 1 },
		});
		expect(extensionEvents).toEqual(["agent_end", "agent_end", "agent_settled:true"]);
		expect(publicEvents).toEqual(["agent_settled"]);
	});

	it("cancels an in-flight retry delay through the total run scope", async () => {
		let markRetryStarted = () => {};
		const retryStarted = new Promise<void>((resolve) => {
			markRetryStarted = resolve;
		});
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 } },
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") markRetryStarted();
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const prompt = harness.session.prompt("test");
		await retryStarted;
		const [abortReceipt] = await Promise.all([harness.session.abort(), prompt]);

		expect(abortReceipt).toMatchObject({
			schemaVersion: "pi.agent-abort-receipt.v1",
			cancelledOperationIds: expect.arrayContaining(["provider", "retry-sleep"]),
			failedOperationIds: [],
			pendingOperations: [],
			drained: true,
			idle: true,
		});
		expect(abortReceipt.operations.map((operation) => operation.kind)).toEqual(
			expect.arrayContaining(["provider", "retry_sleep"]),
		);
		expect(harness.eventsOfType("agent_settled")[0]?.receipt).toMatchObject({
			aborted: true,
			pendingOperations: 0,
			operationCounts: { provider: 1, retry_sleep: 1 },
		});
	});

	it("settles only after follow-ups queued by agent_end handlers run", async () => {
		let queuedFollowUp = false;
		const settledIdleStates: boolean[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (queuedFollowUp) return;
						queuedFollowUp = true;
						pi.sendUserMessage("status follow-up", { deliverAs: "followUp" });
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledIdleStates.push(ctx.isIdle());
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");

		expect(getUserTexts(harness)).toEqual(["hello", "status follow-up"]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(settledIdleStates).toEqual([true]);
		expect(harness.eventsOfType("agent_settled")[0]?.receipt).toMatchObject({
			aborted: false,
			pendingOperations: 0,
			operationCounts: { provider: 1 },
		});
	});

	it("runs one governed before-settle follow-up before exposing the settled event", async () => {
		let attempt = 0;
		const phases: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_settle", (event) => {
						phases.push(`before:${event.message.stopReason}:${event.settleAttempt}`);
						attempt += 1;
						if (attempt > 1) return;
						return {
							followUp: {
								text: "请在收工前补齐结构化责任提交",
								continuation: {
									correlationId: "room-root-1",
									idempotencyKey: "settle-remedial-1",
									maxAttempts: 2,
								},
							},
						};
					});
					pi.on("agent_settled", () => {
						phases.push("settled");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("初步完成"), fauxAssistantMessage("已经提交")]);

		await harness.session.prompt("完成 Room 工作项");

		expect(getUserTexts(harness)).toEqual(["完成 Room 工作项", "请在收工前补齐结构化责任提交"]);
		expect(phases).toEqual(["before:stop:1", "before:stop:2", "settled"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("keeps one run identity across a suspended delayed continuation", async () => {
		let scheduled = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_settle", () => {
						if (scheduled) return;
						scheduled = true;
						return {
							followUp: {
								text: "delayed continuation",
								continuation: {
									id: "delayed-continuation",
									idempotencyKey: "delayed-continuation",
									notBefore: Date.now() + 20,
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("start");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")[0]?.receipt.disposition).toBe("suspended");
		await harness.session.waitForIdle();

		const receipts = harness.eventsOfType("agent_settled").map((event) => event.receipt);
		expect(receipts).toHaveLength(2);
		expect(receipts.map((receipt) => receipt.disposition)).toEqual(["suspended", "completed"]);
		expect(receipts[1]?.runId).toBe(receipts[0]?.runId);
		expect(receipts[1]?.scopeId).not.toBe(receipts[0]?.scopeId);
	});

	it("does not expose a false settled event when the settlement owner fails", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_settle", () => {
						throw new Error("settlement unavailable");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("finished locally")]);

		await expect(harness.session.prompt("finish governed work")).rejects.toThrow("settlement unavailable");

		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settle_failed")).toEqual([
			expect.objectContaining({
				type: "agent_settle_failed",
				error: "settlement unavailable",
				receipt: expect.objectContaining({ pendingOperations: 0 }),
			}),
		]);
	});

	it("lists, selectively cancels, and wakes delayed structured continuations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("start");

		await harness.session.followUp("duplicate text", undefined, {
			id: "by-id",
			correlationId: "correlation-a",
			idempotencyKey: "by-id",
			notBefore: Date.now() + 10_000,
		});
		await harness.session.followUp("duplicate text", undefined, {
			id: "by-correlation",
			correlationId: "correlation-b",
			idempotencyKey: "by-correlation",
			notBefore: Date.now() + 10_000,
		});
		expect(harness.session.cancelContinuation({ id: "by-id" }).cancelledIds).toEqual(["by-id"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["duplicate text"]);
		expect(harness.session.cancelContinuation({ correlationId: "correlation-b" }).cancelledIds).toEqual([
			"by-correlation",
		]);
		await harness.session.followUp("cancel by generation", undefined, {
			id: "by-generation",
			idempotencyKey: "by-generation",
			cancelGeneration: 0,
			notBefore: Date.now() + 10_000,
		});
		expect(harness.session.cancelContinuation({ generation: 0 }).cancelledIds).toEqual(["by-generation"]);

		await harness.session.followUp("timer delivery", undefined, {
			id: "timer",
			idempotencyKey: "timer",
			notBefore: Date.now() + 20,
		});
		expect(harness.session.listContinuations().find((item) => item.id === "timer")?.state).toBe("pending");
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "timer delivery"]);
		expect(harness.session.listContinuations()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "by-id", state: "cancelled" }),
				expect.objectContaining({ id: "by-correlation", state: "cancelled" }),
				expect.objectContaining({ id: "by-generation", state: "cancelled" }),
				expect.objectContaining({ id: "timer", state: "completed", attempt: 1, cancelGeneration: 1 }),
			]),
		);
	});

	it("global abort cancels a delayed continuation before its timer fires", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		await harness.session.followUp("must not run", undefined, {
			id: "delayed-abort",
			idempotencyKey: "delayed-abort",
			notBefore: Date.now() + 10_000,
		});

		await harness.session.abort();

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.listContinuations()).toContainEqual(
			expect.objectContaining({ id: "delayed-abort", state: "cancelled", terminalReason: "user_abort" }),
		);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("extension command waitForIdle waits for session-level settlement", async () => {
		let releaseTool = () => {};
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let markCommandStarted = () => {};
		const commandStarted = new Promise<void>((resolve) => {
			markCommandStarted = resolve;
		});
		const commandResults: boolean[] = [];
		const harness = await createHarness({
			tools: [createWaitTool(released)],
			extensionFactories: [
				(pi) => {
					pi.registerCommand("after-idle", {
						description: "Wait for idle",
						handler: async (_args, ctx) => {
							markCommandStarted();
							await ctx.waitForIdle();
							commandResults.push(ctx.isIdle());
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		const commandPromise = harness.session.prompt("/after-idle");
		await commandStarted;
		let commandFinished = false;
		void commandPromise.then(() => {
			commandFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(commandFinished).toBe(false);

		releaseTool();
		await Promise.all([promptPromise, commandPromise]);

		expect(commandResults).toEqual([true]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("propagates abort through the run scope and reports drained tool operations", async () => {
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const abortableTool: AgentTool = {
			name: "abortable",
			label: "Abortable",
			description: "Wait for cancellation",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				markStarted();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [abortableTool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("abortable", {}), { stopReason: "toolUse" })]);

		const prompt = harness.session.prompt("start");
		await started;
		const abortReceipt = await harness.session.abort();
		await prompt;

		expect(abortReceipt).toMatchObject({
			schemaVersion: "pi.agent-abort-receipt.v1",
			reason: "user_abort",
			cancelledOperationIds: expect.arrayContaining(["provider", expect.stringMatching(/^tool:/)]),
			failedOperationIds: [],
			pendingOperations: [],
			drained: true,
			idle: true,
		});
		expect(abortReceipt.operations.map((operation) => operation.kind)).toEqual(
			expect.arrayContaining(["provider", "tool"]),
		);
		expect(harness.eventsOfType("agent_settled")[0]?.receipt).toMatchObject({
			aborted: true,
			generation: 1,
			pendingOperations: 0,
			operationCounts: { provider: 1, tool: 1 },
		});
	});
});
