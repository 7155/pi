import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface DebugTurnIdentity {
	turnId: string;
	clientMessageId?: string;
}

export interface PiDebugContextRecord {
	schemaVersion: "rag-ime.pi-debug-context.v1";
	sessionId: string;
	turnId: string;
	clientMessageId: string;
	capturedAtMs: number;
	updatedAtMs: number;
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: unknown;
	model?: Record<string, unknown>;
	activeTools: string[];
	toolSchemas: Array<Record<string, unknown>>;
	contextWindows: Array<{ index: number; capturedAtMs: number; messages: unknown }>;
	providerRequests: Array<{ index: number; capturedAtMs: number; payload: unknown }>;
}

const MAX_TURNS = 8;
const MAX_CALLS_PER_TURN = 12;
const MAX_SERIALIZED_CHARS = 6_000_000;

/**
 * Captures the final extension/provider boundary in memory for local debugging.
 * Records are never appended to Pi JSONL or product observation storage.
 */
export class PiDebugContextRecorder {
	private readonly records = new Map<string, PiDebugContextRecord>();
	private readonly sessionId: string;
	private readonly activeTurn: () => DebugTurnIdentity | undefined;

	constructor(sessionId: string, activeTurn: () => DebugTurnIdentity | undefined) {
		this.sessionId = sessionId;
		this.activeTurn = activeTurn;
	}

	extension(): ExtensionFactory {
		return (pi) => {
			pi.on("before_agent_start", (event, context) => {
				const identity = this.activeTurn();
				if (!identity?.turnId) return;
				const now = Date.now();
				const activeTools = pi.getActiveTools();
				const activeSet = new Set(activeTools);
				const toolSchemas = pi
					.getAllTools()
					.filter((tool) => activeSet.has(tool.name))
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: cloneForDebug(tool.parameters),
						promptGuidelines: tool.promptGuidelines,
					}));
				this.records.delete(identity.turnId);
				this.records.set(identity.turnId, {
					schemaVersion: "rag-ime.pi-debug-context.v1",
					sessionId: this.sessionId,
					turnId: identity.turnId,
					clientMessageId: identity.clientMessageId ?? "",
					capturedAtMs: now,
					updatedAtMs: now,
					prompt: event.prompt,
					systemPrompt: event.systemPrompt,
					systemPromptOptions: cloneForDebug(event.systemPromptOptions),
					model: context.model
						? {
								provider: context.model.provider,
								id: context.model.id,
								name: context.model.name,
								api: context.model.api,
								contextWindow: context.model.contextWindow,
								maxTokens: context.model.maxTokens,
							}
						: undefined,
					activeTools: [...activeTools],
					toolSchemas,
					contextWindows: [],
					providerRequests: [],
				});
				this.trim();
			});

			pi.on("context", (event) => {
				const record = this.current();
				if (!record) return;
				record.contextWindows.push({
					index: record.contextWindows.length + 1,
					capturedAtMs: Date.now(),
					messages: cloneForDebug(event.messages),
				});
				if (record.contextWindows.length > MAX_CALLS_PER_TURN) record.contextWindows.shift();
				record.updatedAtMs = Date.now();
			});

			pi.on("before_provider_request", (event) => {
				const record = this.current();
				if (!record) return;
				record.providerRequests.push({
					index: record.providerRequests.length + 1,
					capturedAtMs: Date.now(),
					payload: cloneForDebug(event.payload),
				});
				if (record.providerRequests.length > MAX_CALLS_PER_TURN) record.providerRequests.shift();
				record.updatedAtMs = Date.now();
			});
		};
	}

	get(turnId?: string): PiDebugContextRecord | undefined {
		const record = turnId ? this.records.get(turnId) : [...this.records.values()].at(-1);
		return record ? (cloneForDebug(record) as PiDebugContextRecord) : undefined;
	}

	clear(): void {
		this.records.clear();
	}

	private current(): PiDebugContextRecord | undefined {
		const identity = this.activeTurn();
		return identity?.turnId ? this.records.get(identity.turnId) : undefined;
	}

	private trim(): void {
		while (this.records.size > MAX_TURNS) {
			const oldest = this.records.keys().next().value;
			if (typeof oldest !== "string") break;
			this.records.delete(oldest);
		}
	}
}

function cloneForDebug(value: unknown): unknown {
	let serialized: string;
	try {
		serialized = JSON.stringify(value, function debugReplacer(key, item) {
			if (
				/^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie)$/iu.test(
					key,
				)
			) {
				return "[credential omitted]";
			}
			if (typeof item === "bigint") return item.toString();
			if (typeof item === "string" && /^data:[^;]+;base64,/iu.test(item)) {
				return `[binary data omitted: ${item.length} chars]`;
			}
			return item;
		});
	} catch (error) {
		return { unavailable: true, error: error instanceof Error ? error.message : String(error) };
	}
	if (serialized.length > MAX_SERIALIZED_CHARS) {
		return {
			truncated: true,
			originalChars: serialized.length,
			jsonPreview: serialized.slice(0, MAX_SERIALIZED_CHARS),
		};
	}
	return JSON.parse(serialized) as unknown;
}
