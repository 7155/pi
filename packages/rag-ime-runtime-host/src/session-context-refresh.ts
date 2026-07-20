import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";
import { replaceRuntimeSessionContext } from "./transient-context.ts";

interface SessionContextRefreshOptions {
	bridge: BackendToolBridgeOptions;
	getSessionContext(): string;
	setSessionContext(value: string): void;
	getRecentMessages(): Array<{ role: "user" | "assistant"; text: string }>;
	getRoomSkillRecovery(): Record<string, unknown> | undefined;
}

export function createSessionContextRefreshExtension(options: SessionContextRefreshOptions): ExtensionFactory {
	async function refresh(
		trigger: "session_start" | "compaction",
		queryText: string,
		summary = "",
	): Promise<string | undefined> {
		if (!options.bridge.gatewayUrl) return undefined;
		const roomSkillRecovery = options.getRoomSkillRecovery();
		try {
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
					roomSkillRecovery,
				},
				undefined,
			);
			const context = String(response.result?.sessionContext ?? "").trim();
			if (!context) return undefined;
			options.setSessionContext(context);
			return context;
		} catch (error) {
			if (roomSkillRecovery) throw error;
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
			const context = await refresh("compaction", "", event.compactionEntry.summary);
			if (!context) return;
			return {
				systemPrompt: replaceRuntimeSessionContext(ctx.getSystemPrompt(), context),
			};
		});
	};
}
