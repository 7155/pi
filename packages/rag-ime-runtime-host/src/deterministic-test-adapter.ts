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
const PROJECT_COLLABORATION_SCENARIO = "project-collaboration";
const AGENT_SESSION_SCENARIO = "agent-session";
const AGENT_SESSION_TASK_MARKER = "AGENT-SESSION-RESILIENCE";
const AGENT_SESSION_FINAL_MARKER = "AGENT-SESSION-CANARY-OK";
const AGENT_SESSION_RECOVERY_MARKER = "AGENT-SESSION-RECOVERY-OK";
const AGENT_SESSION_SKILL = "room-test-driven-implementation";

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
	for (const source of stringsIn(context.messages)) {
		try {
			if (containsField(JSON.parse(source) as unknown, field, expected)) return true;
		} catch {}
	}
	return false;
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
	const values: unknown[] = [];
	for (const source of stringsIn(context.messages)) {
		try {
			values.push(JSON.parse(source) as unknown);
		} catch {}
	}
	return values.flatMap(recordsIn);
}

function participantIdForRole(context: Context, collaborationRole: string): string {
	const participant = parsedContextRecords(context).find((record) => {
		const id = String(record.id ?? record.participantId ?? "");
		return id.startsWith("participant:") && record.collaborationRole === collaborationRole;
	});
	if (!participant) {
		throw new Error(`Room state did not expose the ${collaborationRole} participant`);
	}
	return String(participant.id ?? participant.participantId);
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

function acceptanceCriterionIds(task: string): string[] {
	return [...task.matchAll(/"?criterionId"?\s*:\s*"([^"]+)"/gu)]
		.map((match) => match[1])
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function executionReceiptIds(serialized: string, limit = 2): string[] {
	return [...serialized.matchAll(/"executionReceiptId":"([^"]+)"/gu)]
		.map((match) => match[1])
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
		.slice(-limit);
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
	if (!tools.has("workspace_read")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_read" }, { id: `${prefix}-load-read` }),
			{
				stopReason: "toolUse",
			},
		);
	}
	if (!serialized.includes(`${prefix}-read-a`)) {
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "rag_ime/agent_service.py", offset: 0, limit: 65_536 },
					{ id: `${prefix}-read-a` },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "rag_ime/agent_room_kernel.py", offset: 0, limit: 65_536 },
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
				{ content: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。` },
				{ id: `${prefix}-post` },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes(`${prefix}-commit`)) {
		const requirementCoverage = acceptanceCriterionIds(task);
		if (requirementCoverage.length === 0) {
			throw new Error("The context epoch canary requires explicit acceptance criterion ids");
		}
		const receipts = executionReceiptIds(serialized);
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					result: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。`,
					evidenceRefs: receipts.length > 0 ? receipts : [`${prefix}-read-a`, `${prefix}-read-b`],
					requirementCoverage,
				},
				{ id: `${prefix}-commit` },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(`CANARY-${epoch}-OK`);
}

/** Drive an approved read, patch, test, publish and settle task in an isolated project. */
export function projectTaskCanaryResponse(context: Context): AssistantMessage {
	const task = currentRoomTask(context);
	if (!task || !task.includes("PROJECT-TASK-CANARY")) {
		return fauxAssistantMessage("A managed PROJECT-TASK-CANARY dispatch is required.");
	}
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	const requiredDiscoveryTools = ["workspace_list", "workspace_search", "workspace_read"];
	const missingDiscoveryTools = requiredDiscoveryTools.filter((name) => !tools.has(name));
	if (missingDiscoveryTools.length > 0) {
		return fauxAssistantMessage(
			missingDiscoveryTools.map((name) => fauxToolCall("tool_load", { name }, { id: `project-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-list")) {
		return fauxAssistantMessage(
			fauxToolCall("workspace_list", { op: "list", path: ".", depth: 2, limit: 50 }, { id: "project-list" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-search")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_search",
				{
					op: "search",
					query: "ROOM_PROJECT_TASK",
					path: ".",
					mode: "both",
					caseSensitive: true,
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
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "calculator.py", offset: 0, limit: 16_384 },
					{ id: "project-read-app" },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "test_calculator.py", offset: 0, limit: 16_384 },
					{ id: "project-read-test" },
				),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (!tools.has("workspace_patch")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_patch" }, { id: "project-load-patch" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-patch")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_patch",
				{
					op: "apply",
					path: "calculator.py",
					oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
					newText:
						"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
					expectedOccurrences: 1,
				},
				{ id: "project-patch" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "mutationApplied", true)) {
		throw new Error("The approved project patch did not produce an applied receipt");
	}
	if (!tools.has("workspace_shell")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_shell" }, { id: "project-load-shell" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-test")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_shell",
				{
					op: "run",
					command: "/usr/bin/python3 -m unittest -v",
					cwd: ".",
					timeoutSeconds: 30,
					allowNetwork: false,
				},
				{ id: "project-test" },
			),
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
				{ content: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。" },
				{ id: "project-post" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-commit")) {
		const requirementCoverage = acceptanceCriterionIds(task);
		if (requirementCoverage.length === 0) {
			throw new Error("The project canary requires explicit acceptance criterion ids");
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					result: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。",
					evidenceRefs: executionReceiptIds(serialized, 8),
					requirementCoverage,
				},
				{ id: "project-commit" },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage("PROJECT-CANARY-OK");
}

/** Drive one A -> (B collaboration, C handoff) Room task through the real Kernel. */
export function projectCollaborationCanaryResponse(context: Context): AssistantMessage {
	const serialized = contextText(context);
	if (serialized.includes("structured context checkpoint summary")) {
		return fauxAssistantMessage(
			"Preserve exactly one recovery packet with the immutable THREE-MEMBER-ROOM-CANARY requirement, " +
				"current task, all acceptance criteria, blockers, formal handoff, and exact Skill and Tool receipts.",
		);
	}
	const task = currentRoomTask(context);
	if (!task) return fauxAssistantMessage("A managed three-member Room dispatch is required.");
	const currentTask = (task.split("当前任务：").at(-1) ?? task).split("验收条件 acceptance.criteria")[0] ?? task;
	const member = currentTask.includes("COLLAB-B-REVIEWED")
		? "B"
		: currentTask.includes("COLLAB-C-ACCEPTED")
			? "C"
			: currentTask.includes("THREE-MEMBER-ROOM-CANARY")
				? "A"
				: "";
	if (!member) return fauxAssistantMessage("The current Room task is outside the collaboration canary.");
	const prefix = `collab-${member.toLowerCase()}`;
	const tools = activeToolNames(context);
	const callId = (suffix: string): string => `${prefix}-${suffix}`;

	if (!tools.has("room_state")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_state" }, { id: callId("load-state") }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes(callId("state"))) {
		return fauxAssistantMessage(fauxToolCall("room_state", {}, { id: callId("state") }), { stopReason: "toolUse" });
	}

	if (member === "A") {
		if (!tools.has("room_collaborate")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "room_collaborate" }, { id: callId("load-collaborate") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("collaborate"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"room_collaborate",
					{
						targetParticipantId: participantIdForRole(context, "reviewer"),
						intentKind: "review",
						objective:
							"B 先调用 room_state，再独立读取 calculator.py 与 test_calculator.py；" +
							"不得调用 workspace_patch 或 workspace_shell；room_post 以 COLLAB-B-REVIEWED 开头，" +
							"最后 room_commit decision=deliver、result=COLLAB-B-COMMIT-RESULT。",
						expectedOutput: "B 交付只读测试意图复核与两份文件证据。",
						acceptanceCriterionIds: [],
					},
					{ id: callId("collaborate") },
				),
				{ stopReason: "toolUse" },
			);
		}
	}

	if (!tools.has("workspace_read")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "workspace_read" }, { id: callId("load-read") }), {
			stopReason: "toolUse",
		});
	}
	if (member === "A" && !serialized.includes(callId("missing-read"))) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_read",
				{ op: "read", path: "missing_requirements.md", offset: 0, limit: 16_384 },
				{ id: callId("missing-read") },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (member === "A") {
		const missingDiscoveryTools = ["workspace_list", "workspace_search"].filter((name) => !tools.has(name));
		if (missingDiscoveryTools.length > 0) {
			return fauxAssistantMessage(
				missingDiscoveryTools.map((name) =>
					fauxToolCall("tool_load", { name }, { id: callId(`load-${name.replace("workspace_", "")}`) }),
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("list"))) {
			return fauxAssistantMessage(
				fauxToolCall("workspace_list", { op: "list", path: ".", depth: 2, limit: 50 }, { id: callId("list") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("search"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"workspace_search",
					{ op: "search", query: "ROOM_PROJECT_TASK", path: ".", mode: "both", caseSensitive: true, limit: 20 },
					{ id: callId("search") },
				),
				{ stopReason: "toolUse" },
			);
		}
	}
	if (!serialized.includes(callId("read-app"))) {
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "calculator.py", offset: 0, limit: 16_384 },
					{ id: callId("read-app") },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "test_calculator.py", offset: 0, limit: 16_384 },
					{ id: callId("read-test") },
				),
			],
			{ stopReason: "toolUse" },
		);
	}

	if (member === "A" || member === "C") {
		if (!tools.has("workspace_shell")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "workspace_shell" }, { id: callId("load-shell") }),
				{ stopReason: "toolUse" },
			);
		}
		const shellId = member === "A" ? callId("baseline-shell") : callId("acceptance-shell");
		if (!serialized.includes(shellId)) {
			return fauxAssistantMessage(
				fauxToolCall(
					"workspace_shell",
					{
						op: "run",
						command: "/usr/bin/python3 -m unittest -v",
						cwd: ".",
						timeoutSeconds: 30,
						allowNetwork: false,
					},
					{ id: shellId },
				),
				{ stopReason: "toolUse" },
			);
		}
	}

	if (member === "A") {
		if (!tools.has("workspace_patch")) {
			return fauxAssistantMessage(
				fauxToolCall("tool_load", { name: "workspace_patch" }, { id: callId("load-patch") }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(callId("patch"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"workspace_patch",
					{
						op: "apply",
						path: "calculator.py",
						oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
						newText:
							"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
						expectedOccurrences: 1,
					},
					{ id: callId("patch") },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!contextHasJsonField(context, "mutationApplied", true)) {
			throw new Error("The managed collaboration patch did not produce an applied receipt");
		}
		if (!serialized.includes(callId("regression-shell"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"workspace_shell",
					{
						op: "run",
						command: "/usr/bin/python3 -m unittest -v",
						cwd: ".",
						timeoutSeconds: 30,
						allowNetwork: false,
					},
					{ id: callId("regression-shell") },
				),
				{ stopReason: "toolUse" },
			);
		}
	}

	if (!tools.has("room_post")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_post" }, { id: callId("load-post") }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes(callId("post"))) {
		const marker =
			member === "A" ? "COLLAB-A-IMPLEMENTED" : member === "B" ? "COLLAB-B-REVIEWED" : "COLLAB-C-ACCEPTED";
		return fauxAssistantMessage(
			fauxToolCall("room_post", { content: `${marker}；隔离项目证据已核对。` }, { id: callId("post") }),
			{ stopReason: "toolUse" },
		);
	}
	if (!tools.has("room_commit")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_commit" }, { id: callId("load-commit") }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes(callId("commit"))) {
		const evidenceRefs = executionReceiptIds(serialized, 8);
		if (member === "A") {
			return fauxAssistantMessage(
				fauxToolCall(
					"room_commit",
					{
						decision: "handoff",
						result: "COLLAB-A-COMMIT-RESULT",
						evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : [callId("regression-shell")],
						requirementCoverage: [],
						targetParticipantId: participantIdForRole(context, "coordinator"),
						nextIntentKind: "close",
						nextTask:
							"C 先调用 room_state，独立读取 calculator.py 与 test_calculator.py；" +
							"运行 /usr/bin/python3 -m unittest -v，不得调用 workspace_patch；" +
							"room_post 以 COLLAB-C-ACCEPTED 开头；最后 room_commit decision=deliver、" +
							"result=COLLAB-C-COMMIT-RESULT，并原样覆盖全部 acceptance.criteria[].criterionId。",
						nextExpectedOutput: "C 交付独立测试验收证据并最终关闭 Root。",
					},
					{ id: callId("commit") },
				),
				{ stopReason: "toolUse" },
			);
		}
		const requirementCoverage = member === "C" ? acceptanceCriterionIds(task) : [];
		if (member === "C" && requirementCoverage.length === 0) {
			throw new Error("The final collaboration task requires explicit acceptance criterion ids");
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					result: member === "B" ? "COLLAB-B-COMMIT-RESULT" : "COLLAB-C-COMMIT-RESULT",
					evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : [callId("read-app")],
					requirementCoverage,
				},
				{ id: callId("commit") },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(`${prefix.toUpperCase()}-SETTLED`);
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
	if (!tools.has("workspace_read")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "workspace_read" }, { id: "agent-load-read" }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes("agent-missing-read")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_read",
				{ op: "read", path: "missing_requirements.md", offset: 0, limit: 16_384 },
				{ id: "agent-missing-read" },
			),
			{ stopReason: "toolUse" },
		);
	}

	const discoveryTools = ["workspace_list", "workspace_search"].filter((name) => !tools.has(name));
	if (discoveryTools.length > 0) {
		return fauxAssistantMessage(
			discoveryTools.map((name) => fauxToolCall("tool_load", { name }, { id: `agent-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-list")) {
		return fauxAssistantMessage(
			fauxToolCall("workspace_list", { op: "list", path: ".", depth: 2, limit: 50 }, { id: "agent-list" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("agent-search")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_search",
				{
					op: "search",
					query: "ROOM_PROJECT_TASK",
					path: ".",
					mode: "both",
					caseSensitive: true,
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
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "calculator.py", offset: 0, limit: 16_384 },
					{ id: "agent-read-app" },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "test_calculator.py", offset: 0, limit: 16_384 },
					{ id: "agent-read-test" },
				),
			],
			{ stopReason: "toolUse" },
		);
	}

	if (!tools.has("agent_plan")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "agent_plan" }, { id: "agent-load-plan" }), {
			stopReason: "toolUse",
		});
	}
	for (const [id, title] of [
		["agent-plan-baseline", "运行失败基线测试"],
		["agent-plan-patch", "精确修改 normalize_scores"],
		["agent-plan-regression", "运行回归测试并交付"],
	] as const) {
		if (!serialized.includes(id)) {
			return fauxAssistantMessage(fauxToolCall("agent_plan", { op: "update", title, status: "pending" }, { id }), {
				stopReason: "toolUse",
			});
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

	if (!tools.has("workspace_shell")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "workspace_shell" }, { id: "agent-load-shell" }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes("agent-baseline-shell")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_shell",
				{
					op: "run",
					command: "/usr/bin/python3 -m unittest -v",
					cwd: ".",
					timeoutSeconds: 30,
					allowNetwork: false,
				},
				{ id: "agent-baseline-shell" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!tools.has("workspace_patch")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "workspace_patch" }, { id: "agent-load-patch" }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes("agent-patch")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_patch",
				{
					op: "apply",
					path: "calculator.py",
					oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
					newText:
						"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
					expectedOccurrences: 1,
				},
				{ id: "agent-patch" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "mutationApplied", true)) {
		throw new Error("The approved Agent Session patch did not produce an applied receipt");
	}
	if (!serialized.includes("agent-regression-shell")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_shell",
				{
					op: "run",
					command: "/usr/bin/python3 -m unittest -v",
					cwd: ".",
					timeoutSeconds: 30,
					allowNetwork: false,
				},
				{ id: "agent-regression-shell" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "exitCode", 0)) {
		throw new Error("The Agent Session regression command did not pass");
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
	const faux = createFauxCore({
		api: "faux:room-v2",
		provider: DETERMINISTIC_TEST_PROVIDER,
		models: [{ id: DETERMINISTIC_TEST_MODEL, name: "Room V2 deterministic test model", input: ["text"] }],
		tokensPerSecond: process.env.RAG_IME_PI_DETERMINISTIC_SLOW === "1" ? 10 : undefined,
	});
	if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === CONTEXT_EPOCH_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => contextEpochCanaryResponse));
	} else if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === PROJECT_TASK_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => projectTaskCanaryResponse));
	} else if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === PROJECT_COLLABORATION_SCENARIO) {
		faux.setResponses(Array.from({ length: 128 }, () => projectCollaborationCanaryResponse));
	} else if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === AGENT_SESSION_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => agentSessionCanaryResponse));
	} else {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json", limit: 4 }, { id: "deterministic-read" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Room dispatch inspected the workspace and settled."),
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
