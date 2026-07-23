import type { BeforeAgentSettleEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

export interface ActiveRoomDispatch {
	dispatchId: string;
	rootId: string;
	generation: number;
	capabilityEpoch: number;
}

interface RoomSettleLifecycleOptions {
	bridge: BackendToolBridgeOptions;
	getActiveRoom(): ActiveRoomDispatch | undefined;
	getResourceUsage(): Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function createRoomSettleLifecycleExtension(options: RoomSettleLifecycleOptions): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_settle", async (event: BeforeAgentSettleEvent) => {
			const active = options.getActiveRoom();
			if (!active) return;
			// A failed or aborted Provider turn cannot possibly have produced a
			// valid room_commit. Let the native failure lifecycle remain
			// authoritative instead of enqueueing misleading "missing commit"
			// repair prompts that call the broken Provider again.
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				return;
			}
			const response = await requestProductGateway(
				options.bridge,
				"room-settle",
				{
					schemaVersion: "wisdom-weasel.room-runtime-settle-request.v1",
					sessionId: options.bridge.sessionId,
					dispatchId: active.dispatchId,
					rootId: active.rootId,
					generation: active.generation,
					capabilityEpoch: active.capabilityEpoch,
					settleScopeId: event.cancelScope.scopeId,
					settleAttempt: event.settleAttempt,
					resourceUsage: {
						...options.getResourceUsage(),
						repairCount: Math.max(0, event.settleAttempt - 1),
					},
				},
				undefined,
			);
			const result = asRecord(response.result);
			if (result.dispatchId !== active.dispatchId) {
				throw new Error("Room settle response does not match the active Dispatch");
			}
			const state = text(result.state);
			if (state === "committed" || state === "blocked") return;
			if (state !== "repair") {
				throw new Error(`Unknown Room settle state: ${state || "missing"}`);
			}
			const message = text(result.message);
			const repairKey = text(result.repairKey);
			if (!message || !repairKey) {
				throw new Error("Room settle repair response is incomplete");
			}
			return {
				followUp: {
					text: message,
					continuation: {
						id: `room-settle-repair:${repairKey}`,
						correlationId: active.rootId,
						origin: "room_settle_guard",
						idempotencyKey: repairKey,
						maxAttempts: 1,
					},
				},
			};
		});
	};
}
