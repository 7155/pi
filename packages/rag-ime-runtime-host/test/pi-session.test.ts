import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	PiProductSession,
	prepareNativePiFork,
	publicPiForkCandidates,
	publicPiRewriteTarget,
} from "../src/pi-session.ts";
import { ProviderContextJournal } from "../src/provider-context-journal.ts";

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function assistantWith(
	content: AssistantMessage["content"],
	timestamp: number,
	options: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		...assistant("", timestamp),
		content,
		...options,
	};
}

describe("native Pi conversation fork", () => {
	it("creates a distinct transcript at the selected user anchor without mutating the source", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "first question", timestamp: 1 });
			source.appendMessage(assistant("first answer", 2));
			const secondUserId = source.appendMessage({ role: "user", content: "branch this", timestamp: 3 });
			const sourceLeaf = source.appendMessage(assistant("abandoned answer", 4));
			const sourceFile = source.getSessionFile();

			const prepared = prepareNativePiFork(source, secondUserId);

			expect(prepared.selectedText).toBe("branch this");
			expect(prepared.sessionFile).not.toBe(sourceFile);
			expect(prepared.branchAnchor).not.toBe(secondUserId);
			expect(prepared.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(source.getLeafId()).toBe(sourceLeaf);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("creates an assistant branch at the response and leaves the composer empty", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "question", timestamp: 1 });
			const assistantId = source.appendMessage(assistant("answer", 2));
			source.appendMessage({ role: "user", content: "later question", timestamp: 3 });
			const sourceLeaf = source.appendMessage(assistant("later answer", 4));
			const sourceFile = source.getSessionFile();

			const prepared = prepareNativePiFork(source, assistantId);

			expect(prepared.selectedText).toBe("");
			expect(prepared.branchAnchor).toBe(assistantId);
			expect(prepared.sessionFile).not.toBe(sourceFile);
			expect(prepared.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(source.getLeafId()).toBe(sourceLeaf);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns every public user and assistant node without exposing tools or hidden RAG context", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			const userId = source.appendMessage({ role: "user", content: "plain question", timestamp: 10 });
			const assistantId = source.appendMessage(assistant("plain answer", 20));
			const mixedAssistantId = source.appendMessage(
				assistantWith(
					[
						{ type: "text", text: "calling a tool" },
						{ type: "toolCall", id: "tool-1", name: "memory", arguments: {} },
					],
					30,
					{ stopReason: "toolUse" },
				),
			);
			source.appendMessage({
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "memory",
				content: [{ type: "text", text: "private tool result" }],
				isError: false,
				timestamp: 40,
			});
			const failedId = source.appendMessage(
				assistantWith([], 50, { stopReason: "error", errorMessage: '404 Model "missing" is unavailable' }),
			);
			const imageUserId = source.appendMessage({
				role: "user",
				content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				timestamp: 60,
			});
			const imageAssistantId = source.appendMessage(
				assistantWith(
					[{ type: "image", data: "AA==", mimeType: "image/png" }] as unknown as AssistantMessage["content"],
					70,
				),
			);
			const wrappedUserId = source.appendMessage({
				role: "user",
				content:
					"<rag-ime-deep-search-context>private evidence</rag-ime-deep-search-context>" +
					"<rag-ime-user-query>public query</rag-ime-user-query>",
				timestamp: 80,
			});
			source.appendMessage({
				role: "user",
				content: "<rag-ime-deep-search-context>private only</rag-ime-deep-search-context>",
				timestamp: 90,
			});
			source.appendMessage(assistantWith([{ type: "thinking", thinking: "private reasoning" }], 100));

			const candidates = publicPiForkCandidates(source);

			expect(candidates).toEqual([
				{ entryId: userId, text: "plain question", role: "user", createdAtMs: 10 },
				{ entryId: assistantId, text: "plain answer", role: "assistant", createdAtMs: 20 },
				{
					entryId: mixedAssistantId,
					text: "calling a tool",
					role: "assistant",
					createdAtMs: 30,
				},
				{
					entryId: failedId,
					text: '404 Model "missing" is unavailable',
					role: "assistant",
					createdAtMs: 50,
				},
				{ entryId: imageUserId, text: "非文本消息", role: "user", createdAtMs: 60 },
				{ entryId: imageAssistantId, text: "非文本消息", role: "assistant", createdAtMs: 70 },
				{ entryId: wrappedUserId, text: "public query", role: "user", createdAtMs: 80 },
			]);
			expect(JSON.stringify(candidates)).not.toContain("private evidence");
			expect(JSON.stringify(candidates)).not.toContain("private tool result");
			expect(JSON.stringify(candidates)).not.toContain("private reasoning");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects hidden tool-call assistant nodes as fork anchors", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "question", timestamp: 1 });
			const toolCallId = source.appendMessage(
				assistantWith([{ type: "toolCall", id: "tool-1", name: "memory", arguments: {} }], 2, {
					stopReason: "toolUse",
				}),
			);
			source.appendMessage({
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "memory",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			});
			source.appendMessage(assistant("answer", 4));

			expect(() => prepareNativePiFork(source, toolCallId)).toThrow(
				"Fork entry must identify a public user or assistant message",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("only accepts public user entries as in-place rewrite targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-rewrite-"));
		try {
			const source = SessionManager.create(root, root);
			const userId = source.appendMessage({ role: "user", content: "edit me", timestamp: 1 });
			const assistantId = source.appendMessage(assistant("answer", 2));

			expect(publicPiRewriteTarget(source, userId)).toMatchObject({
				entryId: userId,
				role: "user",
				text: "edit me",
			});
			expect(() => publicPiRewriteTarget(source, assistantId)).toThrow(
				"Rewrite entry must identify a public user message",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("active-turn message queue", () => {
	it("queues steering and follow-up messages against the current product turn", async () => {
		const steering: string[] = [];
		const followUp: string[] = [];
		const steer = vi.fn(async (message: string) => {
			steering.push(message);
		});
		const queueFollowUp = vi.fn(async (message: string) => {
			followUp.push(message);
		});
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		Object.assign(productSession as unknown as Record<string, unknown>, {
			activeTurn: { turnId: "turn-1", clientMessageId: "prompt-1" },
			session: {
				isIdle: false,
				steer,
				followUp: queueFollowUp,
				getSteeringMessages: () => steering,
				getFollowUpMessages: () => followUp,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
			},
		});

		await expect(
			productSession.queueMessage({
				delivery: "steer",
				message: "change direction",
				clientMessageId: "steer-1",
			}),
		).resolves.toMatchObject({
			accepted: true,
			queued: true,
			delivery: "steer",
			turnId: "turn-1",
			clientMessageId: "steer-1",
			messageQueue: { steering: ["change direction"], followUp: [] },
		});
		await expect(
			productSession.queueMessage({ delivery: "followUp", message: "then summarize" }),
		).resolves.toMatchObject({
			delivery: "followUp",
			messageQueue: { steering: ["change direction"], followUp: ["then summarize"] },
		});
		expect(steer).toHaveBeenCalledWith("change direction", undefined);
		expect(queueFollowUp).toHaveBeenCalledWith("then summarize", undefined);
	});

	it("rejects queued messages when no turn is running", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		Object.assign(productSession as unknown as Record<string, unknown>, {
			activeTurn: undefined,
			session: { isIdle: true },
		});

		await expect(productSession.queueMessage({ delivery: "steer", message: "too late" })).rejects.toMatchObject({
			code: "SESSION_IDLE",
		});
	});
});

describe("request-scoped UI resolution", () => {
	it("resolves exactly the pending request id and acknowledges only after resolution", () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		let resolved: boolean | undefined;
		Object.assign(productSession as unknown as Record<string, unknown>, {
			pendingUIRequests: new Map(),
			pendingDecisions: new Map([
				[
					"review:run-1",
					{
						requestId: "ui-review-1",
						resolve: (value: boolean) => {
							resolved = value;
						},
						cleanup: () => {},
					},
				],
			]),
		});

		expect(productSession.resolveUI("ui-review-1", { value: "是，继续审阅。" })).toEqual({
			requestId: "ui-review-1",
			resolved: true,
		});
		expect(resolved).toBe(true);
		expect(() => productSession.resolveUI("ui-missing", { confirmed: true })).toThrow("UI request is not pending");
	});
});

describe("typed Session cancellation", () => {
	it("cancels pending UI and decisions before returning the exact Agent lifecycle receipt", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const pendingUIRequests = new Map<string, { cancel(): void }>();
		const pendingDecisions = new Map<string, { requestId: string; resolve(value: boolean): void }>();
		pendingUIRequests.set("ui-1", {
			cancel: () => pendingUIRequests.delete("ui-1"),
		});
		pendingDecisions.set("approval:write-1", {
			requestId: "decision-1",
			resolve: () => pendingDecisions.delete("approval:write-1"),
		});
		const lifecycle = {
			schemaVersion: "pi.agent-abort-receipt.v1" as const,
			scopeId: "pi-session:run:1",
			generation: 1,
			reason: "user_abort",
			cancelledContinuationIds: ["continuation-1"],
			cancelledOperationIds: ["provider"],
			failedOperationIds: [],
			operations: [{ operationId: "provider", kind: "provider", registeredAt: 1 }],
			pendingOperations: [],
			drained: true,
			idle: true,
		};
		Object.assign(productSession as unknown as Record<string, unknown>, {
			externalSessionId: "agent:1",
			activeTurn: { turnId: "turn:1", clientMessageId: "message:1" },
			pendingUIRequests,
			pendingDecisions,
			session: { abort: vi.fn(async () => lifecycle) },
		});

		await expect(productSession.abort()).resolves.toEqual({
			schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
			sessionId: "agent:1",
			turnId: "turn:1",
			cancelledDecisionIds: ["decision-1"],
			cancelledUIRequestIds: ["ui-1"],
			lifecycle,
		});
		expect(pendingUIRequests.size).toBe(0);
		expect(pendingDecisions.size).toBe(0);
	});
});

describe("prompt preflight diagnostics", () => {
	it("preserves the concrete AgentSession failure after a rejected preflight", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		Object.assign(productSession as unknown as Record<string, unknown>, {
			externalSessionId: "agent:preflight",
			activeTurn: undefined,
			sessionContext: "",
			transientContext: "",
			providerContextJournal: new ProviderContextJournal(),
			session: {
				isIdle: true,
				prompt: vi.fn(async (_message, options) => {
					options.preflightResult(false);
					throw new Error("Room recovery receipt revision does not match");
				}),
			},
		});

		await expect(productSession.prompt({ message: "run the Room task" })).rejects.toThrow(
			"Room recovery receipt revision does not match",
		);
		expect((productSession as unknown as { activeTurn?: unknown }).activeTurn).toBeUndefined();
	});
});

describe("per-turn Provider context lifecycle", () => {
	it("clears the projected turn tail when the Agent settles", () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal();
		const withTurnContext = providerContextJournal.project("stable system prompt", {
			roomContext: "",
			sessionContext: "stable memory",
			transientContext: "current input and UI",
		});
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeTurn: { turnId: "turn:1" },
			activeRoom: undefined,
			roomUsageBaseline: undefined,
			transientContext: "current input and UI",
			providerContextJournal,
			sequence: 0,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
			session: {
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
				getContextUsage: () => undefined,
				messages: [],
				model: undefined,
				setRetryLimitOverride: vi.fn(),
			},
			settingsManager: {
				getCompactionSettings: () => ({ reserveTokens: 0 }),
			},
		});

		mutable.onSessionEvent({ type: "agent_settled" });

		expect(mutable.transientContext).toBe("");
		expect(providerContextJournal.snapshot().entryCount).toBe(1);
		const afterSettle = providerContextJournal.project(withTurnContext, {
			roomContext: "",
			sessionContext: "stable memory",
			transientContext: "",
		});
		expect(afterSettle).not.toContain("current input and UI");
		expect(afterSettle).toContain("stable memory");
	});

	it("reprojects the managed prompt before an idle Room repair continuation", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal();
		const followUpWithSystemPrompt = vi.fn(async () => ({
			id: "continuation:repair",
			state: "pending",
		}));
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeTurn: { turnId: "turn:room" },
			roomContext: "Room frozen responsibility",
			sessionContext: "approved memory",
			transientContext: "current UI evidence",
			providerContextJournal,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				followUpWithSystemPrompt,
			},
		});

		const result = await mutable.queueRoomContinuation({
			message: "repair the missing commit",
			dispatchId: "dispatch:1",
			rootId: "root:1",
			generation: 2,
		});

		expect(followUpWithSystemPrompt).toHaveBeenCalledOnce();
		const call = followUpWithSystemPrompt.mock.calls[0] as unknown as [
			string,
			string,
			undefined,
			Record<string, unknown>,
		];
		expect(call[0]).toBe("repair the missing commit");
		expect(call[1]).toContain("Room frozen responsibility");
		expect(call[1]).toContain("approved memory");
		expect(call[1]).toContain("current UI evidence");
		expect(call.slice(2)).toEqual([
			undefined,
			{
				correlationId: "root:1",
				idempotencyKey: "dispatch:1",
			},
		]);
		expect(result).toEqual({
			delivery: "followUp",
			turnId: "turn:room",
			continuationId: "continuation:repair",
		});
	});
});

describe("ordinary Session memory context epochs", () => {
	it("rebases changed or cleared memory without accumulating the prior turn", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal();
		const prompt = vi.fn(async (_message, options) => {
			options.preflightResult(true);
		});
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeRoom: undefined,
			activeTurn: undefined,
			roomContext: "",
			sessionContext: "",
			transientContext: "",
			providerContextJournal,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				prompt,
			},
		});

		await productSession.prompt({ message: "first", sessionContext: "memory A" });
		mutable.activeTurn = undefined;
		let rendered = providerContextJournal.project("stable system prompt", {
			roomContext: "",
			sessionContext: mutable.sessionContext,
			transientContext: "",
		});
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 1,
			epochReason: "session_open",
		});
		expect(rendered).toContain("memory A");

		await productSession.prompt({ message: "second", sessionContext: "memory B" });
		mutable.activeTurn = undefined;
		rendered = providerContextJournal.project(rendered, {
			roomContext: "",
			sessionContext: mutable.sessionContext,
			transientContext: "",
		});
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 2,
			epochReason: "session_memory_refresh",
			entryCount: 1,
		});
		expect(rendered).toContain("memory B");
		expect(rendered).not.toContain("memory A");

		await productSession.prompt({ message: "same", sessionContext: "memory B" });
		mutable.activeTurn = undefined;
		expect(providerContextJournal.snapshot().epoch).toBe(2);

		await productSession.prompt({ message: "clear", sessionContext: "" });
		mutable.activeTurn = undefined;
		rendered = providerContextJournal.project(rendered, {
			roomContext: "",
			sessionContext: mutable.sessionContext,
			transientContext: "",
		});
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 3,
			epochReason: "session_memory_refresh",
			entryCount: 0,
		});
		expect(rendered).not.toContain("memory B");
	});

	it("leaves active Room context epoch ownership to the Room lifecycle", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal(3, "task_switch");
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeRoom: {
				dispatchId: "dispatch:1",
				rootId: "root:1",
				generation: 0,
				capabilityEpoch: 1,
				dispatchAttempt: 0,
			},
			activeTurn: undefined,
			roomContext: "Room task",
			sessionContext: "memory A",
			transientContext: "",
			providerContextJournal,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				prompt: vi.fn(async (_message, options) => {
					options.preflightResult(true);
				}),
			},
		});

		await productSession.prompt({ message: "Room-owned", sessionContext: "memory B" });
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 3,
			epochReason: "task_switch",
		});
	});
});

describe("managed Room retry budget", () => {
	it("caps the Agent lifecycle and reports each retry to Kernel settlement", () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const setRetryLimitOverride = vi.fn();
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeTurn: undefined,
			activeRoom: undefined,
			roomResourceLimits: { retryRemaining: 3 },
			roomRetryCount: 0,
			sequence: 0,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
			session: {
				getSessionStats: () => ({ tokens: { input: 12, output: 7 } }),
				setRetryLimitOverride,
			},
		});

		mutable.beginRoomDispatch({
			dispatchId: "dispatch:retry",
			rootId: "root:retry",
			generation: 0,
			capabilityEpoch: 1,
			dispatchAttempt: 1,
			roomResourceLimits: { retryRemaining: 1 },
		});
		mutable.onSessionEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 8_000,
			errorMessage: "OpenAI API error (502): 502 status code (no body)",
		});

		expect(setRetryLimitOverride).toHaveBeenCalledWith(1);
		expect(mutable.roomResourceUsage()).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			retryCount: 1,
		});
	});
});

describe("manual compaction context refresh", () => {
	it("reports when the compaction hook already refreshed Session memory", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, unknown>;
		Object.assign(mutable, {
			sessionContextRefreshRevision: 0,
			providerContextJournal: new ProviderContextJournal(),
			session: {
				isIdle: true,
				sessionManager: {
					getEntries: () => [{ type: "compaction", id: "compaction:1" }],
				},
				compact: vi.fn(async () => {
					mutable.sessionContextRefreshRevision = 1;
					return {
						summary: "压缩摘要",
						firstKeptEntryId: "entry-1",
						tokensBefore: 1200,
						estimatedTokensAfter: 400,
					};
				}),
			},
		});

		await expect(productSession.compact()).resolves.toMatchObject({
			summary: "压缩摘要",
			contextRefreshApplied: true,
		});
	});

	it("reports a missed refresh so the product gateway can use its fallback", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		Object.assign(productSession as unknown as Record<string, unknown>, {
			sessionContextRefreshRevision: 0,
			providerContextJournal: new ProviderContextJournal(),
			session: {
				isIdle: true,
				sessionManager: {
					getEntries: () => [{ type: "compaction", id: "compaction:missed" }],
				},
				compact: vi.fn(async () => ({
					summary: "压缩摘要",
					firstKeptEntryId: "entry-1",
					tokensBefore: 1200,
				})),
			},
		});

		await expect(productSession.compact()).resolves.toMatchObject({
			contextRefreshApplied: false,
		});
	});
});

describe("managed Room context epochs", () => {
	it("rebases one resident Session for the exact next task-switch epoch", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal(2, "compaction");
		const prompt = vi.fn(async () => ({ turnId: "turn:task-switch" }));
		Object.assign(productSession as unknown as Record<string, unknown>, {
			activeRoom: undefined,
			activeTurn: undefined,
			roomCapability: {
				rootId: "root:old",
				generation: 0,
				contextEpoch: 2,
				contextEpochReason: "compaction",
			},
			roomContext: "old room context",
			roomRecoveryContext: "old recovery context",
			sessionContext: "old session context",
			providerContextJournal,
			backendBridge: { roomCapability: {}, gatewayUrl: undefined },
			roomProviderContext: undefined,
			roomResourceLimits: undefined,
			roomSkillLoad: undefined,
			prompt,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				getSessionStats: () => ({ tokens: { input: 10, output: 5 } }),
				setRetryLimitOverride: vi.fn(),
			},
		});

		await expect(
			productSession.dispatchRoom({
				message: "start the next task",
				dispatchId: "dispatch:new",
				rootId: "root:new",
				generation: 0,
				capabilityEpoch: 9,
				dispatchAttempt: 0,
				sessionContext: "new session context",
				roomContext: "new full room context",
				roomRecoveryContext: "new recovery context",
				roomCapability: {
					rootId: "root:new",
					generation: 0,
					contextEpoch: 3,
					contextEpochReason: "task_switch",
				},
			}),
		).resolves.toMatchObject({ delivery: "prompt", turnId: "turn:task-switch" });

		expect(prompt).toHaveBeenCalledOnce();
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 3,
			epochReason: "task_switch",
			entryCount: 2,
		});
		expect((productSession as unknown as { roomCapability: Record<string, unknown> }).roomCapability).toMatchObject({
			rootId: "root:new",
			contextEpoch: 3,
		});
	});
});

describe("managed Room runtime turn identity", () => {
	it("binds the initial accepted turn before the native prompt can settle", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		let turnIdObservedByPrompt = "";
		const prompt = vi.fn(async (_message, options) => {
			turnIdObservedByPrompt = String(mutable.activeRoom?.runtimeTurnId ?? "");
			expect(turnIdObservedByPrompt).toBe(String(mutable.activeTurn?.turnId ?? ""));
			options.preflightResult(true);
		});
		Object.assign(mutable, {
			activeRoom: undefined,
			activeTurn: undefined,
			roomContext: "",
			roomRecoveryContext: "",
			sessionContext: "",
			transientContext: "",
			providerContextJournal: new ProviderContextJournal(),
			backendBridge: { gatewayUrl: undefined },
			roomProviderContext: undefined,
			roomResourceLimits: undefined,
			roomSkillLoad: undefined,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
				setRetryLimitOverride: vi.fn(),
				prompt,
			},
		});

		const receipt = await productSession.dispatchRoom({
			message: "start bounded Room work",
			dispatchId: "dispatch:initial",
			rootId: "root:initial",
			generation: 0,
			dispatchAttempt: 0,
			capabilityEpoch: 1,
		});

		expect(receipt).toMatchObject({ delivery: "prompt", turnId: turnIdObservedByPrompt });
		expect(mutable.activeRoom).toMatchObject({
			dispatchId: "dispatch:initial",
			dispatchAttempt: 0,
			runtimeTurnId: receipt.turnId,
		});
	});

	it("binds a queued continuation to its accepted active turn and explicit retry attempt", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		let turnIdObservedByFollowUp = "";
		const followUp = vi.fn(async () => {
			turnIdObservedByFollowUp = String(mutable.activeRoom?.runtimeTurnId ?? "");
			return { id: "continuation:retry" };
		});
		Object.assign(mutable, {
			activeRoom: undefined,
			activeTurn: { turnId: "turn:accepted-continuation" },
			roomContext: "",
			roomRecoveryContext: "",
			sessionContext: "",
			transientContext: "",
			backendBridge: { gatewayUrl: undefined },
			roomProviderContext: undefined,
			roomResourceLimits: undefined,
			session: {
				isIdle: false,
				getSessionStats: () => ({ tokens: { input: 8, output: 3 } }),
				setRetryLimitOverride: vi.fn(),
				followUp,
			},
		});

		const receipt = await productSession.dispatchRoom({
			message: "retry bounded Room work",
			dispatchId: "dispatch:continuation-retry",
			rootId: "root:continuation",
			generation: 2,
			dispatchAttempt: 3,
			capabilityEpoch: 4,
		});

		expect(receipt).toMatchObject({
			delivery: "followUp",
			turnId: "turn:accepted-continuation",
			continuationId: "continuation:retry",
		});
		expect(turnIdObservedByFollowUp).toBe(receipt.turnId);
		expect(mutable.activeRoom).toMatchObject({
			dispatchId: "dispatch:continuation-retry",
			dispatchAttempt: 3,
			runtimeTurnId: receipt.turnId,
		});
	});
});

describe("managed Room cancellation lineage", () => {
	it("cancels only the exact active dispatch and preserves its turn across retries", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		const cancelContinuation = vi.fn(() => ({ cancelledIds: ["continuation:1"] }));
		const abort = vi.fn(async () => ({
			schemaVersion: "pi.agent-abort-receipt.v1" as const,
			scopeId: "scope:1",
			generation: 1,
			reason: "user_abort",
			cancelledContinuationIds: [],
			cancelledOperationIds: [],
			failedOperationIds: [],
			operations: [],
			pendingOperations: [],
			drained: true,
			idle: true,
		}));
		Object.assign(mutable, {
			externalSessionId: "session:target",
			appliedRoomCancels: new Map(),
			pendingUIRequests: new Map(),
			pendingDecisions: new Map(),
			activeTurn: { turnId: "turn:1" },
			activeRoom: {
				dispatchId: "dispatch:1",
				rootId: "root:1",
				generation: 3,
				dispatchAttempt: 1,
				runtimeTurnId: "turn:1",
				capabilityEpoch: 7,
			},
			session: { abort, cancelContinuation },
		});
		const lineage = {
			cancelId: "cancel:1",
			sessionId: "session:target",
			rootId: "root:1",
			dispatchId: "dispatch:1",
			generation: 4,
			turnId: "turn:1",
			capabilityEpoch: 7,
		};

		expect(productSession.cancelRoom(lineage)).toEqual({
			cancelledIds: ["continuation:1"],
			abortRequired: true,
		});
		expect(() => productSession.cancelRoom({ ...lineage, dispatchId: "dispatch:stale" })).toThrow(
			"Room cancellation does not match the active Room runtime lineage",
		);
		expect(cancelContinuation).toHaveBeenCalledOnce();
		expect(cancelContinuation).toHaveBeenCalledWith({ correlationId: "root:1" }, "room_cancel");

		mutable.activeTurn = undefined;
		mutable.activeRoom = undefined;
		await expect(productSession.abortRoom(lineage)).resolves.toMatchObject({
			sessionId: "session:target",
			turnId: "turn:1",
			lifecycle: { drained: true, idle: true },
		});
		expect(abort).toHaveBeenCalledOnce();
		productSession.finishRoomCancel(lineage.rootId, lineage.generation, lineage.cancelId);
		expect(mutable.appliedRoomCancels.size).toBe(0);
	});
});

describe("managed Room optional per-dispatch limits", () => {
	it("does not impose fixed input-token or tool-call caps when they are omitted", () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			roomResourceLimits: {
				deadlineAtMs: Date.now() + 60_000,
				maxOutputTokens: 16_000,
				maxToolCost: 10_000,
				retryRemaining: 0,
				repairRemaining: 0,
			},
			roomToolCalls: 0,
			roomToolCost: 0,
			session: {
				getContextUsage: () => ({ tokens: 128_000 }),
			},
		});

		expect(() => mutable.assertRoomDispatchResources()).not.toThrow();
		for (let index = 0; index < 65; index += 1) {
			expect(productSession.authorizeRoomToolCall()).toEqual({ allowed: true });
		}
		expect(mutable.roomToolCalls).toBe(65);
	});
});
