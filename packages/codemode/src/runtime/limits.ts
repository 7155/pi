import { Buffer } from "node:buffer";
import type { WorkerToHostMessage } from "./protocol.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_ITEMS = 1024;
/** Bound both queued payloads and per-message/object overhead, including tool calls. */
export const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_BRIDGE_BYTES = 64 * 1024 * 1024;
export const MAX_BRIDGE_MESSAGES = 4096;

export interface OutputLimits {
	maxOutputBytes: number;
	maxOutputItems: number;
}

/** Independent copies run before worker postMessage and before host accumulation. */
export class MessageBudget {
	private readonly limits: OutputLimits;
	private outputBytes = 0;
	private outputItems = 0;
	private bridgeBytes = 0;
	private bridgeMessages = 0;

	constructor(limits: OutputLimits) {
		this.limits = limits;
	}

	/** Also used with UTF-16 lengths as a lower bound before copying strings out of the VM. */
	check(messageBytes: number, outputBytes: number, outputItems: number): string | undefined {
		if (this.outputItems + outputItems > this.limits.maxOutputItems) {
			return `Output limit exceeded: at most ${this.limits.maxOutputItems} items per execution`;
		}
		if (this.outputBytes + outputBytes > this.limits.maxOutputBytes) {
			return `Output limit exceeded: at most ${this.limits.maxOutputBytes} UTF-8 bytes per execution`;
		}
		if (messageBytes > MAX_BRIDGE_MESSAGE_BYTES) {
			return `Bridge limit exceeded: at most ${MAX_BRIDGE_MESSAGE_BYTES} UTF-8 bytes per message`;
		}
		if (this.bridgeBytes + messageBytes > MAX_BRIDGE_BYTES) {
			return `Bridge limit exceeded: at most ${MAX_BRIDGE_BYTES} UTF-8 payload bytes per execution`;
		}
		if (this.bridgeMessages >= MAX_BRIDGE_MESSAGES) {
			return `Bridge limit exceeded: at most ${MAX_BRIDGE_MESSAGES} messages per execution`;
		}
		return undefined;
	}

	accept(message: Exclude<WorkerToHostMessage, { type: "limit" }>): string | undefined {
		let messageBytes = 0;
		let outputBytes = 0;
		let outputItems = 0;
		switch (message.type) {
			case "output":
				outputBytes =
					message.item.type === "text"
						? Buffer.byteLength(message.item.text)
						: Buffer.byteLength(message.item.data) + Buffer.byteLength(message.item.mimeType);
				messageBytes = outputBytes;
				outputItems = 1;
				break;
			case "call":
				messageBytes = Buffer.byteLength(message.name) + Buffer.byteLength(message.args ?? "");
				break;
			case "done":
				if (message.ok) {
					outputBytes = Buffer.byteLength(message.value ?? "");
					outputItems = message.value === undefined ? 0 : 1;
					messageBytes = outputBytes + Buffer.byteLength(message.writes);
				} else {
					messageBytes = Buffer.byteLength(message.error);
					outputBytes = messageBytes;
				}
				break;
			case "crash":
				messageBytes = Buffer.byteLength(message.message);
				break;
		}
		const error = this.check(messageBytes, outputBytes, outputItems);
		if (error) return error;
		this.outputBytes += outputBytes;
		this.outputItems += outputItems;
		this.bridgeBytes += messageBytes;
		this.bridgeMessages++;
		return undefined;
	}
}
