import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface RoomResourceLimits {
	deadlineAtMs: number;
	maxInputTokens?: number;
	maxOutputTokens: number;
	maxToolCalls?: number;
	maxToolCost: number;
	retryRemaining: number;
	repairRemaining: number;
}

export function createRoomResourceLimitExtension(authorizeToolCall: () => { allowed: boolean; reason?: string }): {
	name: string;
	factory: ExtensionFactory;
} {
	return {
		name: "rag-ime-room-resource-limits",
		factory: (pi) => {
			pi.on("tool_call", async () => {
				const decision = authorizeToolCall();
				return decision.allowed
					? undefined
					: { block: true, reason: decision.reason ?? "Room tool limit exhausted" };
			});
		},
	};
}
