import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const protocolVersion = "2";
const children: ChildProcessWithoutNullStreams[] = [];

async function startHost(slow = false) {
	const stateRoot = await mkdtemp(join(tmpdir(), "rag-ime-real-host-e2e-"));
	const child = spawn(process.execPath, [join(packageRoot, "dist/cli.js")], {
		cwd: workspaceRoot,
		env: {
			...process.env,
			NODE_ENV: "test",
			RAG_IME_PI_DETERMINISTIC_ADAPTER: "room-v2",
			RAG_IME_PI_DETERMINISTIC_SLOW: slow ? "1" : "0",
			RAG_IME_APP_SUPPORT_DIR: stateRoot,
			RAG_IME_WORKSPACE_ROOTS: workspaceRoot,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const messages: Record<string, any>[] = [];
	const waiters = new Set<() => void>();
	createInterface({ input: child.stdout }).on("line", (line) => {
		messages.push(JSON.parse(line));
		for (const wake of waiters) wake();
	});
	const waitFor = async (predicate: (message: Record<string, any>) => boolean, timeoutMs = 10_000) => {
		const existing = messages.find(predicate);
		if (existing) return existing;
		return new Promise<Record<string, any>>((accept, reject) => {
			const timeout = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`Timed out waiting for host message. stderr=${child.stderr.read() ?? ""}`));
			}, timeoutMs);
			const check = () => {
				const match = messages.find(predicate);
				if (!match) return;
				clearTimeout(timeout);
				waiters.delete(check);
				accept(match);
			};
			waiters.add(check);
		});
	};
	const request = async (id: string, method: string, params: Record<string, unknown>) => {
		child.stdin.write(`${JSON.stringify({ protocolVersion, id, method, params })}\n`);
		return waitFor((message) => message.id === id);
	};
	const close = async () => {
		const closed = new Promise<void>((accept) => child.once("close", () => accept()));
		child.stdin.end();
		child.kill("SIGTERM");
		await closed;
		await rm(stateRoot, { recursive: true, force: true });
	};
	return { child, messages, waitFor, request, close };
}

async function openSession(host: Awaited<ReturnType<typeof startHost>>) {
	const hash = "a".repeat(64);
	return host.request("open", "session.open", {
		sessionId: "session:e2e",
		cwd: workspaceRoot,
		provider: "rag-ime-deterministic",
		modelId: "room-v2-test",
		noContextFiles: true,
		toolManifest: [{ name: "product_probe", description: "test manifest", parameters: { type: "object" } }],
		roomCapability: {
			manifestId: "manifest:test",
			manifestHash: hash,
			capabilityEpoch: 1,
			promptCompileReceiptId: "receipt:test",
			promptPlanHash: hash,
			toolNames: ["room_post"],
		},
	});
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (!child.killed) child.kill("SIGTERM");
	}
});

describe("runtime host real JSONL process", () => {
	it("opens a real Pi Session, preserves manifest/prompt receipts, runs a tool, and settles", async () => {
		const host = await startHost();
		const opened = await openSession(host);
		expect(opened.ok).toBe(true);
		expect(opened.result.snapshot.roomCapability).toMatchObject({
			manifestId: "manifest:test",
			promptCompileReceiptId: "receipt:test",
			toolNames: ["room_post"],
		});
		expect(opened.result.snapshot.toolManifest).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "product_probe" })]),
		);

		const receipt = await host.request("dispatch", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:e2e",
			generation: 1,
			idempotencyKey: "root:e2e/task/participant",
			message: "Inspect package.json and settle.",
		});
		expect(receipt.result).toMatchObject({ delivery: "prompt", receiptKind: "dispatch_accepted" });
		await host.waitFor(
			(message) => message.event === "agent.event" && message.payload?.type === "tool_execution_start",
		);
		await host.waitFor(
			(message) => message.event === "agent.event" && message.payload?.type === "tool_execution_end",
		);
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");
		expect(host.messages.some((message) => message.payload?.toolName === "read")).toBe(true);
		await host.close();
	});

	it("queues a continuation and propagates cancel while the Provider is active", async () => {
		const host = await startHost(true);
		await openSession(host);
		await host.request("dispatch-1", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:1",
			generation: 1,
			idempotencyKey: "root:e2e/1",
			message: "Start bounded work.",
		});
		const followUp = await host.request("dispatch-2", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:2",
			generation: 1,
			idempotencyKey: "root:e2e/2",
			message: "Continue the same bounded work.",
		});
		expect(followUp.result).toMatchObject({ delivery: "followUp" });
		expect(followUp.result.continuationId).toEqual(expect.any(String));
		const cancelled = await host.request("cancel", "room.cancel", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			generation: 2,
		});
		expect(cancelled.result.activeRunAborted).toBe(true);
		expect(cancelled.result.cancelledContinuationIds).toContain(followUp.result.continuationId);
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");
		await host.close();
	}, 20_000);
});
