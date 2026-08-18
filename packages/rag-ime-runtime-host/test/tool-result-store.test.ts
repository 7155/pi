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
	vi.useRealTimers();
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

function hiddenMutationTarget(runtimeName: "edit" | "write"): BackendToolManifest {
	const operation = "apply";
	const mutationProperties =
		runtimeName === "edit"
			? {
					path: { type: "string" },
					resourceRevision: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
					edits: {
						type: "array",
						items: {
							type: "object",
							properties: { oldText: { type: "string" }, newText: { type: "string" } },
							required: ["oldText", "newText"],
						},
					},
				}
			: {
					path: { type: "string" },
					resourceRevision: { type: "string", pattern: "^(?:sha256:[0-9a-f]{64}|missing)$" },
					content: { type: "string" },
				};
	const required =
		runtimeName === "edit"
			? ["op", "path", "resourceRevision", "edits"]
			: ["op", "path", "resourceRevision", "content"];
	return {
		name: `workspace_${runtimeName}`,
		description: `Governed target for ${runtimeName}`,
		modelVisible: false,
		parameters: {
			type: "object",
			additionalProperties: false,
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					required,
					properties: { op: { const: operation }, ...mutationProperties },
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

		const visible = modelVisibleResult({ summary: "Search completed", output, matchCount: 8_000 }, store, "grep", {
			pattern: "semantic evidence",
			path: "src",
			limit: 100,
		}) as Record<string, unknown>;
		const serialized = JSON.stringify(visible);
		const handle = String(visible.evidenceHandle);

		expect(Object.keys(visible)[0]).toBe("evidenceHandle");
		expect(serialized.indexOf(handle)).toBeLessThan(100);
		// Pi's compaction serializer keeps only the first 2,000 characters of a
		// tool result. Both identity and the semantic outcome must survive that
		// exact boundary even after the raw payload becomes reclaimable.
		expect(serialized.slice(0, 2_000)).toContain(handle);
		expect(serialized.slice(0, 2_000)).toContain("Search completed");
		expect(serialized.slice(0, 2_000)).toContain("semantic evidence");
		expect(visible).toMatchObject({
			evidenceToolName: "grep",
			evidenceStatus: "completed",
			evidenceRequest: {
				pattern: "semantic evidence",
				path: "src",
				limit: 100,
			},
			evidenceSummary: "Search completed",
			evidenceAvailable: true,
			evidenceAvailability: "available_at_capture",
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

	it("keeps a useful semantic tombstone after reclaiming the raw result", () => {
		const store = temporaryStore(1024 * 1024);
		const visible = modelVisibleResult(
			{
				summary: "Found 100 matching call sites in 24 files",
				matches: Array.from({ length: 20_000 }, (_, index) => ({
					path: `src/file-${index % 24}.ts`,
					line: index + 1,
				})),
			},
			store,
			"grep",
			{
				pattern: "modelVisibleResult",
				path: "packages/rag-ime-runtime-host/src",
				limit: 100,
				apiKey: "must-not-survive",
			},
		) as Record<string, unknown>;
		const handle = String(visible.evidenceHandle);
		store.persist(`newer:${"z".repeat(900_000)}`, {
			toolName: "bash",
			status: "completed",
			requestSummary: { commandPreview: "run focused tests" },
			resultSummary: "Focused tests passed",
		});

		const reclaimed = store.read(handle);
		expect(reclaimed.available).toBe(false);
		expect(reclaimed.observations).toHaveLength(1);
		expect(reclaimed.observations[0]).toMatchObject({
			toolName: "grep",
			status: "completed",
			requestSummary: {
				pattern: "modelVisibleResult",
				path: "packages/rag-ime-runtime-host/src",
				limit: 100,
				apiKey: "[redacted]",
			},
			resultSummary: "Found 100 matching call sites in 24 files",
		});
		expect(reclaimed.content).toContain("rawPayloadAvailable=false");
		expect(reclaimed.content).toContain("observation1.tool=grep");
		expect(reclaimed.content).toContain("modelVisibleResult");
		expect(reclaimed.content).toContain("Found 100 matching call sites in 24 files");
		expect(reclaimed.content).not.toContain("must-not-survive");
	});

	it("restores an evicted content-addressed payload without changing its handle", () => {
		const store = temporaryStore(1024 * 1024);
		const original = `repeatable:${"x".repeat(700_000)}`;
		const first = store.persist(original, {
			toolName: "read",
			status: "completed",
			requestSummary: { path: "first.txt" },
			resultSummary: "Read first.txt",
		});
		store.persist(`newer:${"y".repeat(700_000)}`, "read");
		expect(store.read(first.evidenceHandle).available).toBe(false);

		const restored = store.persist(original, {
			toolName: "grep",
			status: "completed",
			requestSummary: { pattern: "repeatable", path: "first.txt" },
			resultSummary: "Found repeatable text",
		});

		expect(restored.evidenceHandle).toBe(first.evidenceHandle);
		const reread = store.read(first.evidenceHandle);
		expect(reread.available).toBe(true);
		expect(reread.observations.map((item) => item.toolName)).toEqual(["read", "grep"]);
	});
});

describe("governed Pi-native workspace tools", () => {
	it("streams truthful lifecycle updates while a governed bash request is still pending", async () => {
		vi.useFakeTimers();
		const registry = new BackendToolRegistry();
		registry.sync([hiddenTarget("workspace_shell", "bash", "run")]);
		const definitions = new Map<string, ToolDefinition<any, any, any>>();
		const extension = createNativeWorkspaceToolsExtension({
			sessionId: "session-native-bash-lifecycle",
			registry,
			gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			cwd: "/workspace",
			resultStore: temporaryStore(),
		});
		const factory = typeof extension === "function" ? extension : extension.factory;
		factory({
			registerTool(definition: ToolDefinition<any, any, any>) {
				definitions.set(definition.name, definition);
			},
		} as never);

		let resolveFetch: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const updates = vi.fn();

		const execution = definitions
			.get("bash")
			?.execute(
				"call-bash-lifecycle",
				{ command: "run focused tests", timeout: 20 },
				undefined,
				updates,
				{} as never,
			);

		expect(updates).toHaveBeenCalledTimes(1);
		expect(updates.mock.calls[0]?.[0]).toMatchObject({
			content: [],
			details: {
				schemaVersion: "rag-ime.projected-tool-lifecycle.v1",
				toolName: "bash",
				lifecycleStage: "started",
				elapsedMs: 0,
			},
		});

		await vi.advanceTimersByTimeAsync(2_100);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(updates).toHaveBeenCalledTimes(2);
		expect(updates.mock.calls[1]?.[0]).toMatchObject({
			content: [],
			details: {
				schemaVersion: "rag-ime.projected-tool-lifecycle.v1",
				toolName: "bash",
				lifecycleStage: "running",
			},
		});
		expect(String(updates.mock.calls[1]?.[0]?.details?.summary)).toContain("仍在执行");
		expect(JSON.stringify(updates.mock.calls)).not.toContain("workspace_shell");
		expect(JSON.stringify(updates.mock.calls)).not.toContain("stdout");
		expect(JSON.stringify(updates.mock.calls)).not.toContain("stderr");

		if (!resolveFetch) throw new Error("Expected the governed gateway request to start");
		resolveFetch(
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
		const result = await execution;

		expect(result?.content[0]).toEqual({
			type: "text",
			text: "three focused tests passed\n[exit code: 0]",
		});
		expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({
			content: [],
			details: {
				toolName: "bash",
				lifecycleStage: "response_received",
			},
		});
	});

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
		const factory = typeof extension === "function" ? extension : extension.factory;
		factory({
			registerTool(definition: ToolDefinition<any, any, any>) {
				definitions.set(definition.name, definition);
			},
		} as never);

		expect(registry.catalog()).toEqual([]);
		expect([...definitions]).toHaveLength(2);
		expect(definitions.get("read")?.description).toContain("offset/limit");
		expect(definitions.get("bash")?.executionMode).toBe("parallel");

		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						summary: "命令执行完成，退出码 0",
						output: "three focused tests passed",
						exitCode: 0,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		await definitions
			.get("read")
			?.execute("call-read", { path: "calculator.py", offset: 0, limit: 16_384 }, undefined, undefined, {} as never);
		const result = await definitions
			.get("bash")
			?.execute("call-bash", { command: "run focused tests", timeout: 20 }, undefined, undefined, {} as never);

		expect(result?.content[0]).toEqual({
			type: "text",
			text: "three focused tests passed\n[exit code: 0]",
		});
		const readRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			tool: string;
			args: Record<string, unknown>;
		};
		expect(readRequest).toMatchObject({
			tool: "workspace_read",
			args: {
				op: "read",
				path: "calculator.py",
				lineOffset: 1,
				lineLimit: 2_000,
			},
		});
		const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
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

	it("projects snapshot-bound edit and write schemas with truthful mutation receipts", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([
			hiddenTarget("workspace_read", "read", "read"),
			hiddenMutationTarget("edit"),
			hiddenMutationTarget("write"),
		]);
		const definitions = new Map<string, ToolDefinition<any, any, any>>();
		const extension = createNativeWorkspaceToolsExtension({
			sessionId: "session-native-mutations",
			registry,
			gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			cwd: "/workspace",
			resultStore: temporaryStore(),
		});
		const factory = typeof extension === "function" ? extension : extension.factory;
		factory({
			registerTool(definition: ToolDefinition<any, any, any>) {
				definitions.set(definition.name, definition);
			},
		} as never);

		const revision = `sha256:${"a".repeat(64)}`;
		const responses = [
			{
				summary: "已读取 source.ts 第 1-2 行",
				content: "const before = true;\n",
				startLine: 1,
				endLine: 1,
				resourceRevision: revision,
			},
			{
				summary: "已修改 source.ts 的 1 处内容",
				mutationApplied: true,
				path: "/workspace/source.ts",
				postimageSha256: "b".repeat(64),
			},
			{
				summary: "已创建 created.ts",
				mutationApplied: true,
				path: "/workspace/created.ts",
				postimageSha256: "c".repeat(64),
			},
		];
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: true, result: responses.shift() }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const readResult = await definitions
			.get("read")
			?.execute("call-read-revision", { path: "source.ts" }, undefined, undefined, {} as never);
		const editResult = await definitions.get("edit")?.execute(
			"call-edit",
			{
				path: "source.ts",
				resourceRevision: revision,
				edits: [{ oldText: "true", newText: "false" }],
			},
			undefined,
			undefined,
			{} as never,
		);
		const writeResult = await definitions
			.get("write")
			?.execute(
				"call-write",
				{ path: "created.ts", resourceRevision: "missing", content: "export {};\n" },
				undefined,
				undefined,
				{} as never,
			);

		expect(readResult?.content[0]).toEqual({
			type: "text",
			text: `[resourceRevision: ${revision}]\nconst before = true;\n`,
		});
		expect(editResult?.content[0]).toEqual({
			type: "text",
			text: `已修改 source.ts 的 1 处内容\npath=/workspace/source.ts\npostimageSha256=${"b".repeat(64)}`,
		});
		expect(writeResult?.content[0]).toEqual({
			type: "text",
			text: `已创建 created.ts\npath=/workspace/created.ts\npostimageSha256=${"c".repeat(64)}`,
		});
		const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))) as Array<{
			tool: string;
			args: Record<string, unknown>;
		}>;
		expect(requests[1]).toMatchObject({
			tool: "workspace_edit",
			args: {
				op: "apply",
				path: "source.ts",
				resourceRevision: revision,
				edits: [{ oldText: "true", newText: "false" }],
			},
		});
		expect(requests[2]).toMatchObject({
			tool: "workspace_write",
			args: {
				op: "apply",
				path: "created.ts",
				resourceRevision: "missing",
				content: "export {};\n",
			},
		});
		for (const name of ["edit", "write"] as const) {
			const parameters = definitions.get(name)?.parameters as unknown as {
				required?: string[];
				properties?: Record<string, unknown>;
			};
			expect(parameters.required).toContain("resourceRevision");
			expect(parameters.properties).not.toHaveProperty("op");
		}
	});

	it("reads an evidence handle locally without sending another gateway request", async () => {
		const registry = new BackendToolRegistry();
		registry.sync([hiddenTarget("workspace_read", "read", "read")]);
		const store = temporaryStore();
		const evidence = store.persist(`start\n${"evidence ".repeat(8_000)}\nend`, "bash");
		const definitions = new Map<string, ToolDefinition<any, any, any>>();
		const extension = createNativeWorkspaceToolsExtension({
			sessionId: "session-evidence-read",
			registry,
			gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
			cwd: "/workspace",
			resultStore: store,
		});
		const factory = typeof extension === "function" ? extension : extension.factory;
		factory({
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
