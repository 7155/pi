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
	it("clears Room receipts and cancellation fences when the idle-session LRU evicts their owner", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-room-runtime-eviction-"));
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const advertisedModel = modelRuntime.getModels().find((model) => model.maxTokens > 1024);
		expect(advertisedModel).toBeDefined();
		const host = await RagImeRuntimeHost.create({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
			pluginsRoot: join(root, "plugins"),
			pluginInbox: join(root, "plugin-inbox"),
			maxSessions: 1,
			modelRuntime,
			emitEvent: () => undefined,
		});
		try {
			await host.handle(
				request("open:a", "session.open", {
					sessionId: "session:a",
					cwd: root,
					provider: advertisedModel?.provider,
					modelId: advertisedModel?.id,
				}),
			);
			const mutable = host as unknown as {
				roomReceipts: Map<string, Record<string, unknown>>;
				roomCancelOperations: Map<string, { lineage: { sessionId: string } }>;
				roomCancelFences: Map<string, { sessionId: string }>;
			};
			mutable.roomReceipts.set("receipt:a", { sessionId: "session:a" });
			mutable.roomCancelOperations.set("cancel:a", {
				lineage: { sessionId: "session:a" },
			});
			mutable.roomCancelFences.set("fence:a", { sessionId: "session:a" });

			const opened = (await host.handle(
				request("open:b", "session.open", {
					sessionId: "session:b",
					cwd: root,
					provider: advertisedModel?.provider,
					modelId: advertisedModel?.id,
				}),
			)) as Record<string, unknown>;

			expect(opened.evictedSessionId).toBe("session:a");
			expect(mutable.roomReceipts.size).toBe(0);
			expect(mutable.roomCancelOperations.size).toBe(0);
			expect(mutable.roomCancelFences.size).toBe(0);
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("opens a governed Session with one exact native Skill and provider-only Room context", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-room-runtime-context-"));
		const skillRoot = join(root, "skills", "test-driven-implementation");
		const body = "Apply the bounded implementation workflow.";
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			`---\nname: test-driven-implementation\ndescription: Implement safely.\n---\n${body}\n`,
		);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const advertisedModel = modelRuntime.getModels().find((model) => model.maxTokens > 1024);
		expect(advertisedModel).toBeDefined();
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
					sessionContext: "generic-agent-rag",
					roomContext: "dynamic-room-tail",
					roomRecoveryContext: "full-room-bootstrap",
					roomProviderContext: {
						journalId: "journal:1",
						throughSequence: 1,
						projectionHash: "a".repeat(64),
					},
					roomSkillPolicy: {
						selection: "required",
						skillId: "test-driven-implementation",
						skillHash: createHash("sha256").update(body).digest("hex"),
					},
					roomResourceLimits: {
						deadlineAtMs: Date.now() + 60_000,
						maxOutputTokens: 1024,
						maxToolCost: 2,
						retryRemaining: 1,
						repairRemaining: 1,
					},
					provider: advertisedModel?.provider,
					modelId: advertisedModel?.id,
				}),
			)) as Record<string, any>;

			expect(opened.roomSkillLoad).toMatchObject({
				name: "test-driven-implementation",
				contentRevision: createHash("sha256").update(body).digest("hex"),
				loadReason: "stage_required",
			});
			expect(opened.snapshot.roomProviderContext).toMatchObject({
				journalId: "journal:1",
				throughSequence: 1,
			});
			expect(opened.snapshot.model.maxTokens).toBe(advertisedModel?.maxTokens);
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
			awaitSettled: vi.fn(async (turnId: string) => ({
				schemaVersion: "rag-ime.pi-turn-settlement.v1" as const,
				sessionId: "session:target",
				runtimeSessionId: "pi-session:target",
				turnId,
				receipt: {
					schemaVersion: "pi.agent-settled.v2" as const,
					receiptId: "receipt:turn:1",
					disposition: "completed" as const,
				},
			})),
			dispatchRoom: vi.fn(async (_options: Record<string, any>) => ({ delivery: "prompt", turnId: "turn:1" })),
			cancelRoom: vi.fn((_lineage: Record<string, any>) => ({
				cancelledIds: ["continuation:1"],
				abortRequired: true,
			})),
			finishRoomCancel: vi.fn(() => undefined),
			abortRoom: vi.fn(async () => ({
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1" as const,
				sessionId: "session:target",
				turnId: "turn:1",
				cancelledDecisionIds: [],
				cancelledUIRequestIds: [],
				lifecycle: {
					schemaVersion: "pi.agent-abort-receipt.v1" as const,
					scopeId: "pi-session:run:1",
					generation: 1,
					reason: "user_abort",
					cancelledContinuationIds: ["continuation:2"],
					cancelledOperationIds: ["provider"],
					failedOperationIds: [],
					operations: [{ operationId: "provider", kind: "provider", registeredAt: 1 }],
					pendingOperations: [],
					drained: true,
					idle: true,
				},
			})),
			abort: vi.fn(async () => ({
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1" as const,
				sessionId: "session:target",
				turnId: "turn:1",
				cancelledDecisionIds: [],
				cancelledUIRequestIds: [],
				lifecycle: {
					schemaVersion: "pi.agent-abort-receipt.v1" as const,
					scopeId: "pi-session:run:1",
					generation: 1,
					reason: "user_abort",
					cancelledContinuationIds: [],
					cancelledOperationIds: [],
					failedOperationIds: [],
					operations: [],
					pendingOperations: [],
					drained: true,
					idle: true,
				},
			})),
			dispose: vi.fn(async () => undefined),
		};
		await host.sessions.open("session:target", async () => target as never);

		try {
			const hello = (await host.handle(request("hello", "hello", {}))) as Record<string, any>;
			expect(hello.capabilities.runtimePrimitives.roomTypes).toBe(true);
			const settled = await host.handle(
				request("settled", "session.await_settled", {
					sessionId: "session:target",
					turnId: "turn:1",
					allowSuspended: false,
					timeoutMs: 600_000,
				}),
			);
			expect(settled).toMatchObject({
				schemaVersion: "rag-ime.pi-turn-settlement.v1",
				sessionId: "session:target",
				runtimeSessionId: "pi-session:target",
				turnId: "turn:1",
				receipt: { schemaVersion: "pi.agent-settled.v2", disposition: "completed" },
			});
			expect(target.awaitSettled).toHaveBeenCalledWith("turn:1", {
				allowSuspended: false,
				timeoutMs: 600_000,
			});
			const params = {
				sessionId: "session:target",
				rootId: "root:1",
				dispatchId: "dispatch:1",
				generation: 3,
				capabilityEpoch: 7,
				dispatchAttempt: 4,
				idempotencyKey: "root:1/task:1/participant:b",
				message: "Execute the bounded Room task.",
				sessionContext: "generic-agent-rag",
				roomContext: "governed-room-task",
				roomRecoveryContext: "full-governed-room-task",
				roomProviderContext: {
					journalId: "journal:dispatch:1",
					throughSequence: 2,
					projectionHash: "b".repeat(64),
				},
				roomCapability: {
					manifestId: "manifest:dispatch:1",
					manifestHash: "c".repeat(64),
					promptCompileReceiptId: "prompt:dispatch:1",
					promptPlanHash: "d".repeat(64),
					capabilityEpoch: 7,
				},
				roomResourceLimits: {
					deadlineAtMs: Date.now() + 60_000,
					maxOutputTokens: 1024,
					maxToolCost: 2,
					retryRemaining: 1,
					repairRemaining: 1,
				},
			};
			const missingDispatchAttempt: Record<string, unknown> = { ...params };
			delete missingDispatchAttempt.dispatchAttempt;
			await expect(
				host.handle(request("dispatch-missing-attempt", "room.dispatch", missingDispatchAttempt)),
			).rejects.toThrow("dispatchAttempt must be a non-negative safe integer");
			for (const dispatchAttempt of [-1, 1.5, "4"]) {
				await expect(
					host.handle(
						request("dispatch-invalid-attempt", "room.dispatch", {
							...params,
							dispatchAttempt,
						}),
					),
				).rejects.toThrow("dispatchAttempt must be a non-negative safe integer");
			}
			expect(target.dispatchRoom).not.toHaveBeenCalled();

			const receipt = await host.handle(request("dispatch", "room.dispatch", params));
			const duplicate = await host.handle(request("dispatch-again", "room.dispatch", params));
			expect(receipt).toMatchObject({
				schemaVersion: "wisdom-weasel.room-runtime-receipt.v1",
				receiptKind: "dispatch_accepted",
				status: "accepted",
				rootId: "root:1",
				dispatchId: "dispatch:1",
				generation: 3,
				capabilityEpoch: 7,
				turnId: "turn:1",
			});
			expect(duplicate).toMatchObject({ duplicate: true, dispatchId: "dispatch:1" });
			expect(target.dispatchRoom).toHaveBeenCalledTimes(1);
			expect(target.dispatchRoom).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionContext: "generic-agent-rag",
					roomContext: "governed-room-task",
					roomRecoveryContext: "full-governed-room-task",
					roomProviderContext: expect.objectContaining({ journalId: "journal:dispatch:1" }),
					roomCapability: expect.objectContaining({ manifestId: "manifest:dispatch:1" }),
					roomResourceLimits: expect.objectContaining({ maxOutputTokens: 1024 }),
					dispatchAttempt: 4,
				}),
			);
			expect(target.dispatchRoom.mock.calls[0]?.[0]?.roomResourceLimits).not.toHaveProperty("maxInputTokens");
			expect(target.dispatchRoom.mock.calls[0]?.[0]?.roomResourceLimits).not.toHaveProperty("maxToolCalls");

			await expect(
				host.handle(
					request("cancel-wrong-turn", "room.cancel", {
						cancelId: "cancel:wrong-turn",
						sessionId: "session:target",
						rootId: "root:1",
						dispatchId: "dispatch:1",
						generation: 4,
						turnId: "turn:stale",
						capabilityEpoch: 7,
					}),
				),
			).rejects.toMatchObject({ code: "ROOM_CANCEL_LINEAGE_MISMATCH" });
			expect(target.cancelRoom).not.toHaveBeenCalled();

			const cancelLineage = {
				cancelId: "cancel:1",
				sessionId: "session:target",
				rootId: "root:1",
				dispatchId: "dispatch:1",
				generation: 4,
				turnId: "turn:1",
				capabilityEpoch: 7,
			};
			const cancelled = await host.handle(
				request("cancel", "room.cancel", {
					...cancelLineage,
				}),
			);
			expect(cancelled).toMatchObject({
				receiptKind: "cancel_applied",
				...cancelLineage,
				activeRunAborted: true,
				cancelledContinuationIds: ["continuation:1"],
				pendingTargets: [],
			});
			expect((cancelled as Record<string, any>).cancellationSurfaces.session).toMatchObject({
				schemaVersion: "wisdom-weasel.runtime-surface-termination-receipt.v1",
				state: "terminated",
			});
			expect((cancelled as Record<string, any>).cancellationSurfaces.provider.targetIds).toEqual([
				"session:target",
				"provider",
			]);
			expect((cancelled as Record<string, any>).cancellationSurfaces.continuation.targetIds).toEqual([
				"session:target",
				"continuation:1",
				"continuation:2",
			]);
			expect((cancelled as Record<string, any>).sessionAbortReceipt).toMatchObject({
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
				turnId: "turn:1",
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
			const replayed = await host.handle(request("cancel-replay", "room.cancel", cancelLineage));
			expect(replayed).toEqual(cancelled);
			await expect(
				host.handle(
					request("cancel-reused-id", "room.cancel", {
						...cancelLineage,
						dispatchId: "dispatch:other",
					}),
				),
			).rejects.toMatchObject({ code: "ROOM_CANCEL_LINEAGE_MISMATCH" });
			const sessionAbort = await host.handle(
				request("abort-session", "session.abort", { sessionId: "session:target" }),
			);
			expect(sessionAbort).toMatchObject({
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
				sessionId: "session:target",
				turnId: "turn:1",
				lifecycle: { schemaVersion: "pi.agent-abort-receipt.v1", drained: true, idle: true },
			});
			expect(target.abortRoom).toHaveBeenCalledOnce();
			expect(target.abort).toHaveBeenCalledOnce();
			expect(target.cancelRoom).toHaveBeenCalledWith(cancelLineage);
			expect(target.cancelRoom).toHaveBeenCalledOnce();
			expect(target.finishRoomCancel).toHaveBeenCalledWith("root:1", 4, "cancel:1");
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("single-flights duplicate cancellation and refreshes pending surfaces to terminal", async () => {
		const root = await mkdtemp(join(tmpdir(), "rag-ime-room-cancel-replay-"));
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
		let resolveFirstAbort!: (value: Record<string, any>) => void;
		const firstAbort = new Promise<Record<string, any>>((resolve) => {
			resolveFirstAbort = resolve;
		});
		const terminalAbort = {
			schemaVersion: "rag-ime.pi-session-abort-receipt.v1" as const,
			sessionId: "session:target",
			turnId: "turn:1",
			cancelledDecisionIds: [],
			cancelledUIRequestIds: [],
			lifecycle: {
				schemaVersion: "pi.agent-abort-receipt.v1" as const,
				scopeId: "pi-session:run:1",
				generation: 1,
				reason: "user_abort",
				cancelledContinuationIds: [],
				cancelledOperationIds: ["compaction:1"],
				failedOperationIds: [],
				operations: [{ operationId: "compaction:1", kind: "manual_compaction", registeredAt: 1 }],
				pendingOperations: [],
				drained: true,
				idle: true,
			},
		};
		const abortRoom = vi
			.fn()
			.mockImplementationOnce(() => firstAbort)
			.mockResolvedValueOnce(terminalAbort);
		const target = {
			externalSessionId: "session:target",
			dispatchRoom: vi.fn(async () => ({ delivery: "prompt", turnId: "turn:1" })),
			cancelRoom: vi.fn(() => ({ cancelledIds: ["continuation:1"], abortRequired: true })),
			abortRoom,
			finishRoomCancel: vi.fn(() => undefined),
			dispose: vi.fn(async () => undefined),
		};
		await host.sessions.open("session:target", async () => target as never);
		const dispatchParams = {
			sessionId: "session:target",
			rootId: "root:1",
			dispatchId: "dispatch:1",
			generation: 3,
			capabilityEpoch: 7,
			dispatchAttempt: 1,
			idempotencyKey: "root:1/task:1/participant:a",
			message: "Execute bounded Room work.",
		};
		const cancelLineage = {
			cancelId: "cancel:1",
			sessionId: "session:target",
			rootId: "root:1",
			dispatchId: "dispatch:1",
			generation: 4,
			turnId: "turn:1",
			capabilityEpoch: 7,
		};
		try {
			await host.handle(request("dispatch", "room.dispatch", dispatchParams));
			const first = host.handle(request("cancel:1", "room.cancel", cancelLineage));
			const concurrent = host.handle(request("cancel:2", "room.cancel", cancelLineage));
			await vi.waitFor(() => expect(abortRoom).toHaveBeenCalledOnce());
			await expect(
				host.handle(
					request("dispatch:late", "room.dispatch", {
						...dispatchParams,
						idempotencyKey: "root:1/task:1/participant:a/late",
					}),
				),
			).rejects.toMatchObject({ code: "ROOM_DISPATCH_CANCELLED" });
			await expect(
				host.handle(
					request("dispatch:resurrect", "room.dispatch", {
						...dispatchParams,
						generation: 5,
						idempotencyKey: "root:1/task:1/participant:a/resurrect",
					}),
				),
			).rejects.toMatchObject({ code: "ROOM_DISPATCH_CANCELLED" });
			expect(target.dispatchRoom).toHaveBeenCalledOnce();
			resolveFirstAbort({
				...terminalAbort,
				lifecycle: {
					...terminalAbort.lifecycle,
					pendingOperations: [{ operationId: "compaction:1", kind: "manual_compaction", registeredAt: 1 }],
					drained: false,
					idle: false,
				},
			});
			const [pending, samePending] = await Promise.all([first, concurrent]);
			expect(samePending).toEqual(pending);
			expect((pending as Record<string, any>).pendingTargets).toEqual(["compaction", "session"]);
			expect(target.cancelRoom).toHaveBeenCalledOnce();
			expect(target.finishRoomCancel).not.toHaveBeenCalled();

			const terminal = await host.handle(request("cancel:retry", "room.cancel", cancelLineage));
			expect((terminal as Record<string, any>).pendingTargets).toEqual([]);
			expect(abortRoom).toHaveBeenCalledTimes(2);
			expect(target.cancelRoom).toHaveBeenCalledOnce();
			expect(target.finishRoomCancel).toHaveBeenCalledOnce();
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
