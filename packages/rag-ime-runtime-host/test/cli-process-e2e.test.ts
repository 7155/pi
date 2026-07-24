import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const protocolVersion = "2";
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

async function startHost(slow = false, settleStates: string[] = ["committed"]) {
	const stateRoot = await mkdtemp(join(tmpdir(), "rag-ime-real-host-e2e-"));
	const settleRequests: Record<string, unknown>[] = [];
	const gateway = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			const isSettle = request.url?.endsWith("/room-settle") === true;
			if (isSettle) settleRequests.push(payload);
			const settleState =
				settleStates[Math.min(Math.max(0, settleRequests.length - 1), settleStates.length - 1)] ?? "committed";
			const result = request.url?.endsWith("/tool/load")
				? { receiptId: `receipt:${String(payload.toolName ?? "")}` }
				: {
						state: isSettle ? settleState : "committed",
						dispatchId: payload.dispatchId,
						...(isSettle && settleState !== "committed" && settleState !== "blocked"
							? {
									message:
										'<managed-task-follow-up origin="room-kernel" kind="continue">' +
										"继续完成尚未满足的验收项。" +
										"</managed-task-follow-up>",
									followUpKey: `follow-up:${settleRequests.length}`,
								}
							: {}),
					};
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					ok: true,
					result,
				}),
			);
		});
	});
	await new Promise<void>((accept) => gateway.listen(0, "127.0.0.1", accept));
	servers.push(gateway);
	const address = gateway.address();
	if (!address || typeof address === "string") throw new Error("test gateway did not bind a TCP port");
	const child = spawn(process.execPath, [join(packageRoot, "dist/cli.js")], {
		cwd: workspaceRoot,
		env: {
			...process.env,
			NODE_ENV: "test",
			RAG_IME_PI_DETERMINISTIC_ADAPTER: "room-v2",
			RAG_IME_PI_DETERMINISTIC_SLOW: slow ? "1" : "0",
			RAG_IME_APP_SUPPORT_DIR: stateRoot,
			RAG_IME_WORKSPACE_ROOTS: workspaceRoot,
			RAG_IME_TOOL_GATEWAY_URL: `http://127.0.0.1:${address.port}/api/agent/tool/execute`,
			RAG_IME_TOOL_GATEWAY_TOKEN: "test-token",
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
		await new Promise<void>((accept) => gateway.close(() => accept()));
		await rm(stateRoot, { recursive: true, force: true });
	};
	return { child, messages, settleRequests, waitFor, request, close };
}

async function openSession(host: Awaited<ReturnType<typeof startHost>>) {
	const hash = "a".repeat(64);
	return host.request("open", "session.open", {
		sessionId: "session:e2e",
		cwd: workspaceRoot,
		provider: "rag-ime-deterministic",
		modelId: "room-v2-test",
		noContextFiles: true,
		toolManifest: [
			{ name: "product_probe", description: "test manifest", parameters: { type: "object" } },
			{ name: "room_state", description: "read Room state", parameters: { type: "object" } },
			{ name: "room_post", description: "publish Room post", parameters: { type: "object" } },
			{ name: "room_commit", description: "settle Room work", parameters: { type: "object" } },
		],
		roomCapability: {
			manifestId: "manifest:test",
			manifestHash: hash,
			capabilityEpoch: 1,
			promptCompileReceiptId: "receipt:test",
			promptPlanHash: hash,
			toolNames: ["room_state", "room_post", "room_commit"],
		},
	});
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (!child.killed) child.kill("SIGTERM");
	}
	for (const server of servers.splice(0)) {
		if (server.listening) server.close();
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
			toolNames: ["room_state", "room_post", "room_commit"],
		});
		expect(opened.result.snapshot.toolManifest).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "product_probe" })]),
		);
		const controlState = await host.request("control-state", "session.control_state", {
			sessionId: "session:e2e",
		});
		expect(controlState.result).toMatchObject({
			schemaVersion: "rag-ime.pi-session-control-state.v1",
			sessionId: "session:e2e",
			isIdle: true,
			roomCapability: {
				manifestId: "manifest:test",
				promptCompileReceiptId: "receipt:test",
			},
		});
		expect(controlState.result).not.toHaveProperty("messages");
		expect(controlState.result).not.toHaveProperty("entries");

		const receipt = await host.request("dispatch", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:e2e",
			generation: 1,
			capabilityEpoch: 1,
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
		expect(host.settleRequests).toEqual([
			expect.objectContaining({
				dispatchId: "dispatch:e2e",
				rootId: "root:e2e",
				capabilityEpoch: 1,
				settleAttempt: 1,
			}),
		]);
		await host.close();
	});

	it("feeds a governed continuation back into the same Pi run before settling", async () => {
		const host = await startHost(false, ["continue", "committed"]);
		await openSession(host);

		await host.request("dispatch", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:e2e",
			generation: 1,
			capabilityEpoch: 1,
			idempotencyKey: "root:e2e/goal-loop",
			message: "Keep working until the governed acceptance is complete.",
		});
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");

		expect(host.settleRequests.map((request) => request.settleAttempt)).toEqual([1, 2]);
		expect(
			host.messages.filter(
				(message) => message.event === "agent.event" && message.payload?.type === "agent_settled",
			),
		).toHaveLength(1);
		expect(JSON.stringify(host.messages)).toContain("继续完成尚未满足的验收项");
		await host.close();
	});

	it("rejects overlapping Dispatch ownership and propagates cancel while the Provider is active", async () => {
		const host = await startHost(true);
		await openSession(host);
		await host.request("dispatch-1", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:1",
			generation: 1,
			capabilityEpoch: 1,
			idempotencyKey: "root:e2e/1",
			message: "Start bounded work.",
		});
		const overlapping = await host.request("dispatch-2", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:2",
			generation: 1,
			capabilityEpoch: 1,
			idempotencyKey: "root:e2e/2",
			message: "Continue the same bounded work.",
		});
		expect(overlapping).toMatchObject({
			ok: false,
			error: { code: "ROOM_SESSION_BUSY" },
		});
		const cancelled = await host.request("cancel", "room.cancel", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			generation: 2,
		});
		expect(cancelled.result.activeRunAborted).toBe(true);
		expect(cancelled.result.cancelledContinuationIds).toEqual(expect.any(Array));
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");
		await host.close();
	}, 20_000);
});
