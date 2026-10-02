import { afterEach, expect, it, vi } from "vitest";
import { BackendToolRegistry, createBackendToolDefinition } from "../src/tool-bridge.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["message:old", ""])("freezes exact turn and Room identity before capacity waiting (%s)", async (clientMessageId) => {
	let binding = { turnId: "turn:old", clientMessageId };
	const roomCapability = { roomId: "room:one", rootId: "root:old", dispatchId: "dispatch:old", generation: 1 };
	const requests: Array<Record<string, unknown>> = [];
	const release: Array<() => void> = [];
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		await new Promise<void>((resolve) => release.push(resolve));
		return new Response(JSON.stringify({ ok: true, result: { summary: "done" } }));
	}));
	const tool = createBackendToolDefinition({
		sessionId: "session:one",
		registry: new BackendToolRegistry(),
		gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
		executionBinding: () => binding,
		roomCapability,
	}, { name: "workspace_read", description: "read", parameters: { type: "object" } });
	const pending = Array.from({ length: 9 }, (_, index) =>
		tool.execute(`call:${index}`, {}, undefined, undefined, {} as never));
	await vi.waitFor(() => expect(requests).toHaveLength(8));
	binding = { turnId: "turn:new", clientMessageId: "message:new" };
	roomCapability.rootId = "root:new";
	roomCapability.dispatchId = "dispatch:new";
	release[0]();
	await vi.waitFor(() => expect(requests).toHaveLength(9));
	expect(requests[8].executionBinding).toEqual({ turnId: "turn:old", clientMessageId });
	expect(requests[8].roomCapability).toEqual({
		roomId: "room:one", rootId: "root:old", dispatchId: "dispatch:old", generation: 1,
	});
	for (const finish of release) finish();
	await Promise.all(pending);
});
