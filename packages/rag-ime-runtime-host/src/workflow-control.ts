import { createHash, randomUUID } from "node:crypto";
import type { BeforeAgentSettleEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

const WORKFLOW_BLOCK_PATTERN =
	/\n*(?:<workflow-state\b[^>]*>[\s\S]*?<\/workflow-state>|<rag-ime-context type="workflow_control"[^>]*>[\s\S]*?<\/rag-ime-context>)\n*/gu;
const MAX_TOOL_EVIDENCE_FINGERPRINTS = 10_000;
// Loopback should normally answer in milliseconds. Eight seconds tolerates a
// loaded local process while still bounding Agent settlement deterministically.
const GOAL_SETTLE_GATEWAY_TIMEOUT_MS = 8_000;
// The Product Room Kernel already bounds recovery to four repairs
// (`SYSTEM_MAX_REPAIRS = 4`). Ordinary Goals get the same four native
// continuation opportunities; attempt five is the final typed settle decision.
const MAX_GOAL_SETTLE_ATTEMPTS_PER_SCOPE = 5;

interface WorkflowControlOptions {
	bridge: BackendToolBridgeOptions;
	hasActiveRoom?(): boolean;
	onProjectComplete?(details: Record<string, unknown>): Promise<void>;
}

interface WorkflowSnapshot {
	plan?: Record<string, unknown>;
	goal?: Record<string, unknown>;
	actGate?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return '"[circular]"';
		ancestors.add(value);
		const result = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
		ancestors.delete(value);
		return result;
	}
	if (value && typeof value === "object") {
		if (ancestors.has(value)) return '"[circular]"';
		ancestors.add(value);
		const result = `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`)
			.join(",")}}`;
		ancestors.delete(value);
		return result;
	}
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value === "number" && !Number.isFinite(value)) return "null";
	return JSON.stringify(value) ?? "null";
}

function toolEvidenceFingerprint(toolName: string, args: unknown, result: unknown): string {
	const visibleResult =
		result &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		Array.isArray((result as Record<string, unknown>).content)
			? {
					content: (result as Record<string, unknown>).content,
					...((result as Record<string, unknown>).terminate === true ? { terminate: true } : {}),
				}
			: result;
	return createHash("sha256")
		.update(canonicalJson({ args, result: visibleResult, toolName }))
		.digest("hex");
}

function evidenceSetDigest(fingerprints: ReadonlySet<string>): string {
	return createHash("sha256")
		.update([...fingerprints].sort().join("\n"))
		.digest("hex");
}

function optionalNumber(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

interface PublicPlanItem {
	label: string;
	status: string;
}

function publicPlanItems(value: unknown): PublicPlanItem[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 12).flatMap((item) => {
		const record = asRecord(item);
		const label = text(record.text) || text(record.title) || text(record.objective);
		if (!label) return [];
		return [
			{
				label: label.slice(0, 240),
				status: text(record.status) || (record.completed === true ? "completed" : "pending"),
			},
		];
	});
}

function renderWorkflow(snapshot: WorkflowSnapshot): string {
	const plan = asRecord(snapshot.plan);
	const goal = asRecord(snapshot.goal);
	const gate = asRecord(snapshot.actGate);
	const planStatus = text(plan.status);
	const goalStatus = text(goal.status);
	const lines: string[] = [];
	const planItems = publicPlanItems(plan.items);
	const showPlan = Boolean(planStatus) && (planStatus !== "draft" || planItems.length > 0);

	const objective = (showPlan ? text(plan.title) : "") || (goal.configured === true ? text(goal.objective) : "");
	if (objective) {
		lines.push(`当前任务：${objective.slice(0, 500)}`);
	}

	if (showPlan && planItems.length > 0) {
		const completed = planItems.filter((item) => item.status === "completed").length;
		const active = planItems.find((item) => ["in_progress", "executing"].includes(item.status));
		const next = active ?? planItems.find((item) => item.status !== "completed");
		const summary =
			completed === planItems.length
				? "全部完成"
				: `${completed}/${planItems.length} 项完成${next ? `，正在执行：${next.label}` : ""}`;
		lines.push(`计划：${summary}`);
	} else if (showPlan && planStatus === "completed") {
		lines.push("计划：全部完成");
	}

	if (goal.configured === true && goalStatus) {
		const remaining = asRecord(goal.remaining);
		const budget = asRecord(goal.budget);
		const remainingTokens = optionalNumber(remaining.tokens);
		const remainingTimeMs = optionalNumber(remaining.timeMs);
		const budgetParts = [
			remainingTokens !== undefined || optionalNumber(budget.tokenLimit) !== undefined
				? `剩余 Token ${(remainingTokens ?? 0).toLocaleString()}`
				: "",
			remainingTimeMs !== undefined || optionalNumber(budget.timeLimitMs) !== undefined
				? `剩余时间 ${Math.ceil((remainingTimeMs ?? 0) / 60_000)} 分钟`
				: "",
		].filter(Boolean);
		if (budgetParts.length) lines.push(`剩余预算：${budgetParts.join(" · ")}`);
	}

	if (goalStatus === "paused") {
		lines.push("行动状态：已暂停，等待用户继续。");
	} else if (Object.keys(gate).length > 0) {
		const message = text(gate.message);
		const reason = text(gate.reason);
		const roomDispatch = `${message} ${reason}`.includes("Room Dispatch");
		const state =
			gate.allowed === true
				? roomDispatch
					? "当前 Room 任务已经开始，可以在本轮权限范围内继续工作。"
					: "可以继续。"
				: message || reason || "当前改变尚未获准。";
		lines.push(`行动状态：${state}`);
	} else if (goalStatus === "active" || showPlan) {
		lines.push("行动状态：可以继续。");
	}
	return lines.join("\n").trim();
}

function replaceWorkflowBlock(systemPrompt: string, body: string): string {
	const base = systemPrompt.replace(WORKFLOW_BLOCK_PATTERN, "\n").trimEnd();
	if (!body) return base;
	return [base, "<workflow-state>", body, "</workflow-state>"].filter(Boolean).join("\n");
}

function assistantUsage(messages: readonly unknown[]): { tokenDelta: number } {
	let tokenDelta = 0;
	for (const message of messages) {
		const record = message as unknown as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const usage = asRecord(record.usage);
		tokenDelta +=
			numberValue(usage.totalTokens) ||
			numberValue(usage.input) +
				numberValue(usage.output) +
				numberValue(usage.cacheRead) +
				numberValue(usage.cacheWrite);
	}
	return { tokenDelta };
}

function completionKey(snapshot: WorkflowSnapshot): string {
	const plan = asRecord(snapshot.plan);
	const goal = asRecord(snapshot.goal);
	const completed = [
		text(plan.status) === "completed" ? `plan:${text(plan.id) || text(plan.title)}` : "",
		goal.configured === true && text(goal.status) === "completed"
			? `goal:${text(goal.goalId) || text(goal.objective)}`
			: "",
	].filter(Boolean);
	return completed.join("|");
}

export function createWorkflowControlExtension(options: WorkflowControlOptions): ExtensionFactory {
	let turnStartedAtMs = 0;
	let lastCompletionKey = "";
	let initializedCompletionState = false;
	let goalActive = false;
	let activeTurnId = "";
	let usageReportSequence = 0;
	let usageReportedAtMs = 0;
	const toolArgsByCallId = new Map<string, unknown>();
	const seenToolEvidenceFingerprints = new Set<string>();
	const freshToolEvidenceFingerprints = new Set<string>();

	async function fetchState(
		path: "workflow-state" | "goal-usage",
		body: Record<string, unknown>,
	): Promise<WorkflowSnapshot> {
		if (!options.bridge.gatewayUrl) return {};
		const response = await requestProductGateway(options.bridge, path, body, undefined);
		const result = asRecord(response.result);
		return {
			plan: asRecord(result.plan),
			goal: asRecord(result.goal),
			actGate: asRecord(result.actGate),
		};
	}

	async function observeCompletion(snapshot: WorkflowSnapshot): Promise<void> {
		const key = completionKey(snapshot);
		if (!initializedCompletionState) {
			lastCompletionKey = key;
			initializedCompletionState = true;
			return;
		}
		if (key && key !== lastCompletionKey && options.onProjectComplete) {
			await options.onProjectComplete({
				completionKey: key,
				plan: snapshot.plan ?? {},
				goal: snapshot.goal ?? {},
			});
		}
		lastCompletionKey = key;
	}

	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			turnStartedAtMs = Date.now();
			activeTurnId = `turn:${randomUUID()}`;
			usageReportSequence = 0;
			usageReportedAtMs = turnStartedAtMs;
			toolArgsByCallId.clear();
			seenToolEvidenceFingerprints.clear();
			freshToolEvidenceFingerprints.clear();
			try {
				const snapshot = await fetchState("workflow-state", {
					sessionId: options.bridge.sessionId,
				});
				const goal = asRecord(snapshot.goal);
				goalActive = goal.configured === true && text(goal.status) === "active";
				await observeCompletion(snapshot);
				return {
					systemPrompt: replaceWorkflowBlock(event.systemPrompt, renderWorkflow(snapshot)),
				};
			} catch {
				// Workflow state is advisory in the prompt. The Product gateway
				// still enforces the authoritative Act Gate on every mutation.
				return undefined;
			}
		});

		pi.on("agent_end", async (event) => {
			if (!options.bridge.gatewayUrl || !goalActive) return;
			const { tokenDelta } = assistantUsage(event.messages);
			const turnId = activeTurnId;
			if (!turnId) return;
			const sequence = ++usageReportSequence;
			const reportAtMs = Date.now();
			const report = {
				turnId,
				eventId: `agent-end:${turnId}:${sequence}`,
				idempotencyKey: `goal-usage:${turnId}:agent-end:${sequence}`,
				tokenDelta,
				elapsedDeltaMs:
					usageReportedAtMs > 0
						? Math.max(0, reportAtMs - usageReportedAtMs)
						: turnStartedAtMs > 0
							? Math.max(0, reportAtMs - turnStartedAtMs)
							: 0,
			};
			usageReportedAtMs = reportAtMs;
			try {
				const snapshot = await fetchState("goal-usage", {
					sessionId: options.bridge.sessionId,
					...report,
				});
				const goal = asRecord(snapshot.goal);
				goalActive = goal.configured === true && text(goal.status) === "active";
				await observeCompletion(snapshot);
			} catch {
				// Usage telemetry must not turn a successful model response into
				// a failed turn. Product-side enforcement remains authoritative.
			}
		});

		pi.on("tool_execution_start", (event) => {
			if (toolArgsByCallId.size < MAX_TOOL_EVIDENCE_FINGERPRINTS) {
				toolArgsByCallId.set(event.toolCallId, event.args);
			}
		});

		pi.on("tool_execution_end", (event) => {
			const args = toolArgsByCallId.get(event.toolCallId);
			toolArgsByCallId.delete(event.toolCallId);
			if (!event.isError && seenToolEvidenceFingerprints.size < MAX_TOOL_EVIDENCE_FINGERPRINTS) {
				const fingerprint = toolEvidenceFingerprint(event.toolName, args, event.result);
				if (!seenToolEvidenceFingerprints.has(fingerprint)) {
					seenToolEvidenceFingerprints.add(fingerprint);
					freshToolEvidenceFingerprints.add(fingerprint);
				}
			}
		});

		pi.on("before_agent_settle", async (event: BeforeAgentSettleEvent) => {
			// Room Dispatch settlement has its own Kernel-backed owner.  Never
			// compete with it for Pi's single before_agent_settle continuation.
			if (options.hasActiveRoom?.()) return;
			if (!options.bridge.gatewayUrl || !goalActive) return;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				return;
			}
			const reachedAttemptLimit = event.settleAttempt >= MAX_GOAL_SETTLE_ATTEMPTS_PER_SCOPE;
			const evidenceDigest = evidenceSetDigest(freshToolEvidenceFingerprints);
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				controller.abort(new Error(`Goal settle gateway timed out after ${GOAL_SETTLE_GATEWAY_TIMEOUT_MS}ms`));
			}, GOAL_SETTLE_GATEWAY_TIMEOUT_MS);
			let response: Awaited<ReturnType<typeof requestProductGateway>>;
			try {
				response = await requestProductGateway(
					options.bridge,
					"goal-settle",
					{
						schemaVersion: "rag-ime.agent-goal-settle-request.v1",
						sessionId: options.bridge.sessionId,
						settleScopeId: event.cancelScope.scopeId,
						settleAttempt: event.settleAttempt,
						freshToolEvidenceCount: freshToolEvidenceFingerprints.size,
						freshToolEvidenceSha256: evidenceDigest,
					},
					controller.signal,
				);
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error(`Goal settle gateway timed out after ${GOAL_SETTLE_GATEWAY_TIMEOUT_MS}ms`, {
						cause: error,
					});
				}
				if (!reachedAttemptLimit) throw error;
				// The local cap is authoritative even if the Product gateway is
				// temporarily unavailable for its typed `settle_attempt_limit`
				// receipt. Never turn attempt five into another continuation.
				goalActive = false;
				return;
			} finally {
				clearTimeout(timeout);
			}
			const result = asRecord(response.result);
			const state = text(result.state);
			goalActive = state === "continue" && !reachedAttemptLimit;
			if (state !== "continue" || reachedAttemptLimit) return;
			const message = text(result.message);
			const followUpKey = text(result.followUpKey);
			const goalId = text(result.goalId);
			if (!message || !followUpKey || !goalId) {
				throw new Error("Goal settle follow-up response is incomplete");
			}
			// Evidence belongs to the work completed since the previous Goal
			// continuation. Once this continuation is accepted for queuing, the
			// next settle attempt must prove fresh progress instead of reusing it.
			freshToolEvidenceFingerprints.clear();
			return {
				followUp: {
					text: message,
					continuation: {
						id: `goal-settle-follow-up:${followUpKey}`,
						correlationId: goalId,
						origin: "goal_supervisor",
						idempotencyKey: followUpKey,
						maxAttempts: 1,
					},
				},
			};
		});
	};
}

export { renderWorkflow, replaceWorkflowBlock };
