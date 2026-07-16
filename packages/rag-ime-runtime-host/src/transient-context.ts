import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { RuntimeProtocolError } from "./protocol.ts";

export const TRANSIENT_CONTEXT_ENVELOPE_PREFIX = "RAG_IME_TRANSIENT_CONTEXT_V1\n";
const TRANSIENT_CONTEXT_SCHEMA = "rag-ime.runtime-prompt.v1";
const MAX_TRANSIENT_CONTEXT_CHARS = 64_000;

export interface DecodedRuntimePrompt {
	message: string;
	transientContext: string;
}

type ContextMessage = ContextEvent["messages"][number];

export function decodeRuntimePrompt(value: string): DecodedRuntimePrompt {
	if (!value.startsWith(TRANSIENT_CONTEXT_ENVELOPE_PREFIX)) {
		return { message: value, transientContext: "" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.slice(TRANSIENT_CONTEXT_ENVELOPE_PREFIX.length));
	} catch {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context envelope is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context envelope must be an object");
	}
	const envelope = parsed as Record<string, unknown>;
	if (
		envelope.schemaVersion !== TRANSIENT_CONTEXT_SCHEMA ||
		typeof envelope.message !== "string" ||
		!envelope.message.trim() ||
		typeof envelope.transientContext !== "string"
	) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context envelope is incomplete");
	}
	if (envelope.transientContext.length > MAX_TRANSIENT_CONTEXT_CHARS) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context exceeds 64000 characters");
	}
	return {
		message: envelope.message,
		transientContext: envelope.transientContext.trim(),
	};
}

export function createTransientContextExtension(getContext: () => string): ExtensionFactory {
	return (pi) => {
		pi.on("context", (event) => {
			const context = getContext().trim();
			if (!context) return;
			return {
				messages: injectTransientContext(event.messages, context),
			};
		});
	};
}

export function injectTransientContext(messages: ContextEvent["messages"], context: string): ContextEvent["messages"] {
	const injected: ContextMessage = {
		role: "custom",
		customType: "rag-ime.transient-context",
		content: context,
		display: false,
		details: { lifecycle: "turn", persisted: false },
		timestamp: Date.now(),
	};
	const result = [...messages];
	let currentUserIndex = -1;
	for (let index = result.length - 1; index >= 0; index -= 1) {
		if (result[index]?.role === "user") {
			currentUserIndex = index;
			break;
		}
	}
	result.splice(currentUserIndex >= 0 ? currentUserIndex : result.length, 0, injected);
	return result;
}
