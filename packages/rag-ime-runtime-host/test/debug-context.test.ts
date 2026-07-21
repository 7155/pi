import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiDebugContextRecorder } from "../src/debug-context.ts";

type DebugHandler = (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown;

describe("PiDebugContextRecorder", () => {
	it("distinguishes a reported no-hit usage block from unavailable all-zero usage", () => {
		let activeTurn = { turnId: "turn-zero" };
		const recorder = new PiDebugContextRecorder("session-cache-capability", () => activeTurn);
		const handlers = new Map<string, DebugHandler>();
		recorder.extension()({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => [],
			getAllTools: () => [],
		} as never);
		const begin = () => {
			handlers.get("before_agent_start")?.(
				{ prompt: "test", systemPrompt: "system", systemPromptOptions: { skills: [] } },
				{},
			);
			handlers.get("context")?.({ messages: [{ role: "user", content: "test" }] });
		};

		begin();
		handlers.get("message_end")?.({
			message: { role: "assistant", content: [], usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 } },
		});
		expect(recorder.get()?.cacheEvidence.at(-1)?.capability).toBe("reported");
		expect(recorder.get()?.cacheEvidence.at(-1)?.cacheHitProven).toBe(false);

		activeTurn = { turnId: "turn-absent" };
		begin();
		handlers.get("message_end")?.({
			message: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		});
		expect(recorder.get()?.cacheEvidence.at(-1)?.capability).toBe("unsupported");
	});

	it("captures the final local request boundary while omitting credentials and binary bodies", () => {
		let activeTurn = { turnId: "turn-1", clientMessageId: "client-1" };
		const recorder = new PiDebugContextRecorder("session-1", () => activeTurn);
		const handlers = new Map<string, DebugHandler>();
		const extension = recorder.extension();
		extension({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => ["read"],
			getAllTools: () => [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					promptGuidelines: ["Use an absolute path"],
				},
			],
		} as never);

		handlers.get("before_agent_start")?.(
			{
				prompt: "raw user prompt",
				systemPrompt: "assembled system prompt",
				systemPromptOptions: { cwd: "/workspace" },
			},
			{
				model: {
					provider: "openai",
					id: "gpt-test",
					name: "GPT Test",
					api: "responses",
					contextWindow: 128_000,
					maxTokens: 16_000,
				},
			},
		);
		handlers.get("turn_start")?.({ turnIndex: 0, timestamp: Date.now() });
		handlers.get("context")?.({
			messages: [
				{ role: "user", content: "final context" },
				{ role: "assistant", thinking: "hidden chain", content: [{ type: "reasoning", text: "private" }] },
			],
		});
		handlers.get("provider_context_inspection")?.({
			context: {
				systemPrompt: "assembled system prompt",
				messages: [{ role: "user", content: "final context" }],
				tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			},
		});
		handlers.get("before_provider_request")?.({
			payload: {
				model: "gpt-test",
				input: "final provider input",
				authorization: "Bearer secret",
				api_key: "secret-key",
				headers: { Authorization: "Bearer nested-secret", "x-api-key": "x-secret" },
				image: "data:image/png;base64,AAAA",
			},
		});
		handlers.get("after_provider_response")?.({
			status: 200,
			headers: { "x-request-id": "request-1", "set-cookie": "private-cookie" },
		});
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read" }],
				usage: { input: 20, output: 4, cacheRead: 10, cacheWrite: 2, totalTokens: 36 },
			},
		});
		handlers.get("tool_execution_start")?.({ toolCallId: "tool-1", toolName: "read", args: { path: "a.ts" } });
		handlers.get("tool_execution_start")?.({ toolCallId: "tool-2", toolName: "read", args: { path: "b.ts" } });
		handlers.get("tool_execution_end")?.({
			toolCallId: "tool-2",
			toolName: "read",
			result: { text: "b" },
			isError: false,
		});
		handlers.get("tool_execution_end")?.({
			toolCallId: "tool-1",
			toolName: "read",
			result: { text: "a" },
			isError: false,
		});
		handlers.get("turn_end")?.({ turnIndex: 0, message: { role: "assistant" }, toolResults: [] });

		handlers.get("turn_start")?.({ turnIndex: 1, timestamp: Date.now() });
		handlers.get("context")?.({
			messages: [
				{ role: "user", content: "final context" },
				{ role: "assistant", content: "I inspected the files" },
				{ role: "toolResult", content: "tool evidence" },
			],
		});
		handlers.get("before_provider_request")?.({ payload: { model: "gpt-test", input: "follow-up" } });
		handlers.get("tool_execution_start")?.({ toolCallId: "tool-3", toolName: "read", args: { path: "c.ts" } });
		handlers.get("tool_execution_end")?.({
			toolCallId: "tool-3",
			toolName: "read",
			result: { text: "c" },
			isError: false,
		});
		handlers.get("tool_execution_start")?.({ toolCallId: "tool-4", toolName: "read", args: { path: "d.ts" } });
		handlers.get("tool_execution_end")?.({
			toolCallId: "tool-4",
			toolName: "read",
			result: { error: "denied" },
			isError: true,
		});

		const captured = recorder.get("turn-1");
		expect(captured).toMatchObject({
			sessionId: "session-1",
			turnId: "turn-1",
			clientMessageId: "client-1",
			prompt: "raw user prompt",
			systemPrompt: "assembled system prompt",
			activeTools: ["read"],
		});
		expect(captured?.contextWindows[0]?.messages).toEqual([
			{ role: "user", content: "final context" },
			{ role: "assistant", content: [{ type: "reasoning", omitted: true }] },
		]);
		expect(captured?.modelCalls[0]?.providerContext).toMatchObject({
			systemPrompt: "assembled system prompt",
			tools: [{ name: "read" }],
		});
		expect(captured?.cacheEvidence[0]).toMatchObject({
			inputTokens: 20,
			outputTokens: 4,
			cacheReadTokens: 10,
			cacheWriteTokens: 2,
			capability: "reported",
		});
		expect(captured?.cacheEvidence[0]?.prefixSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(captured?.providerRequests[0]?.payload).toMatchObject({
			model: "gpt-test",
			input: "final provider input",
			authorization: "[credential omitted]",
			api_key: "[credential omitted]",
			headers: { Authorization: "[credential omitted]", "x-api-key": "[credential omitted]" },
			image: expect.stringContaining("binary data omitted"),
		});
		expect(captured?.modelCalls).toHaveLength(2);
		expect(captured?.modelCalls[0]?.providerExchanges[0]).toMatchObject({
			status: 200,
			headers: { "x-request-id": "request-1", "set-cookie": "[credential omitted]" },
		});
		expect(captured?.modelCalls[1]?.contextDelta).toMatchObject({
			baseCallIndex: 1,
			commonPrefixMessages: 1,
			removedMessageCount: 1,
			addedMessageCount: 2,
		});
		expect(captured?.modelCalls[1]?.contextDelta.addedMessages).toEqual([
			{ role: "assistant", content: "I inspected the files" },
			{ role: "toolResult", content: "tool evidence" },
		]);
		expect(captured?.toolExecutions).toHaveLength(4);
		expect(captured?.toolBatches.map((batch) => ({ mode: batch.executionMode, ids: batch.toolCallIds }))).toEqual([
			{ mode: "parallel", ids: ["tool-1", "tool-2"] },
			{ mode: "serial", ids: ["tool-3"] },
			{ mode: "serial", ids: ["tool-4"] },
		]);
		expect(captured?.toolExecutions.at(-1)).toMatchObject({ status: "failed", isError: true });
		expect(JSON.stringify(captured)).not.toContain("nested-secret");
		expect(JSON.stringify(captured)).not.toContain("x-secret");
		expect(JSON.stringify(captured)).not.toContain("private-cookie");
		expect(JSON.stringify(captured)).not.toContain("hidden chain");
		expect(JSON.stringify(captured)).not.toContain('"text":"private"');
		expect(recorder.list()).toEqual([
			expect.objectContaining({
				turnId: "turn-1",
				modelCallCount: 2,
				providerRequestCount: 2,
				toolCallCount: 4,
				runningToolCount: 0,
			}),
		]);

		activeTurn = { turnId: "turn-2", clientMessageId: "client-2" };
		expect(recorder.get("turn-2")).toBeUndefined();
		recorder.clear();
		expect(recorder.get()).toBeUndefined();
	});

	it("persists recent snapshots and restores them without exceeding the configured cap", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-debug-context-"));
		try {
			const activeTurn = { turnId: "turn-persisted", clientMessageId: "client-persisted" };
			const recorder = new PiDebugContextRecorder("session-persisted", () => activeTurn, {
				directory,
				maxBytes: 64 * 1024,
			});
			const handlers = new Map<string, DebugHandler>();
			recorder.extension()({
				on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
				getActiveTools: () => [],
				getAllTools: () => [],
			} as never);
			handlers.get("before_agent_start")?.(
				{
					prompt: "persist me",
					systemPrompt: "system",
					systemPromptOptions: { cwd: "/workspace" },
				},
				{},
			);
			handlers.get("turn_start")?.({ turnIndex: 0, timestamp: Date.now() });
			handlers.get("context")?.({ messages: [{ role: "user", content: "persist me" }] });
			handlers.get("turn_end")?.({ turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
			recorder.clear();
			await recorder.flush();

			const storage = recorder.storage();
			expect(storage).toMatchObject({ persistent: true, directory, maxBytes: 64 * 1024, fileCount: 1 });
			expect(storage.usedBytes).toBeGreaterThan(0);
			expect(storage.usedBytes).toBeLessThanOrEqual(64 * 1024);

			const restored = new PiDebugContextRecorder("session-persisted", () => undefined, {
				directory,
				maxBytes: 64 * 1024,
			});
			await restored.flush();
			expect(restored.get("turn-persisted")).toMatchObject({
				turnId: "turn-persisted",
				prompt: "persist me",
			});
			expect(restored.list()).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
