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
const CONTEXT_EPOCH_SCENARIO = "context-epoch";
const PROJECT_TASK_SCENARIO = "project-task";
const PROJECT_TOOL_RECOVERY_SCENARIO = "project-tool-recovery";
const PROJECT_COLLABORATION_SCENARIO = "project-collaboration";
const AGENT_SESSION_SCENARIO = "agent-session";
const NO_PROGRESS_SCENARIO = "no-progress";
const THRESHOLD_CONTINUATION_SCENARIO = "threshold-continuation";
const AGENT_SESSION_TASK_MARKER = "AGENT-SESSION-RESILIENCE";
const AGENT_SESSION_FINAL_MARKER = "AGENT-SESSION-CANARY-OK";
const AGENT_SESSION_RECOVERY_MARKER = "AGENT-SESSION-RECOVERY-OK";
const AGENT_SESSION_SKILL = "test-driven-implementation";
const PROJECT_TOOL_RECOVERY_MARKER = "PROJECT-TOOL-RECOVERY-CANARY";

// Coding tools are resident Pi tools. Their hidden governed targets are bound
// during runtime bootstrap, so a model must never spend turns loading the
// backend-only workspace_* names.
const NATIVE_CODING_TOOL_NAMES = ["ls", "find", "grep", "read", "edit", "bash"] as const;

function contextText(context: Context): string {
	return JSON.stringify({ systemPrompt: context.systemPrompt ?? "", messages: context.messages });
}

function activeToolNames(context: Context): Set<string> {
	return new Set((context.tools ?? []).map((tool) => tool.name));
}

function stringsIn(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap(stringsIn);
	}
	return [];
}

function containsField(value: unknown, field: string, expected: unknown): boolean {
	if (Array.isArray(value)) return value.some((item) => containsField(item, field, expected));
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record[field] === expected || Object.values(record).some((item) => containsField(item, field, expected));
}

function contextHasJsonField(context: Context, field: string, expected: unknown): boolean {
	// Native projected tools keep machine-readable receipts in tool-result
	// details while their visible text stays concise. Inspect that structured
	// context directly before falling back to legacy JSON-in-text receipts.
	if (containsField(context.messages, field, expected)) return true;
	for (const source of stringsIn(context.messages)) {
		try {
			if (containsField(JSON.parse(source) as unknown, field, expected)) return true;
		} catch {}
	}
	return false;
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

function participantRefForRole(context: Context, collaborationRole: string): string {
	const participant = parsedContextRecords(context).find((record) => {
		const participantRef = String(record.participantRef ?? "").trim();
		return participantRef.length > 0 && record.capabilitySummary === collaborationRole;
	});
	if (!participant) {
		throw new Error(`Room state did not expose the ${collaborationRole} participant`);
	}
	return String(participant.participantRef);
}

function currentRoomTask(context: Context): string | undefined {
	for (const source of [context.systemPrompt ?? "", ...stringsIn(context.messages)]) {
		const match = source.match(/<room-fact kind="dispatch_state">([\s\S]*?)<\/room-fact>/u);
		if (match?.[1].trim()) return match[1].trim();
	}
	return undefined;
}

function currentEpochMarker(task: string): string {
	const match = task.match(/CANARY-(\d+)-OK/u);
	return match?.[1] ?? "";
}

function acceptanceAliases(task: string): string[] {
	return [...task.matchAll(/\b(AC-[1-9][0-9]*)\b/gu)]
		.map((match) => match[1].toUpperCase())
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function currentAcceptanceAliases(context: Context, task: string): string[] {
	const groups = parsedContextRecords(context)
		.map((record) => record.acceptanceAliases)
		.filter((value): value is unknown[] => Array.isArray(value));
	for (const group of groups.reverse()) {
		const aliases = group
			.map((item) => {
				if (typeof item === "string") return item.trim().toUpperCase();
				if (typeof item !== "object" || item === null) return "";
				return String((item as Record<string, unknown>).acceptance ?? "")
					.trim()
					.toUpperCase();
			})
			.filter((value, index, values) => /^AC-[1-9][0-9]*$/u.test(value) && values.indexOf(value) === index);
		if (aliases.length > 0) return aliases;
	}
	return acceptanceAliases(task);
}

function runtimeEvidenceRefs(context: Context, limit = 2): string[] {
	return parsedContextRecords(context)
		.map((record) => {
			const evidenceRef = String(record.evidenceRef ?? "").trim();
			if (evidenceRef) return evidenceRef;
			if (record.status !== "applied") return "";
			return String(record.executionReceiptId ?? "").trim();
		})
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
		.slice(-limit);
}

function evidenceProposal(aliases: string[], evidenceRefs: string[]): Array<Record<string, unknown>> {
	return aliases.map((acceptance) => ({
		acceptance,
		refs: evidenceRefs,
	}));
}

/** Drive the real discovery, product Tool and settle loops for the API epoch canary. */
export function contextEpochCanaryResponse(context: Context): AssistantMessage {
	const task = currentRoomTask(context);
	const epoch = task ? currentEpochMarker(task) : "";
	if (!task || !epoch) {
		return fauxAssistantMessage(
			"Preserve the original requirement, current task, acceptance criteria, blockers, handoff, and exact Skill and Tool receipts.",
		);
	}
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	const prefix = `epoch-${epoch}`;
	requireResidentNativeCodingTools(tools, ["read"]);
	if (!serialized.includes(`${prefix}-read-a`)) {
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"read",
					{ path: "rag_ime/agent_service.py", offset: 0, limit: 65_536 },
					{ id: `${prefix}-read-a` },
				),
				fauxToolCall(
					"read",
					{ path: "rag_ime/agent_room_kernel.py", offset: 0, limit: 65_536 },
					{ id: `${prefix}-read-b` },
				),
			],
			{ stopReason: "toolUse" },
		);
	}
	const missingRoomTools = ["room_post", "room_commit"].filter((name) => !tools.has(name));
	if (missingRoomTools.length > 0) {
		return fauxAssistantMessage(
			missingRoomTools.map((name) => fauxToolCall("tool_load", { name }, { id: `${prefix}-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes(`${prefix}-post`)) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_post",
				{ kind: "evidence", content: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。` },
				{ id: `${prefix}-post` },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes(`${prefix}-commit`)) {
		const aliases = acceptanceAliases(task);
		if (aliases.length === 0) {
			throw new Error("The context epoch canary requires explicit AC aliases");
		}
		const receipts = runtimeEvidenceRefs(context);
		const evidenceRefs = receipts.length > 0 ? receipts : [`${prefix}-read-a`, `${prefix}-read-b`];
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					summary: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。`,
					evidence: evidenceProposal(aliases, evidenceRefs),
					residualRisks: [],
				},
				{ id: `${prefix}-commit` },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(`CANARY-${epoch}-OK`);
}

/** Drive an approved read, edit, test, publish and settle task in an isolated project. */
export function projectTaskCanaryResponse(context: Context): AssistantMessage {
	const task = currentRoomTask(context);
	const recovery = task?.includes(PROJECT_TOOL_RECOVERY_MARKER) === true;
	if (!task || (!task.includes("PROJECT-TASK-CANARY") && !recovery)) {
		return fauxAssistantMessage(
			"A managed PROJECT-TASK-CANARY or PROJECT-TOOL-RECOVERY-CANARY dispatch is required.",
		);
	}
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	requireResidentNativeCodingTools(tools, NATIVE_CODING_TOOL_NAMES);
	if (recovery && !serialized.includes("project-missing-read")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"read",
				{ path: "missing_requirements.md", offset: 0, limit: 16_384 },
				{ id: "project-missing-read" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-list")) {
		return fauxAssistantMessage(fauxToolCall("ls", { path: ".", limit: 50 }, { id: "project-list" }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes("project-search")) {
		if (!serialized.includes("project-find")) {
			return fauxAssistantMessage(
				fauxToolCall("find", { pattern: "*.py", path: ".", limit: 20 }, { id: "project-find" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"grep",
				{
					pattern: "ROOM_PROJECT_TASK",
					path: ".",
					literal: true,
					limit: 20,
				},
				{ id: "project-search" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-read-app")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: "project-read-app" }),
				fauxToolCall("read", { path: "test_calculator.py", offset: 0, limit: 16_384 }, { id: "project-read-test" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (recovery && !serialized.includes("project-baseline-test")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"bash",
				{ command: "/usr/bin/python3 -m unittest -v", timeout: 30 },
				{ id: "project-baseline-test" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (recovery && !contextHasNonzeroExitCode(context)) {
		throw new Error("The project recovery canary requires one failed baseline test receipt before repair");
	}
	if (!serialized.includes("project-patch")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"edit",
				{
					path: "calculator.py",
					edits: [
						{
							oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
							newText:
								"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
						},
					],
				},
				{ id: "project-patch" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "mutationApplied", true)) {
		throw new Error("The approved project patch did not produce an applied receipt");
	}
	if (!serialized.includes("project-test")) {
		return fauxAssistantMessage(
			fauxToolCall("bash", { command: "/usr/bin/python3 -m unittest -v", timeout: 30 }, { id: "project-test" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "exitCode", 0)) {
		throw new Error("The approved project test command did not pass");
	}
	const missingRoomTools = ["room_post", "room_commit"].filter((name) => !tools.has(name));
	if (missingRoomTools.length > 0) {
		return fauxAssistantMessage(
			missingRoomTools.map((name) => fauxToolCall("tool_load", { name }, { id: `project-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-post")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_post",
				{ kind: "evidence", content: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。" },
				{ id: "project-post" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-commit")) {
		const aliases = acceptanceAliases(task);
		if (aliases.length === 0) {
			throw new Error("The project canary requires explicit AC aliases");
		}
		const receipts = runtimeEvidenceRefs(context, 8);
		const evidenceRefs = receipts.length > 0 ? receipts : ["project-test"];
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					summary: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。",
					evidence: evidenceProposal(aliases, evidenceRefs),
					residualRisks: [],
				},
				{ id: "project-commit" },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage("PROJECT-CANARY-OK");
}

/** Drive the canonical three-member full-auto Room lifecycle through the real Kernel. */
export function projectCollaborationCanaryResponse(context: Context): AssistantMessage {
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	const task = currentRoomTask(context);
	if (!task) {
		return fauxAssistantMessage("A managed full-auto Room dispatch is required.");
	}
	const currentTask =
		(task.split("当前任务：").at(-1) ?? task).split(/验收条件(?:\s+acceptance\.criteria|（|:|：)/u)[0] ?? task;
	if (!serialized.includes("写 TUI") && !currentTask.includes("ROOM-FULL-AUTO-")) {
		return fauxAssistantMessage("A managed full-auto Room dispatch for 写 TUI is required.");
	}
	const reviewerAccepted = contextHasJsonField(context, "reviewState", "accepted");
	const reviewerResult = reviewerAccepted || serialized.includes("room-full-auto-review-commit");
	const pendingIntegrationReady = parsedContextRecords(context).some((record) => {
		const pending = record.pendingIntegrations;
		return Array.isArray(pending) && pending.length > 0;
	});
	const waitChildIndex = serialized.lastIndexOf("room-full-auto-alignment-wait-child");
	const resumedAfterWait =
		waitChildIndex >= 0 &&
		["这是恢复轮次", '<room-work-follow-up source="system"'].some(
			(marker) => serialized.lastIndexOf(marker) > waitChildIndex,
		);
	const reviewHandoffIndex = serialized.lastIndexOf("room-full-auto-integration-handoff-review");
	const resumedAfterReviewHandoff =
		reviewHandoffIndex >= 0 &&
		["这是恢复轮次", '<room-work-follow-up source="system"'].some(
			(marker) => serialized.lastIndexOf(marker) > reviewHandoffIndex,
		);
	const taskPhase = currentTask.includes("ROOM-FULL-AUTO-REVIEW")
		? "review"
		: currentTask.includes("ROOM-FULL-AUTO-CHILD")
			? "child"
			: "";
	const phase =
		taskPhase ||
		(reviewerResult || resumedAfterReviewHandoff
			? "await-review"
			: serialized.includes("room-full-auto-alignment-wait-child") && (pendingIntegrationReady || resumedAfterWait)
				? "integration"
				: "alignment");
	const prefix = `room-full-auto-${phase}`;
	const callId = (suffix: string): string => `${prefix}-${suffix}`;
	const aliases = (): string[] => {
		const current = currentAcceptanceAliases(context, task);
		return current.length > 0 ? current : ["AC-1", "AC-2", "AC-3", "AC-4"];
	};
	const settlementEvidence = (
		currentAliases: string[],
		currentToolCallId: string,
		includeCurrent = true,
	): Array<Record<string, unknown>> => {
		const referenceSet = new Set(runtimeEvidenceRefs(context, 64));
		for (const record of parsedContextRecords(context)) {
			for (const key of ["contextEvidenceRefs", "evidenceRefs", "acceptedEvidenceRefs"]) {
				const values = record[key];
				if (!Array.isArray(values)) continue;
				for (const value of values) {
					const reference = String(value ?? "").trim();
					if (reference) referenceSet.add(reference);
				}
			}
		}
		const references = [...referenceSet];
		const fallback = `execution:invoke:${currentToolCallId}`;
		return currentAliases.map((acceptance) => ({
			acceptance,
			refs: includeCurrent ? references : references.length > 0 ? references : [fallback],
		}));
	};
	const distinctRuntimeEvidence = (
		currentAliases: string[],
		toolCallIds: string[],
	): Array<Record<string, unknown>> => {
		if (currentAliases.length > toolCallIds.length) {
			throw new Error("The deterministic Room phase has fewer tool receipts than acceptance items");
		}
		return currentAliases.map((acceptance, index) => ({
			acceptance,
			refs: [`execution:invoke:${toolCallIds[index]}`],
		}));
	};
	const acceptedEvidence = (currentAliases: string[]): Array<Record<string, unknown>> => {
		const refsByAlias = new Map<string, string[]>();
		for (const record of parsedContextRecords(context)) {
			const items = record.acceptanceAliases;
			if (!Array.isArray(items)) continue;
			for (const rawItem of items) {
				if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) continue;
				const item = rawItem as Record<string, unknown>;
				const acceptance = String(item.acceptance ?? "").trim();
				const refs = Array.isArray(item.evidenceRefs)
					? item.evidenceRefs.map((value) => String(value ?? "").trim()).filter(Boolean)
					: [];
				if (acceptance && refs.length > 0) refsByAlias.set(acceptance, refs);
			}
		}
		const missing = currentAliases.filter((acceptance) => !refsByAlias.has(acceptance));
		if (missing.length > 0) {
			throw new Error(`Final Room delivery has no accepted evidence for ${missing.join(", ")}`);
		}
		return currentAliases.map((acceptance) => ({
			acceptance,
			refs: refsByAlias.get(acceptance) ?? [],
		}));
	};
	const commit = (argumentsValue: Record<string, unknown>, id: string): AssistantMessage =>
		fauxAssistantMessage(fauxToolCall("room_commit", argumentsValue, { id }), { stopReason: "toolUse" });
	const state = (id: string): AssistantMessage =>
		fauxAssistantMessage(fauxToolCall("room_state", {}, { id }), { stopReason: "toolUse" });

	if (phase === "alignment") {
		if (!tools.has("room_state")) {
			return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("state"))) return state(callId("state"));

		const answers = [
			"先做一个最小可运行的终端界面：有清晰的标题、输入区和结果区；不用安装新依赖，启动后能直接使用。",
			"优先保证键盘操作、状态反馈和基本错误提示，先不加入网络同步或复杂主题。",
			"交付时保留现有项目约定，只改实现所需内容，并给出可复现的验证结果。",
		];
		const answerIndex = answers.findIndex((answer) => !serialized.includes(answer));
		const waitIndex = answerIndex < 0 ? answers.length : answerIndex;
		if (waitIndex < answers.length) {
			const waitId = callId(`wait-${waitIndex + 1}`);
			if (!serialized.includes(waitId)) {
				if (waitIndex > 0 && !serialized.includes(answers[waitIndex - 1])) {
					return fauxAssistantMessage("等待用户对当前问题作答。");
				}
				return commit(
					{
						decision: "wait",
						summary: "需要用户逐项确认终端界面的目标、交互边界和验证方式。",
						publicSummary: "开始需求确认，请先回答当前问题。",
						evidence: [],
						residualRisks: [],
						waitingFor: "user",
						question:
							waitIndex === 0
								? "终端界面的最小版本需要包含哪些可见区域和启动行为？"
								: waitIndex === 1
									? "交互、状态反馈和错误提示中，哪一项需要优先保证？"
									: "交付边界和验证方式有哪些必须遵守的限制？",
						questionOptions: [
							{ value: "minimum", label: "先完成最小可用界面", recommended: true },
							{ value: "polish", label: "先做完整视觉和主题" },
						],
						resumeCondition: "收到用户对当前问题的一条普通自然语言回答后继续需求对齐。",
					},
					waitId,
				);
			}
			return fauxAssistantMessage("等待用户对当前问题作答。");
		}
		if (!tools.has("room_define")) {
			if (!serialized.includes(callId("search-define"))) {
				return fauxAssistantMessage(
					fauxToolCall("tool_search", { query: "room_define", limit: 4 }, { id: callId("search-define") }),
					{ stopReason: "toolUse" },
				);
			}
			if (!serialized.includes(callId("load-define"))) {
				return fauxAssistantMessage(
					fauxToolCall("tool_load", { name: "room_define" }, { id: callId("load-define") }),
					{ stopReason: "toolUse" },
				);
			}
		}
		if (!serialized.includes(callId("define"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"room_define",
					{
						objective: "交付一个最小可运行的终端界面，满足已确认的输入、结果展示和反馈边界。",
						expectedOutput: "可直接启动、可键盘操作、带状态反馈和基本错误提示的可验证实现。",
						requirements: [
							"启动后显示清晰标题、输入区和结果区，并能直接进入可用状态。",
							"键盘操作、状态反馈和基本错误提示保持明确且可复现。",
							"保留现有项目约定，只修改实现所需内容，不加入网络同步或复杂主题。",
							"交付包含可重复执行的验证结果，说明已验证范围与未验证边界。",
						],
						acceptanceCriteria: [
							{
								statement: "启动后出现清晰标题、输入区和结果区，并可直接使用。",
								kind: "user_journey",
								expectedReceiptTypes: ["evidence"],
								fullNameZh: "启动后显示并可使用最小界面",
							},
							{
								statement: "键盘操作、状态反馈和基本错误提示可观察且行为一致。",
								kind: "requirement",
								expectedReceiptTypes: ["evidence"],
								fullNameZh: "交互与错误反馈可观察",
							},
							{
								statement: "实现遵守现有项目约定，不引入网络同步或复杂主题。",
								kind: "requirement",
								expectedReceiptTypes: ["evidence"],
								fullNameZh: "实现边界保持最小",
							},
							{
								statement: "交付提供可重复执行的验证结果和清楚的边界说明。",
								kind: "requirement",
								expectedReceiptTypes: ["evidence"],
								fullNameZh: "验证结果可复现",
							},
						],
						implementationParticipantRef: participantRefForRole(context, "implementer"),
					},
					{ id: callId("define") },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("defined-state"))) return state(callId("defined-state"));
		requireResidentNativeCodingTools(tools, ["read"]);
		if (!serialized.includes(callId("evidence-read"))) {
			return fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "README.md", offset: 0, limit: 16_384 }, { id: callId("evidence-read-a") }),
					fauxToolCall(
						"read",
						{ path: "calculator.py", offset: 0, limit: 16_384 },
						{ id: callId("evidence-read-b") },
					),
					fauxToolCall(
						"read",
						{ path: "test_calculator.py", offset: 0, limit: 16_384 },
						{ id: callId("evidence-read-c") },
					),
					fauxToolCall("read", { path: "README.md", offset: 0, limit: 16_384 }, { id: callId("evidence-read-d") }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (!tools.has("room_collaborate")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "room_collaborate" }, { id: callId("load-collaborate") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("collaborate"))) {
			const currentAliases = aliases();
			return fauxAssistantMessage(
				fauxToolCall(
					"room_collaborate",
					{
						targetParticipantRef: participantRefForRole(context, "implementer"),
						intent: "execute",
						workspacePolicy: "isolated_writable",
						objective:
							"ROOM-FULL-AUTO-CHILD：在隔离工作区完成已确认终端界面的最小实现，" +
							"只修改 calculator.py，不修改测试文件或其他路径。",
						expectedOutput: "隔离工作区中的最小实现和可复现回归验证结果。",
						acceptance: currentAliases.slice(0, 1),
						evidenceRefs: runtimeEvidenceRefs(context, 8),
					},
					{ id: callId("collaborate") },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("wait-child"))) {
			const currentAliases = aliases();
			return commit(
				{
					decision: "wait",
					summary: "已邀请实施伙伴在隔离工作区完成有界实现，等待其返回结果后由协调者集成。",
					publicSummary: "实施伙伴正在独立工作区完成有界实现，完成后由协调者合入并验证。",
					evidence: distinctRuntimeEvidence(currentAliases, [
						callId("evidence-read-a"),
						callId("evidence-read-b"),
						callId("evidence-read-c"),
						callId("evidence-read-d"),
					]),
					residualRisks: ["隔离工作区结果尚未合入权威工作区。"],
					waitingFor: "participant",
					waitingForParticipantRef: participantRefForRole(context, "implementer"),
					resumeCondition: "实施伙伴已返回隔离工作区结果，Facilitator 可以继续集成。",
				},
				callId("wait-child"),
			);
		}
		return fauxAssistantMessage("等待实施伙伴返回隔离工作区结果。");
	}

	if (phase === "integration") {
		if (!tools.has("room_state")) {
			return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("state"))) return state(callId("state"));
		const childTaskId = parsedContextRecords(context)
			.map((record) => String(record.childTaskId ?? "").trim())
			.filter(Boolean)
			.at(-1);
		if (!childTaskId) throw new Error("Facilitator integration requires the bounded child Task id");
		if (!tools.has("room_integrate")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "room_integrate" }, { id: callId("load-integrate") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("integrate"))) {
			return fauxAssistantMessage(fauxToolCall("room_integrate", { childTaskId }, { id: callId("integrate") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("integrated-state"))) return state(callId("integrated-state"));
		requireResidentNativeCodingTools(tools, ["read", "bash"]);
		if (!serialized.includes(callId("read-integrated"))) {
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"read",
						{ path: "calculator.py", offset: 0, limit: 16_384 },
						{ id: callId("read-integrated-a") },
					),
					fauxToolCall(
						"read",
						{ path: "test_calculator.py", offset: 0, limit: 16_384 },
						{ id: callId("read-integrated-b") },
					),
					fauxToolCall(
						"read",
						{ path: "README.md", offset: 0, limit: 16_384 },
						{ id: callId("read-integrated-c") },
					),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("integrated-shell"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: "/usr/bin/python3 -m unittest -v", timeout: 30 },
					{ id: callId("integrated-shell") },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (contextHasNonzeroExitCode(context)) throw new Error("Facilitator integrated-workspace verification failed");
		if (!tools.has("room_commit")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "room_commit" }, { id: callId("load-review-handoff") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("handoff-review"))) {
			const currentAliases = aliases();
			return commit(
				{
					decision: "handoff",
					summary: "集成工作区已完成验证，交由独立 Reviewer 按全部验收条件复核。",
					publicSummary: "集成结果已验证，下一步交由独立 Reviewer 复核后由协调者收口。",
					evidence: distinctRuntimeEvidence(currentAliases, [
						callId("read-integrated-a"),
						callId("integrated-shell"),
						callId("read-integrated-b"),
						callId("read-integrated-c"),
					]),
					residualRisks: ["独立复核尚未返回。"],
					targetParticipantRef: participantRefForRole(context, "reviewer"),
					intent: "review",
					nextTask:
						"ROOM-FULL-AUTO-REVIEW：只读复核 Facilitator 集成后的完整结果和全部验收条件，" +
						"不得修改任何文件，也不得替实施者修复问题。",
					expectedOutput: "独立 Reviewer 的验收覆盖、证据和可交付建议。",
					acceptanceAliases: currentAliases,
				},
				callId("handoff-review"),
			);
		}
		return fauxAssistantMessage("等待独立 Reviewer 返回复核结果。");
	}

	if (phase === "await-review") {
		if (!tools.has("room_state")) {
			return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("state"))) return state(callId("state"));
		if (!serialized.includes(callId("deliver"))) {
			const currentAliases = aliases();
			return commit(
				{
					decision: "deliver",
					summary: "独立 Reviewer 已完成复核并返回证据，Facilitator 依据审查结果完成最终收口。",
					publicSummary: "已完成最小可运行终端界面，独立复核通过；交付保留现有项目约定并说明验证边界。",
					evidence: acceptedEvidence(currentAliases),
					residualRisks: [],
				},
				callId("deliver"),
			);
		}
		return fauxAssistantMessage("Room 最终结果已提交。");
	}

	if (phase === "child") {
		if (!tools.has("room_state")) {
			return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("state"))) return state(callId("state"));
		requireResidentNativeCodingTools(tools, ["read", "edit", "bash"]);
		if (!serialized.includes(callId("read"))) {
			return fauxAssistantMessage(
				fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: callId("read") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("patch"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"edit",
					{
						path: "calculator.py",
						edits: [
							{
								oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
								newText:
									"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
							},
						],
					},
					{ id: callId("patch") },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!contextHasJsonField(context, "mutationApplied", true)) {
			throw new Error("The bounded implementation child did not produce an applied edit receipt");
		}
		if (!serialized.includes(callId("test"))) {
			return fauxAssistantMessage(
				fauxToolCall("bash", { command: "/usr/bin/python3 -m unittest -v", timeout: 30 }, { id: callId("test") }),
				{ stopReason: "toolUse" },
			);
		}
		if (contextHasNonzeroExitCode(context)) throw new Error("The bounded implementation child verification failed");
		if (!serialized.includes(callId("commit"))) {
			const childAliases = aliases();
			return commit(
				{
					decision: "deliver",
					summary: "隔离工作区中的有界实现和回归验证已完成，未修改测试文件。",
					publicSummary: "实施伙伴已返回隔离工作区结果和可复现验证证据，等待协调者合入。",
					evidence: settlementEvidence(childAliases.length > 0 ? childAliases : ["AC-1"], callId("test")),
					residualRisks: [],
				},
				callId("commit"),
			);
		}
		return fauxAssistantMessage("隔离实现结果已返回协调者。");
	}

	if (phase === "review") {
		if (!tools.has("room_state")) {
			return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("state"))) return state(callId("state"));
		requireResidentNativeCodingTools(tools, ["read"]);
		if (!serialized.includes(callId("read-app"))) {
			return fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: callId("read-app") }),
					fauxToolCall(
						"read",
						{ path: "test_calculator.py", offset: 0, limit: 16_384 },
						{ id: callId("read-test") },
					),
					fauxToolCall("read", { path: "README.md", offset: 0, limit: 16_384 }, { id: callId("read-contract") }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("review-read"))) {
			return fauxAssistantMessage(
				fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: callId("review-read") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("commit"))) {
			const currentAliases = aliases();
			return commit(
				{
					decision: "deliver",
					summary: "独立 Reviewer 已按全部验收条件复核集成结果，未修改被审文件。",
					publicSummary: "独立复核通过并返回证据；Reviewer 未修改被审交付物，协调者可依据结果收口。",
					evidence: distinctRuntimeEvidence(currentAliases, [
						callId("read-app"),
						callId("read-test"),
						callId("read-contract"),
						callId("review-read"),
					]),
					residualRisks: [],
					reviewFindings: [],
				},
				callId("commit"),
			);
		}
		return fauxAssistantMessage("独立复核结果已返回协调者。");
	}

	return fauxAssistantMessage("当前 Room 阶段已提交规范的生命周期出口。");
}

/** Drive an ordinary Agent Session through failure, planning, approvals, repair and recovery. */
export function agentSessionCanaryResponse(context: Context): AssistantMessage {
	const serialized = contextText(context);
	if (serialized.includes("structured context checkpoint summary")) {
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
				{
					pattern: "ROOM_PROJECT_TASK",
					path: ".",
					literal: true,
					limit: 20,
				},
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
		if (serialized.includes(`"id":"${callId}"`)) {
			throw new Error("The Agent Session boundary continuation did not advance");
		}
		return fauxAssistantMessage(
			fauxToolCall("read", { path: "read-boundary.txt", offset: nextOffset, limit: 1_000 }, { id: callId }),
			{ stopReason: "toolUse" },
		);
	}
	if (boundaryReceipt.nextLineOffset !== null) {
		throw new Error("read ended before the boundary fixture was fully consumed");
	}

	if (!tools.has("agent_plan")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "agent_plan" }, { id: "agent-load-plan" }), {
			stopReason: "toolUse",
		});
	}
	for (const [id, itemId, title] of [
		["agent-plan-baseline", "agent-plan-item-baseline", "运行失败基线测试"],
		["agent-plan-patch", "agent-plan-item-patch", "精确修改 normalize_scores"],
		["agent-plan-regression", "agent-plan-item-regression", "运行回归测试并交付"],
	] as const) {
		if (!serialized.includes(id)) {
			return fauxAssistantMessage(
				fauxToolCall("agent_plan", { op: "update", itemId, title, status: "pending" }, { id }),
				{
					stopReason: "toolUse",
				},
			);
		}
	}
	if (!serialized.includes("agent-plan-review")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_plan",
				{ op: "submit_review", note: "写入与 Shell 前请原生控制中心审阅" },
				{ id: "agent-plan-review" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("原生控制中心已经批准当前执行计划")) {
		return fauxAssistantMessage("执行计划已提交审阅，等待原生控制中心批准。");
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
	if (!serialized.includes("agent-plan-baseline-done")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_plan",
				{ op: "update", itemId: "agent-plan-item-baseline", status: "completed" },
				{ id: "agent-plan-baseline-done" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-patch")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"edit",
				{
					path: "calculator.py",
					edits: [
						{
							oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
							newText:
								"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
						},
					],
				},
				{ id: "agent-patch" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "mutationApplied", true)) {
		throw new Error("The approved Agent Session patch did not produce an applied receipt");
	}
	if (!serialized.includes("agent-plan-patch-done")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_plan",
				{ op: "update", itemId: "agent-plan-item-patch", status: "completed" },
				{ id: "agent-plan-patch-done" },
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
	if (!contextHasJsonField(context, "exitCode", 0)) {
		throw new Error("The Agent Session regression command did not pass");
	}
	if (!serialized.includes("agent-plan-regression-done")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_plan",
				{ op: "update", itemId: "agent-plan-item-regression", status: "completed" },
				{ id: "agent-plan-regression-done" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-plan-complete")) {
		return fauxAssistantMessage(
			fauxToolCall("agent_plan", { op: "complete", note: "全部计划项和验收已完成" }, { id: "agent-plan-complete" }),
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
		throw new Error("The deterministic Room Provider is available only under the explicit test gate");
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	const scenario = process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO;
	const faux = createFauxCore({
		api: "faux:room-v2",
		provider: DETERMINISTIC_TEST_PROVIDER,
		models: [
			{
				id: DETERMINISTIC_TEST_MODEL,
				name: "Room V2 deterministic test model",
				input: ["text"],
				...(scenario === THRESHOLD_CONTINUATION_SCENARIO ? { contextWindow: 64_000 } : {}),
			},
		],
		tokensPerSecond: process.env.RAG_IME_PI_DETERMINISTIC_SLOW === "1" ? 10 : undefined,
	});
	if (scenario === CONTEXT_EPOCH_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => contextEpochCanaryResponse));
	} else if (scenario === PROJECT_TASK_SCENARIO || scenario === PROJECT_TOOL_RECOVERY_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => projectTaskCanaryResponse));
	} else if (scenario === PROJECT_COLLABORATION_SCENARIO) {
		faux.setResponses(Array.from({ length: 128 }, () => projectCollaborationCanaryResponse));
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
			fauxAssistantMessage("Room dispatch inspected the workspace and settled."),
			fauxAssistantMessage("Governed continuation completed the remaining acceptance check."),
		]);
	}
	const model = faux.getModel();
	runtime.registerProvider(DETERMINISTIC_TEST_PROVIDER, {
		name: "Room V2 deterministic test Provider",
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
