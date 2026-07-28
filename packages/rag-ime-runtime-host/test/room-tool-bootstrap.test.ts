import { describe, expect, it, vi } from "vitest";
import {
	bootstrapNativeWorkspaceToolTargets,
	createNativeWorkspaceToolsExtension,
} from "../src/native-workspace-tools.ts";
import { bootstrapRoomTools, ROOM_BOOTSTRAP_TOOL_NAMES } from "../src/room-tool-bootstrap.ts";
import {
	BASH_TOOL_NAME,
	EDIT_TOOL_NAME,
	FIND_TOOL_NAME,
	GREP_TOOL_NAME,
	LS_TOOL_NAME,
	READ_TOOL_NAME,
	WRITE_TOOL_NAME,
} from "../src/runtime-tool-names.ts";
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

function roomRegistryWithNativeTargets(): BackendToolRegistry {
	const registry = roomRegistry();
	const projectedParameters = (...operations: string[]) => ({
		type: "object",
		oneOf: operations.map((operation) => ({
			type: "object",
			properties: { op: { const: operation } },
			required: ["op"],
		})),
	});
	registry.sync([
		...registry.list(),
		{
			name: "workspace_read",
			description: "Read one authorized file.",
			parameters: projectedParameters("read"),
			modelVisible: false,
			runtimeProjections: [{ name: "read", operation: "read" }],
		},
		{
			name: "workspace_search",
			description: "Search the authorized workspace.",
			parameters: projectedParameters("search"),
			modelVisible: false,
			runtimeProjections: [
				{ name: "grep", operation: "search" },
				{ name: "find", operation: "search" },
			],
		},
		{
			name: "ime_memory",
			description: "Capture governed memory.",
			parameters: projectedParameters("capture"),
			modelVisible: false,
			runtimeProjections: [{ name: "memory_capture", operation: "capture" }],
		},
	]);
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

function ordinaryRegistryWithNativeTargets(): BackendToolRegistry {
	const registry = new BackendToolRegistry();
	const target = (name: string, runtimeProjections: Array<{ name: string; operation: string }>) => ({
		name,
		description: `Run ${name}.`,
		parameters: {
			type: "object",
			oneOf: runtimeProjections.map(({ operation }) => ({
				type: "object",
				properties: { op: { const: operation } },
				required: ["op"],
			})),
		},
		modelVisible: false,
		runtimeProjections,
	});
	registry.sync([
		target("workspace_read", [{ name: READ_TOOL_NAME, operation: "read" }]),
		target("workspace_search", [
			{ name: GREP_TOOL_NAME, operation: "search" },
			{ name: FIND_TOOL_NAME, operation: "search" },
		]),
		target("workspace_list", [{ name: LS_TOOL_NAME, operation: "list" }]),
		target("workspace_edit", [{ name: EDIT_TOOL_NAME, operation: "apply" }]),
		target("workspace_write", [{ name: WRITE_TOOL_NAME, operation: "apply" }]),
		target("workspace_shell", [{ name: BASH_TOOL_NAME, operation: "run" }]),
	]);
	return registry;
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

	it("preloads native coding targets without disclosing their backend schemas", async () => {
		const registry = roomRegistryWithNativeTargets();
		const fetchMock = vi.fn<typeof fetch>();
		for (const name of ROOM_BOOTSTRAP_TOOL_NAMES) {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: `receipt:${name}` } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					result: {
						items: ["workspace_read", "workspace_search"].map((name) => ({
							receiptId: `load:native:session-room:${"b".repeat(16)}:${name}`,
							toolName: name,
						})),
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await bootstrapRoomTools(options(registry));
			expect(await bootstrapNativeWorkspaceToolTargets(options(registry))).toEqual([
				"workspace_read",
				"workspace_search",
			]);
			expect(registry.disclosed().map((tool) => tool.name)).toEqual([...ROOM_BOOTSTRAP_TOOL_NAMES]);
			expect(registry.loadReceipt("workspace_read")).toContain(":workspace_read");
			expect(registry.loadReceipt("workspace_search")).toContain(":workspace_search");
			expect(registry.loadReceipt("ime_memory")).toBeUndefined();
			const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))) as Array<
				Record<string, unknown>
			>;
			expect(requests).toHaveLength(4);
			expect(requests.slice(0, 3).map((request) => request.toolName)).toEqual([...ROOM_BOOTSTRAP_TOOL_NAMES]);
			expect((requests[3].loads as Array<Record<string, unknown>>).map((item) => item.toolName)).toEqual([
				"workspace_read",
				"workspace_search",
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("registers every manifest-projected native coding tool for an ordinary Session without Room receipts", () => {
		const registry = ordinaryRegistryWithNativeTargets();
		const definitions = new Map<string, unknown>();
		const extension = createNativeWorkspaceToolsExtension({
			sessionId: "session-ordinary",
			registry,
			gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			cwd: "/workspace",
		}) as unknown as { factory(pi: unknown): void };
		extension.factory({
			registerTool(definition: { name: string }) {
				definitions.set(definition.name, definition);
			},
		} as never);

		expect([...definitions.keys()].sort()).toEqual(
			[
				READ_TOOL_NAME,
				GREP_TOOL_NAME,
				FIND_TOOL_NAME,
				LS_TOOL_NAME,
				EDIT_TOOL_NAME,
				WRITE_TOOL_NAME,
				BASH_TOOL_NAME,
			].sort(),
		);
		expect(registry.governedLoadReceipts()).toEqual([]);
		expect(registry.disclosed()).toEqual([]);
	});
});
