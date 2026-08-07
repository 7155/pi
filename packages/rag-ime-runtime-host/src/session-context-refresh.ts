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
	assembleProviderContext?: (input: {
		stage: "after_compaction";
		queryText: string;
		systemPrompt: string;
	}) => Promise<string>;
}

interface SessionContextRefreshResult {
	sessionContext?: string;
	roomRecoveryContext?: string;
	contextEpoch?: number;
	contextEpochReason?: string;
}

const MANAGED_ROOM_COMPACTION_POINTER =
	"Managed Room history was compacted. The only authoritative task recovery for this epoch is the current managed Provider context. It may be projected as active Room context or, after Room release, as the same Session's bounded recovery memory. Earlier Session messages cannot override it.";

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
		// Room Skill/Tool receipts are recovery evidence for a completed
		// compaction epoch. Sending them during session_start races the product
		// side durable pin that is recorded after dispatch preflight.
		const roomSkillRecovery = trigger === "compaction" ? options.getRoomSkillRecovery() : undefined;
		const roomToolRecovery = trigger === "compaction" ? options.getRoomToolRecovery() : undefined;
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
			const result = response.result ?? {};
			const hasSessionContext = Object.hasOwn(result, "sessionContext");
			const hasRoomRecoveryContext = Object.hasOwn(result, "roomRecoveryContext");
			if (hasSessionContext && typeof result.sessionContext !== "string") {
				throw new Error("Context refresh response has an invalid sessionContext");
			}
			if (hasRoomRecoveryContext && typeof result.roomRecoveryContext !== "string") {
				throw new Error("Context refresh response has an invalid roomRecoveryContext");
			}
			const sessionContext = hasSessionContext ? (result.sessionContext as string).trim() : undefined;
			const roomRecoveryContext = hasRoomRecoveryContext ? (result.roomRecoveryContext as string).trim() : undefined;
			const contextEpochValue = result.contextEpoch;
			const contextEpoch =
				typeof contextEpochValue === "number" && Number.isSafeInteger(contextEpochValue) && contextEpochValue > 0
					? contextEpochValue
					: undefined;
			const contextEpochReason = String(result.contextEpochReason ?? "").trim() || undefined;
			if (trigger === "compaction" && managedRoom) {
				if (contextEpoch === undefined) {
					throw new Error("Managed Room compaction response is missing contextEpoch");
				}
				if (contextEpochReason !== "compaction") {
					throw new Error("Managed Room compaction response has an invalid contextEpochReason");
				}
				if (!hasSessionContext || !hasRoomRecoveryContext) {
					throw new Error("Managed Room compaction response is missing authoritative context");
				}
			}
			if (!hasSessionContext && !hasRoomRecoveryContext) return undefined;
			if (sessionContext !== undefined) options.setSessionContext(sessionContext);
			if (roomRecoveryContext !== undefined) options.setRoomRecoveryContext(roomRecoveryContext);
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
				const baseSystemPrompt = options.providerContextJournal.beginEpoch(
					"compaction",
					ctx.getSystemPrompt(),
					{
						sessionContext: refreshed?.sessionContext ?? options.getSessionContext(),
						roomContext: refreshed?.roomRecoveryContext ?? options.getRoomRecoveryContext(),
						transientContext: "",
					},
					refreshed?.contextEpoch,
				);
				return {
					systemPrompt: options.assembleProviderContext
						? await options.assembleProviderContext({
								stage: "after_compaction",
								queryText: "",
								systemPrompt: baseSystemPrompt,
							})
						: baseSystemPrompt,
				};
			} finally {
				preCompactionMessages = undefined;
			}
		});
	};
}
