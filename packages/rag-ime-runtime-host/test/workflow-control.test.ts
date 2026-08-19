import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowControlExtension } from "../src/workflow-control.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

function fetchCall(mock: unknown, index: number): unknown[] {
	return (mock as { mock: { calls: unknown[][] } }).mock.calls[index] ?? [];
}

function fetchBody(mock: unknown, index: number): Record<string, unknown> {
	const init = fetchCall(mock, index)[1] as { body?: unknown } | undefined;
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function register(extension: ReturnType<typeof createWorkflowControlExtension>): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	extension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as never);
	return handlers;
}

describe("workflow control", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("injects the approved plan and thread goal without changing the user prompt", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: {
						status: "approved",
						title: "完成 Agent 工作流",
						actApproved: true,
						items: [
							{ text: "实现后端契约", status: "completed" },
							{ text: "完成前端验收", status: "in_progress" },
						],
					},
					goal: {
						configured: true,
						status: "active",
						objective: "把六项能力交付到正式 App",
						remaining: { tokens: 18_000, timeMs: 1_800_000 },
					},
					actGate: { allowed: true },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:workflow",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					gatewayToken: "token",
				},
				now: () => new Date("2026-07-19T02:00:00.000Z"),
			}),
		);

		const result = (await handlers.get("before_agent_start")?.({
			prompt: "继续",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };
		expect(result.systemPrompt).toContain('type="workflow_control"');
		expect(result.systemPrompt).toContain("完成 Agent 工作流");
		expect(result.systemPrompt).toContain("把六项能力交付到正式 App");
		expect(result.systemPrompt).toContain("[x] 实现后端契约");
		expect(result.systemPrompt).toContain("[>] 完成前端验收");
		expect(fetchCall(fetchMock, 0)[0]).toBe("http://127.0.0.1:8766/api/agent/tool/workflow-state");
		const body = fetchBody(fetchMock, 0);
		expect(body.sessionId).toBe("agent:workflow");
		expect(body).not.toHaveProperty("prompt");
	});

	it("reports per-turn usage without failing the completed response", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: {},
					goal: { configured: true, status: "active" },
					actGate: { allowed: true },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:usage",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);

		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });
		await handlers.get("agent_end")?.({
			messages: [
				{
					role: "assistant",
					usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 0 },
				},
			],
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchCall(fetchMock, 1)[0]).toBe("http://127.0.0.1:8766/api/agent/tool/goal-usage");
		const body = fetchBody(fetchMock, 1);
		expect(body.tokenDelta).toBe(200);
		expect(body.elapsedDeltaMs).toBeGreaterThanOrEqual(0);
		expect(body.turnId).toMatch(/^turn:[0-9a-f-]{36}$/);
		expect(body.idempotencyKey).toBe(`goal-usage:${body.turnId}`);

		await handlers.get("agent_end")?.({
			messages: [
				{
					role: "assistant",
					usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 0 },
				},
			],
		});
		const replayBody = fetchBody(fetchMock, 2);
		expect(replayBody.turnId).toBe(body.turnId);
		expect(replayBody.idempotencyKey).toBe(body.idempotencyKey);
	});

	it("does not call goal usage when the Session has no active Goal", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: { status: "draft", items: [] },
					goal: { configured: false, status: "cleared" },
					actGate: { allowed: false, message: "Approve a plan first." },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:no-goal",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });
		await handlers.get("agent_end")?.({
			messages: [{ role: "assistant", usage: { totalTokens: 500 } }],
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
