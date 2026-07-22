import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

const HOOK_BLOCK_PATTERN = /\n*<rag-ime-context type="lifecycle_hook"[^>]*>[\s\S]*?<\/rag-ime-context>\n*/gu;
const DEFAULT_IDLE_DELAY_MS = 5 * 60 * 1000;
const PENDING_STATE_SCHEMA_VERSION = "rag-ime.lifecycle-pending-events.v1";

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
	isManagedRoom?(): boolean;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
	stateDirectory?: string;
}

interface LifecycleEventEnvelope extends Record<string, unknown> {
	schemaVersion: "rag-ime.agent-lifecycle-event.v1";
	eventId: string;
	sessionId: string;
	eventType: LifecycleEventType;
	occurredAtMs: number;
	payload: Record<string, unknown>;
}

interface LifecyclePendingState {
	schemaVersion: typeof PENDING_STATE_SCHEMA_VERSION;
	sessionId: string;
	events: LifecycleEventEnvelope[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
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

function lifecycleEventType(value: unknown): value is LifecycleEventType {
	return (
		value === "session_start" ||
		value === "turn_end" ||
		value === "compaction" ||
		value === "project_complete" ||
		value === "tool_failed" ||
		value === "idle"
	);
}

function pendingStateDirectory(explicit: string | undefined): string {
	if (explicit !== undefined) return explicit.trim();
	const configured = text(process.env.RAG_IME_PI_LIFECYCLE_STATE_DIR);
	if (configured) return configured;
	const sessionDirectory = text(process.env.RAG_IME_PI_SESSION_DIR);
	return sessionDirectory ? join(sessionDirectory, ".lifecycle-hooks") : "";
}

function pendingStateFile(directory: string, sessionId: string): string {
	return directory ? join(directory, `${digest(sessionId).slice(0, 40)}.json`) : "";
}

function isLifecycleEnvelope(value: unknown, sessionId: string): value is LifecycleEventEnvelope {
	const envelope = asRecord(value);
	return (
		envelope.schemaVersion === "rag-ime.agent-lifecycle-event.v1" &&
		text(envelope.eventId).startsWith("lifecycle:") &&
		envelope.sessionId === sessionId &&
		lifecycleEventType(envelope.eventType) &&
		Number.isFinite(Number(envelope.occurredAtMs)) &&
		typeof envelope.payload === "object" &&
		envelope.payload !== null &&
		!Array.isArray(envelope.payload)
	);
}

function completedWorkflowDetails(event: ToolResultEvent): Record<string, unknown> | undefined {
	if (event.isError || (event.toolName !== "agent_plan" && event.toolName !== "agent_goal")) return undefined;
	const input = asRecord(event.input);
	if ((text(input.op) || text(input.action)) !== "complete") return undefined;
	const details = asRecord(event.details);
	const plan = asRecord(details.plan);
	const goal = asRecord(details.goal);
	const completed = [
		text(plan.status) === "completed" ? `plan:${text(plan.id) || text(plan.title)}` : "",
		goal.configured === true && text(goal.status) === "completed"
			? `goal:${text(goal.goalId) || text(goal.objective)}`
			: "",
	].filter(Boolean);
	if (completed.length === 0) return undefined;
	return {
		completionKey: completed.join("|"),
		plan,
		goal,
	};
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

function replaceHookBlock(systemPrompt: string, context: string): string {
	const base = systemPrompt.replace(HOOK_BLOCK_PATTERN, "\n").trimEnd();
	if (!context.trim()) return base;
	return [base, '<rag-ime-context type="lifecycle_hook">', context.trim(), "</rag-ime-context>"]
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
	const awaitingResults = new Set<string>();
	const stateDirectory = pendingStateDirectory(options.stateDirectory);
	const stateFile = pendingStateFile(stateDirectory, options.bridge.sessionId);
	let activeFlush: Promise<void> | undefined;
	let persistenceQueue: Promise<void> = Promise.resolve();
	const schedule = options.setTimer ?? setTimeout;
	const cancel = options.clearTimer ?? clearTimeout;
	const isManagedRoom = (): boolean => options.isManagedRoom?.() === true;

	async function writePendingState(events: LifecycleEventEnvelope[]): Promise<void> {
		if (!stateFile) return;
		await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		await chmod(stateDirectory, 0o700);
		if (events.length === 0) {
			try {
				await unlink(stateFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return;
		}
		const state: LifecyclePendingState = {
			schemaVersion: PENDING_STATE_SCHEMA_VERSION,
			sessionId: options.bridge.sessionId,
			events,
		};
		const temporary = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
		try {
			await writeFile(temporary, `${JSON.stringify(state)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await rename(temporary, stateFile);
		} finally {
			try {
				await unlink(temporary);
			} catch {
				// A successful atomic rename already removed the temporary path.
			}
		}
	}

	function persistPending(): Promise<void> {
		if (!stateFile) return Promise.resolve();
		const snapshot = [...pendingEvents.values()];
		const pending = persistenceQueue.catch(() => undefined).then(() => writePendingState(snapshot));
		persistenceQueue = pending;
		return pending;
	}

	async function restorePending(): Promise<number> {
		if (!stateFile) return 0;
		let serialized = "";
		try {
			serialized = await readFile(stateFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		const state = asRecord(JSON.parse(serialized));
		if (
			state.schemaVersion !== PENDING_STATE_SCHEMA_VERSION ||
			state.sessionId !== options.bridge.sessionId ||
			!Array.isArray(state.events)
		) {
			throw new Error("Lifecycle pending state is invalid");
		}
		for (const event of state.events) {
			if (!isLifecycleEnvelope(event, options.bridge.sessionId)) {
				throw new Error("Lifecycle pending event is invalid");
			}
			pendingEvents.set(event.eventId, event);
		}
		return pendingEvents.size;
	}

	const restored = restorePending();

	function clearIdle(): void {
		if (idleTimer !== undefined) cancel(idleTimer);
		idleTimer = undefined;
	}

	async function flushPending(): Promise<void> {
		await restored;
		if (!options.bridge.gatewayUrl || pendingEvents.size === 0) return;
		if (activeFlush) return activeFlush;
		activeFlush = (async () => {
			for (const [eventId, envelope] of pendingEvents) {
				try {
					const response = await requestProductGateway(options.bridge, "lifecycle-event", envelope, undefined);
					const result = asRecord(response.result);
					const nextContext = bounded(text(result.nextTurnContext), 2_000);
					if (nextContext) pendingContext = nextContext;
					if (awaitingResults.has(eventId)) deliveredResults.set(eventId, result);
					pendingEvents.delete(eventId);
					await persistPending();
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
		await restored;
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
			await persistPending();
		}
		awaitingResults.add(eventId);
		try {
			await flushPending();
			const result = deliveredResults.get(eventId);
			if (!result) throw new Error(`Lifecycle event remains queued: ${eventId}`);
			deliveredResults.delete(eventId);
			return result;
		} finally {
			awaitingResults.delete(eventId);
		}
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

	async function projectComplete(details: Record<string, unknown>): Promise<void> {
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
			// The stable envelope was persisted before delivery and remains queued
			// for startup or the next lifecycle opportunity.
		}
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
			if (isManagedRoom()) {
				// Room context epochs own task recovery. Keep lifecycle events auditable,
				// but never let an old generic suggestion become a second recovery packet.
				pendingContext = "";
				const systemPrompt = replaceHookBlock(event.systemPrompt, "");
				return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
			}
			if (!pendingContext) return;
			const context = pendingContext;
			pendingContext = "";
			return {
				systemPrompt: replaceHookBlock(event.systemPrompt, context),
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
			const managedRoom = isManagedRoom();
			try {
				await send(
					"compaction",
					managedRoom
						? {
								reason: event.reason,
								willRetry: event.willRetry,
								summaryLength: summary.length,
								summarySha256: digest(summary),
								auditOnly: true,
								facts: [],
								contextOwner: "room_context_epoch",
							}
						: {
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
			if (managedRoom) {
				pendingContext = "";
				return {
					systemPrompt: replaceHookBlock(ctx.getSystemPrompt(), ""),
				};
			}
			if (!pendingContext) return undefined;
			const context = pendingContext;
			pendingContext = "";
			return {
				systemPrompt: replaceHookBlock(ctx.getSystemPrompt(), context),
			};
		});

		pi.on("tool_result", async (event: ToolResultEvent) => {
			if (!event.isError) {
				const completion = completedWorkflowDetails(event);
				if (completion) await projectComplete(completion);
				return;
			}
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

		pi.on("session_shutdown", async () => {
			clearIdle();
			try {
				await restored;
				await persistPending();
				await flushPending();
			} catch {
				// Atomic pending state remains the recovery source after shutdown.
			}
		});
	};

	void restored
		.then((restoredEventCount) => (restoredEventCount > 0 ? flushPending() : undefined))
		.catch(() => undefined);

	return {
		extension,
		projectComplete,
	};
}

export { replaceHookBlock };
