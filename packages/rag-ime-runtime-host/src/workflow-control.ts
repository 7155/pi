import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

const WORKFLOW_BLOCK_PATTERN =
	/\n*(?:<workflow-state\b[^>]*>[\s\S]*?<\/workflow-state>|<rag-ime-context type="workflow_control"[^>]*>[\s\S]*?<\/rag-ime-context>)\n*/gu;

interface WorkflowControlOptions {
	bridge: BackendToolBridgeOptions;
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

function lastAssistantUsage(messages: readonly unknown[]): { tokenDelta: number } {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const record = messages[index] as unknown as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const usage = asRecord(record.usage);
		const total =
			numberValue(usage.totalTokens) ||
			numberValue(usage.input) +
				numberValue(usage.output) +
				numberValue(usage.cacheRead) +
				numberValue(usage.cacheWrite);
		return { tokenDelta: total };
	}
	return { tokenDelta: 0 };
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
	let activeUsageReport:
		| {
				turnId: string;
				idempotencyKey: string;
				tokenDelta: number;
				elapsedDeltaMs: number;
		  }
		| undefined;

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
			activeUsageReport = undefined;
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
			const { tokenDelta } = lastAssistantUsage(event.messages);
			const turnId = activeTurnId;
			if (!turnId) return;
			activeUsageReport ??= {
				turnId,
				idempotencyKey: `goal-usage:${turnId}`,
				tokenDelta,
				elapsedDeltaMs: turnStartedAtMs > 0 ? Math.max(0, Date.now() - turnStartedAtMs) : 0,
			};
			try {
				const snapshot = await fetchState("goal-usage", {
					sessionId: options.bridge.sessionId,
					...activeUsageReport,
				});
				const goal = asRecord(snapshot.goal);
				goalActive = goal.configured === true && text(goal.status) === "active";
				await observeCompletion(snapshot);
			} catch {
				// Usage telemetry must not turn a successful model response into
				// a failed turn. Product-side enforcement remains authoritative.
			}
		});
	};
}

export { renderWorkflow, replaceWorkflowBlock };
