import { describe, expect, it, vi } from "vitest";
import { bootstrapRoomTools, ROOM_BOOTSTRAP_TOOL_NAMES } from "../src/room-tool-bootstrap.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

function roomRegistry(): BackendToolRegistry {
	const registry = new BackendToolRegistry();
	registry.sync(
		ROOM_BOOTSTRAP_TOOL_NAMES.map((name) => ({
			name,
			description: `Run ${name}.`,
			parameters: { type: "object", properties: {} },
		})),
	);
	return registry;
}

function options(registry: BackendToolRegistry) {
	return {
		sessionId: "session-room",
		registry,
		gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
		roomCapability: {
			manifestId: "manifest:room",
			manifestHash: "b".repeat(64),
		},
	};
}

describe("Room bootstrap tools", () => {
	it("loads and discloses the three stable Room tools in lifecycle order", async () => {
		const registry = roomRegistry();
		const fetchMock = vi.fn<typeof fetch>();
		for (const name of ROOM_BOOTSTRAP_TOOL_NAMES) {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: `receipt:${name}` } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		vi.stubGlobal("fetch", fetchMock);
		try {
			expect(await bootstrapRoomTools(options(registry))).toEqual([...ROOM_BOOTSTRAP_TOOL_NAMES]);
			expect(registry.disclosed().map((tool) => tool.name)).toEqual([...ROOM_BOOTSTRAP_TOOL_NAMES]);
			expect(registry.governedLoadReceipts()).toEqual(
				[...ROOM_BOOTSTRAP_TOOL_NAMES].map((name) => ({ name, receiptId: `receipt:${name}` })),
			);
			const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))) as Array<
				Record<string, unknown>
			>;
			expect(requests.map((request) => request.toolName)).toEqual([...ROOM_BOOTSTRAP_TOOL_NAMES]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps Provider visibility unchanged when a governed load fails", async () => {
		const registry = roomRegistry();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: "receipt:room_state" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: false, error: "load rejected" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(bootstrapRoomTools(options(registry))).rejects.toThrow("load rejected");
			expect(registry.disclosed()).toEqual([]);
			expect(registry.governedLoadReceipts()).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
