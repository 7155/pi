import {
	type AssistantMessage,
	type Context,
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const DETERMINISTIC_TEST_PROVIDER = "rag-ime-deterministic";
export const DETERMINISTIC_TEST_MODEL = "room-v2-test";
const LIGHT_ROOM_SCENARIO = "light-room";
const AGENT_SESSION_SCENARIO = "agent-session";
const NO_PROGRESS_SCENARIO = "no-progress";
const THRESHOLD_CONTINUATION_SCENARIO = "threshold-continuation";
const LIGHT_ROOM_TASK_MARKER = "LIGHT-ROOM-CANARY";
const LIGHT_ROOM_FINAL_MARKER = "LIGHT-ROOM-CANARY-OK";
const AGENT_SESSION_TASK_MARKER = "AGENT-SESSION-RESILIENCE";
const AGENT_SESSION_FINAL_MARKER = "AGENT-SESSION-CANARY-OK";
const AGENT_SESSION_RECOVERY_MARKER = "AGENT-SESSION-RECOVERY-OK";
const AGENT_SESSION_SKILL = "implementation-execution";
const AGENT_SESSION_TODO_TASKS = ["运行失败基线测试", "精确修改 normalize_scores", "运行回归测试并交付"] as const;

const NATIVE_CODING_TOOL_NAMES = ["ls", "find", "grep", "read", "bash"] as const;
const CALCULATOR_PATCH_COMMAND = [
	"/usr/bin/python3 - <<'PY'",
	"from pathlib import Path",
	'path = Path("calculator.py")',
	"source = path.read_text()",
	"old = '    raise NotImplementedError(\"ROOM_PROJECT_TASK\")'",
	'new = "    if not values:\\n        return []\\n    minimum = min(values)\\n    return [value - minimum for value in values]"',
	"if old not in source:",
	'    raise SystemExit("expected calculator placeholder was not found")',
	"path.write_text(source.replace(old, new, 1))",
	"PY",
].join("\n");

function contextText(context: Context): string {
	return JSON.stringify({ systemPrompt: context.systemPrompt ?? "", messages: context.messages });
}

function activeToolNames(context: Context): Set<string> {
	return new Set((context.tools ?? []).map((tool) => tool.name));
}

function stringsIn(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
	return [];
}

function containsField(value: unknown, field: string, expected: unknown): boolean {
	if (Array.isArray(value)) return value.some((item) => containsField(item, field, expected));
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record[field] === expected || Object.values(record).some((item) => containsField(item, field, expected));
}

function contextHasJsonField(context: Context, field: string, expected: unknown): boolean {
	if (containsField(context.messages, field, expected)) return true;
	for (const source of stringsIn(context.messages)) {
		try {
			if (containsField(JSON.parse(source) as unknown, field, expected)) return true;
		} catch {}
	}
	return false;
}

function recordsIn(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value.flatMap(recordsIn);
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	return [record, ...Object.values(record).flatMap(recordsIn)];
}

function parsedContextRecords(context: Context): Array<Record<string, unknown>> {
	const values: unknown[] = [context.messages];
	for (const source of stringsIn(context.messages)) {
		try {
			values.push(JSON.parse(source) as unknown);
		} catch {}
	}
	return values.flatMap(recordsIn);
}

function contextHasNonzeroExitCode(context: Context): boolean {
	return parsedContextRecords(context).some((record) => {
		const exitCode = record.exitCode;
		return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
	});
}

function requireResidentNativeCodingTools(tools: Set<string>, names: readonly string[]): void {
	const missing = names.filter((name) => !tools.has(name));
	if (missing.length > 0) {
		throw new Error(`Native coding tools must be resident before model execution: ${missing.join(", ")}`);
	}
}

function contextHasLoadedSkill(context: Context, name: string): boolean {
	const marker = `<loaded_skill name="${name}"`;
	return [context.systemPrompt ?? "", ...stringsIn(context.messages)].some((source) => source.includes(marker));
}

function toolCallSucceeded(context: Context, toolCallId: string, toolName: string): boolean {
	return parsedContextRecords(context).some((record) => {
		if (
			String(record.toolCallId ?? "") !== toolCallId ||
			String(record.toolName ?? "") !== toolName ||
			record.isError === true
		) {
			return false;
		}
		return record.role === "toolResult" || (record.status === "completed" && Object.hasOwn(record, "result"));
	});
}

function toolCallFailed(context: Context, toolCallId: string, toolName: string): boolean {
	const receiptSuffix = `:${toolCallId}`;
	return parsedContextRecords(context).some((record) => {
		const failedToolResult =
			String(record.toolCallId ?? "") === toolCallId &&
			String(record.toolName ?? "") === toolName &&
			record.isError === true;
		const failedExecutionReceipt =
			record.status === "failed" &&
			[String(record.executionReceiptId ?? ""), String(record.invocationReceiptId ?? "")].some((receiptId) =>
				receiptId.endsWith(receiptSuffix),
			);
		return failedToolResult || failedExecutionReceipt;
	});
}

function latestWorkspaceReadReceipt(context: Context, fileName: string): Record<string, unknown> | undefined {
	return parsedContextRecords(context)
		.filter((record) => {
			const path = String(record.path ?? "");
			return (
				(path === fileName || path.endsWith(`/${fileName}`)) &&
				typeof record.startLine === "number" &&
				typeof record.endLine === "number" &&
				(record.nextLineOffset === null || typeof record.nextLineOffset === "number") &&
				typeof record.truncated === "boolean" &&
				(record.toolName === undefined || record.toolName === "workspace_read")
			);
		})
		.sort((left, right) => Number(left.endLine) - Number(right.endLine))
		.at(-1);
}

function firstRoomPartnerId(context: Context): string {
	for (const record of parsedContextRecords(context)) {
		const participantId = String(record.participantId ?? "").trim();
		if (participantId) return participantId;
	}
	return "";
}

/** Drive the current light Room contract: list, delegate, publish, then let Pi settle normally. */
export function lightRoomCanaryResponse(context: Context): AssistantMessage {
	const serialized = contextText(context);
	if (!serialized.includes(LIGHT_ROOM_TASK_MARKER))
		return fauxAssistantMessage("A light Room canary task is required.");
	if (!activeToolNames(context).has("room_partner")) {
		throw new Error("A Room-bound Session must expose the direct room_partner tool");
	}
	if (!serialized.includes("light-room-list")) {
		return fauxAssistantMessage(fauxToolCall("room_partner", { op: "list" }, { id: "light-room-list" }), {
			stopReason: "toolUse",
		});
	}
	if (toolCallFailed(context, "light-room-list", "room_partner")) throw new Error("room_partner list failed");
	const targetParticipantId = firstRoomPartnerId(context);
	if (!targetParticipantId) throw new Error("room_partner list returned no Partner participantId");
	if (!serialized.includes("light-room-delegate")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_partner",
				{
					op: "delegate",
					targetParticipantId,
					task: "Return the exact marker LIGHT-ROOM-PARTNER-OK.",
					expectedOutput: "One exact marker",
					acceptanceCriteria: ["The result contains LIGHT-ROOM-PARTNER-OK"],
					timeoutSeconds: 30,
				},
				{ id: "light-room-delegate" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!toolCallSucceeded(context, "light-room-delegate", "room_partner")) {
		throw new Error("room_partner delegate did not return a successful child Session receipt");
	}
	if (!serialized.includes("light-room-post")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_partner",
				{
					op: "post",
					kind: "result",
					content: `${LIGHT_ROOM_FINAL_MARKER}；伙伴结果已接收，轻量 Room 可以交付。`,
				},
				{ id: "light-room-post" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!toolCallSucceeded(context, "light-room-post", "room_partner")) {
		throw new Error("room_partner result post did not return a successful public receipt");
	}
	return fauxAssistantMessage(`${LIGHT_ROOM_FINAL_MARKER}；已发布唯一 Room 结果，Pi Session 正常结束。`);
}

export function agentSessionCanaryResponse(context: Context): AssistantMessage {
	const serialized = contextText(context);
	if ((context.systemPrompt ?? "").startsWith("You are a context summarization assistant.")) {
		return fauxAssistantMessage(
			`${AGENT_SESSION_TASK_MARKER} completed. Preserve the failed read, failed baseline test, ` +
				"approved repair, passing regression test, loaded Skill and Tool receipts, and final delivery state.",
		);
	}
	if (serialized.includes("压缩恢复检查") && serialized.includes(AGENT_SESSION_RECOVERY_MARKER)) {
		return fauxAssistantMessage(`${AGENT_SESSION_RECOVERY_MARKER}；原始任务、验收与能力回执已恢复。`);
	}
	if (!serialized.includes(AGENT_SESSION_TASK_MARKER)) {
		return fauxAssistantMessage("An ordinary Agent Session canary task is required.");
	}

	const tools = activeToolNames(context);
	if (!contextHasLoadedSkill(context, AGENT_SESSION_SKILL)) {
		return fauxAssistantMessage(
			fauxToolCall("skill_load", { name: AGENT_SESSION_SKILL }, { id: "agent-load-skill" }),
			{ stopReason: "toolUse" },
		);
	}
	requireResidentNativeCodingTools(tools, NATIVE_CODING_TOOL_NAMES);
	if (!serialized.includes("agent-missing-read")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"read",
				{ path: "missing_requirements.md", offset: 0, limit: 16_384 },
				{ id: "agent-missing-read" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-list")) {
		return fauxAssistantMessage(fauxToolCall("ls", { path: ".", limit: 50 }, { id: "agent-list" }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes("agent-search")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"grep",
				{ pattern: "ROOM_PROJECT_TASK", path: ".", literal: true, limit: 20 },
				{ id: "agent-search" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-read-app")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: "agent-read-app" }),
				fauxToolCall("read", { path: "test_calculator.py", offset: 0, limit: 16_384 }, { id: "agent-read-test" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	const boundaryReceipt = latestWorkspaceReadReceipt(context, "read-boundary.txt");
	if (!boundaryReceipt) {
		if (serialized.includes("agent-read-boundary-1")) {
			throw new Error("The Agent Session boundary read did not return a structured receipt");
		}
		return fauxAssistantMessage(
			fauxToolCall("read", { path: "read-boundary.txt", offset: 1, limit: 1_000 }, { id: "agent-read-boundary-1" }),
			{ stopReason: "toolUse" },
		);
	}
	const boundaryContent = String(boundaryReceipt.content ?? "");
	const boundaryStartLine = Number(boundaryReceipt.startLine);
	const boundaryEndLine = Number(boundaryReceipt.endLine);
	if (
		Buffer.byteLength(boundaryContent, "utf8") > 50 * 1024 ||
		boundaryEndLine - boundaryStartLine + 1 > 1_000 ||
		!Number.isSafeInteger(boundaryStartLine) ||
		!Number.isSafeInteger(boundaryEndLine) ||
		boundaryEndLine < boundaryStartLine
	) {
		throw new Error("read exceeded the Pi model-visible result budget");
	}
	if (boundaryReceipt.truncated === true) {
		const nextOffset = Number(boundaryReceipt.nextLineOffset);
		if (!Number.isSafeInteger(nextOffset) || nextOffset !== boundaryEndLine + 1) {
			throw new Error("read did not advance its line continuation offset");
		}
		const callId = `agent-read-boundary-${nextOffset}`;
		if (serialized.includes(`"id":"${callId}"`))
			throw new Error("The Agent Session boundary continuation did not advance");
		return fauxAssistantMessage(
			fauxToolCall("read", { path: "read-boundary.txt", offset: nextOffset, limit: 1_000 }, { id: callId }),
			{ stopReason: "toolUse" },
		);
	}
	if (boundaryReceipt.nextLineOffset !== null)
		throw new Error("read ended before the boundary fixture was fully consumed");

	if (!tools.has("todo")) throw new Error("The canonical Session Todo tool must be resident");
	if (!serialized.includes("agent-todo-init")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"todo",
				{ op: "init", list: [{ phase: "实现与验证", items: [...AGENT_SESSION_TODO_TASKS] }] },
				{ id: "agent-todo-init" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-todo-baseline-start")) {
		return fauxAssistantMessage(
			fauxToolCall("todo", { op: "start", task: AGENT_SESSION_TODO_TASKS[0] }, { id: "agent-todo-baseline-start" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-baseline-shell")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"bash",
				{ command: "/usr/bin/python3 -m unittest -v", timeout: 30 },
				{ id: "agent-baseline-shell" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!toolCallFailed(context, "agent-baseline-shell", "bash") && !contextHasNonzeroExitCode(context)) {
		throw new Error("The Agent Session baseline command did not fail as expected");
	}
	if (!serialized.includes("agent-todo-baseline-done")) {
		return fauxAssistantMessage(
			fauxToolCall("todo", { op: "done", task: AGENT_SESSION_TODO_TASKS[0] }, { id: "agent-todo-baseline-done" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-todo-patch-start")) {
		return fauxAssistantMessage(
			fauxToolCall("todo", { op: "start", task: AGENT_SESSION_TODO_TASKS[1] }, { id: "agent-todo-patch-start" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-patch")) {
		return fauxAssistantMessage(
			fauxToolCall("bash", { command: CALCULATOR_PATCH_COMMAND, timeout: 30 }, { id: "agent-patch" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!toolCallSucceeded(context, "agent-patch", "bash")) {
		throw new Error("The approved Agent Session shell patch did not produce a successful receipt");
	}
	if (!serialized.includes("agent-todo-patch-done")) {
		return fauxAssistantMessage(
			fauxToolCall("todo", { op: "done", task: AGENT_SESSION_TODO_TASKS[1] }, { id: "agent-todo-patch-done" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-todo-regression-start")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"todo",
				{ op: "start", task: AGENT_SESSION_TODO_TASKS[2] },
				{ id: "agent-todo-regression-start" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-regression-shell")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"bash",
				{ command: "/usr/bin/python3 -m unittest -v", timeout: 30 },
				{ id: "agent-regression-shell" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "exitCode", 0))
		throw new Error("The Agent Session regression command did not pass");
	if (!serialized.includes("agent-todo-regression-checkpoint")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"todo",
				{
					op: "checkpoint",
					task: AGENT_SESSION_TODO_TASKS[2],
					checkpoint: "回归测试通过，准备交付",
					references: [{ kind: "test", label: "普通 Session 回归", reference: "test_calculator.py" }],
				},
				{ id: "agent-todo-regression-checkpoint" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-todo-regression-done")) {
		return fauxAssistantMessage(
			fauxToolCall("todo", { op: "done", task: AGENT_SESSION_TODO_TASKS[2] }, { id: "agent-todo-regression-done" }),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(
		`${AGENT_SESSION_FINAL_MARKER}；失败读取与失败基线均已确认，修复已获批，回归测试通过；无剩余风险。`,
	);
}

/** Test-only Provider adapter. It drives the real Pi Session and tool loop without network access. */
export async function createDeterministicTestModelRuntime(): Promise<ModelRuntime> {
	if (process.env.NODE_ENV !== "test" || process.env.RAG_IME_PI_DETERMINISTIC_ADAPTER !== "room-v2") {
		throw new Error("The deterministic Session/Room Provider is available only under the explicit test gate");
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	const scenario = process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO;
	const faux = createFauxCore({
		api: "faux:paw-runtime",
		provider: DETERMINISTIC_TEST_PROVIDER,
		models: [
			{
				id: DETERMINISTIC_TEST_MODEL,
				name: "Session and light Room deterministic test model",
				input: ["text"],
				...(scenario === THRESHOLD_CONTINUATION_SCENARIO ? { contextWindow: 64_000 } : {}),
			},
		],
		tokensPerSecond: process.env.RAG_IME_PI_DETERMINISTIC_SLOW === "1" ? 10 : undefined,
	});
	if (scenario === LIGHT_ROOM_SCENARIO) {
		faux.setResponses(Array.from({ length: 32 }, () => lightRoomCanaryResponse));
	} else if (scenario === AGENT_SESSION_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => agentSessionCanaryResponse));
	} else if (scenario === NO_PROGRESS_SCENARIO) {
		faux.setResponses(
			Array.from({ length: 16 }, (_, index) =>
				fauxAssistantMessage(
					fauxToolCall(
						"read",
						{ path: ".paw-progress-guard-missing-proof", limit: 4 },
						{ id: `no-progress-read-${index + 1}` },
					),
					{ stopReason: "toolUse" },
				),
			),
		);
	} else if (scenario === THRESHOLD_CONTINUATION_SCENARIO) {
		faux.setResponses([
			fauxAssistantMessage("THRESHOLD-COMPACTION-HISTORY-ANSWER"),
			fauxAssistantMessage("THRESHOLD-COMPACTION-SEED-ANSWER"),
			fauxAssistantMessage("THRESHOLD-COMPACTION-FIRST-ANSWER"),
			fauxAssistantMessage("THRESHOLD-COMPACTION-CONTINUED-OK"),
		]);
	} else {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json", limit: 4 }, { id: "deterministic-read" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Session inspected the workspace and completed."),
			fauxAssistantMessage("Governed continuation completed the remaining acceptance check."),
		]);
	}
	const model = faux.getModel();
	runtime.registerProvider(DETERMINISTIC_TEST_PROVIDER, {
		name: "Session and light Room deterministic test Provider",
		baseUrl: "http://localhost.invalid",
		api: model.api,
		apiKey: "test-only",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
	return runtime;
}
