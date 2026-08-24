import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.4",
		responseId: "response:test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 42,
	};
}

function projectEvent(event: Record<string, unknown>): Record<string, unknown> {
	const emitted: Array<{ payload: Record<string, unknown> }> = [];
	const session = Object.create(PiProductSession.prototype) as PiProductSession;
	Object.assign(session as unknown as Record<string, unknown>, {
		activeTurn: { turnId: "turn:test", clientMessageId: "message:test" },
		sequence: 0,
		emitEvent: (envelope: { payload: Record<string, unknown> }) => emitted.push(envelope),
		telemetry: () => ({}),
	});
	(session as unknown as { onSessionEvent(value: Record<string, unknown>): void }).onSessionEvent(event);
	return emitted[0].payload;
}

describe("Runtime Session event projection", () => {
	it("emits only message identity and the delta for cumulative tool-call updates", () => {
		const privateCumulativeArguments = "private-cumulative-arguments ".repeat(20_000);
		const message = assistant([
			{
				type: "toolCall",
				id: "call:delegate-batch",
				name: "room_partner",
				arguments: { op: "delegate_batch", tasks: privateCumulativeArguments },
			},
		]);

		const projected = projectEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "x",
				partial: message,
			},
		});

		expect(projected).toMatchObject({
			type: "message_update",
			message: { role: "assistant", responseId: "response:test", timestamp: 42 },
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x" },
		});
		expect(projected.message).not.toHaveProperty("content");
		expect(projected.assistantMessageEvent).not.toHaveProperty("partial");
		expect(JSON.stringify(projected)).not.toContain("private-cumulative-arguments");
		expect(JSON.stringify(projected).length).toBeLessThan(1_000);
	});

	it("preserves the completed public thinking summary without the duplicate partial", () => {
		const privateContinuationSignature = "private-provider-continuation ".repeat(8_000);
		const message = assistant([
			{
				type: "thinking",
				thinking: "public reasoning summary",
				thinkingSignature: privateContinuationSignature,
			},
		]);
		const projected = projectEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "public reasoning summary",
				partial: message,
			},
		});

		expect(projected.message).toEqual({
			role: "assistant",
			api: "openai-responses",
			responseId: "response:test",
			timestamp: 42,
			content: [{ type: "thinking", thinking: "public reasoning summary" }],
		});
		expect(projected.assistantMessageEvent).toEqual({
			type: "thinking_end",
			contentIndex: 0,
			content: "public reasoning summary",
		});
		expect(JSON.stringify(projected)).not.toContain("private-provider-continuation");
		expect(JSON.stringify(projected).length).toBeLessThan(1_000);
	});
});
