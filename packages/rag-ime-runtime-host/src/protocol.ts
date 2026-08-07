export const PROTOCOL_VERSION = "2" as const;
export const PROTOCOL_NAME = "rag-ime.pi-runtime" as const;

export type RuntimeMethod =
	| "hello"
	| "health"
	| "models.list"
	| "completion.once"
	| "completion.cancel"
	| "tools.list"
	| "tools.sync"
	| "session.open"
	| "session.control_state"
	| "session.settlement.get"
	| "session.await_settled"
	| "session.snapshot"
	| "session.debug.context"
	| "session.commands"
	| "session.fork.candidates"
	| "session.fork"
	| "session.rewind"
	| "session.prompt"
	| "session.steer"
	| "session.follow_up"
	| "session.abort"
	| "session.compact"
	| "session.model.set"
	| "session.thinking.set"
	| "session.close"
	| "room.dispatch"
	| "room.cancel"
	| "approval.resolve"
	| "review.resolve"
	| "ui.resolve"
	| "plugins.list"
	| "plugins.create"
	| "plugins.validate"
	| "plugins.install"
	| "plugins.enable"
	| "plugins.disable"
	| "plugins.rollback";

export interface RuntimeRequest {
	protocolVersion: typeof PROTOCOL_VERSION;
	id: string;
	method: RuntimeMethod;
	params?: Record<string, unknown>;
}

export interface RoomCancelParams {
	cancelId: string;
	sessionId: string;
	rootId: string;
	dispatchId: string;
	generation: number;
	turnId: string;
	capabilityEpoch: number;
}

export function parseRoomCancelParams(params: Record<string, unknown>): RoomCancelParams {
	const requiredString = (key: keyof RoomCancelParams): string => {
		const value = params[key];
		if (typeof value !== "string" || value.trim().length === 0 || value.length > 240) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a non-empty string`);
		}
		return value.trim();
	};
	const requiredInteger = (key: "generation" | "capabilityEpoch"): number => {
		const value = params[key];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a non-negative safe integer`);
		}
		return value;
	};
	return {
		cancelId: requiredString("cancelId"),
		sessionId: requiredString("sessionId"),
		rootId: requiredString("rootId"),
		dispatchId: requiredString("dispatchId"),
		generation: requiredInteger("generation"),
		turnId: requiredString("turnId"),
		capabilityEpoch: requiredInteger("capabilityEpoch"),
	};
}

export function sameRoomCancelLineage(left: RoomCancelParams, right: RoomCancelParams): boolean {
	return (
		left.cancelId === right.cancelId &&
		left.sessionId === right.sessionId &&
		left.rootId === right.rootId &&
		left.dispatchId === right.dispatchId &&
		left.generation === right.generation &&
		left.turnId === right.turnId &&
		left.capabilityEpoch === right.capabilityEpoch
	);
}

export interface RuntimeError {
	code: string;
	message: string;
	details?: unknown;
}

export interface RuntimeSuccessResponse {
	protocolVersion: typeof PROTOCOL_VERSION;
	id: string;
	ok: true;
	result: unknown;
}

export interface RuntimeErrorResponse {
	protocolVersion: typeof PROTOCOL_VERSION;
	id: string;
	ok: false;
	error: RuntimeError;
}

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

export interface RuntimeEventEnvelope {
	protocolVersion: typeof PROTOCOL_VERSION;
	event: "agent.event" | "runtime.notice";
	sessionId: string;
	turnId?: string;
	clientMessageId?: string;
	sequence: number;
	payload: Record<string, unknown>;
}

export class RuntimeProtocolError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = "RuntimeProtocolError";
		this.code = code;
		this.details = details;
	}
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_REQUEST", "Request must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		throw new RuntimeProtocolError("UNSUPPORTED_PROTOCOL_VERSION", `Expected protocolVersion ${PROTOCOL_VERSION}`, {
			received: record.protocolVersion,
		});
	}
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256) {
		throw new RuntimeProtocolError("INVALID_REQUEST", "Request id must be a non-empty string");
	}
	if (typeof record.method !== "string" || !RUNTIME_METHODS.has(record.method as RuntimeMethod)) {
		throw new RuntimeProtocolError("METHOD_NOT_FOUND", `Unknown runtime method: ${String(record.method)}`);
	}
	if (
		record.params !== undefined &&
		(typeof record.params !== "object" || record.params === null || Array.isArray(record.params))
	) {
		throw new RuntimeProtocolError("INVALID_REQUEST", "Request params must be an object");
	}
	return record as unknown as RuntimeRequest;
}

export function successResponse(id: string, result: unknown): RuntimeSuccessResponse {
	return { protocolVersion: PROTOCOL_VERSION, id, ok: true, result };
}

export function errorResponse(id: string, error: unknown): RuntimeErrorResponse {
	if (error instanceof RuntimeProtocolError) {
		return {
			protocolVersion: PROTOCOL_VERSION,
			id,
			ok: false,
			error: { code: error.code, message: error.message, details: error.details },
		};
	}
	return {
		protocolVersion: PROTOCOL_VERSION,
		id,
		ok: false,
		error: {
			code: "INTERNAL_ERROR",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

const RUNTIME_METHODS = new Set<RuntimeMethod>([
	"hello",
	"health",
	"models.list",
	"completion.once",
	"completion.cancel",
	"tools.list",
	"tools.sync",
	"session.open",
	"session.control_state",
	"session.settlement.get",
	"session.await_settled",
	"session.snapshot",
	"session.debug.context",
	"session.commands",
	"session.fork.candidates",
	"session.fork",
	"session.rewind",
	"session.prompt",
	"session.steer",
	"session.follow_up",
	"session.abort",
	"session.compact",
	"session.model.set",
	"session.thinking.set",
	"session.close",
	"room.dispatch",
	"room.cancel",
	"approval.resolve",
	"review.resolve",
	"ui.resolve",
	"plugins.list",
	"plugins.create",
	"plugins.validate",
	"plugins.install",
	"plugins.enable",
	"plugins.disable",
	"plugins.rollback",
]);
