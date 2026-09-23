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
import { ProductContextProvider } from "../src/product-context-provider.ts";
import { ProviderContextJournal } from "../src/provider-context-journal.ts";
import { ToolLoopProgressGuard } from "../src/tool-loop-progress-guard.ts";
import { TurnSettlementTracker } from "../src/turn-settlement.ts";

function testProductContextProvider(
	mutable: Record<string, any>,
	options: { roomRequired?: boolean } = {},
): ProductContextProvider {
	return new ProductContextProvider({
		sessionId: "session:test",
		roomRequired: options.roomRequired,
		getRunId: () => String(mutable.activeTurn?.turnId ?? "session:test:preflight"),
		getRoomContext: () => String(mutable.roomContext ?? ""),
		getRoomRecoveryContext: () => String(mutable.roomRecoveryContext ?? ""),
		getSessionContext: () => String(mutable.sessionContext ?? ""),
		getTurnContext: () => String(mutable.transientContext ?? ""),
		isRoomBound: () => Boolean(mutable.activeRoom ?? mutable.roomContext ?? mutable.roomRecoveryContext),
	});
}

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
	it("applies a bounded Provider output budget when selecting a model", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const model = {
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372_000,
			maxTokens: 128_000,
		};
		const setModel = vi.fn(async () => undefined);
		Object.assign(productSession as unknown as Record<string, unknown>, {
			session: {
				isIdle: true,
				modelRuntime: { getModel: () => model },
				setModel,
			},
		});

		const selected = await productSession.setModel(
			"openai-codex",
			"gpt-5.6-luna",
			16_384,
		);

		expect(setModel).toHaveBeenCalledWith({ ...model, maxTokens: 16_384 });
		expect(selected.maxTokens).toBe(16_384);
	});

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
			return { id: "continuation:steer" };
		});
		const queueFollowUp = vi.fn(async (message: string) => {
			followUp.push(message);
			return { id: "continuation:follow-up" };
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
			continuationId: "steer-1",
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
		const clearQueue = vi.fn();
		const abort = vi.fn(async () => undefined);
		const waitForIdle = vi.fn(async () => undefined);
		Object.assign(productSession as unknown as Record<string, unknown>, {
			externalSessionId: "agent:1",
			activeTurn: { turnId: "turn:1", clientMessageId: "message:1" },
			pendingUIRequests,
			pendingDecisions,
			abortGeneration: 0,
			roomContinuationIds: new Set(["continuation-1"]),
			session: {
				sessionId: "pi-session",
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				isBashRunning: false,
				isIdle: true,
				clearQueue,
				abortBash: vi.fn(),
				abortCompaction: vi.fn(),
				abortBranchSummary: vi.fn(),
				abortRetry: vi.fn(),
				abort,
				waitForIdle,
			},
		});

		await expect(productSession.abort()).resolves.toEqual({
			schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
			sessionId: "agent:1",
			turnId: "turn:1",
			cancelledDecisionIds: ["decision-1"],
			cancelledUIRequestIds: ["ui-1"],
			lifecycle: {
				schemaVersion: "pi.agent-abort-receipt.v1",
				scopeId: "pi-session:turn:1",
				generation: 1,
				reason: "user_abort",
				cancelledContinuationIds: ["continuation-1"],
				cancelledOperationIds: [],
				failedOperationIds: [],
				operations: [],
				pendingOperations: [],
				drained: true,
				idle: true,
				source: "runtime_host_adapter",
			},
		});
		expect(pendingUIRequests.size).toBe(0);
		expect(pendingDecisions.size).toBe(0);
		expect(clearQueue).toHaveBeenCalledOnce();
		expect(abort).toHaveBeenCalledOnce();
		expect(waitForIdle).toHaveBeenCalledOnce();
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
	it("tracks every assistant message_start as a distinct factual source loop", () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			externalSessionId: "agent:loop-cards",
			activeTurn: { turnId: "turn:shared", clientMessageId: "message:shared" },
			activeSourceLoopId: "",
			sourceLoopOrdinal: 0,
			sequence: 0,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
		});

		mutable.onSessionEvent({ type: "message_start", message: assistant("first", 101) });
		expect(mutable.activeSourceLoopId).toBe("pi:message:assistant:101");
		mutable.onSessionEvent({ type: "message_start", message: assistant("follow-up", 202) });
		expect(mutable.activeSourceLoopId).toBe("pi:message:assistant:202");
		expect(mutable.emitEvent).toHaveBeenCalledTimes(2);
	});

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
			externalSessionId: "agent:test",
			activeTurn: { turnId: "turn:1", clientMessageId: "message:1" },
			activeRoom: undefined,
			transientContext: "current input and UI",
			providerContextJournal,
			settlementGeneration: 0,
			roomContinuationIds: new Set(),
			turnSettlements: new TurnSettlementTracker("agent:test", "pi:test"),
			sequence: 0,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
			session: {
				sessionId: "pi:test",
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
				getContextUsage: () => undefined,
				messages: [assistant("done", 1)],
				model: undefined,
				sessionManager: {
					getBranch: () => [{ id: "entry:1" }],
					appendCustomEntry: vi.fn(),
				},
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

	it("starts an idle Room repair through native prompt preflight", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const providerContextJournal = new ProviderContextJournal();
		const prompt = vi.fn(async (_message: string, options: { preflightResult(success: boolean): void }) => {
			options.preflightResult(true);
		});
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeTurn: { turnId: "turn:room" },
			roomContext: "Room frozen responsibility",
			sessionContext: "approved memory",
			transientContext: "current UI evidence",
			roomSkillLoad: {
				schemaVersion: "rag-ime.skill-load.v1",
				name: "implementation-execution",
				catalogRevision: "c".repeat(64),
				contentRevision: "a".repeat(64),
				loadReason: "stage_required",
			},
			providerContextJournal,
			roomContinuationIds: new Set(),
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				prompt,
			},
		});
		mutable.productContextProvider = testProductContextProvider(mutable, { roomRequired: true });

		const result = await mutable.queueRoomContinuation({
			message: "repair the missing commit",
			dispatchId: "dispatch:1",
			rootId: "root:1",
			generation: 2,
			dispatchAttempt: 3,
		});

		expect(prompt).toHaveBeenCalledOnce();
		const call = prompt.mock.calls[0] as unknown as [string, Record<string, unknown>];
		expect(call[0]).toBe("repair the missing commit");
		expect(call[1]).toMatchObject({
			source: "rpc",
			expandPromptTemplates: false,
			preflightResult: expect.any(Function),
		});
		expect(result).toMatchObject({
			delivery: "followUp",
			turnId: "turn:room",
			continuationId: expect.stringMatching(/^room-continuation:dispatch:1:3:/u),
			roomSkillLoad: {
				schemaVersion: "rag-ime.skill-load.v1",
				name: "implementation-execution",
				catalogRevision: "c".repeat(64),
				contentRevision: "a".repeat(64),
				loadReason: "stage_required",
			},
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
				sessionManager: { appendCustomEntry: vi.fn() },
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
				sessionManager: { appendCustomEntry: vi.fn() },
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
	it("cancels Pi's native retry when one bounded Room exceeds its retry budget", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const abortRetry = vi.fn();
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			activeTurn: undefined,
			activeRoom: undefined,
			roomResourceLimits: { retryRemaining: 1 },
			roomContinuationIds: new Set(),
			sequence: 0,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
			session: {
				getSessionStats: () => ({ tokens: { input: 12, output: 7 } }),
				abortRetry,
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
			attempt: 2,
			maxAttempts: 1,
			delayMs: 8_000,
			errorMessage: "OpenAI API error (502): 502 status code (no body)",
		});

		await Promise.resolve();
		expect(abortRetry).toHaveBeenCalledOnce();
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
			roomContinuationIds: new Set(),
			prompt,
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				getSessionStats: () => ({ tokens: { input: 10, output: 5 } }),
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
	it("releases a failed Room runtime binding so the next Dispatch can start", async () => {
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		const providerContextJournal = new ProviderContextJournal();
		const prompt = vi.fn(async (_message, options) => {
			options.preflightResult(true);
		});
		Object.assign(mutable, {
			externalSessionId: "agent:runtime",
			activeTurn: { turnId: "turn:failed", clientMessageId: "client:failed" },
			activeRoom: {
				dispatchId: "dispatch:failed",
				rootId: "root:failed",
				generation: 0,
				dispatchAttempt: 0,
				runtimeTurnId: "turn:failed",
				capabilityEpoch: 1,
			},
			roomContext: "",
			roomRecoveryContext: "",
			sessionContext: "",
			transientContext: "turn context",
			settlementGeneration: 0,
			roomContinuationIds: new Set(),
			sequence: 0,
			turnSettlements: new TurnSettlementTracker("agent:runtime", "pi:session"),
			providerContextJournal,
			backendBridge: { gatewayUrl: undefined },
			roomProviderContext: undefined,
			roomResourceLimits: undefined,
			roomSkillLoad: undefined,
			emitEvent: vi.fn(),
			telemetry: vi.fn(() => ({})),
			session: {
				sessionId: "pi:session",
				isIdle: true,
				systemPrompt: "stable system prompt",
				messages: [assistantWith([], 1, { stopReason: "error", errorMessage: "provider failed" })],
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
				sessionManager: {
					getBranch: () => [{ id: "entry:failed" }],
					appendCustomEntry: vi.fn(),
				},
				prompt,
			},
		});

		mutable.onSessionEvent({ type: "agent_settled" });

		expect(mutable.activeTurn).toBeUndefined();
		expect(mutable.activeRoom).toBeUndefined();
		expect(mutable.transientContext).toBe("");
		expect(providerContextJournal.snapshot().entryCount).toBe(0);

		await expect(
			productSession.dispatchRoom({
				message: "start the next bounded task",
				dispatchId: "dispatch:next",
				rootId: "root:next",
				generation: 0,
				dispatchAttempt: 0,
				capabilityEpoch: 2,
			}),
		).resolves.toMatchObject({ delivery: "prompt" });
		expect(prompt).toHaveBeenCalledOnce();
		expect(mutable.activeRoom).toMatchObject({
			dispatchId: "dispatch:next",
			rootId: "root:next",
		});
	});

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
			roomContinuationIds: new Set(),
			session: {
				isIdle: true,
				systemPrompt: "stable system prompt",
				sessionManager: { appendCustomEntry: vi.fn() },
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
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
			roomSkillLoad: undefined,
			roomContinuationIds: new Set(),
			providerContextJournal: new ProviderContextJournal(),
			session: {
				isIdle: false,
				systemPrompt: "stable system prompt",
				getSessionStats: () => ({ tokens: { input: 8, output: 3 } }),
				followUp,
			},
		});
		mutable.productContextProvider = testProductContextProvider(mutable);

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
			continuationId: expect.stringMatching(
				/^room-continuation:dispatch:continuation-retry:3:/u,
			),
		});
		expect(turnIdObservedByFollowUp).toBe(receipt.turnId);
		expect(followUp).toHaveBeenCalledWith("retry bounded Room work");
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
		const clearQueue = vi.fn();
		const abort = vi.fn(async () => undefined);
		Object.assign(mutable, {
			externalSessionId: "session:target",
			appliedRoomCancels: new Map(),
			pendingUIRequests: new Map(),
			pendingDecisions: new Map(),
			abortGeneration: 0,
			roomContinuationIds: new Set(["continuation:1"]),
			activeTurn: { turnId: "turn:1" },
			activeRoom: {
				dispatchId: "dispatch:1",
				rootId: "root:1",
				generation: 3,
				dispatchAttempt: 1,
				runtimeTurnId: "turn:1",
				capabilityEpoch: 7,
			},
			session: {
				sessionId: "pi:target",
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				isBashRunning: false,
				isIdle: true,
				clearQueue,
				abortBash: vi.fn(),
				abortCompaction: vi.fn(),
				abortBranchSummary: vi.fn(),
				abortRetry: vi.fn(),
				abort,
				waitForIdle: vi.fn(async () => undefined),
			},
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
		expect(clearQueue).toHaveBeenCalledOnce();

		mutable.activeTurn = undefined;
		mutable.activeRoom = undefined;
		await expect(productSession.abortRoom(lineage)).resolves.toMatchObject({
			sessionId: "session:target",
			turnId: "turn:1",
			lifecycle: { drained: true, idle: true },
		});
		expect(abort).toHaveBeenCalledOnce();
		expect(clearQueue).toHaveBeenCalledTimes(2);
		productSession.finishRoomCancel(lineage.rootId, lineage.generation, lineage.cancelId);
		expect(mutable.appliedRoomCancels.size).toBe(0);
	});
});

describe("managed Room optional per-dispatch limits", () => {
	it("aborts the exact Room turn when Provider recovery stalls after an all-error tool turn", async () => {
		vi.useFakeTimers();
		try {
			const abort = vi.fn(async () => undefined);
			const events: Array<Record<string, any>> = [];
			const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
			const mutable = productSession as unknown as Record<string, any>;
			Object.assign(mutable, {
				activeTurn: { turnId: "turn:review", clientMessageId: "message:review" },
				activeRoom: { dispatchId: "dispatch:review" },
				emitEvent: (event: Record<string, any>) => events.push(event),
				sequence: 0,
				session: { abort },
				toolLoopProgressGuard: new ToolLoopProgressGuard({ maxRecoveryWaitMs: 1_000 }),
			});
			const message = assistantWith(
				[{ type: "toolCall", id: "call:post", name: "room_partner", arguments: { op: "post", kind: "result" } }],
				1,
				{ stopReason: "toolUse" },
			);
			const shouldStop = mutable.observeToolLoopTurn({
				message,
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "call:post",
						toolName: "room_partner",
						content: [{ type: "text", text: "must omit resumeCondition" }],
						details: {},
						isError: true,
						timestamp: 1,
					},
				],
			});

			expect(shouldStop).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(abort).toHaveBeenCalledOnce();
			expect(events).toContainEqual(
				expect.objectContaining({
					turnId: "turn:review",
					payload: expect.objectContaining({ reason: "all_error_recovery_timeout" }),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let an expired recovery timer abort a newer Room Dispatch", async () => {
		vi.useFakeTimers();
		try {
			const abort = vi.fn(async () => undefined);
			const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
			const mutable = productSession as unknown as Record<string, any>;
			Object.assign(mutable, {
				activeTurn: { turnId: "turn:review" },
				activeRoom: { dispatchId: "dispatch:review" },
				emitEvent: () => undefined,
				sequence: 0,
				session: { abort },
				toolLoopProgressGuard: new ToolLoopProgressGuard({ maxRecoveryWaitMs: 1_000 }),
			});
			mutable.observeToolLoopTurn({
				message: assistantWith(
					[{ type: "toolCall", id: "call:post", name: "room_partner", arguments: { op: "post" } }],
					1,
					{
						stopReason: "toolUse",
					},
				),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "call:post",
						toolName: "room_partner",
						content: [{ type: "text", text: "invalid" }],
						details: {},
						isError: true,
						timestamp: 1,
					},
				],
			});
			mutable.activeRoom = { dispatchId: "dispatch:newer" };

			await vi.advanceTimersByTimeAsync(1_000);
			expect(abort).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

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

describe("Pi Product Session shutdown", () => {
	it("aborts active work, emits session_shutdown, and disposes exactly once", async () => {
		const order: string[] = [];
		const productSession = Object.create(PiProductSession.prototype) as PiProductSession;
		const mutable = productSession as unknown as Record<string, any>;
		Object.assign(mutable, {
			toolLoopProgressGuard: { reset: () => order.push("progress.reset") },
			turnSettlements: { dispose: () => order.push("settlements.dispose") },
			pendingUIRequests: new Map(),
			pendingDecisions: new Map(),
			transientContext: "transient",
			providerContextJournal: { clearTurnContext: () => order.push("context.clear") },
			session: {
				abort: async () => order.push("session.abort"),
				hasExtensionHandlers: (event: string) => event === "session_shutdown",
				extensionRunner: {
					emit: async (event: { type: string; reason: string }) =>
						order.push(`${event.type}:${event.reason}`),
				},
				dispose: () => order.push("session.dispose"),
			},
			unsubscribe: () => order.push("unsubscribe"),
			debugContextRecorder: { clear: () => order.push("debug.clear") },
		});

		const first = productSession.dispose();
		const second = productSession.dispose();
		expect(first).toBe(second);
		await first;

		expect(mutable.transientContext).toBe("");
		expect(order).toEqual([
			"progress.reset",
			"settlements.dispose",
			"context.clear",
			"session.abort",
			"session_shutdown:quit",
			"unsubscribe",
			"debug.clear",
			"session.dispose",
		]);
	});
});
