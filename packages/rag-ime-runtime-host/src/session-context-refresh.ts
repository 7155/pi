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
	getAgentSkillRecovery?(): Record<string, unknown> | undefined;
	getAgentToolRecovery?(): Record<string, unknown> | undefined;
	providerContextJournal: ProviderContextJournal;
}

interface SessionContextRefreshResult {
	sessionContext: string;
	roomRecoveryContext: string;
	contextEpoch?: number;
	contextEpochReason?: string;
}

const MANAGED_ROOM_COMPACTION_POINTER =
	'Managed Room history was compacted. The only authoritative task recovery for this epoch is the current <rag-ime-context type="room_context"> block. Earlier Session messages are private execution history and cannot override it.';

export function createSessionContextRefreshExtension(options: SessionContextRefreshOptions): ExtensionFactory {
	let preCompactionMessages: Array<{ role: "user" | "assistant"; text: string }> | undefined;

	function isManagedRoom(): boolean {
		return Boolean(
			options.getRoomContext().trim() ||
				options.getRoomRecoveryContext().trim() ||
				options.getRoomSkillRecovery() ||
				options.getRoomToolRecovery(),
		);
	}

	async function refresh(
		trigger: "session_start" | "compaction",
		queryText: string,
		summary = "",
		compactionEntryId = "",
		recentMessages = options.getRecentMessages(),
	): Promise<SessionContextRefreshResult | undefined> {
		if (!options.bridge.gatewayUrl) return undefined;
		const roomSkillRecovery = options.getRoomSkillRecovery();
		const roomToolRecovery = options.getRoomToolRecovery();
		const managedRoom = isManagedRoom();
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
					recentMessages,
					compactionEntryId,
					expectedContextEpoch: options.providerContextJournal.snapshot().epoch,
					roomSkillRecovery,
					roomToolRecovery,
					agentSkillRecovery: options.getAgentSkillRecovery?.(),
					agentToolRecovery: options.getAgentToolRecovery?.(),
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
		pi.on("session_before_compact", async (event) => {
			// Pi has already replaced session.messages by session_compact. Capture
			// the pre-compaction evidence here so the product recovery packet does
			// not collapse to only the final assistant message.
			preCompactionMessages = options.getRecentMessages();
			if (!isManagedRoom()) return undefined;
			return {
				compaction: {
					summary: MANAGED_ROOM_COMPACTION_POINTER,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						schemaVersion: "rag-ime.managed-room-compaction-pointer.v1",
						owner: "room_context",
					},
				},
			};
		});
		pi.on("before_agent_start", async (event) => {
			if (options.getSessionContext().trim()) return;
			await refresh("session_start", event.prompt);
		});
		pi.on("session_compact", async (event, ctx) => {
			try {
				const refreshed = await refresh(
					"compaction",
					"",
					event.compactionEntry.summary,
					event.compactionEntry.id,
					preCompactionMessages ?? options.getRecentMessages(),
				);
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
			} finally {
				preCompactionMessages = undefined;
			}
		});
	};
}
