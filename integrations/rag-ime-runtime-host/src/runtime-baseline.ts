import { PROTOCOL_NAME } from "./protocol.ts";

/** Upstream Pi baseline used to build and validate this product adapter. */
export const PI_RUNTIME_BASELINE = "0.84.2" as const;

/**
 * Keep externally visible Runtime metadata authoritative while the legacy host
 * implementation is migrated as an isolated product adapter.
 */
export function normalizeRuntimeMetadata(result: unknown): unknown {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	if (record.protocol !== PROTOCOL_NAME || typeof record.hostVersion !== "string") return result;
	return { ...record, piVersion: PI_RUNTIME_BASELINE };
}
