import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiDebugContextRecorder } from "../src/debug-context.ts";

type DebugHandler = (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown;

describe("PiDebugContextRecorder", () => {
	it("captures unbound compaction Provider calls as a first-class lifecycle record", () => {
		const recorder = new PiDebugContextRecorder("session-compaction", () => undefined);
		const handlers = new Map<string, DebugHandler>();
		recorder.extension()({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => [],
			getAllTools: () => [],
		} as never);

		const lifecycleTurnId = recorder.beginLifecycle("compaction", { reason: "manual" });
		for (const index of [1, 2]) {
			handlers.get("provider_context_inspection")?.({
				model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
				context: {
					systemPrompt: "summarize safely",
					messages: [{ role: "user", content: `summary part ${index}` }],
					tools: [],
				},
			});
			handlers.get("before_provider_request")?.({
				payload: { model: "gpt-test", input: `wire part ${index}`, stream: true },
			});
			handlers.get("after_provider_response")?.({
				status: 200,
				headers: { "x-request-id": `request-${index}` },
			});
		}
		recorder.endLifecycle("compaction", "completed");

		const captured = recorder.get(lifecycleTurnId);
		expect(captured?.lifecycle).toEqual({
			kind: "compaction",
			reason: "manual",
			status: "completed",
			error: undefined,
		});
		expect(captured?.model).toMatchObject({ provider: "openai", id: "gpt-test" });
		expect(captured?.modelCalls).toHaveLength(2);
		expect(captured?.modelCalls.map((call) => call.index)).toEqual([1, 2]);
		expect(captured?.providerRequests.map((request) => request.payload)).toEqual([
			expect.objectContaining({ input: "wire part 1" }),
			expect.objectContaining({ input: "wire part 2" }),
		]);
		expect(recorder.list()).toEqual([
			expect.objectContaining({
				turnId: lifecycleTurnId,
				modelCallCount: 2,
				providerRequestCount: 2,
			}),
		]);
	});

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
		let activeTools = ["read"];
		const recorder = new PiDebugContextRecorder("session-1", () => activeTurn);
		const handlers = new Map<string, DebugHandler>();
		const extension = recorder.extension();
		extension({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => activeTools,
			getAllTools: () => [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					promptGuidelines: ["Use an absolute path"],
				},
				{
					name: "write",
					description: "Write a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					promptGuidelines: ["Write only after approval"],
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
				reasoning: {
					effort: "high",
					summary: "auto",
					content: "private rationale",
					encrypted_content: "encrypted-rationale",
				},
				usage: { output_tokens_details: { reasoning_tokens: 17 } },
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
		activeTools = ["read", "write"];
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
			activeTools: ["read", "write"],
		});
		expect(captured?.toolSchemas.map((tool) => tool.name)).toEqual(["read", "write"]);
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
			reasoning: { effort: "high", summary: "auto" },
			usage: { output_tokens_details: { reasoning_tokens: 17 } },
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
		expect(JSON.stringify(captured)).not.toContain("private rationale");
		expect(JSON.stringify(captured)).not.toContain("encrypted-rationale");
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

	it("persists the provider request boundary when the provider fails before an assistant message", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-debug-context-provider-failure-"));
		try {
			const activeTurn = { turnId: "turn-provider-failure", clientMessageId: "client-provider-failure" };
			const recorder = new PiDebugContextRecorder("session-provider-failure", () => activeTurn, {
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
				{ prompt: "test failure", systemPrompt: "system", systemPromptOptions: {} },
				{ model: { provider: "openai", id: "gpt-test", api: "responses" } },
			);
			handlers.get("context")?.({ messages: [{ role: "user", content: "test failure" }] });
			handlers.get("provider_context_inspection")?.({
				context: {
					systemPrompt: "system",
					messages: [{ role: "user", content: "test failure" }],
					tools: [],
				},
			});
			handlers.get("before_provider_request")?.({
				payload: { model: "gpt-test", input: "final provider input", stream: true },
			});
			handlers.get("after_provider_response")?.({
				status: 400,
				headers: { "x-request-id": "request-failed" },
			});
			await recorder.flush();

			const restored = new PiDebugContextRecorder("session-provider-failure", () => undefined, {
				directory,
				maxBytes: 64 * 1024,
			});
			await restored.flush();
			const captured = restored.get("turn-provider-failure");

			expect(captured?.providerRequests).toHaveLength(1);
			expect(captured?.providerRequests[0]?.payload).toMatchObject({
				model: "gpt-test",
				input: "final provider input",
			});
			expect(captured?.modelCalls[0]?.providerContext).toMatchObject({
				systemPrompt: "system",
			});
			expect(captured?.modelCalls[0]?.providerExchanges[0]).toMatchObject({
				status: 400,
				headers: { "x-request-id": "request-failed" },
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
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

	it("accepts a multi-GiB archive budget and keeps an upper safety bound", () => {
		const fiveGiB = 5 * 1024 * 1024 * 1024;
		const recorder = new PiDebugContextRecorder("session-five-gib", () => undefined, {
			maxBytes: fiveGiB,
		});
		expect(recorder.storage().maxBytes).toBe(fiveGiB);

		const oversized = new PiDebugContextRecorder("session-oversized", () => undefined, {
			maxBytes: 128 * 1024 * 1024 * 1024,
		});
		expect(oversized.storage().maxBytes).toBe(64 * 1024 * 1024 * 1024);
	});

	it("returns a structurally valid record when the complete inspection exceeds the per-value clone cap", () => {
		const activeTurn = { turnId: "turn-large" };
		const recorder = new PiDebugContextRecorder("session-large", () => activeTurn);
		const handlers = new Map<string, DebugHandler>();
		recorder.extension()({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => [],
			getAllTools: () => [],
		} as never);
		handlers.get("before_agent_start")?.({ prompt: "large", systemPrompt: "system", systemPromptOptions: {} }, {});
		const content = "x".repeat(800_000);
		for (let index = 0; index < 4; index += 1) {
			handlers.get("context")?.({ messages: [{ role: "user", content, index }] });
			handlers.get("provider_context_inspection")?.({
				context: { systemPrompt: "system", messages: [{ role: "user", content, index }], tools: [] },
			});
		}

		const captured = recorder.get();
		expect(JSON.stringify(captured).length).toBeGreaterThan(6_000_000);
		expect(captured?.schemaVersion).toBe("rag-ime.context-inspection.v2");
		expect(captured?.modelCalls).toHaveLength(4);
		expect(captured?.modelCalls.at(-1)?.contextDelta).toBeDefined();
	});

	it("retains every provider call when an audit raises the bounded per-turn cap", () => {
		const activeTurn = { turnId: "turn-full-audit" };
		const recorder = new PiDebugContextRecorder("session-full-audit", () => activeTurn, {
			maxCallsPerTurn: 24,
		});
		const handlers = new Map<string, DebugHandler>();
		recorder.extension()({
			on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
			getActiveTools: () => [],
			getAllTools: () => [],
		} as never);
		handlers.get("before_agent_start")?.({ prompt: "audit", systemPrompt: "system", systemPromptOptions: {} }, {});
		for (let index = 0; index < 20; index += 1) {
			handlers.get("context")?.({ messages: [{ role: "user", content: `call-${index}` }] });
			handlers.get("before_provider_request")?.({ payload: { model: "test", index } });
			handlers.get("message_end")?.({
				message: { role: "assistant", content: [], usage: { input: 1, output: 1 } },
			});
		}

		const captured = recorder.get();
		expect(captured?.modelCalls).toHaveLength(20);
		expect(captured?.providerRequests).toHaveLength(20);
		expect(captured?.providerRequestReceipts).toHaveLength(20);
		expect(captured?.cacheEvidence).toHaveLength(20);
	});

	it("normalizes incomplete legacy snapshots before exposing or mutating them", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-debug-context-legacy-"));
		try {
			const sessionDirectory = join(directory, "session-legacy");
			mkdirSync(sessionDirectory, { recursive: true });
			writeFileSync(
				join(sessionDirectory, "1-turn-legacy.json"),
				JSON.stringify({
					schemaVersion: "rag-ime.pi-debug-context.v1",
					sessionId: "session-legacy",
					turnId: "turn-legacy",
					capturedAtMs: 1,
					prompt: "legacy",
					systemPrompt: "system",
				}),
			);
			const restored = new PiDebugContextRecorder("session-legacy", () => undefined, { directory });
			await restored.flush();

			expect(restored.get("turn-legacy")).toMatchObject({
				schemaVersion: "rag-ime.context-inspection.v2",
				turnId: "turn-legacy",
				modelCalls: [],
				contributionRefs: [],
				toolExecutions: [],
			});
			expect(restored.list()).toEqual([
				expect.objectContaining({ modelCallCount: 0, providerRequestCount: 0, toolCallCount: 0 }),
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
