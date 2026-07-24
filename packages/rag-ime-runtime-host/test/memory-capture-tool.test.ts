import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createMemoryCaptureExtension,
	prepareGovernedMemoryCapture,
	supportsMemoryCapture,
} from "../src/memory-capture-tool.ts";
import { MEMORY_CAPTURE_TOOL_NAME } from "../src/runtime-tool-names.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

function memoryRegistry(capture = true): BackendToolRegistry {
	const registry = new BackendToolRegistry();
	registry.sync([
		{
			name: "ime_memory",
			description: "Use the governed memory pipeline.",
			parameters: {
				type: "object",
				oneOf: [
					{
						type: "object",
						properties: {
							op: { const: capture ? "capture" : "recent" },
							kind: { type: "string" },
							claim: { type: "string" },
							captureScope: { type: "string" },
							reason: { type: "string" },
						},
					},
				],
			},
		},
	]);
	return registry;
}

describe("memory_capture runtime projection", () => {
	it("registers only when the existing ime_memory schema supports capture", async () => {
		const supported = memoryRegistry();
		const unsupported = memoryRegistry(false);
		expect(supportsMemoryCapture(supported.get("ime_memory"))).toBe(true);
		expect(supportsMemoryCapture(unsupported.get("ime_memory"))).toBe(false);

		const registered: string[] = [];
		const extension = createMemoryCaptureExtension({
			sessionId: "session-memory",
			registry: unsupported,
		});
		if (typeof extension === "function") throw new Error("Expected a named inline extension");
		await extension.factory({
			registerTool(definition: ToolDefinition) {
				registered.push(definition.name);
			},
		} as never);
		expect(registered).toEqual([]);
	});

	it("projects a small Provider tool onto governed ime_memory.capture", async () => {
		const registry = memoryRegistry();
		const definitions = new Map<string, ToolDefinition>();
		const options = {
			sessionId: "session-memory",
			registry,
			gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
			roomCapability: {
				manifestId: "manifest:memory",
				manifestHash: "a".repeat(64),
			},
		};
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { receiptId: "load:memory-capture" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, result: { stored: true, status: "pending" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await prepareGovernedMemoryCapture(options);
			expect(registry.loadReceipt("ime_memory")).toBe("load:memory-capture");
			expect(registry.isDisclosed("ime_memory")).toBe(false);

			const extension = createMemoryCaptureExtension(options);
			if (typeof extension === "function") throw new Error("Expected a named inline extension");
			await extension.factory({
				registerTool(definition: ToolDefinition) {
					definitions.set(definition.name, definition);
				},
			} as never);
			const tool = definitions.get(MEMORY_CAPTURE_TOOL_NAME);
			if (!tool) throw new Error("memory_capture was not registered");
			expect(JSON.stringify(tool.parameters)).not.toContain("sourceId");
			expect(JSON.stringify(tool.parameters)).not.toContain("maintenance_apply");

			await tool.execute(
				"call-memory",
				{
					kind: "preference",
					claim: "用户希望 Room 默认工作区托管。",
					scope: "project",
					reason: "这是稳定的项目运行偏好。",
				} as never,
				undefined,
				undefined,
				{} as never,
			);

			const loadRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
			expect(loadRequest).toMatchObject({
				sessionId: "session-memory",
				toolName: "ime_memory",
			});
			const executeRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
			expect(executeRequest).toMatchObject({
				sessionId: "session-memory",
				toolCallId: "call-memory",
				tool: "ime_memory",
				loadReceiptId: "load:memory-capture",
				args: {
					op: "capture",
					kind: "preference",
					claim: "用户希望 Room 默认工作区托管。",
					captureScope: "project",
					reason: "这是稳定的项目运行偏好。",
				},
			});
			expect(JSON.stringify(executeRequest)).not.toContain("memory_capture");
			expect(JSON.stringify(executeRequest)).not.toContain("sourceId");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
