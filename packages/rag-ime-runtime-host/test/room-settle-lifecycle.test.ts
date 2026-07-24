import type { BeforeAgentSettleEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ActiveRoomDispatch, createRoomSettleLifecycleExtension } from "../src/room-settle-lifecycle.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

const activeRoom: ActiveRoomDispatch = {
	dispatchId: "dispatch:1",
	rootId: "root:1",
	generation: 2,
	capabilityEpoch: 7,
};

const event = {
	type: "before_agent_settle",
	settleAttempt: 2,
	cancelScope: { scopeId: "scope:1", generation: 3 },
	message: { role: "assistant", content: [] },
} as unknown as BeforeAgentSettleEvent;

function captureHandler(getActiveRoom: () => ActiveRoomDispatch | undefined) {
	let handler: ((value: BeforeAgentSettleEvent) => Promise<unknown>) | undefined;
	const extension = createRoomSettleLifecycleExtension({
		bridge: {
			sessionId: "session:1",
			registry: new BackendToolRegistry(),
			gatewayUrl: "http://product.test/api/agent/tool/execute",
			gatewayToken: "token:test",
		},
		getActiveRoom,
		getResourceUsage: () => ({ inputTokens: 100, outputTokens: 20, toolCalls: 1 }),
	});
	extension({
		on(name: string, candidate: (value: BeforeAgentSettleEvent) => Promise<unknown>) {
			if (name === "before_agent_settle") handler = candidate;
		},
	} as never);
	if (!handler) throw new Error("before_agent_settle handler was not registered");
	return handler;
}

function gatewayResponse(payload: Record<string, unknown>, ok = true) {
	return {
		ok,
		status: ok ? 200 : 503,
		json: async () => payload,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Room settle lifecycle", () => {
	it("is a strict no-op for an ordinary Agent Session", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const handler = captureHandler(() => undefined);

		await expect(handler(event)).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["error", "aborted"] as const)(
		"does not turn a %s Provider result into a missing-room-commit repair",
		async (stopReason) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			const handler = captureHandler(() => activeRoom);

			await expect(
				handler({
					...event,
					message: {
						...event.message,
						stopReason,
						errorMessage: stopReason === "error" ? "upstream failed" : undefined,
					},
				}),
			).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["continue", "继续推进并核验证据", "room_goal_guard"],
		["repair_commit", "请修正 room_commit", "room_commit_guard"],
	] as const)("turns one product %s receipt into a native structured continuation", async (state, message, origin) => {
		const fetchMock = vi.fn(async () =>
			gatewayResponse({
				ok: true,
				result: {
					state,
					dispatchId: "dispatch:1",
					message,
					followUpKey: "follow-up:1",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const handler = captureHandler(() => activeRoom);

		await expect(handler(event)).resolves.toEqual({
			followUp: {
				text: message,
				continuation: {
					id: "room-settle-follow-up:follow-up:1",
					correlationId: "root:1",
					origin,
					idempotencyKey: "follow-up:1",
					maxAttempts: 1,
				},
			},
		});
		const [, request] = fetchMock.mock.calls[0] as unknown as [string, { body?: unknown }];
		const body = JSON.parse(String(request.body)) as Record<string, unknown>;
		expect(body).toMatchObject({
			sessionId: "session:1",
			dispatchId: "dispatch:1",
			rootId: "root:1",
			generation: 2,
			capabilityEpoch: 7,
			settleScopeId: "scope:1",
			settleAttempt: 2,
			resourceUsage: { repairCount: 1 },
		});
	});

	it("accepts committed and blocked product decisions without another model turn", async () => {
		for (const state of ["committed", "blocked"] as const) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => gatewayResponse({ ok: true, result: { state, dispatchId: "dispatch:1" } })),
			);
			const handler = captureHandler(() => activeRoom);
			await expect(handler(event)).resolves.toBeUndefined();
			vi.unstubAllGlobals();
		}
	});

	it("fails closed when the product cannot settle the Dispatch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => gatewayResponse({ ok: false, error: "kernel unavailable" }, false)),
		);
		const handler = captureHandler(() => activeRoom);

		await expect(handler(event)).rejects.toThrow("kernel unavailable");
	});
});
