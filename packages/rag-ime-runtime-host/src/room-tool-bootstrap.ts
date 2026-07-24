import { RuntimeProtocolError } from "./protocol.ts";
import { type BackendToolBridgeOptions, requestGovernedToolLoad } from "./tool-bridge.ts";

export const ROOM_BOOTSTRAP_TOOL_NAMES = ["room_state", "room_post", "room_commit"] as const;

/** Make the existing Room responsibility loop visible before the first model call. */
export async function bootstrapRoomTools(options: BackendToolBridgeOptions): Promise<string[]> {
	if (!options.roomCapability || !options.gatewayUrl) return [];
	for (const name of ROOM_BOOTSTRAP_TOOL_NAMES) {
		if (!options.registry.get(name)) {
			throw new RuntimeProtocolError("TOOL_NOT_FOUND", `Managed Room is missing required bootstrap tool: ${name}`);
		}
	}
	const receipts: Array<{ name: string; receiptId: string }> = [];
	const manifestHash = String(options.roomCapability.manifestHash ?? "").slice(0, 16) || "room";
	for (const name of ROOM_BOOTSTRAP_TOOL_NAMES) {
		const receipt = await requestGovernedToolLoad(
			options,
			name,
			`load:bootstrap:${options.sessionId}:${manifestHash}:${name}`,
		);
		receipts.push({ name, receiptId: String(receipt?.receiptId ?? "") });
	}
	for (const item of receipts) {
		options.registry.recordLoadReceipt(item.name, item.receiptId);
		options.registry.disclose(item.name);
	}
	return receipts.map((item) => item.name);
}
