import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowControlExtension } from "../src/workflow-control.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

interface RegisteredExtension {
	handlers: Map<string, Handler>;
	sendUserMessage: ReturnType<typeof vi.fn>;
}

function fetchCall(mock: ReturnType<typeof vi.fn>, index: number): unknown[] {
	return mock.mock.calls[index] ?? [];
}

function fetchBody(mock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
	const init = fetchCall(mock, index)[1] as { body?: unknown } | undefined;
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function jsonResponse(result: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function register(
	options: Parameters<typeof createWorkflowControlExtension>[0],
): RegisteredExtension {
	const handlers = new Map<string, Handler>();
	const sendUserMessage = vi.fn();
	createWorkflowControlExtension(options)({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		sendUserMessage,
	} as never);
	return { handlers, sendUserMessage };
}

function activeGoal(goalId = "goal:1"): Record<string, unknown> {
	return {
		plan: {
			status: "approved",
			title: "完成 Agent 工作流",
			items: [
				{ text: "实现后端契约", status: "completed" },
				{ text: "完成前端验收", status: "in_progress" },
			],
		},
		goal: {
			configured: true,
			status: "active",
			goalId,
			objective: "把插件工作流交付到正式 App",
			remaining: { tokens: 18_000, timeMs: 1_800_000 },
		},
		actGate: { allowed: true },
	};
}

function agentEnd(stopReason = "stop", totalTokens = 30): Record<string, unknown> {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				stopReason,
				content: [{ type: "text", text: "progress" }],
				usage: { totalTokens },
			},
		],
	};
}

async function finishTool(
	handlers: Map<string, Handler>,
	input: { toolCallId: string; args: unknown; result: unknown; isError?: boolean },
): Promise<void> {
	await handlers.get("tool_execution_start")?.({
		type: "tool_execution_start",
		toolCallId: input.toolCallId,
		toolName: "read",
		args: input.args,
	});
	await handlers.get("tool_execution_end")?.({
		type: "tool_execution_end",
		toolCallId: input.toolCallId,
		toolName: "read",
		result: input.result,
		isError: input.isError ?? false,
	});
}

const bridge = {
	sessionId: "agent:workflow",
	registry: {} as never,
	gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
};

describe("workflow control on native Pi 0.84 lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("is inert and strips stale workflow context while its Package capability is disabled", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(activeGoal()));
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge, isEnabled: () => false });

		const result = (await handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "继续",
			systemPrompt: "base\n<workflow-state>stale</workflow-state>",
		})) as { systemPrompt?: string };
		await finishTool(handlers, { toolCallId: "disabled", args: { path: "a" }, result: { ok: true } });
		await handlers.get("agent_end")?.(agentEnd());

		expect(result.systemPrompt).toBe("base");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("injects approved workflow state without changing the user prompt", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(activeGoal()));
		vi.stubGlobal("fetch", fetchMock);
		const { handlers } = register({ bridge });

		const result = (await handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "继续",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };

		expect(result.systemPrompt).toContain("<workflow-state>");
		expect(result.systemPrompt).toContain("完成 Agent 工作流");
		expect(result.systemPrompt).toContain("计划：1/2 项完成");
		expect(result.systemPrompt).toContain("正在执行：完成前端验收");
		expect(result.systemPrompt).not.toContain("实现后端契约");
		expect(fetchCall(fetchMock, 0)[0]).toBe(
			"http://127.0.0.1:8766/api/agent/tool/workflow-state",
		);
		expect(fetchBody(fetchMock, 0)).toEqual({ sessionId: "agent:workflow" });
	});

	it("reports usage and queues one native Pi follow-up from agent_end", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith("/goal-settle")) {
				return jsonResponse({
					state: "continue",
					goalId: "goal:1",
					followUpKey: "goal:1:attempt:1",
					message: "<managed-goal-follow-up>继续完成验收</managed-goal-follow-up>",
				});
			}
			return jsonResponse(activeGoal());
		});
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge });

		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		await handlers.get("agent_end")?.(agentEnd("stop", 50));

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchCall(fetchMock, 1)[0]).toContain("/goal-usage");
		expect(fetchBody(fetchMock, 1)).toMatchObject({ tokenDelta: 50 });
		expect(fetchBody(fetchMock, 1).turnId).toMatch(/^turn:[0-9a-f-]{36}$/u);
		expect(fetchCall(fetchMock, 2)[0]).toContain("/goal-settle");
		expect(fetchBody(fetchMock, 2)).toMatchObject({
			schemaVersion: "rag-ime.agent-goal-settle-request.v1",
			settleAttempt: 1,
			freshToolEvidenceCount: 0,
			freshToolEvidenceSha256: createHash("sha256").update("").digest("hex"),
		});
		expect(sendUserMessage).toHaveBeenCalledWith(
			"<managed-goal-follow-up>继续完成验收</managed-goal-follow-up>",
			{ deliverAs: "followUp", expandPromptTemplates: false },
		);
	});

	it("reports each native agent_end with a stable turn and increasing sequence", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith("/goal-settle")) return jsonResponse(activeGoal());
			const body = JSON.parse(String(init?.body)) as { settleAttempt: number };
			return jsonResponse({
				state: "continue",
				goalId: "goal:1",
				followUpKey: `sequence:${body.settleAttempt}`,
				message: "continue",
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { handlers } = register({ bridge });

		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		await handlers.get("agent_end")?.(agentEnd("stop", 20));
		const first = fetchBody(fetchMock, 1);
		await handlers.get("agent_end")?.(agentEnd("stop", 30));
		const second = fetchBody(fetchMock, 3);

		expect(first.turnId).toBe(second.turnId);
		expect(first.eventId).toBe(`agent-end:${String(first.turnId)}:1`);
		expect(second.eventId).toBe(`agent-end:${String(first.turnId)}:2`);
		expect(second.tokenDelta).toBe(30);
	});

	it("retains a failed goal usage report and retries the same idempotency key", async () => {
		let usageAttempts = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith("/goal-usage")) {
				usageAttempts += 1;
				if (usageAttempts === 1) throw new Error("gateway unavailable");
			}
			return jsonResponse(activeGoal());
		});
		vi.stubGlobal("fetch", fetchMock);
		const { handlers } = register({ bridge, hasActiveRoom: () => true });

		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "first" });
		await handlers.get("agent_end")?.(agentEnd("stop", 21));
		const failed = fetchBody(fetchMock, 1);
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "second" });
		const retried = fetchBody(fetchMock, 3);

		expect(usageAttempts).toBe(2);
		expect(retried.idempotencyKey).toBe(failed.idempotencyKey);
		expect(retried.eventId).toBe(failed.eventId);
		expect(retried.turnId).toBe(failed.turnId);
	});

	it("only treats new successful tool results as fresh continuation evidence", async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url.endsWith("/goal-settle")
				? jsonResponse({
						state: "continue",
						goalId: "goal:1",
						followUpKey: `key:${fetchMock.mock.calls.length}`,
						message: "continue",
					})
				: jsonResponse(activeGoal()),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { handlers } = register({ bridge });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });

		await finishTool(handlers, { toolCallId: "call:1", args: { path: "a" }, result: { ok: true } });
		await handlers.get("agent_end")?.(agentEnd());
		expect(fetchBody(fetchMock, 2).freshToolEvidenceCount).toBe(1);

		await finishTool(handlers, { toolCallId: "call:2", args: { path: "a" }, result: { ok: true } });
		await handlers.get("agent_end")?.(agentEnd());
		expect(fetchBody(fetchMock, 4).freshToolEvidenceCount).toBe(0);

		await finishTool(handlers, {
			toolCallId: "call:3",
			args: { path: "b" },
			result: { ok: false },
			isError: true,
		});
		await handlers.get("agent_end")?.(agentEnd());
		expect(fetchBody(fetchMock, 6).freshToolEvidenceCount).toBe(0);
	});

	it("caps managed continuation at four queued follow-ups", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith("/goal-settle")) return jsonResponse(activeGoal());
			const body = JSON.parse(String(init?.body)) as { settleAttempt: number };
			return jsonResponse({
				state: "continue",
				goalId: "goal:1",
				followUpKey: `goal:1:${body.settleAttempt}`,
				message: `continue:${body.settleAttempt}`,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await handlers.get("agent_end")?.(agentEnd());
		}

		expect(sendUserMessage).toHaveBeenCalledTimes(4);
		expect(fetchBody(fetchMock, 10).settleAttempt).toBe(5);
	});

	it("bounds a stalled goal-settle gateway at eight seconds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith("/goal-settle")) return jsonResponse(activeGoal());
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { handlers } = register({ bridge });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });

		const settlement = Promise.resolve(handlers.get("agent_end")?.(agentEnd()));
		const rejection = expect(settlement).rejects.toThrow("Goal settle gateway timed out after 8000ms");
		await vi.advanceTimersByTimeAsync(8_001);
		await rejection;
	});

	it.each(["error", "aborted"])("does not continue after %s terminal output", async (stopReason) => {
		const fetchMock = vi.fn(async () => jsonResponse(activeGoal()));
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		await handlers.get("agent_end")?.(agentEnd(stopReason));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("lets an active Room own continuation instead of queueing a Goal follow-up", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(activeGoal()));
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge, hasActiveRoom: () => true });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		await handlers.get("agent_end")?.(agentEnd());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not register Goal usage or continuation when no Goal is active", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ plan: {}, goal: { configured: false }, actGate: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { handlers, sendUserMessage } = register({ bridge });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		await handlers.get("agent_end")?.(agentEnd());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("reports a newly completed project once", async () => {
		let completed = false;
		const fetchMock = vi.fn(async () =>
			jsonResponse(
				completed
					? { plan: { status: "completed", id: "plan:1" }, goal: { configured: false }, actGate: {} }
					: activeGoal(),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onProjectComplete = vi.fn(async () => undefined);
		const { handlers } = register({ bridge, onProjectComplete });
		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "继续" });
		completed = true;
		await handlers.get("agent_end")?.(agentEnd());

		expect(onProjectComplete).toHaveBeenCalledOnce();
		expect(onProjectComplete).toHaveBeenCalledWith(
			expect.objectContaining({ completionKey: "plan:plan:1" }),
		);
	});
});
