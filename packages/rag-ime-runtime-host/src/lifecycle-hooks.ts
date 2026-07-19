import { createHash } from "node:crypto";
import type { ExtensionFactory, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

const HOOK_BLOCK_PATTERN = /\n*<rag-ime-context type="lifecycle_hook"[^>]*>[\s\S]*?<\/rag-ime-context>\n*/gu;
const DEFAULT_IDLE_DELAY_MS = 5 * 60 * 1000;

export type LifecycleEventType =
	| "session_start"
	| "turn_end"
	| "compaction"
	| "project_complete"
	| "tool_failed"
	| "idle";

export interface LifecycleHookController {
	extension: ExtensionFactory;
	projectComplete(details: Record<string, unknown>): Promise<void>;
}

interface LifecycleHookOptions {
	bridge: BackendToolBridgeOptions;
	now?: () => Date;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
}

interface LifecycleEventEnvelope extends Record<string, unknown> {
	schemaVersion: "rag-ime.agent-lifecycle-event.v1";
	eventId: string;
	sessionId: string;
	eventType: LifecycleEventType;
	occurredAtMs: number;
	payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function localTimestamp(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
	return `${local}${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(
		absoluteOffset % 60,
	).padStart(2, "0")}`;
}

function bounded(value: string, maximum: number): string {
	return value.trim().slice(0, maximum);
}

function redactSensitiveText(value: string, maximum: number): string {
	return bounded(value, maximum)
		.replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted-token]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [redacted-token]")
		.replace(
			/\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/giu,
			"[redacted-credential]",
		)
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted-jwt]");
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableEventId(sessionId: string, eventType: LifecycleEventType, identity: unknown): string {
	return `lifecycle:${eventType}:${digest({ sessionId, eventType, identity }).slice(0, 40)}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return bounded(content, 600);
	if (!Array.isArray(content)) return "";
	return bounded(
		content
			.flatMap((item) => {
				const record = asRecord(item);
				return record.type === "text" ? [text(record.text)] : [];
			})
			.filter(Boolean)
			.join("\n"),
		600,
	);
}

function completionFacts(details: Record<string, unknown>): Array<Record<string, string>> {
	const plan = asRecord(details.plan);
	const goal = asRecord(details.goal);
	const audit = asRecord(goal.completionAudit);
	const facts: Array<Record<string, string>> = [];
	const auditSummary = bounded(text(audit.summary), 1_000);
	const auditEvidence = Array.isArray(audit.evidence)
		? audit.evidence
				.slice(0, 5)
				.map((item) => {
					const record = asRecord(item);
					return text(record.reference) || text(record.summary);
				})
				.filter(Boolean)
				.join(", ")
		: "";
	if (auditSummary) {
		facts.push({
			text: auditSummary,
			evidence: bounded(auditEvidence || `goal-audit:${text(audit.auditId)}`, 500),
		});
	}
	if (text(plan.status) === "completed") {
		const title = text(plan.title);
		const identifier = text(plan.id);
		if (title && identifier) {
			facts.push({
				text: `Completed plan: ${bounded(title, 400)}`,
				evidence: `workflow:${bounded(identifier, 300)}@${Number(plan.revision) || 0}`,
			});
		}
	}
	return facts;
}

function replaceHookBlock(systemPrompt: string, context: string, now: Date): string {
	const base = systemPrompt.replace(HOOK_BLOCK_PATTERN, "\n").trimEnd();
	if (!context.trim()) return base;
	return [
		base,
		`<rag-ime-context type="lifecycle_hook" current_time="${localTimestamp(now)}">`,
		context.trim(),
		"</rag-ime-context>",
	]
		.filter(Boolean)
		.join("\n");
}

export function createLifecycleHookController(options: LifecycleHookOptions): LifecycleHookController {
	let pendingContext = "";
	let sessionStarted = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let idleSequence = 0;
	const pendingEvents = new Map<string, LifecycleEventEnvelope>();
	const deliveredResults = new Map<string, Record<string, unknown>>();
	let activeFlush: Promise<void> | undefined;
	const schedule = options.setTimer ?? setTimeout;
	const cancel = options.clearTimer ?? clearTimeout;

	function clearIdle(): void {
		if (idleTimer !== undefined) cancel(idleTimer);
		idleTimer = undefined;
	}

	async function flushPending(): Promise<void> {
		if (!options.bridge.gatewayUrl || pendingEvents.size === 0) return;
		if (activeFlush) return activeFlush;
		activeFlush = (async () => {
			for (const [eventId, envelope] of pendingEvents) {
				try {
					const response = await requestProductGateway(options.bridge, "lifecycle-event", envelope, undefined);
					const result = asRecord(response.result);
					const nextContext = bounded(text(result.nextTurnContext), 2_000);
					if (nextContext) pendingContext = nextContext;
					deliveredResults.set(eventId, result);
					pendingEvents.delete(eventId);
				} catch {
					// Preserve ordering and retry the same stable event on the next
					// lifecycle opportunity instead of minting a duplicate event.
					break;
				}
			}
		})().finally(() => {
			activeFlush = undefined;
		});
		return activeFlush;
	}

	async function send(
		eventType: LifecycleEventType,
		payload: Record<string, unknown>,
		identity: unknown,
	): Promise<Record<string, unknown>> {
		if (!options.bridge.gatewayUrl) return {};
		const eventId = stableEventId(options.bridge.sessionId, eventType, identity);
		if (!pendingEvents.has(eventId)) {
			pendingEvents.set(eventId, {
				schemaVersion: "rag-ime.agent-lifecycle-event.v1",
				eventId,
				sessionId: options.bridge.sessionId,
				eventType,
				occurredAtMs: Date.now(),
				payload,
			});
		}
		await flushPending();
		const result = deliveredResults.get(eventId);
		if (!result) throw new Error(`Lifecycle event remains queued: ${eventId}`);
		deliveredResults.delete(eventId);
		return result;
	}

	function scheduleIdle(delayValue: unknown): void {
		clearIdle();
		const parsed = Number(delayValue);
		const delay =
			Number.isFinite(parsed) && parsed > 0
				? Math.min(Math.max(parsed, 30_000), 24 * 60 * 60 * 1000)
				: DEFAULT_IDLE_DELAY_MS;
		idleTimer = schedule(() => {
			idleTimer = undefined;
			idleSequence += 1;
			void send(
				"idle",
				{
					idleForMs: delay,
					auditOnly: true,
					facts: [],
					reason: "no_governed_fact_candidate",
				},
				{ idleSequence, delay },
			).catch(() => undefined);
		}, delay);
	}

	const extension: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", async (event) => {
			clearIdle();
			await flushPending();
			if (!sessionStarted) {
				sessionStarted = true;
				try {
					await send(
						"session_start",
						{
							promptLength: event.prompt.length,
							promptSha256: digest(event.prompt),
						},
						"session_start",
					);
				} catch {
					// Hooks are optional automation. A Sidecar outage must not
					// block the user's first provider request.
				}
			}
			if (!pendingContext) return;
			const context = pendingContext;
			pendingContext = "";
			return {
				systemPrompt: replaceHookBlock(event.systemPrompt, context, (options.now ?? (() => new Date()))()),
			};
		});

		pi.on("turn_end", async (event: TurnEndEvent) => {
			const assistantSummary = textFromContent(asRecord(event.message).content);
			try {
				const result = await send(
					"turn_end",
					{
						turnIndex: event.turnIndex,
						assistantSummaryLength: assistantSummary.length,
						assistantSummarySha256: digest(assistantSummary),
						toolResultCount: event.toolResults.length,
						failedToolCount: event.toolResults.filter((item) => item.isError).length,
					},
					{ turnIndex: event.turnIndex },
				);
				scheduleIdle(result.idleDelayMs);
			} catch {
				scheduleIdle(undefined);
			}
		});

		pi.on("session_compact", async (event, ctx) => {
			const summary = redactSensitiveText(event.compactionEntry.summary, 800);
			try {
				await send(
					"compaction",
					{
						reason: event.reason,
						willRetry: event.willRetry,
						summary,
						facts: summary ? [{ text: summary, evidence: `pi-compaction:${event.reason}` }] : [],
					},
					{
						reason: event.reason,
						summarySha256: digest(summary),
						willRetry: event.willRetry,
					},
				);
			} catch {
				return undefined;
			}
			if (!pendingContext) return undefined;
			const context = pendingContext;
			pendingContext = "";
			return {
				systemPrompt: replaceHookBlock(ctx.getSystemPrompt(), context, (options.now ?? (() => new Date()))()),
			};
		});

		pi.on("tool_result", async (event: ToolResultEvent) => {
			if (!event.isError) return;
			const errorSha256 = digest(event.content);
			const toolCallIdSha256 = digest(event.toolCallId);
			const safeToolName = bounded(event.toolName, 128);
			try {
				await send(
					"tool_failed",
					{
						toolName: safeToolName,
						toolCallIdSha256,
						inputSha256: digest(event.input),
						errorSha256,
						errorSummary: "Tool error details redacted by Runtime Host.",
						auditOnly: true,
						reason: "tool_failure_is_not_a_durable_memory_fact",
						facts: [],
					},
					{ toolCallIdSha256, errorSha256 },
				);
			} catch {
				// The original tool error remains the source of truth.
			}
		});

		pi.on("session_shutdown", () => {
			clearIdle();
		});
	};

	return {
		extension,
		async projectComplete(details: Record<string, unknown>): Promise<void> {
			try {
				const completionKey = bounded(text(details.completionKey), 400);
				await send(
					"project_complete",
					{
						completionKey,
						plan: asRecord(details.plan),
						goal: asRecord(details.goal),
						facts: completionFacts(details),
					},
					{ completionKey },
				);
			} catch {
				// The stable envelope remains queued and is flushed before the
				// next available lifecycle request.
			}
		},
	};
}

export { replaceHookBlock };
