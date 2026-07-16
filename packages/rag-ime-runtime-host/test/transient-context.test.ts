import { describe, expect, it } from "vitest";
import {
	decodeRuntimePrompt,
	injectTransientContext,
	TRANSIENT_CONTEXT_ENVELOPE_PREFIX,
} from "../src/transient-context.ts";

describe("transient context", () => {
	it("decodes the gateway envelope without changing the persisted user message", () => {
		const encoded =
			TRANSIENT_CONTEXT_ENVELOPE_PREFIX +
			JSON.stringify({
				schemaVersion: "rag-ime.runtime-prompt.v1",
				message: "继续当前任务",
				transientContext: "<context>只在本回合可见</context>",
			});

		expect(decodeRuntimePrompt(encoded)).toEqual({
			message: "继续当前任务",
			transientContext: "<context>只在本回合可见</context>",
		});
	});

	it("injects context before the current user message without mutating history", () => {
		const history = [
			{ role: "user" as const, content: "上一次问题", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [],
				api: "openai-responses" as const,
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 2,
			},
			{ role: "user" as const, content: "当前问题", timestamp: 3 },
		];

		const injected = injectTransientContext(history, "临时上下文");

		expect(history).toHaveLength(3);
		expect(injected).toHaveLength(4);
		expect(injected[2]).toMatchObject({
			role: "custom",
			customType: "rag-ime.transient-context",
			content: "临时上下文",
			display: false,
		});
		expect(injected[3]).toBe(history[2]);
	});

	it("rejects malformed envelopes instead of storing them as user text", () => {
		expect(() => decodeRuntimePrompt(`${TRANSIENT_CONTEXT_ENVELOPE_PREFIX}{`)).toThrow("not valid JSON");
	});
});
