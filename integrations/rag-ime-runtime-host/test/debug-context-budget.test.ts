import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiDebugContextRecorder } from "../src/debug-context.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return { ...actual, open: vi.fn(actual.open) };
});

type DebugHandler = (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown;
const directories: string[] = [];

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-debug-context-budget-"));
	directories.push(directory);
	const sessionId = "synthetic-budget-session";
	const sessionDirectory = join(directory, sessionId);
	mkdirSync(sessionDirectory);
	return { directory, sessionId, sessionDirectory };
}

function snapshot(sessionId: string, index: number, content: string) {
	return {
		schemaVersion: "rag-ime.context-inspection.v2",
		sessionId,
		turnId: `turn-${index}`,
		capturedAtMs: index,
		prompt: content,
	};
}

function capture(recorder: PiDebugContextRecorder) {
	const handlers = new Map<string, DebugHandler>();
	recorder.extension()({
		on: (name: string, handler: DebugHandler) => handlers.set(name, handler),
		getActiveTools: () => [],
		getAllTools: () => [],
	} as never);
	handlers.get("before_agent_start")?.({ prompt: "test", systemPrompt: "system", systemPromptOptions: {} }, {});
	return handlers;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("debug context memory budgets", () => {
	it("defers a snapshot larger than the read budget without deleting the historical file", async () => {
		const { directory, sessionId, sessionDirectory } = fixture();
		const path = join(sessionDirectory, "1-turn-1.json");
		writeFileSync(path, JSON.stringify(snapshot(sessionId, 1, "x".repeat(128 * 1024))));
		const originalBytes = statSync(path).size;
		const recorder = new PiDebugContextRecorder(sessionId, () => undefined, { directory, maxBytes: 64 * 1024 });
		await recorder.flush();
		expect(recorder.list()).toEqual([]);
		expect(recorder.storage()).toMatchObject({
			omissions: [expect.objectContaining({ reason: "snapshot_byte_budget", path, bytes: originalBytes })],
		});
		expect(statSync(path).size).toBe(originalBytes);
	});

	it("restores newest snapshots within one aggregate budget, preserving deferred files", async () => {
		const { directory, sessionId, sessionDirectory } = fixture();
		for (const index of [1, 2, 3]) {
			const path = join(sessionDirectory, `${index}-turn-${index}.json`);
			writeFileSync(path, JSON.stringify(snapshot(sessionId, index, "x".repeat(40 * 1024))));
			utimesSync(path, index, index);
		}
		const recorder = new PiDebugContextRecorder(sessionId, () => undefined, { directory, maxBytes: 64 * 1024 });
		await recorder.flush();
		expect(recorder.list().map((entry) => entry.turnId)).toEqual(["turn-3"]);
		expect(recorder.storage()).toMatchObject({
			fileCount: 3,
			omissions: [
				expect.objectContaining({ reason: "restore_byte_budget" }),
				expect.objectContaining({ reason: "restore_byte_budget" }),
			],
		});
	});

	it("checks oversized capture values before JSON serialization and leaves the actual event unchanged", () => {
		const recorder = new PiDebugContextRecorder("live", () => ({ turnId: "turn" }));
		const handlers = capture(recorder);
		const payload = { input: "界".repeat(400_000) };
		const stringify = vi.spyOn(JSON, "stringify");
		handlers.get("before_provider_request")?.({ payload });
		expect(stringify.mock.calls.some(([value]) => value === payload)).toBe(false);
		expect(recorder.get()?.providerRequests[0]?.payload).toMatchObject({
			omitted: true,
			reason: "capture_byte_budget",
		});
		expect(payload.input.length).toBe(400_000);
	});

	it("does not execute arbitrary toJSON hooks while inspecting a payload", () => {
		const recorder = new PiDebugContextRecorder("live", () => ({ turnId: "turn" }));
		const handlers = capture(recorder);
		const toJSON = vi.fn(() => ({ expanded: "unexpected" }));
		handlers.get("before_provider_request")?.({ payload: { toJSON } });
		expect(toJSON).not.toHaveBeenCalled();
		expect(recorder.get()?.providerRequests[0]?.payload).toMatchObject({ omitted: true });
	});

	it("skips a sparse 423 MB historical snapshot before opening it and never replaces it", async () => {
		const { directory, sessionId, sessionDirectory } = fixture();
		const path = join(sessionDirectory, "1-turn-1.json");
		writeFileSync(path, "");
		truncateSync(path, 423_292_319);
		const opening = vi.mocked(fsPromises.open);
		opening.mockClear();
		const recorder = new PiDebugContextRecorder(sessionId, () => ({ turnId: "turn-1" }), {
			directory,
			maxBytes: 64 * 1024,
		});
		await recorder.flush();
		expect(opening).not.toHaveBeenCalled();
		expect(recorder.get("turn-1")).toBeUndefined();
		const handlers = capture(recorder);
		handlers.get("before_provider_request")?.({ payload: { input: "new, small checkpoint" } });
		handlers.get("after_provider_response")?.({ status: 200, headers: {} });
		await recorder.flush();
		expect(statSync(path).size).toBe(423_292_319);
		expect(recorder.storage().error).toContain("cannot be pruned");
		expect(recorder.storage().omissions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path, reason: "snapshot_byte_budget", bytes: 423_292_319 }),
			]),
		);
	});

	it("bounds the actual read when the file grows after the open handle was statted", async () => {
		const { directory, sessionId, sessionDirectory } = fixture();
		const path = join(sessionDirectory, "1-turn-1.json");
		writeFileSync(path, JSON.stringify(snapshot(sessionId, 1, "small")));
		const opening = vi.mocked(fsPromises.open);
		const actualOpen = opening.getMockImplementation();
		if (!actualOpen) throw new Error("expected a real file opener");
		opening.mockImplementationOnce(async (...args) => {
			const handle = await actualOpen(...args);
			const stat = handle.stat.bind(handle);
			vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
				const metadata = await stat();
				writeFileSync(path, JSON.stringify(snapshot(sessionId, 1, "x".repeat(128 * 1024))));
				return metadata;
			});
			return handle;
		});
		const recorder = new PiDebugContextRecorder(sessionId, () => undefined, { directory, maxBytes: 64 * 1024 });
		await recorder.flush();
		expect(recorder.list()).toEqual([]);
		expect(recorder.storage().omissions).toEqual([
			expect.objectContaining({ path, reason: "snapshot_changed_or_oversized" }),
		]);
		expect(statSync(path).size).toBeGreaterThan(128 * 1024);
	});

	it("bounds live inspection bodies while preserving call identity, skill receipts, and input values", () => {
		const recorder = new PiDebugContextRecorder("live", () => ({ turnId: "turn" }), { maxCallsPerTurn: 128 });
		const handlers = capture(recorder);
		const skill = { name: "test-skill", contentRevision: "revision-1", sourceRef: "skill://test-skill" };
		handlers.get("tool_execution_start")?.({ toolCallId: "skill-1", toolName: "skill_load", args: {} });
		handlers.get("tool_execution_end")?.({
			toolCallId: "skill-1",
			toolName: "skill_load",
			result: { details: skill },
			isError: false,
		});
		const payload = { input: "x".repeat(700_000) };
		for (let index = 0; index < 24; index += 1) {
			handlers.get("context")?.({ messages: [{ role: "user", content: payload.input, index }] });
			handlers.get("before_provider_request")?.({ payload });
		}
		const record = recorder.get();
		expect(record?.modelCalls).toHaveLength(24);
		expect(record?.providerRequestReceipts).toHaveLength(24);
		expect(record?.inspectionOmissions).toContainEqual(expect.objectContaining({ reason: "retained_byte_budget" }));
		expect(record?.modelCalls[0]?.contextMessages).toMatchObject({ omitted: true });
		expect(recorder.loadedSkillRecoveryReceipts()).toEqual([skill]);
		expect(recorder.list()[0]?.omitted).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(recorder.storage().limits.snapshotBytes);
		expect(recorder.storage().retainedBytes).toBeLessThanOrEqual(recorder.storage().limits.retainedBytes);
		expect(payload.input).toBe("x".repeat(700_000));
	});

	it("bounds retention across eight turns even when each turn fits its own budget", () => {
		let activeTurn = { turnId: "turn-0" };
		const recorder = new PiDebugContextRecorder("live", () => activeTurn);
		const handlers = capture(recorder);
		for (let index = 0; index < 8; index += 1) {
			activeTurn = { turnId: `turn-${index}` };
			handlers.get("before_agent_start")?.({ prompt: "test", systemPrompt: "system", systemPromptOptions: {} }, {});
			for (let call = 0; call < 3; call += 1) {
				handlers.get("before_provider_request")?.({ payload: { input: "y".repeat(800_000), call } });
			}
		}
		expect(recorder.list()).toHaveLength(8);
		expect(recorder.storage().retainedBytes).toBeLessThanOrEqual(recorder.storage().limits.retainedBytes);
		expect(recorder.get("turn-0")?.providerRequests[0]?.payload).toMatchObject({ omitted: true });
		expect(recorder.get("turn-7")?.providerRequests.at(-1)?.payload).toMatchObject({ call: 2 });
	});

	it("bounds pending checkpoints while a burst of retired turns waits on the storage queue", async () => {
		const { directory, sessionId, sessionDirectory } = fixture();
		let activeTurn = { turnId: "turn-0" };
		const recorder = new PiDebugContextRecorder(sessionId, () => activeTurn, { directory });
		const handlers = capture(recorder);
		for (let index = 0; index < 20; index += 1) {
			activeTurn = { turnId: `turn-${index}` };
			handlers.get("before_agent_start")?.({ prompt: "test", systemPrompt: "system", systemPromptOptions: {} }, {});
			recorder.clear();
		}
		await recorder.flush();
		expect(readdirSync(sessionDirectory)).toHaveLength(8);
		expect(recorder.storage().omissions).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "persistence_queue_budget" })]),
		);
	});

	it("rejects sparse collection amplification and accessors before cloning", () => {
		const recorder = new PiDebugContextRecorder("live", () => ({ turnId: "turn" }));
		const handlers = capture(recorder);
		const getter = vi.fn(() => "private");
		const payload = Object.defineProperty({}, "content", { enumerable: true, get: getter });
		handlers.get("before_provider_request")?.({ payload });
		handlers.get("before_provider_request")?.({ payload: new Array(65_536) });
		expect(getter).not.toHaveBeenCalled();
		expect(recorder.get()?.providerRequests.map((entry) => entry.payload)).toEqual([
			expect.objectContaining({ omitted: true, reason: "capture_unsupported_value" }),
			expect.objectContaining({ omitted: true, reason: "capture_structure_budget" }),
		]);
	});
});
