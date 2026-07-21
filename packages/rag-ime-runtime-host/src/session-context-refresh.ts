import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProviderContextJournal } from "./provider-context-journal.ts";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

interface SessionContextRefreshOptions {
	bridge: BackendToolBridgeOptions;
	getSessionContext(): string;
	setSessionContext(value: string): void;
	getRoomContext(): string;
	getRoomRecoveryContext(): string;
	setRoomRecoveryContext(value: string): void;
	getRecentMessages(): Array<{ role: "user" | "assistant"; text: string }>;
	getRoomSkillRecovery(): Record<string, unknown> | undefined;
	getRoomToolRecovery(): Record<string, unknown> | undefined;
	providerContextJournal: ProviderContextJournal;
}

interface SessionContextRefreshResult {
	sessionContext: string;
	roomRecoveryContext: string;
	contextEpoch?: number;
	contextEpochReason?: string;
}

export function createSessionContextRefreshExtension(options: SessionContextRefreshOptions): ExtensionFactory {
	async function refresh(
		trigger: "session_start" | "compaction",
		queryText: string,
		summary = "",
		compactionEntryId = "",
	): Promise<SessionContextRefreshResult | undefined> {
		if (!options.bridge.gatewayUrl) return undefined;
		const roomSkillRecovery = options.getRoomSkillRecovery();
		const roomToolRecovery = options.getRoomToolRecovery();
		const managedRoom = Boolean(
			options.getRoomContext().trim() ||
				options.getRoomRecoveryContext().trim() ||
				roomSkillRecovery ||
				roomToolRecovery,
		);
		try {
			if (trigger === "compaction" && managedRoom && !compactionEntryId.trim()) {
				throw new Error("Managed Room compaction is missing compactionEntryId");
			}
			const response = await requestProductGateway(
				options.bridge,
				"context-refresh",
				{
					schemaVersion: "rag-ime.agent-session-context-refresh-request.v1",
					sessionId: options.bridge.sessionId,
					trigger,
					queryText,
					summary,
					recentMessages: options.getRecentMessages(),
					compactionEntryId,
					expectedContextEpoch: options.providerContextJournal.snapshot().epoch,
					roomSkillRecovery,
					roomToolRecovery,
				},
				undefined,
			);
			const sessionContext = String(response.result?.sessionContext ?? "").trim();
			const roomRecoveryContext = String(response.result?.roomRecoveryContext ?? "").trim();
			const contextEpochValue = response.result?.contextEpoch;
			const contextEpoch =
				typeof contextEpochValue === "number" && Number.isSafeInteger(contextEpochValue) && contextEpochValue > 0
					? contextEpochValue
					: undefined;
			const contextEpochReason = String(response.result?.contextEpochReason ?? "").trim() || undefined;
			if (trigger === "compaction" && managedRoom) {
				if (contextEpoch === undefined) {
					throw new Error("Managed Room compaction response is missing contextEpoch");
				}
				if (contextEpochReason !== "compaction") {
					throw new Error("Managed Room compaction response has an invalid contextEpochReason");
				}
			}
			if (!sessionContext && !roomRecoveryContext) return undefined;
			if (sessionContext) options.setSessionContext(sessionContext);
			if (roomRecoveryContext) options.setRoomRecoveryContext(roomRecoveryContext);
			return { sessionContext, roomRecoveryContext, contextEpoch, contextEpochReason };
		} catch (error) {
			if ((trigger === "compaction" && managedRoom) || roomSkillRecovery || roomToolRecovery) throw error;
			// Retrieval is an enhancement. Keep the last valid Session context
			// rather than failing a model turn when the Sidecar is unavailable.
			return undefined;
		}
	}

	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			if (options.getSessionContext().trim()) return;
			await refresh("session_start", event.prompt);
		});
		pi.on("session_compact", async (event, ctx) => {
			const refreshed = await refresh("compaction", "", event.compactionEntry.summary, event.compactionEntry.id);
			return {
				systemPrompt: options.providerContextJournal.beginEpoch(
					"compaction",
					ctx.getSystemPrompt(),
					{
						sessionContext: refreshed?.sessionContext || options.getSessionContext(),
						roomContext: refreshed?.roomRecoveryContext || options.getRoomRecoveryContext(),
						transientContext: "",
					},
					refreshed?.contextEpoch,
				),
			};
		});
	};
}
