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

async function startHost(slow = false, settleStates: string[] = ["committed"], scenario?: string) {
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
			...(scenario ? { RAG_IME_PI_DETERMINISTIC_SCENARIO: scenario } : {}),
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
				reject(
					new Error(
						`Timed out waiting for host message. stderr=${child.stderr.read() ?? ""} messages=${JSON.stringify(
							messages.slice(-12).map((message) => ({
								id: message.id,
								event: message.event,
								type: message.payload?.type,
								reason: message.payload?.reason,
							})),
						)}`,
					),
				);
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
	it("continues the same run once after native threshold compaction", async () => {
		const host = await startHost(false, ["committed"], "threshold-continuation");
		const opened = await openSession(host);
		expect(opened.result.snapshot.telemetry.context).toMatchObject({
			contextWindow: 64_000,
			autoCompactEnabled: true,
		});
		expect(opened.result.snapshot).toMatchObject({
			messageCount: 0,
			leafId: expect.any(String),
		});
		expect(opened.result.snapshot).not.toHaveProperty("messages");
		expect(opened.result.snapshot).not.toHaveProperty("entries");

		const history = await host.request("threshold-history", "session.prompt", {
			sessionId: "session:e2e",
			message: "THRESHOLD-COMPACTION-EARLY-HISTORY",
			clientMessageId: "threshold-continuation-history",
		});
		expect(history.ok).toBe(true);
		await host.waitFor(
			(message) =>
				message.event === "agent.event" &&
				message.payload?.type === "agent_settled" &&
				message.clientMessageId === "threshold-continuation-history",
		);

		const seeded = await host.request("threshold-seed", "session.prompt", {
			sessionId: "session:e2e",
			// Keep one complete recent exchange large enough to establish a
			// real retained boundary while remaining just below the threshold.
			message: `THRESHOLD-COMPACTION-SEED\n${"bounded-context-evidence ".repeat(3_500)}`,
			clientMessageId: "threshold-continuation-seed",
		});
		expect(seeded.ok).toBe(true);
		await host.waitFor(
			(message) =>
				message.event === "agent.event" &&
				message.payload?.type === "agent_settled" &&
				message.clientMessageId === "threshold-continuation-seed",
		);
		expect(
			host.messages.filter(
				(message) =>
					message.event === "agent.event" &&
					message.payload?.type === "agent_settled" &&
					message.clientMessageId === "threshold-continuation-seed",
			),
		).toHaveLength(1);

		host.child.stdin.write(
			`${JSON.stringify({
				protocolVersion,
				id: "threshold-prompt",
				method: "session.prompt",
				params: {
					sessionId: "session:e2e",
					message: `THRESHOLD-COMPACTION-ORIGINAL-TASK\n${"current-task-evidence ".repeat(2_180)}`,
					clientMessageId: "threshold-continuation-e2e",
				},
			})}\n`,
		);
		await host.waitFor(
			(message) =>
				message.event === "agent.event" &&
				message.payload?.type === "agent_settled" &&
				message.clientMessageId === "threshold-continuation-e2e",
		);
		const prompt = await host.waitFor((message) => message.id === "threshold-prompt");
		expect(prompt.ok).toBe(true);

		const snapshot = await host.request("snapshot-after-threshold", "session.snapshot", {
			sessionId: "session:e2e",
		});
		const compactionStarts = host.messages.filter(
			(message) =>
				message.event === "agent.event" &&
				message.payload?.type === "compaction_start" &&
				message.payload?.reason === "threshold",
		);
		const compactionEnds = host.messages.filter(
			(message) =>
				message.event === "agent.event" &&
				message.payload?.type === "compaction_end" &&
				message.payload?.reason === "threshold",
		);
		if (compactionStarts.length === 0) {
			throw new Error(`threshold compaction did not start: ${JSON.stringify(snapshot.result.telemetry)}`);
		}
		expect({
			compactionStarts: compactionStarts.length,
			compactionEnds: compactionEnds.length,
			telemetry: snapshot.result.telemetry,
		}).toMatchObject({
			compactionStarts: 1,
			compactionEnds: 1,
		});
		expect(compactionEnds[0].payload).toMatchObject({ aborted: false, willRetry: true });
		expect(snapshot.result.telemetry).toMatchObject({
			compactionCount: 1,
			latestCompaction: {
				reason: "threshold",
				status: "completed",
				willRetry: true,
			},
		});
		expect(JSON.stringify(snapshot.result)).toContain("THRESHOLD-COMPACTION-CONTINUED-OK");
		expect(JSON.stringify(snapshot.result)).toContain("threshold-compaction-continuation");
		expect(
			host.messages.filter((message) => message.event === "agent.event" && message.payload?.type === "turn_start"),
		).toHaveLength(4);
		expect(
			host.messages.filter(
				(message) => message.event === "agent.event" && message.payload?.type === "agent_settled",
			),
		).toHaveLength(3);
		await host.close();
	}, 30_000);

	it("stops an installed-style deterministic all-error Tool loop after three identical turns", async () => {
		const host = await startHost(false, ["committed"], "no-progress");
		await openSession(host);

		const accepted = await host.request("prompt", "session.prompt", {
			sessionId: "session:e2e",
			message: "Keep reading the missing proof path until the Runtime guard stops the loop.",
			clientMessageId: "no-progress-e2e",
		});
		expect(accepted.ok).toBe(true);
		await host.waitFor(
			(message) => message.event === "agent.event" && message.payload?.type === "tool_loop_no_progress",
		);
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");

		expect(
			host.messages.filter(
				(message) => message.event === "agent.event" && message.payload?.type === "tool_execution_end",
			),
		).toHaveLength(3);
		expect(
			host.messages.filter(
				(message) => message.event === "agent.event" && message.payload?.type === "tool_loop_no_progress",
			),
		).toHaveLength(1);
		const snapshot = await host.request("snapshot-after-no-progress", "session.snapshot", {
			sessionId: "session:e2e",
		});
		expect(snapshot.result.toolLoopProgressStop).toMatchObject({
			schemaVersion: "rag-ime.tool-loop-progress-stop.v1",
			reason: "repeated_failure_signature",
			consecutiveAllErrorTurns: 3,
			repeatedFailureSignature: 3,
		});
		await host.close();
	});

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
			dispatchAttempt: 1,
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
			dispatchAttempt: 1,
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
		const dispatch = await host.request("dispatch-1", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:1",
			generation: 1,
			capabilityEpoch: 1,
			dispatchAttempt: 1,
			idempotencyKey: "root:e2e/1",
			message: "Start bounded work.",
		});
		const overlapping = await host.request("dispatch-2", "room.dispatch", {
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:2",
			generation: 1,
			capabilityEpoch: 1,
			dispatchAttempt: 1,
			idempotencyKey: "root:e2e/2",
			message: "Continue the same bounded work.",
		});
		expect(overlapping).toMatchObject({
			ok: false,
			error: { code: "ROOM_SESSION_BUSY" },
		});
		const cancelled = await host.request("cancel", "room.cancel", {
			cancelId: "cancel:e2e",
			sessionId: "session:e2e",
			rootId: "root:e2e",
			dispatchId: "dispatch:1",
			generation: 2,
			turnId: dispatch.result.turnId,
			capabilityEpoch: 1,
		});
		expect(cancelled.result.activeRunAborted).toBe(true);
		expect(cancelled.result.cancelledContinuationIds).toEqual(expect.any(Array));
		await host.waitFor((message) => message.event === "agent.event" && message.payload?.type === "agent_settled");
		await host.close();
	}, 20_000);
});
