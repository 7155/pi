import { describe, expect, it } from "vitest";
import { stream } from "../src/api/pi-messages.ts";
import type { Model, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("pi-messages local nested receipt privacy", () => {
	it("does not transmit nested result bodies, arguments or metadata", async () => {
		const model: Model<"pi-messages"> = {
			id: "test",
			name: "Test",
			api: "pi-messages",
			provider: "test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "outer",
			toolName: "codemode",
			content: [{ type: "text", text: "selected output" }],
			isError: false,
			timestamp: 1,
			nestedCalls: {
				complete: true,
				calls: [
					{
						id: "outer/1",
						name: "read",
						status: "ok",
						arguments: { path: "private-nested-path" },
						result: {
							content: [{ type: "image", data: "private-image" }],
							details: { apiKey: "private-credential", memoryCheckpoint: "private-checkpoint" },
							structuredContent: { privateReceipt: "private-structured-receipt" },
						},
					},
				],
			},
		};
		let sentBody = "";
		const events = stream(model, normalizeContext({ messages: [message] }), {
			apiKey: "fixture-key",
			fetch: async (_url, init) => {
				sentBody = String(init?.body ?? "");
				return new Response(
					'data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		expect((await events.result()).stopReason).toBe("stop");
		expect(sentBody).toContain("selected output");
		for (const local of [
			"nestedCalls",
			"private-nested-path",
			"private-image",
			"private-credential",
			"private-checkpoint",
			"private-structured-receipt",
		]) {
			expect(sentBody).not.toContain(local);
		}
		expect(message.nestedCalls?.calls[0].result).toBeDefined();
	});
});
