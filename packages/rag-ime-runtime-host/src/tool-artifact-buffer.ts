const MAX_ARTIFACT_BLOCKS = 16;
const MEDIA_ID_PATTERN = /^media_[A-Za-z0-9_-]{12,80}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ROOM_DELIVERY_TOOLS = new Set(["room_post", "room_commit"]);

export interface PreparedToolArguments {
	arguments: unknown;
	deliveryKeys: string[];
}

/**
 * Owns the short-lived handoff from a product tool result to a governed Room
 * post. The model never has to copy opaque media receipts into another call.
 */
export class ToolArtifactBuffer {
	private readonly pending = new Map<string, Record<string, unknown>>();

	capture(...values: unknown[]): Record<string, unknown>[] {
		const captured: Record<string, unknown>[] = [];
		for (const block of toolAgentBlocks(...values)) {
			const key = artifactKey(block);
			if (!key || this.pending.has(key) || this.pending.size >= MAX_ARTIFACT_BLOCKS) continue;
			const copy = structuredClone(block);
			this.pending.set(key, copy);
			captured.push(structuredClone(copy));
		}
		return captured;
	}

	prepare(toolName: string, args: unknown): PreparedToolArguments {
		if (!ROOM_DELIVERY_TOOLS.has(toolName) || this.pending.size === 0 || !isRecord(args)) {
			return { arguments: args, deliveryKeys: [] };
		}
		if (args.blocks !== undefined && (!Array.isArray(args.blocks) || args.blocks.some((block) => !isRecord(block)))) {
			return { arguments: args, deliveryKeys: [] };
		}
		const existing = Array.isArray(args.blocks) ? args.blocks.map((block) => structuredClone(block)) : [];
		const seen = new Set(existing.map(artifactKey).filter(Boolean));
		const deliveryKeys: string[] = [];
		for (const [key, block] of this.pending) {
			if (seen.has(key)) {
				deliveryKeys.push(key);
				continue;
			}
			if (existing.length >= MAX_ARTIFACT_BLOCKS) break;
			existing.push(structuredClone(block));
			seen.add(key);
			deliveryKeys.push(key);
		}
		if (deliveryKeys.length === 0) return { arguments: args, deliveryKeys: [] };
		return {
			arguments: { ...structuredClone(args), blocks: existing },
			deliveryKeys,
		};
	}

	acknowledge(deliveryKeys: readonly string[]): void {
		for (const key of deliveryKeys) this.pending.delete(key);
	}

	clear(): void {
		this.pending.clear();
	}

	size(): number {
		return this.pending.size;
	}
}

export function toolAgentBlocks(...values: unknown[]): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const identities = new Set<string>();
	const visited = new Set<object>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 5 || !isRecord(value) || visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value.agentBlocks)) {
			for (const candidate of value.agentBlocks) {
				if (!isManagedFileBlock(candidate)) continue;
				const key = artifactKey(candidate);
				if (!key || identities.has(key) || result.length >= MAX_ARTIFACT_BLOCKS) continue;
				identities.add(key);
				result.push(structuredClone(candidate));
			}
		}
		for (const key of ["details", "result", "approval", "receipt"] as const) {
			visit(value[key], depth + 1);
		}
	};
	for (const value of values) visit(value, 0);
	return result;
}

/** Remove opaque UI receipts before a product result enters model context. */
export function modelVisibleResult(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(modelVisibleResult);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "agentBlocks")
			.map(([key, item]) => [key, modelVisibleResult(item)]),
	);
}

function isManagedFileBlock(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || typeof value.id !== "string" || value.type !== "file" || !isRecord(value.data)) {
		return false;
	}
	const data = value.data;
	const mediaId = text(data.mediaId);
	const sessionId = text(data.sessionId);
	const sha256 = text(data.sha256).toLowerCase();
	const receiptUrl = text(data.receiptUrl);
	return (
		MEDIA_ID_PATTERN.test(mediaId) &&
		SESSION_ID_PATTERN.test(sessionId) &&
		SHA256_PATTERN.test(sha256) &&
		text(data.fileName).length > 0 &&
		text(data.mimeType).length > 0 &&
		typeof data.byteSize === "number" &&
		Number.isSafeInteger(data.byteSize) &&
		data.byteSize > 0 &&
		receiptUrl ===
			`/api/agent/media/${encodeURIComponent(mediaId)}/content?sessionId=${encodeURIComponent(sessionId)}`
	);
}

function artifactKey(value: Record<string, unknown>): string {
	if (!isRecord(value.data)) return "";
	const mediaId = text(value.data.mediaId);
	const sha256 = text(value.data.sha256).toLowerCase();
	return MEDIA_ID_PATTERN.test(mediaId) && SHA256_PATTERN.test(sha256) ? `${mediaId}:${sha256}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
