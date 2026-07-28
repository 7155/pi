import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeWorkspaceToolsExtension } from "../src/native-workspace-tools.ts";
import { modelVisibleResult } from "../src/tool-artifact-buffer.ts";
import { type BackendToolManifest, BackendToolRegistry } from "../src/tool-bridge.ts";
import { ToolResultStore } from "../src/tool-result-store.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryStore(maxBytes?: number): ToolResultStore {
	const directory = mkdtempSync(join(tmpdir(), "pi-tool-evidence-"));
	temporaryDirectories.push(directory);
	return new ToolResultStore(directory, maxBytes);
}

function hiddenTarget(name: string, runtimeName: string, operation: string): BackendToolManifest {
	return {
		name,
		description: `Governed target for ${runtimeName}`,
		modelVisible: false,
		parameters: {
			type: "object",
			oneOf: [
				{
					type: "object",
					required: ["op"],
					properties: { op: { const: operation } },
				},
			],
		},
		runtimeProjections: [{ name: runtimeName, operation }],
	};
}

describe("ToolResultStore", () => {
	it("keeps a stable handle first in context and supports bounded continuation", () => {
		const store = temporaryStore();
		const output = `first evidence line\n${"semantic tool evidence ".repeat(8_000)}\nlast evidence line`;

		const visible = modelVisibleResult(
			{ summary: "Search completed", output, matchCount: 8_000 },
			store,
			"grep",
		) as Record<string, unknown>;
		const serialized = JSON.stringify(visible);
		const handle = String(visible.evidenceHandle);

		expect(Object.keys(visible)[0]).toBe("evidenceHandle");
		expect(serialized.indexOf(handle)).toBeLessThan(100);
		// Pi's compaction serializer keeps only the first 2,000 characters of a
		// tool result. Both identity and the semantic outcome must survive that
		// exact boundary even after the raw payload becomes reclaimable.
		expect(serialized.slice(0, 2_000)).toContain(handle);
		expect(serialized.slice(0, 2_000)).toContain("Search completed");
		expect(visible).toMatchObject({
			evidenceAvailable: true,
			summary: "Search completed",
			matchCount: 8_000,
			truncated: true,
			modelResultTruncated: true,
			continuation: { tool: "read", path: handle, offset: 1, limit: 1 },
		});
		const first = store.read(handle, 1);
		expect(first.available).toBe(true);
		expect(first.content).toContain("first evidence line");
		expect(first.nextSegment).toBe(2);
		const last = store.read(handle, first.segmentCount);
		expect(last.content).toContain("last evidence line");
		expect(last.nextSegment).toBeUndefined();
	});

	it("reclaims old payloads without deleting their evidence metadata", () => {
		const store = temporaryStore(1024 * 1024);
		const first = store.persist(`old:${"a".repeat(700_000)}`, "bash");
		const second = store.persist(`new:${"b".repeat(700_000)}`, "bash");

		const reclaimed = store.read(first.evidenceHandle);
		const current = store.read(second.evidenceHandle);
		expect(reclaimed).toMatchObject({
			handle: first.evidenceHandle,
			sha256: first.evidenceSha256,
			byteSize: first.evidenceBytes,
			available: false,
			segmentCount: 0,
		});
		expect(reclaimed.content).toContain("payload was reclaimed");
		expect(current.available).toBe(true);
		expect(current.content).toContain("new:");
	});

	it("restores an evicted content-addressed payload without changing its handle", () => {
		const store = temporaryStore(1024 * 1024);
		const original = `repeatable:${"x".repeat(700_000)}`;
		const first = store.persist(original, "read");
		store.persist(`newer:${"y".repeat(700_000)}`, "read");
		expect(store.read(first.evidenceHandle).available).toBe(false);

		const restored = store.persist(original, "read");

		expect(restored.evidenceHandle).toBe(first.evidenceHandle);
		expect(store.read(first.evidenceHandle).available).toBe(true);
	});
});

describe("governed Pi-native workspace tools", () => {
	it("keeps backend targets hidden while exposing native tools with actual results", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([hiddenTarget("workspace_read", "read", "read"), hiddenTarget("workspace_shell", "bash", "run")]);
		const definitions = new Map<string, ToolDefinition<any, any, any>>();
		const extension = createNativeWorkspaceToolsExtension({
			sessionId: "session-native-tools",
			registry,
			gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			cwd: "/workspace",
			resultStore: temporaryStore(),
		});
		extension.factory({
			registerTool(definition: ToolDefinition<any, any, any>) {
				definitions.set(definition.name, definition);
			},
		} as never);

		expect(registry.catalog()).toEqual([]);
		expect([...definitions]).toHaveLength(2);
		expect(definitions.get("read")?.description).toContain("offset/limit");
		expect(definitions.get("bash")?.executionMode).toBe("parallel");

		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: {
						summary: "命令执行完成，退出码 0",
						output: "three focused tests passed",
						exitCode: 0,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await definitions
			.get("bash")
			?.execute("call-bash", { command: "run focused tests", timeout: 20 }, undefined, undefined, {} as never);

		expect(result?.content[0]).toEqual({
			type: "text",
			text: "three focused tests passed\n[exit code: 0]",
		});
		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			tool: string;
			args: Record<string, unknown>;
		};
		expect(request).toMatchObject({
			tool: "workspace_shell",
			args: {
				op: "run",
				command: "run focused tests",
				cwd: "/workspace",
				timeoutSeconds: 20,
				allowNetwork: false,
			},
		});
	});

	it("reads an evidence handle locally without sending another gateway request", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([hiddenTarget("workspace_read", "read", "read")]);
		const store = temporaryStore();
		const evidence = store.persist(`start\n${"evidence ".repeat(8_000)}\nend`, "bash");
		const definitions = new Map<string, ToolDefinition<any, any, any>>();
		createNativeWorkspaceToolsExtension({
			sessionId: "session-evidence-read",
			registry,
			gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			cwd: "/workspace",
			resultStore: store,
		}).factory({
			registerTool(definition: ToolDefinition<any, any, any>) {
				definitions.set(definition.name, definition);
			},
		} as never);
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		const result = await definitions
			.get("read")
			?.execute(
				"call-read-evidence",
				{ path: evidence.evidenceHandle, offset: 1, limit: 1 },
				undefined,
				undefined,
				{} as never,
			);

		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`handle=${evidence.evidenceHandle}`);
		expect(text).toContain("start");
		expect(text).toContain("Continue with read");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
