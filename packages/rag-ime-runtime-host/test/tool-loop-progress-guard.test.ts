import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolLoopProgressGuard } from "../src/tool-loop-progress-guard.ts";

describe("ToolLoopProgressGuard", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not cap a long loop that keeps producing successful tool evidence", () => {
		const guard = new ToolLoopProgressGuard({
			maxConsecutiveAllErrorTurns: 2,
			maxRepeatedFailureSignature: 2,
		});
		for (let index = 0; index < 50; index++) {
			expect(guard.shouldStop(turn(index, false, `result ${index}`))).toBe(false);
		}
		expect(guard.stopReceipt()).toBeUndefined();
	});

	it("stops the same normalized failure signature without depending on volatile ids", () => {
		const guard = new ToolLoopProgressGuard({
			maxConsecutiveAllErrorTurns: 8,
			maxRepeatedFailureSignature: 3,
		});
		expect(guard.shouldStop(turn(1, true, "request 12345 failed for 11111111-1111-4111-8111-111111111111"))).toBe(
			false,
		);
		expect(guard.shouldStop(turn(2, true, "request 67890 failed for 22222222-2222-4222-8222-222222222222"))).toBe(
			false,
		);
		expect(guard.shouldStop(turn(3, true, "request 54321 failed for 33333333-3333-4333-8333-333333333333"))).toBe(
			true,
		);
		expect(guard.stopReceipt()).toEqual({
			schemaVersion: "rag-ime.tool-loop-progress-stop.v1",
			reason: "repeated_failure_signature",
			consecutiveAllErrorTurns: 3,
			repeatedFailureSignature: 3,
			toolNames: ["read"],
		});
	});

	it("bounds varied all-error turns and resets after any successful tool result", () => {
		const guard = new ToolLoopProgressGuard({
			maxConsecutiveAllErrorTurns: 4,
			maxRepeatedFailureSignature: 3,
		});
		expect(guard.shouldStop(turn(1, true, "first failure"))).toBe(false);
		expect(guard.shouldStop(turn(2, true, "second failure"))).toBe(false);
		expect(guard.shouldStop(turn(3, false, "new evidence"))).toBe(false);
		expect(guard.shouldStop(turn(4, true, "fourth failure"))).toBe(false);
		expect(guard.shouldStop(turn(5, true, "fifth failure"))).toBe(false);
		expect(guard.shouldStop(turn(6, true, "sixth failure"))).toBe(false);
		expect(guard.shouldStop(turn(7, true, "seventh failure"))).toBe(true);
		expect(guard.stopReceipt()?.reason).toBe("consecutive_all_error_turns");
	});

	it("resets between externally accepted prompts", () => {
		const guard = new ToolLoopProgressGuard({
			maxConsecutiveAllErrorTurns: 2,
			maxRepeatedFailureSignature: 2,
		});
		expect(guard.shouldStop(turn(1, true, "same failure"))).toBe(false);
		guard.reset();
		expect(guard.shouldStop(turn(2, true, "same failure"))).toBe(false);
		expect(guard.stopReceipt()).toBeUndefined();
	});

	it("aborts a managed recovery provider call that never settles after an all-error turn", async () => {
		vi.useFakeTimers();
		const guard = new ToolLoopProgressGuard({ maxRecoveryWaitMs: 1_000 });
		const onTimeout = vi.fn();

		expect(guard.shouldStop(turn(1, true, "invalid room_commit payload"))).toBe(false);
		guard.armRecoveryTimeout(onTimeout);
		await vi.advanceTimersByTimeAsync(999);
		expect(onTimeout).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onTimeout).toHaveBeenCalledOnce();
		expect(guard.stopReceipt()).toMatchObject({
			reason: "all_error_recovery_timeout",
			toolNames: ["read"],
		});
	});

	it("clears the recovery deadline as soon as a later turn completes", async () => {
		vi.useFakeTimers();
		const guard = new ToolLoopProgressGuard({ maxRecoveryWaitMs: 1_000 });
		const onTimeout = vi.fn();

		expect(guard.shouldStop(turn(1, true, "invalid room_commit payload"))).toBe(false);
		guard.armRecoveryTimeout(onTimeout);
		expect(guard.shouldStop(turn(2, false, "recovered"))).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onTimeout).not.toHaveBeenCalled();
	});
});

function turn(index: number, isError: boolean, text: string) {
	const toolCallId = `call-${index}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/tmp/missing" } }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: index,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		details: {},
		isError,
		timestamp: index,
	};
	return { message, toolResults: [result] };
}
