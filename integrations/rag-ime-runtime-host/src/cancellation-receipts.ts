import type { PiSessionAbortReceipt } from "./pi-session.ts";

export type RoomCancellationSurface =
	| "provider"
	| "tool"
	| "exec"
	| "retry"
	| "compaction"
	| "branch_summary"
	| "timer"
	| "continuation"
	| "session";

export interface RuntimeSurfaceTerminationReceipt {
	schemaVersion: "wisdom-weasel.runtime-surface-termination-receipt.v1";
	surface: RoomCancellationSurface;
	state: "terminated" | "requested" | "unknown";
	targetIds: string[];
}

const OPERATION_KINDS: Record<Exclude<RoomCancellationSurface, "continuation" | "session">, Set<string>> = {
	provider: new Set(["provider"]),
	tool: new Set(["tool"]),
	exec: new Set(["bash_process"]),
	retry: new Set(["retry_sleep"]),
	compaction: new Set(["manual_compaction", "auto_compaction", "compaction_or_branch_summary"]),
	branch_summary: new Set(["branch_summary", "compaction_or_branch_summary"]),
	timer: new Set(["continuation_timer"]),
};

function unique(values: Iterable<string | undefined>): string[] {
	return [...new Set([...values].filter((value): value is string => Boolean(value?.trim())))];
}

function receipt(
	surface: RoomCancellationSurface,
	state: RuntimeSurfaceTerminationReceipt["state"],
	targetIds: Iterable<string | undefined> = [],
): RuntimeSurfaceTerminationReceipt {
	return {
		schemaVersion: "wisdom-weasel.runtime-surface-termination-receipt.v1",
		surface,
		state,
		targetIds: unique(targetIds),
	};
}

/** Derive Room surface states from the exact Agent cancellation receipt, never from SSE disconnect. */
export function roomCancellationSurfaces(
	sessionId: string,
	roomContinuationIds: readonly string[],
	abortReceipt?: PiSessionAbortReceipt,
): Record<RoomCancellationSurface, RuntimeSurfaceTerminationReceipt> {
	const lifecycle = abortReceipt?.lifecycle;
	const pending = new Set(lifecycle?.pendingOperations.map((operation) => operation.operationId) ?? []);
	const failed = new Set(lifecycle?.failedOperationIds ?? []);
	const operations = lifecycle?.operations ?? [];
	const surfaces = {} as Record<RoomCancellationSurface, RuntimeSurfaceTerminationReceipt>;

	for (const [surface, kinds] of Object.entries(OPERATION_KINDS) as Array<
		[Exclude<RoomCancellationSurface, "continuation" | "session">, Set<string>]
	>) {
		const relevant = operations
			.filter((operation) => kinds.has(operation.kind))
			.map((operation) => operation.operationId);
		const state = relevant.some((operationId) => failed.has(operationId))
			? "unknown"
			: relevant.some((operationId) => pending.has(operationId))
				? "requested"
				: "terminated";
		surfaces[surface] = receipt(surface, state, [sessionId, ...relevant]);
	}

	surfaces.continuation = receipt("continuation", "terminated", [
		sessionId,
		...roomContinuationIds,
		...(lifecycle?.cancelledContinuationIds ?? []),
	]);
	surfaces.session = receipt(
		"session",
		!lifecycle || (lifecycle.drained && lifecycle.idle) ? "terminated" : "requested",
		[sessionId, abortReceipt?.turnId],
	);
	return surfaces;
}

export function pendingRoomCancellationSurfaces(
	surfaces: Record<RoomCancellationSurface, RuntimeSurfaceTerminationReceipt>,
): RoomCancellationSurface[] {
	return (Object.keys(surfaces) as RoomCancellationSurface[]).filter(
		(surface) => surfaces[surface].state !== "terminated",
	);
}
