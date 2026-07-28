import { createHash } from "node:crypto";
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

const EMPTY_EVIDENCE_SHA256 = createHash("sha256").update("").digest("hex");

async function finishTool(
	handlers: Map<string, Handler>,
	input: {
		toolCallId: string;
		toolName?: string;
		args?: unknown;
		result: unknown;
		isError?: boolean;
	},
): Promise<void> {
	const toolName = input.toolName ?? "read";
	await handlers.get("tool_execution_start")?.({
		type: "tool_execution_start",
		toolCallId: input.toolCallId,
		toolName,
		args: input.args ?? {},
	});
	await handlers.get("tool_execution_end")?.({
		type: "tool_execution_end",
		toolCallId: input.toolCallId,
		toolName,
		result: input.result,
		isError: input.isError ?? false,
	});
}

const settleEvent = {
	type: "before_agent_settle",
	settleAttempt: 1,
	cancelScope: { scopeId: "scope:goal:1", generation: 1 },
	message: { role: "assistant", content: [], stopReason: "stop" },
};

describe("workflow control", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

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
			}),
		);

		const result = (await handlers.get("before_agent_start")?.({
			prompt: "继续",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };
		expect(result.systemPrompt).toContain("<workflow-state>");
		expect(result.systemPrompt).toContain("完成 Agent 工作流");
		expect(result.systemPrompt).toContain("计划：1/2 项完成");
		expect(result.systemPrompt).toContain("正在执行：完成前端验收");
		expect(result.systemPrompt).not.toContain("实现后端契约");
		expect(fetchCall(fetchMock, 0)[0]).toBe("http://127.0.0.1:8766/api/agent/tool/workflow-state");
		const body = fetchBody(fetchMock, 0);
		expect(body.sessionId).toBe("agent:workflow");
		expect(body).not.toHaveProperty("prompt");
	});

	it("reports every agent run exactly once, including all assistant messages", async () => {
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
				{ role: "toolResult", content: [] },
				{
					role: "assistant",
					usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchCall(fetchMock, 1)[0]).toBe("http://127.0.0.1:8766/api/agent/tool/goal-usage");
		const body = fetchBody(fetchMock, 1);
		expect(body.tokenDelta).toBe(300);
		expect(body.elapsedDeltaMs).toBeGreaterThanOrEqual(0);
		expect(body.turnId).toMatch(/^turn:[0-9a-f-]{36}$/);
		expect(body.eventId).toBe(`agent-end:${body.turnId}:1`);
		expect(body.idempotencyKey).toBe(`goal-usage:${body.turnId}:agent-end:1`);

		await handlers.get("agent_end")?.({
			messages: [
				{
					role: "assistant",
					usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 0 },
				},
			],
		});
		const continuationBody = fetchBody(fetchMock, 2);
		expect(continuationBody.turnId).toBe(body.turnId);
		expect(continuationBody.eventId).toBe(`agent-end:${body.turnId}:2`);
		expect(continuationBody.idempotencyKey).toBe(`goal-usage:${body.turnId}:agent-end:2`);
		expect(continuationBody.tokenDelta).toBe(200);
	});

	it("turns one active Goal decision into one bounded native continuation", async () => {
		const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			const continueGoal = Number(body.settleAttempt) === 1 || Number(body.freshToolEvidenceCount) > 0;
			return {
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? {
								ok: true,
								result: continueGoal
									? {
											state: "continue",
											goalId: "goal:1",
											followUpKey: `goal-settle:key-${String(body.settleAttempt)}`,
											message: "<managed-goal-follow-up>继续完成验收</managed-goal-follow-up>",
										}
									: { state: "stalled", reason: "no_progress" },
							}
						: {
								ok: true,
								result: {
									plan: {
										status: "approved",
										items: [{ text: "完成验收", status: "in_progress" }],
									},
									goal: { configured: true, status: "active", goalId: "goal:1" },
									actGate: { allowed: true },
								},
							},
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:goal-settle",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });

		await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toEqual({
			followUp: {
				text: "<managed-goal-follow-up>继续完成验收</managed-goal-follow-up>",
				continuation: {
					id: "goal-settle-follow-up:goal-settle:key-1",
					correlationId: "goal:1",
					origin: "goal_supervisor",
					idempotencyKey: "goal-settle:key-1",
					maxAttempts: 1,
				},
			},
		});
		expect(fetchCall(fetchMock, 1)[0]).toBe("http://127.0.0.1:8766/api/agent/tool/goal-settle");
		expect(fetchBody(fetchMock, 1)).toEqual({
			schemaVersion: "rag-ime.agent-goal-settle-request.v1",
			sessionId: "agent:goal-settle",
			settleScopeId: "scope:goal:1",
			settleAttempt: 1,
			freshToolEvidenceCount: 0,
			freshToolEvidenceSha256: EMPTY_EVIDENCE_SHA256,
		});

		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				settleAttempt: 2,
			}),
		).resolves.toBeUndefined();
		expect(fetchBody(fetchMock, 2)).toMatchObject({
			settleAttempt: 2,
			freshToolEvidenceCount: 0,
		});
	});

	it("requires fresh successful tool evidence after each issued Goal follow-up", async () => {
		const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			const shouldContinue = Number(body.settleAttempt) === 1 || Number(body.freshToolEvidenceCount) > 0;
			return {
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? {
								ok: true,
								result: shouldContinue
									? {
											state: "continue",
											goalId: "goal:progress",
											followUpKey: `goal-progress:${String(body.settleAttempt)}`,
											message: "继续",
										}
									: { state: "stalled", reason: "no_progress" },
							}
						: {
								ok: true,
								result: {
									plan: { status: "approved", items: [] },
									goal: { configured: true, status: "active" },
									actGate: { allowed: true },
								},
							},
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:progress",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });
		await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toHaveProperty("followUp");

		await finishTool(handlers, {
			toolCallId: "tool:success:1",
			args: { path: "status.json" },
			result: {
				content: [{ type: "text", text: '{"status":"ready","revision":1}' }],
				details: { receiptId: "receipt:first", capturedAtMs: 100 },
			},
		});
		// A new call id and volatile internal receipt metadata do not make the
		// same model-visible observation fresh evidence.
		await finishTool(handlers, {
			toolCallId: "tool:success:2",
			args: { path: "status.json" },
			result: {
				content: [{ type: "text", text: '{"status":"ready","revision":1}' }],
				details: { receiptId: "receipt:second", capturedAtMs: 200 },
			},
		});
		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				settleAttempt: 2,
			}),
		).resolves.toHaveProperty("followUp");
		expect(fetchBody(fetchMock, 2)).toMatchObject({
			settleAttempt: 2,
			freshToolEvidenceCount: 1,
		});
		const firstEvidenceDigest = String(fetchBody(fetchMock, 2).freshToolEvidenceSha256);
		expect(firstEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(firstEvidenceDigest).not.toBe(EMPTY_EVIDENCE_SHA256);

		// The cumulative seen set survives the issued continuation, so replaying
		// the same observation under another call id is not fresh progress.
		await finishTool(handlers, {
			toolCallId: "tool:success:3",
			args: { path: "status.json" },
			result: {
				content: [{ type: "text", text: '{"status":"ready","revision":1}' }],
				details: { receiptId: "receipt:third", capturedAtMs: 300 },
			},
		});
		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				settleAttempt: 3,
			}),
		).resolves.toBeUndefined();
		expect(fetchBody(fetchMock, 3)).toMatchObject({
			settleAttempt: 3,
			freshToolEvidenceCount: 0,
			freshToolEvidenceSha256: EMPTY_EVIDENCE_SHA256,
		});
	});

	it("treats changed read output as fresh evidence in the same settle scope", async () => {
		const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			const shouldContinue = Number(body.settleAttempt) === 1 || Number(body.freshToolEvidenceCount) > 0;
			return {
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? {
								ok: true,
								result: shouldContinue
									? {
											state: "continue",
											goalId: "goal:changed-read",
											followUpKey: `goal-changed:${String(body.settleAttempt)}`,
											message: "继续",
										}
									: { state: "stalled", reason: "no_progress" },
							}
						: {
								ok: true,
								result: {
									plan: { status: "approved", items: [] },
									goal: { configured: true, status: "active" },
									actGate: { allowed: true },
								},
							},
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:changed-read",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });
		await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toHaveProperty("followUp");

		await finishTool(handlers, {
			toolCallId: "tool:read:1",
			args: { path: "status.json" },
			result: { revision: 1 },
		});
		await expect(handlers.get("before_agent_settle")?.({ ...settleEvent, settleAttempt: 2 })).resolves.toHaveProperty(
			"followUp",
		);
		const firstDigest = String(fetchBody(fetchMock, 2).freshToolEvidenceSha256);

		await finishTool(handlers, {
			toolCallId: "tool:read:2",
			args: { path: "status.json" },
			result: { revision: 2 },
		});
		await expect(handlers.get("before_agent_settle")?.({ ...settleEvent, settleAttempt: 3 })).resolves.toHaveProperty(
			"followUp",
		);
		const secondBody = fetchBody(fetchMock, 3);
		expect(secondBody.freshToolEvidenceCount).toBe(1);
		expect(secondBody.freshToolEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(secondBody.freshToolEvidenceSha256).not.toBe(firstDigest);
	});

	it("does not count failed tool executions as Goal progress", async () => {
		const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			const shouldContinue = Number(body.settleAttempt) === 1 || Number(body.freshToolEvidenceCount) > 0;
			return {
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? {
								ok: true,
								result: shouldContinue
									? {
											state: "continue",
											goalId: "goal:failure",
											followUpKey: "goal-failure:first",
											message: "继续",
										}
									: { state: "stalled", reason: "no_progress" },
							}
						: {
								ok: true,
								result: {
									plan: { status: "approved", items: [] },
									goal: { configured: true, status: "active" },
									actGate: { allowed: true },
								},
							},
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:failure",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });
		await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toHaveProperty("followUp");
		await finishTool(handlers, {
			toolCallId: "tool:failed",
			toolName: "write",
			args: { path: "status.json" },
			result: { error: "denied" },
			isError: true,
		});

		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				settleAttempt: 2,
			}),
		).resolves.toBeUndefined();
		expect(fetchBody(fetchMock, 2)).toMatchObject({
			settleAttempt: 2,
			freshToolEvidenceCount: 0,
			freshToolEvidenceSha256: EMPTY_EVIDENCE_SHA256,
		});
	});

	it("stops at the local settle-scope cap even if the gateway requests more work", async () => {
		const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			return {
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? {
								ok: true,
								result: {
									state: "continue",
									goalId: "goal:bounded",
									followUpKey: `goal-bounded:${String(body.settleAttempt)}`,
									message: "继续",
								},
							}
						: {
								ok: true,
								result: {
									plan: { status: "approved", items: [] },
									goal: { configured: true, status: "active" },
									actGate: { allowed: true },
								},
							},
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:bounded",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });

		for (let attempt = 1; attempt < 5; attempt += 1) {
			if (attempt > 1) {
				await finishTool(handlers, {
					toolCallId: `tool:bounded:${attempt}`,
					args: { path: "status.json" },
					result: { revision: attempt },
				});
			}
			await expect(
				handlers.get("before_agent_settle")?.({
					...settleEvent,
					settleAttempt: attempt,
				}),
			).resolves.toHaveProperty("followUp");
		}
		await finishTool(handlers, {
			toolCallId: "tool:bounded:5",
			args: { path: "status.json" },
			result: { revision: 5 },
		});
		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				settleAttempt: 5,
			}),
		).resolves.toBeUndefined();
		expect(fetchBody(fetchMock, 5)).toMatchObject({
			settleAttempt: 5,
			freshToolEvidenceCount: 1,
		});
	});

	it("aborts a hanging Goal settle gateway at the local timeout", async () => {
		vi.useFakeTimers();
		let settleSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
			if (!url.endsWith("/goal-settle")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						result: {
							plan: { status: "approved", items: [] },
							goal: { configured: true, status: "active" },
							actGate: { allowed: true },
						},
					}),
				};
			}
			settleSignal = init?.signal;
			return await new Promise<never>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
					once: true,
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:hanging-settle",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });

		const settlement = Promise.resolve(handlers.get("before_agent_settle")?.(settleEvent));
		const boundedFailure = expect(settlement).rejects.toThrow("Goal settle gateway timed out after 8000ms");
		await vi.advanceTimersByTimeAsync(7_999);
		expect(settleSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await boundedFailure;
		expect(settleSignal?.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["inactive", "paused", "completed", "cancelled", "blocked", "stalled", "budget_exhausted"])(
		"does not continue a %s Goal decision",
		async (state) => {
			const fetchMock = vi.fn(async (url: string) => ({
				ok: true,
				status: 200,
				json: async () =>
					url.endsWith("/goal-settle")
						? { ok: true, result: { state } }
						: {
								ok: true,
								result: {
									plan: { status: "approved", items: [] },
									goal: { configured: true, status: "active" },
									actGate: { allowed: true },
								},
							},
			}));
			vi.stubGlobal("fetch", fetchMock);
			const handlers = register(
				createWorkflowControlExtension({
					bridge: {
						sessionId: "agent:terminal-goal",
						registry: {} as never,
						gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
					},
				}),
			);
			await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });

			await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["error", "aborted"] as const)("does not continue after a %s Provider turn", async (stopReason) => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: { status: "approved", items: [] },
					goal: { configured: true, status: "active" },
					actGate: { allowed: true },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:failed-goal",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续", systemPrompt: "base" });

		await expect(
			handlers.get("before_agent_settle")?.({
				...settleEvent,
				message: { ...settleEvent.message, stopReason },
			}),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("leaves settle ownership to the active Room lifecycle", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: { status: "draft", items: [] },
					goal: { configured: true, status: "active" },
					actGate: { allowed: true },
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:room-goal",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
				hasActiveRoom: () => true,
			}),
		);
		await handlers.get("before_agent_start")?.({ prompt: "继续 Room", systemPrompt: "base" });

		await expect(handlers.get("before_agent_settle")?.(settleEvent)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

	it("renders a fenced Room Dispatch as the work authority instead of an empty draft plan", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: { status: "draft", title: "执行计划", items: [] },
					goal: { configured: false, status: "cleared" },
					actGate: {
						allowed: true,
						reason: "approved",
						message: "当前受管 Room Dispatch 已授权执行；写操作仍受原生审批。",
					},
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:room",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);

		const result = (await handlers.get("before_agent_start")?.({
			prompt: "执行 Room 任务",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };

		expect(result.systemPrompt).not.toContain("Plan");
		expect(result.systemPrompt).not.toContain("不得执行写操作");
		expect(result.systemPrompt).not.toContain("current_time");
		expect(result.systemPrompt).toContain("当前 Room 任务已经开始");
	});

	it("renders a completed plan with the authoritative completion gate exactly once", async () => {
		const completionMessage = "当前计划已经完成；开始新任务前请创建并审批新计划。";
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					plan: {
						status: "completed",
						title: "完成当前任务",
						items: [{ text: "运行验收", status: "completed" }],
					},
					goal: { configured: false, status: "cleared" },
					actGate: {
						allowed: false,
						reason: "plan_completed",
						message: completionMessage,
					},
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = register(
			createWorkflowControlExtension({
				bridge: {
					sessionId: "agent:completed",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
			}),
		);

		const result = (await handlers.get("before_agent_start")?.({
			prompt: "继续聊天",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };

		expect(result.systemPrompt).toContain("计划：全部完成");
		expect(result.systemPrompt).not.toContain("Act Gate");
		expect(result.systemPrompt?.match(new RegExp(completionMessage, "gu"))).toHaveLength(1);
		expect(result.systemPrompt).not.toContain("计划尚未批准");
		expect(result.systemPrompt).not.toContain("计划尚未获得用户批准");
	});
});
