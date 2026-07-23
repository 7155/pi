import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type BackendToolBridgeOptions, requestProductGateway } from "./tool-bridge.ts";

const WORKFLOW_BLOCK_PATTERN = /\n*<rag-ime-context type="workflow_control"[^>]*>[\s\S]*?<\/rag-ime-context>\n*/gu;

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

function publicPlanItems(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 12).flatMap((item, index) => {
		const record = asRecord(item);
		const label = text(record.text) || text(record.title) || text(record.objective);
		if (!label) return [];
		const status = text(record.status) || (record.completed === true ? "completed" : "pending");
		const marker = status === "completed" ? "x" : status === "in_progress" || status === "executing" ? ">" : " ";
		return [`${index + 1}. [${marker}] ${label.slice(0, 240)}`];
	});
}

function renderWorkflow(snapshot: WorkflowSnapshot): string {
	const plan = asRecord(snapshot.plan);
	const goal = asRecord(snapshot.goal);
	const gate = asRecord(snapshot.actGate);
	const planStatus = text(plan.status);
	const goalStatus = text(goal.status);
	const lines = ["## 当前工作流"];
	const planItems = publicPlanItems(plan.items);
	const showPlan = Boolean(planStatus) && (planStatus !== "draft" || planItems.length > 0);

	if (showPlan) {
		lines.push(`### Plan · ${planStatus}`);
		const title = text(plan.title);
		if (title) lines.push(title.slice(0, 320));
		lines.push(...planItems);
	}

	if (goal.configured === true && goalStatus) {
		lines.push(`### Goal · ${goalStatus}`);
		const objective = text(goal.objective);
		if (objective) lines.push(objective.slice(0, 500));
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
		if (budgetParts.length) lines.push(budgetParts.join(" · "));
		if (goalStatus === "paused") lines.push("Goal 已暂停，不要自行继续执行。");
	}

	if (Object.keys(gate).length > 0) {
		const fallback =
			gate.allowed === true ? "当前工作已授权；写操作仍须通过产品权限与审批。" : "当前写操作未获批准。";
		lines.push(`### Act Gate\n${text(gate.message) || text(gate.reason) || fallback}`);
	}
	return lines.join("\n").trim();
}

function replaceWorkflowBlock(systemPrompt: string, body: string): string {
	const base = systemPrompt.replace(WORKFLOW_BLOCK_PATTERN, "\n").trimEnd();
	if (!body) return base;
	return [base, '<rag-ime-context type="workflow_control">', body, "</rag-ime-context>"].filter(Boolean).join("\n");
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
