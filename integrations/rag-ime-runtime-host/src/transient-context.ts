import { RuntimeProtocolError } from "./protocol.ts";

export const TRANSIENT_CONTEXT_ENVELOPE_PREFIX = "RAG_IME_TRANSIENT_CONTEXT_V1\n";
const TRANSIENT_CONTEXT_SCHEMA = "rag-ime.runtime-prompt.v1";
const MAX_TRANSIENT_CONTEXT_CHARS = 64_000;

export interface DecodedRuntimePrompt {
	message: string;
	transientContext: string;
	sessionContext?: string;
}

export interface RuntimeContextSnapshot {
	roomContext?: string;
	sessionContext: string;
	transientContext: string;
}

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
		typeof envelope.transientContext !== "string" ||
		(envelope.sessionContext !== undefined && typeof envelope.sessionContext !== "string")
	) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context envelope is incomplete");
	}
	const sessionContext = typeof envelope.sessionContext === "string" ? envelope.sessionContext.trim() : undefined;
	if (envelope.transientContext.length + (sessionContext?.length ?? 0) > MAX_TRANSIENT_CONTEXT_CHARS) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Transient context exceeds 64000 characters");
	}
	return {
		message: envelope.message,
		transientContext: envelope.transientContext.trim(),
		...(sessionContext !== undefined ? { sessionContext } : {}),
	};
}

export function formatLocalTimestamp(now: Date = new Date()): string {
	if (!Number.isFinite(now.getTime())) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Runtime context timestamp is invalid");
	}
	const pad = (value: number) => String(value).padStart(2, "0");
	const offsetMinutes = -now.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
		`${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
	);
}
