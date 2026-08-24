import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";
import { ProductContextProvider } from "../src/product-context-provider.ts";
import { ProviderContextJournal } from "../src/provider-context-journal.ts";
import { BackendToolRegistry } from "../src/tool-bridge.ts";

const TURN_BINDING_CUSTOM_TYPE = "rag-ime.pi-turn-binding";

interface CustomEntry {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
}

function recoveredProductSession(entries: CustomEntry[]): {
	productSession: PiProductSession;
	prompt: ReturnType<typeof vi.fn>;
} {
	const lifecycle = {
		schemaVersion: "pi.agent-abort-receipt.v1" as const,
		scopeId: "pi-session:recovered",
		generation: 1,
		reason: "user_abort",
		cancelledContinuationIds: [],
		cancelledOperationIds: [],
		failedOperationIds: [],
		operations: [],
		pendingOperations: [],
		drained: true,
		idle: true,
	};
	const prompt = vi.fn(async (_message: string, options: { preflightResult(success: boolean): void }) => {
		options.preflightResult(true);
	});
	const session = {
		sessionId: "pi-session:recovered",
		isIdle: true,
		systemPrompt: "stable system prompt",
		agent: { shouldStopAfterTurn: undefined },
		sessionManager: {
			getBranch: () => entries,
			appendDurableCustomEntry: (customType: string, data: Record<string, unknown>) => {
				entries.push({ type: "custom", customType, data });
			},
		},
		subscribe: vi.fn(() => () => undefined),
		abort: vi.fn(async () => lifecycle),
		setRetryLimitOverride: vi.fn(),
		prompt,
	};
	const providerContextJournal = new ProviderContextJournal();
	const productContextProvider = new ProductContextProvider({
		sessionId: "agent:recovered",
		roomRequired: false,
		getRunId: () => "turn:interrupted",
		getRoomContext: () => "",
		getRoomRecoveryContext: () => "",
		getSessionContext: () => "",
		getTurnContext: () => "",
		isRoomBound: () => false,
	});
	const productSession = Reflect.construct(PiProductSession, [
		{
			externalSessionId: "agent:recovered",
			cwd: "/tmp/recovered-session",
			noContextFiles: false,
			piSkillsEnabled: false,
			codexSkillsEnabled: false,
			emitEvent: vi.fn(),
		},
		session,
		new BackendToolRegistry(),
		{},
		{},
		{},
		providerContextJournal,
		productContextProvider,
		{},
		undefined,
	]) as PiProductSession;
	return { productSession, prompt };
}

describe("recovered interrupted turn", () => {
	it("retires an interrupted binding through explicit abort and accepts the next prompt after restart", async () => {
		const entries: CustomEntry[] = [
			{
				type: "custom",
				customType: TURN_BINDING_CUSTOM_TYPE,
				data: {
					schemaVersion: "rag-ime.pi-turn-binding.v1",
					turnId: "turn:interrupted",
					clientMessageId: "message:interrupted",
				},
			},
		];
		const recovered = recoveredProductSession(entries);

		expect((recovered.productSession as unknown as { activeTurn?: { turnId: string } }).activeTurn?.turnId).toBe(
			"turn:interrupted",
		);
		await expect(recovered.productSession.abort()).resolves.toMatchObject({
			turnId: "turn:interrupted",
			lifecycle: { drained: true, idle: true },
		});
		expect(entries).toHaveLength(2);
		expect(entries.at(-1)).toMatchObject({
			type: "custom",
			customType: TURN_BINDING_CUSTOM_TYPE,
			data: {
				schemaVersion: "rag-ime.pi-turn-binding.v1",
				turnId: "turn:interrupted",
				clientMessageId: "message:interrupted",
				state: "retired",
				reason: "explicit_abort",
			},
		});

		const reopened = recoveredProductSession(entries);
		expect((reopened.productSession as unknown as { activeTurn?: unknown }).activeTurn).toBeUndefined();
		await expect(
			reopened.productSession.prompt({ message: "continue from preserved transcript" }),
		).resolves.toMatchObject({ turnId: expect.any(String) });
		expect(reopened.prompt).toHaveBeenCalledOnce();
	});
});
