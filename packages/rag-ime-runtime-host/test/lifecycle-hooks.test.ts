import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifecycleHookController } from "../src/lifecycle-hooks.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

function fetchBody(mock: unknown, index: number): Record<string, unknown> & { payload: Record<string, unknown> } {
	const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
	const init = calls[index]?.[1] as { body?: unknown } | undefined;
	const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
	if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
		throw new Error("Lifecycle request payload must be an object");
	}
	return body as Record<string, unknown> & { payload: Record<string, unknown> };
}

describe("lifecycle hooks", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("delivers governed next-turn context and emits bounded lifecycle events", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					result: {
						nextTurnContext: "## 项目收尾\n仅在存在稳定事实时调用记忆工具；无事实则跳过。",
						idleDelayMs: 60_000,
					},
				}),
			})
			.mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { idleDelayMs: 60_000 } }),
			});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = new Map<string, Handler>();
		let idleCallback: (() => void) | undefined;
		const controller = createLifecycleHookController({
			bridge: {
				sessionId: "agent:hooks",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "token",
			},
			setTimer: ((callback: () => void) => {
				idleCallback = callback;
				return 1;
			}) as unknown as typeof setTimeout,
			clearTimer: (() => undefined) as typeof clearTimeout,
		});
		controller.extension({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
		} as never);

		const start = (await handlers.get("before_agent_start")?.({
			prompt: "完成插件前端",
			systemPrompt: "基础提示词",
		})) as { systemPrompt?: string };
		expect(start.systemPrompt).toContain('type="lifecycle_hook"');
		expect(start.systemPrompt).toContain("无事实则跳过");
		expect(start.systemPrompt).not.toContain("current_time");
		const firstBody = fetchBody(fetchMock, 0);
		expect(firstBody.eventType).toBe("session_start");
		expect(firstBody.eventId).toMatch(/^lifecycle:session_start:[a-f0-9]{40}$/);
		expect(firstBody.payload).not.toHaveProperty("prompt");
		expect(firstBody.payload.promptSha256).toMatch(/^[a-f0-9]{64}$/);

		await handlers.get("turn_end")?.({
			turnIndex: 0,
			message: { content: [{ type: "text", text: "已完成实现。" }] },
			toolResults: [],
		});
		expect(idleCallback).toBeTypeOf("function");
		idleCallback?.();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		const idleBody = fetchBody(fetchMock, 2);
		expect(idleBody.eventType).toBe("idle");
		expect(idleBody.payload).toMatchObject({
			auditOnly: true,
			facts: [],
			reason: "no_governed_fact_candidate",
		});
	});

	it("keeps managed Room compaction audit-only and leaves one recovery owner", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: { nextTurnContext: "generic lifecycle recovery that must not be injected" },
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = new Map<string, Handler>();
		const controller = createLifecycleHookController({
			bridge: {
				sessionId: "agent:managed-room",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			},
			isManagedRoom: () => true,
		});
		controller.extension({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
		} as never);

		const result = (await handlers.get("session_compact")?.(
			{
				reason: "manual",
				willRetry: false,
				compactionEntry: {
					id: "compaction:room:1",
					summary: "原始需求、当前任务、验收、阻塞、交接和精确回执",
				},
			},
			{
				getSystemPrompt: () => 'base\n<rag-ime-context type="lifecycle_hook">stale duplicate</rag-ime-context>',
			},
		)) as { systemPrompt?: string };

		const body = fetchBody(fetchMock, 0);
		expect(body.eventType).toBe("compaction");
		expect(body.payload).toMatchObject({
			auditOnly: true,
			contextOwner: "room_context_epoch",
			facts: [],
			summaryLength: 23,
		});
		expect(body.payload.summarySha256).toMatch(/^[a-f0-9]{64}$/);
		expect(body.payload).not.toHaveProperty("summary");
		expect(result.systemPrompt).toBe("base");
		expect(result.systemPrompt).not.toContain("lifecycle_hook");
		expect(result.systemPrompt).not.toContain("generic lifecycle recovery");
	});

	it("reports tool failures without replacing the original result", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: {} }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const handlers = new Map<string, Handler>();
		const controller = createLifecycleHookController({
			bridge: {
				sessionId: "agent:failed-tool",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			},
		});
		controller.extension({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
		} as never);

		const result = await handlers.get("tool_result")?.({
			toolName: "workspace_shell",
			toolCallId: "tool-1",
			input: { command: "private command" },
			content: [
				{
					type: "text",
					text: "command failed: /Users/undo/private --token secret-token",
				},
			],
			isError: true,
		});
		expect(result).toBeUndefined();
		const body = fetchBody(fetchMock, 0);
		expect(body.eventType).toBe("tool_failed");
		expect(body.payload).not.toHaveProperty("input");
		expect(body.payload).not.toHaveProperty("toolCallId");
		expect(body.payload.inputSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(body.payload.toolCallIdSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(body.payload.errorSummary).toBe("Tool error details redacted by Runtime Host.");
		expect(body.payload.errorSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(body)).not.toContain("private command");
		expect(JSON.stringify(body)).not.toContain("/Users/undo/private");
		expect(JSON.stringify(body)).not.toContain("secret-token");
		expect(body.payload.facts).toEqual([]);
		expect(body.payload.auditOnly).toBe(true);
		expect(body.payload.reason).toBe("tool_failure_is_not_a_durable_memory_fact");
		await handlers.get("tool_result")?.({
			toolName: "workspace_shell",
			toolCallId: "tool-1",
			input: { command: "private command" },
			content: [{ type: "text", text: "command failed: /Users/undo/private --token secret-token" }],
			isError: true,
		});
		expect(fetchBody(fetchMock, 1).eventId).toBe(body.eventId);
	});

	it("retries the same stable completion event before the next available hook request", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("sidecar unavailable"))
			.mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: {} }),
			});
		vi.stubGlobal("fetch", fetchMock);
		const handlers = new Map<string, Handler>();
		const controller = createLifecycleHookController({
			bridge: {
				sessionId: "agent:retry",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			},
		});
		controller.extension({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
		} as never);

		await controller.projectComplete({
			completionKey: "goal:retry",
			plan: { id: "plan:retry", title: "Retry delivery", status: "completed", revision: 1 },
			goal: {},
		});
		await handlers.get("before_agent_start")?.({ prompt: "continue", systemPrompt: "base" });

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const failedBody = fetchBody(fetchMock, 0);
		const retriedBody = fetchBody(fetchMock, 1);
		expect(failedBody.eventType).toBe("project_complete");
		expect(retriedBody.eventType).toBe("project_complete");
		expect(retriedBody.eventId).toBe(failedBody.eventId);
		expect(fetchBody(fetchMock, 2).eventType).toBe("session_start");
	});

	it("restores a failed lifecycle event after Runtime restart and retries the same event id", async () => {
		const stateDirectory = mkdtempSync(join(tmpdir(), "pi-lifecycle-pending-"));
		try {
			vi.stubEnv("RAG_IME_PI_LIFECYCLE_STATE_DIR", "");
			vi.stubEnv("RAG_IME_PI_SESSION_DIR", stateDirectory);
			const pendingDirectory = join(stateDirectory, ".lifecycle-hooks");
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error("sidecar unavailable"))
				.mockResolvedValue({
					ok: true,
					status: 200,
					json: async () => ({ ok: true, result: {} }),
				});
			vi.stubGlobal("fetch", fetchMock);
			const bridge = {
				sessionId: "agent:restart-retry",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			};
			const firstRuntime = createLifecycleHookController({ bridge });

			await firstRuntime.projectComplete({
				completionKey: "plan:restart-retry",
				plan: {
					id: "restart-retry",
					title: "Persist lifecycle delivery",
					status: "completed",
					revision: 1,
				},
				goal: {},
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(readdirSync(pendingDirectory)).toHaveLength(1);
			const failed = fetchBody(fetchMock, 0);

			createLifecycleHookController({ bridge });
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
			const retried = fetchBody(fetchMock, 1);
			expect(retried.eventType).toBe("project_complete");
			expect(retried.eventId).toBe(failed.eventId);
			await vi.waitFor(() => expect(readdirSync(pendingDirectory)).toEqual([]));

			createLifecycleHookController({ bridge });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("delivers agent_plan completion before the Session can close without an active Goal or next turn", async () => {
		const stateDirectory = mkdtempSync(join(tmpdir(), "pi-lifecycle-close-"));
		try {
			const fetchMock = vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: {} }),
			}));
			vi.stubGlobal("fetch", fetchMock);
			const handlers = new Map<string, Handler>();
			const controller = createLifecycleHookController({
				bridge: {
					sessionId: "agent:complete-and-close",
					registry: {} as never,
					gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				},
				stateDirectory,
			});
			controller.extension({
				on: (name: string, handler: Handler) => handlers.set(name, handler),
			} as never);

			await handlers.get("tool_result")?.({
				toolName: "agent_plan",
				toolCallId: "tool-complete",
				input: { op: "complete" },
				content: [{ type: "text", text: "completed" }],
				details: {
					plan: {
						id: "plan:close",
						title: "Complete and close",
						status: "completed",
						revision: 3,
					},
				},
				isError: false,
			});
			await handlers.get("session_shutdown")?.({ reason: "quit" });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = fetchBody(fetchMock, 0);
			expect(body.eventType).toBe("project_complete");
			expect(body.payload.completionKey).toBe("plan:plan:close");
			expect(body.payload.goal).toEqual({});
			expect(body.payload.facts).toEqual([
				{
					text: "Completed plan: Complete and close",
					evidence: "workflow:plan:close@3",
				},
			]);
			expect(readdirSync(stateDirectory)).toEqual([]);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("turns a durable Goal completion audit into review facts, not a direct memory write", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { action: "memory_review_suggestion" } }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const controller = createLifecycleHookController({
			bridge: {
				sessionId: "agent:complete",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			},
		});

		await controller.projectComplete({
			completionKey: "goal:delivery",
			plan: {
				id: "plan:delivery",
				title: "Deliver workflow suite",
				status: "completed",
				revision: 8,
			},
			goal: {
				completionAudit: {
					auditId: "audit-1",
					summary: "All six workflows passed production verification.",
					evidence: [{ reference: "commit:abc123" }, { reference: "test:runtime-host" }],
				},
			},
		});

		const body = fetchBody(fetchMock, 0);
		expect(body.eventType).toBe("project_complete");
		expect(body.payload.facts).toEqual([
			{
				text: "All six workflows passed production verification.",
				evidence: "commit:abc123, test:runtime-host",
			},
			{
				text: "Completed plan: Deliver workflow suite",
				evidence: "workflow:plan:delivery@8",
			},
		]);
	});
});
