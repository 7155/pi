import { describe, expect, it } from "vitest";
import { PiDebugContextRecorder } from "../src/debug-context.ts";

type DebugHandler = (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown;

describe("PiDebugContextRecorder", () => {
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
		handlers.get("context")?.({
			messages: [{ role: "user", content: "final context" }],
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

		const captured = recorder.get("turn-1");
		expect(captured).toMatchObject({
			sessionId: "session-1",
			turnId: "turn-1",
			clientMessageId: "client-1",
			prompt: "raw user prompt",
			systemPrompt: "assembled system prompt",
			activeTools: ["read"],
		});
		expect(captured?.contextWindows[0]?.messages).toEqual([{ role: "user", content: "final context" }]);
		expect(captured?.providerRequests[0]?.payload).toMatchObject({
			model: "gpt-test",
			input: "final provider input",
			authorization: "[credential omitted]",
			api_key: "[credential omitted]",
			headers: { Authorization: "[credential omitted]", "x-api-key": "[credential omitted]" },
			image: expect.stringContaining("binary data omitted"),
		});
		expect(JSON.stringify(captured)).not.toContain("nested-secret");
		expect(JSON.stringify(captured)).not.toContain("x-secret");

		activeTurn = { turnId: "turn-2", clientMessageId: "client-2" };
		expect(recorder.get("turn-2")).toBeUndefined();
		recorder.clear();
		expect(recorder.get()).toBeUndefined();
	});
});
