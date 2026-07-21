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

	it("turns one product repair receipt into a native structured continuation", async () => {
		const fetchMock = vi.fn(async () =>
			gatewayResponse({
				ok: true,
				result: {
					state: "repair",
					dispatchId: "dispatch:1",
					message: "请补齐 room_commit",
					repairKey: "repair:1",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const handler = captureHandler(() => activeRoom);

		await expect(handler(event)).resolves.toEqual({
			followUp: {
				text: "请补齐 room_commit",
				continuation: {
					id: "room-settle-repair:repair:1",
					correlationId: "root:1",
					origin: "room_settle_guard",
					idempotencyKey: "repair:1",
					cancelGeneration: 3,
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
