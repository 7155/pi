import { RuntimeProtocolError } from "./protocol.ts";

/** The complete surviving standalone native compaction set in one immutable Session. */
export interface CompactionTarget {
	kind: "compaction";
	runtimeSessionId: string;
	taskIds: string[];
}

export function parseCompactionTarget(value: unknown): CompactionTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "compactionTarget must be an object");
	}
	const target = value as Record<string, unknown>;
	if (Object.keys(target).some(key => !["kind", "runtimeSessionId", "taskIds"].includes(key)) ||
		target.kind !== "compaction" || typeof target.runtimeSessionId !== "string" ||
		!target.runtimeSessionId.trim() || target.runtimeSessionId !== target.runtimeSessionId.trim() ||
		target.runtimeSessionId.length > 240 || !Array.isArray(target.taskIds) || target.taskIds.length === 0 ||
		target.taskIds.some((id, index, ids) => typeof id !== "string" || !/^durable:task:[1-9][0-9]*$/u.test(id) ||
			!Number.isSafeInteger(Number(id.slice("durable:task:".length))) || (index > 0 && ids[index - 1] >= id))) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "compactionTarget requires a Session binding and sorted unique native task IDs");
	}
	return { kind: "compaction", runtimeSessionId: target.runtimeSessionId, taskIds: [...target.taskIds] };
}
