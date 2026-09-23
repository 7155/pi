import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_ENTRY_TYPE = "paw-session-workflow-state";
const CONTEXT_MESSAGE_TYPE = "paw-session-workflow-context";
const COMMAND_RESULT_ENTRY_TYPE = "paw-pi-package-command-result";
const MAX_STEPS = 32;
const MAX_TEXT = 2_000;

type GoalStatus = "active" | "paused" | "completed";
type StepStatus = "pending" | "in_progress" | "completed" | "blocked";

interface WorkflowStep {
	id: number;
	text: string;
	status: StepStatus;
}

interface WorkflowState {
	schemaVersion: 1;
	goal?: { objective: string; status: GoalStatus };
	steps: WorkflowStep[];
	updatedAt: string;
}

function initialState(): WorkflowState {
	return { schemaVersion: 1, steps: [], updatedAt: new Date(0).toISOString() };
}

function boundedText(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
}

function normalizeState(value: unknown): WorkflowState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return initialState();
	const record = value as Record<string, unknown>;
	const rawGoal = record.goal;
	let goal: WorkflowState["goal"];
	if (rawGoal && typeof rawGoal === "object" && !Array.isArray(rawGoal)) {
		const objective = boundedText((rawGoal as Record<string, unknown>).objective);
		const status = (rawGoal as Record<string, unknown>).status;
		if (objective && (status === "active" || status === "paused" || status === "completed")) {
			goal = { objective, status };
		}
	}
	const rawSteps = Array.isArray(record.steps) ? record.steps : [];
	const steps = rawSteps.slice(0, MAX_STEPS).flatMap((item, index): WorkflowStep[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const itemRecord = item as Record<string, unknown>;
		const text = boundedText(itemRecord.text);
		const status = itemRecord.status;
		if (!text || !["pending", "in_progress", "completed", "blocked"].includes(String(status))) return [];
		return [{ id: index + 1, text, status: status as StepStatus }];
	});
	return {
		schemaVersion: 1,
		...(goal ? { goal } : {}),
		steps,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

function renderState(state: WorkflowState): string {
	const lines: string[] = [];
	if (state.goal) lines.push(`Goal [${state.goal.status}]: ${state.goal.objective}`);
	if (state.steps.length > 0) {
		lines.push("Plan:");
		for (const step of state.steps) {
			const marker =
				step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : step.status === "blocked" ? "!" : "○";
			lines.push(`${step.id}. ${marker} ${step.text}`);
		}
	}
	return lines.join("\n") || "No active Session workflow.";
}

function parseSteps(value: string): WorkflowStep[] {
	return value
		.split(/\r?\n|;/u)
		.map((item) => item.replace(/^\s*\d+[.)]\s*/u, "").trim())
		.filter(Boolean)
		.slice(0, MAX_STEPS)
		.map((text, index) => ({ id: index + 1, text: text.slice(0, MAX_TEXT), status: "pending" }));
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return (message as AssistantMessage).content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export default function sessionWorkflowExtension(pi: ExtensionAPI): void {
	let state = initialState();
	let lastContext: ExtensionContext | undefined;

	function persist(): void {
		state.updatedAt = new Date().toISOString();
		pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(state));
	}

	function updateUi(ctx = lastContext): void {
		if (!ctx?.hasUI) return;
		lastContext = ctx;
		const completed = state.steps.filter((step) => step.status === "completed").length;
		const label = state.goal
			? `Goal ${state.goal.status}${state.steps.length ? ` · ${completed}/${state.steps.length}` : ""}`
			: undefined;
		ctx.ui.setStatus("paw-session-workflow", label ? ctx.ui.theme.fg("accent", label) : undefined);
		ctx.ui.setWidget(
			"paw-session-workflow",
			state.steps.length
				? state.steps.map((step) => {
						const marker = step.status === "completed" ? "☑" : step.status === "blocked" ? "⚠" : "☐";
						return `${marker} ${step.text}`;
					})
				: undefined,
		);
	}

	function notify(ctx: ExtensionContext, command: string, message = renderState(state)): void {
		pi.appendEntry(COMMAND_RESULT_ENTRY_TYPE, {
			schemaVersion: "rag-ime.pi-package-command-result.v1",
			packageId: "@paw/pi-session-workflow",
			command,
			message,
			details: structuredClone(state),
			timestamp: new Date().toISOString(),
		});
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function setGoal(objective: string): void {
		state.goal = { objective: objective.slice(0, MAX_TEXT), status: "active" };
		persist();
		updateUi();
	}

	function setPlan(steps: string[]): void {
		state.steps = steps
			.map((text) => boundedText(text))
			.filter(Boolean)
			.slice(0, MAX_STEPS)
			.map((text, index) => ({ id: index + 1, text, status: "pending" }));
		persist();
		updateUi();
	}

	pi.registerCommand("goal", {
		description: "Show or update the current Session Goal",
		handler: async (args, ctx) => {
			lastContext = ctx;
			const value = args.trim();
			if (!value) return notify(ctx, "goal");
			if (value === "clear") {
				state.goal = undefined;
				persist();
				updateUi(ctx);
				return notify(ctx, "goal", "Session Goal cleared.");
			}
			if (value === "pause" || value === "resume" || value === "complete") {
				if (!state.goal) return notify(ctx, "goal", "No Session Goal is configured.");
				state.goal.status = value === "resume" ? "active" : value === "complete" ? "completed" : "paused";
				persist();
				updateUi(ctx);
				return notify(ctx, "goal");
			}
			setGoal(value);
			notify(ctx, "goal");
		},
	});

	pi.registerCommand("plan", {
		description: "Show or replace the current Session Plan; separate steps with semicolons",
		handler: async (args, ctx) => {
			lastContext = ctx;
			const value = args.trim();
			if (!value) return notify(ctx, "plan");
			if (value === "clear") {
				state.steps = [];
				persist();
				updateUi(ctx);
				return notify(ctx, "plan", "Session Plan cleared.");
			}
			state.steps = parseSteps(value);
			persist();
			updateUi(ctx);
			notify(ctx, "plan");
		},
	});

	for (const name of ["todos", "workflow"] as const) {
		pi.registerCommand(name, {
			description: "Show the current Session Goal and Plan",
			handler: async (_args, ctx) => {
				lastContext = ctx;
				notify(ctx, name);
			},
		});
	}

	const Status = Type.Union([
		Type.Literal("pending"),
		Type.Literal("in_progress"),
		Type.Literal("completed"),
		Type.Literal("blocked"),
	]);
	pi.registerTool({
		name: "session_workflow",
		label: "Session Workflow",
		description: "Read or update the current Pi Session Goal, Plan, and Todo state.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("get"),
				Type.Literal("set_goal"),
				Type.Literal("set_plan"),
				Type.Literal("set_step"),
				Type.Literal("clear"),
			]),
			objective: Type.Optional(Type.String({ maxLength: MAX_TEXT })),
			steps: Type.Optional(Type.Array(Type.String({ maxLength: MAX_TEXT }), { maxItems: MAX_STEPS })),
			step: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_STEPS })),
			status: Type.Optional(Status),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "set_goal") {
				const objective = boundedText(params.objective);
				if (!objective) throw new Error("set_goal requires a non-empty objective");
				setGoal(objective);
			} else if (params.action === "set_plan") {
				if (!params.steps?.length) throw new Error("set_plan requires at least one step");
				setPlan(params.steps);
			} else if (params.action === "set_step") {
				if (!params.step || !params.status) throw new Error("set_step requires step and status");
				const item = state.steps.find((step) => step.id === params.step);
				if (!item) throw new Error(`Unknown workflow step: ${params.step}`);
				item.status = params.status;
				persist();
				updateUi();
			} else if (params.action === "clear") {
				state = initialState();
				persist();
				updateUi();
			}
			return {
				content: [{ type: "text", text: renderState(state) }],
				details: structuredClone(state),
			};
		},
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) => (message as AgentMessage & { customType?: string }).customType !== CONTEXT_MESSAGE_TYPE,
		),
	}));

	pi.on("before_agent_start", async () => {
		if (!state.goal && state.steps.length === 0) return;
		return {
			message: {
				customType: CONTEXT_MESSAGE_TYPE,
				content: `[SESSION WORKFLOW]\n${renderState(state)}\nUpdate state with the session_workflow tool after real progress.`,
				display: false,
			},
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		lastContext = ctx;
		const text = assistantText(event.message);
		let changed = false;
		for (const match of text.matchAll(/\[(DONE|BLOCKED):(\d+)\]/giu)) {
			const item = state.steps.find((step) => step.id === Number(match[2]));
			if (!item) continue;
			item.status = match[1].toUpperCase() === "DONE" ? "completed" : "blocked";
			changed = true;
		}
		if (changed) {
			persist();
			updateUi(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		const entry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find(
				(candidate) =>
					candidate.type === "custom" &&
					"customType" in candidate &&
					candidate.customType === STATE_ENTRY_TYPE,
			) as { data?: unknown } | undefined;
		state = normalizeState(entry?.data);
		updateUi(ctx);
	});
}
