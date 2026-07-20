import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RuntimeRequest } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

function request(id: string, method: RuntimeRequest["method"], params: Record<string, unknown>): RuntimeRequest {
	return { protocolVersion: PROTOCOL_VERSION, id, method, params };
}

describe("Room runtime RPC", () => {
	it("opens a governed Session with one exact native Skill and provider-only Room context", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-room-runtime-context-"));
		const skillRoot = join(root, "skills", "room-test-driven-implementation");
		const body = "Apply the bounded implementation workflow.";
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			`---\nname: room-test-driven-implementation\ndescription: Implement safely.\n---\n${body}\n`,
		);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const host = await RagImeRuntimeHost.create({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
			pluginsRoot: join(root, "plugins"),
			pluginInbox: join(root, "plugin-inbox"),
			skillPaths: [skillRoot],
			maxSessions: 2,
			modelRuntime,
			emitEvent: () => undefined,
		});
		try {
			const opened = (await host.handle(
				request("open", "session.open", {
					sessionId: "session:governed",
					cwd: root,
					systemPrompt: "stable-layers-1-through-5",
					sessionContext: "dynamic-room-tail",
					roomProviderContext: {
						journalId: "journal:1",
						throughSequence: 1,
						projectionHash: "a".repeat(64),
					},
					roomSkillPolicy: {
						selection: "required",
						skillId: "room-test-driven-implementation",
						skillHash: createHash("sha256").update(body).digest("hex"),
					},
					roomResourceLimits: {
						deadlineAtMs: Date.now() + 60_000,
						maxInputTokens: 64_000,
						maxOutputTokens: 1024,
						maxToolCalls: 2,
						maxToolCost: 2,
						retryRemaining: 1,
						repairRemaining: 1,
					},
				}),
			)) as Record<string, any>;

			expect(opened.roomSkillLoad).toMatchObject({
				name: "room-test-driven-implementation",
				contentRevision: createHash("sha256").update(body).digest("hex"),
				loadReason: "stage_required",
			});
			expect(opened.snapshot.roomProviderContext).toMatchObject({
				journalId: "journal:1",
				throughSequence: 1,
			});
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("negotiates typed Room delivery, deduplicates it, and applies targeted cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-room-runtime-"));
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const host = await RagImeRuntimeHost.create({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
			pluginsRoot: join(root, "plugins"),
			pluginInbox: join(root, "plugin-inbox"),
			maxSessions: 2,
			modelRuntime,
			emitEvent: () => undefined,
		});
		const target = {
			externalSessionId: "session:target",
			dispatchRoom: vi.fn(async () => ({ delivery: "prompt", turnId: "turn:1" })),
			cancelRoom: vi.fn(() => ({ cancelledIds: ["continuation:1"], abortRequired: true })),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		await host.sessions.open("session:target", async () => target as never);

		try {
			const hello = (await host.handle(request("hello", "hello", {}))) as Record<string, any>;
			expect(hello.capabilities.runtimePrimitives.roomTypes).toBe(true);
			const params = {
				sessionId: "session:target",
				rootId: "root:1",
				dispatchId: "dispatch:1",
				generation: 3,
				idempotencyKey: "root:1/task:1/participant:b",
				message: "Execute the bounded Room task.",
			};
			const receipt = await host.handle(request("dispatch", "room.dispatch", params));
			const duplicate = await host.handle(request("dispatch-again", "room.dispatch", params));
			expect(receipt).toMatchObject({
				schemaVersion: "wisdom-weasel.room-runtime-receipt.v1",
				receiptKind: "dispatch_accepted",
				status: "accepted",
				rootId: "root:1",
				dispatchId: "dispatch:1",
				generation: 3,
				turnId: "turn:1",
			});
			expect(duplicate).toMatchObject({ duplicate: true, dispatchId: "dispatch:1" });
			expect(target.dispatchRoom).toHaveBeenCalledTimes(1);

			const cancelled = await host.handle(
				request("cancel", "room.cancel", {
					sessionId: "session:target",
					rootId: "root:1",
					generation: 4,
				}),
			);
			expect(cancelled).toMatchObject({
				receiptKind: "cancel_applied",
				activeRunAborted: true,
				cancelledContinuationIds: ["continuation:1"],
				pendingTargets: [],
			});
			expect((cancelled as Record<string, any>).cancellationSurfaces.session).toMatchObject({
				schemaVersion: "wisdom-weasel.runtime-surface-termination-receipt.v1",
				state: "terminated",
			});
			expect(Object.keys((cancelled as Record<string, any>).cancellationSurfaces)).toEqual([
				"provider",
				"tool",
				"exec",
				"retry",
				"compaction",
				"branch_summary",
				"timer",
				"continuation",
				"session",
			]);
			expect(target.abort).toHaveBeenCalledTimes(1);
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
