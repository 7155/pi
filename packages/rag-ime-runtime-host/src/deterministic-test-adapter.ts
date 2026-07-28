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
	const values: unknown[] = [];
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
				typeof record.nextOffset === "number" &&
				typeof record.truncated === "boolean" &&
				record.toolName === undefined
			);
		})
		.sort((left, right) => Number(left.nextOffset) - Number(right.nextOffset))
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
		.map((record) => String(record.evidenceRef ?? ""))
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
	const currentTask =
		(task.split("当前任务：").at(-1) ?? task).split(/验收条件(?:\s+acceptance\.criteria|（|:|：)/u)[0] ?? task;
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
						targetParticipantRef: participantRefForRole(context, "reviewer"),
						intent: "review",
						objective:
							"B 先调用 room_state，再独立读取 calculator.py 与 test_calculator.py；" +
							"不得调用 edit 或 bash；room_post 以 COLLAB-B-REVIEWED 开头，" +
							"最后用 room_commit 交付 COLLAB-B-COMMIT-RESULT 和 AC 证据。",
						expectedOutput: "B 交付只读测试意图复核与两份文件证据。",
						acceptance: currentAcceptanceAliases(context, task).filter((alias) => alias === "AC-4"),
					},
					{ id: callId("collaborate") },
				),
				{ stopReason: "toolUse" },
			);
		}
	}

	requireResidentNativeCodingTools(tools, member === "A" || member === "C" ? NATIVE_CODING_TOOL_NAMES : ["read"]);
	if (member === "A" && !serialized.includes(callId("missing-read"))) {
		return fauxAssistantMessage(
			fauxToolCall(
				"read",
				{ path: "missing_requirements.md", offset: 0, limit: 16_384 },
				{ id: callId("missing-read") },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (member === "A") {
		if (!serialized.includes(callId("list"))) {
			return fauxAssistantMessage(fauxToolCall("ls", { path: ".", limit: 50 }, { id: callId("list") }), {
				stopReason: "toolUse",
			});
		}
		if (!serialized.includes(callId("search"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"grep",
					{ pattern: "ROOM_PROJECT_TASK", path: ".", literal: true, limit: 20 },
					{ id: callId("search") },
				),
				{ stopReason: "toolUse" },
			);
		}
	}
	if (!serialized.includes(callId("read-app"))) {
		return fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "calculator.py", offset: 0, limit: 16_384 }, { id: callId("read-app") }),
				fauxToolCall("read", { path: "test_calculator.py", offset: 0, limit: 16_384 }, { id: callId("read-test") }),
			],
			{ stopReason: "toolUse" },
		);
	}

	if (member === "A" || member === "C") {
		const shellId = member === "A" ? callId("baseline-shell") : callId("acceptance-shell");
		if (!serialized.includes(shellId)) {
			return fauxAssistantMessage(
				fauxToolCall("bash", { command: "/usr/bin/python3 -m unittest -v", timeout: 30 }, { id: shellId }),
				{ stopReason: "toolUse" },
			);
		}
	}

	if (member === "A") {
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
			throw new Error("The managed collaboration patch did not produce an applied receipt");
		}
		if (!serialized.includes(callId("regression-shell"))) {
			return fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: "/usr/bin/python3 -m unittest -v", timeout: 30 },
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
			fauxToolCall(
				"room_post",
				{ kind: "evidence", content: `${marker}；隔离项目证据已核对。` },
				{ id: callId("post") },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!tools.has("room_commit")) {
		return fauxAssistantMessage(fauxToolCall("tool_load", { name: "room_commit" }, { id: callId("load-commit") }), {
			stopReason: "toolUse",
		});
	}
	if (!serialized.includes(callId("commit"))) {
		const evidenceRefs = runtimeEvidenceRefs(context, 8);
		const committedEvidenceRefs =
			evidenceRefs.length > 0 ? evidenceRefs : [member === "A" ? callId("regression-shell") : callId("read-app")];
		if (member === "A") {
			const aliases = currentAcceptanceAliases(context, task);
			const ownedAliases = aliases.filter((alias) => ["AC-1", "AC-2", "AC-3"].includes(alias));
			return fauxAssistantMessage(
				fauxToolCall(
					"room_commit",
					{
						decision: "handoff",
						summary: "COLLAB-A-COMMIT-RESULT",
						evidence: evidenceProposal(ownedAliases, committedEvidenceRefs),
						residualRisks: ["最终独立验收仍由 C 完成。"],
						targetParticipantRef: participantRefForRole(context, "coordinator"),
						intent: "close",
						nextTask:
							"C 先调用 room_state，独立读取 calculator.py 与 test_calculator.py；" +
							"运行 /usr/bin/python3 -m unittest -v，不得调用 edit；" +
							"room_post 以 COLLAB-C-ACCEPTED 开头；最后用 room_commit 交付 " +
							"COLLAB-C-COMMIT-RESULT，并覆盖全部 AC 验收别名。",
						expectedOutput: "C 交付独立测试验收证据并最终关闭 Root。",
						acceptanceAliases: aliases,
					},
					{ id: callId("commit") },
				),
				{ stopReason: "toolUse" },
			);
		}
		const aliases = currentAcceptanceAliases(context, task);
		if (aliases.length === 0) {
			throw new Error("Every collaboration delivery requires explicit AC aliases");
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					summary: member === "B" ? "COLLAB-B-COMMIT-RESULT" : "COLLAB-C-COMMIT-RESULT",
					evidence: evidenceProposal(aliases, committedEvidenceRefs),
					residualRisks: [],
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
		if (serialized.includes("agent-read-boundary-0")) {
			throw new Error("The Agent Session boundary read did not return a structured receipt");
		}
		return fauxAssistantMessage(
			fauxToolCall("read", { path: "read-boundary.txt", offset: 0, limit: 65_536 }, { id: "agent-read-boundary-0" }),
			{ stopReason: "toolUse" },
		);
	}
	if (
		Number(boundaryReceipt.contentBytes) > 50 * 1024 ||
		Number(boundaryReceipt.contentLines) > 2_000 ||
		Number(boundaryReceipt.modelResultLimitBytes) !== 50 * 1024 ||
		Buffer.byteLength(JSON.stringify(boundaryReceipt), "utf8") > 50 * 1024
	) {
		throw new Error("read exceeded the Pi model-visible result budget");
	}
	if (boundaryReceipt.truncated === true) {
		const nextOffset = Number(boundaryReceipt.nextOffset);
		const currentOffset = Number(boundaryReceipt.offset);
		if (!Number.isSafeInteger(nextOffset) || nextOffset <= currentOffset) {
			throw new Error("read did not advance its UTF-8 continuation offset");
		}
		const callId = `agent-read-boundary-${nextOffset}`;
		if (serialized.includes(`"id":"${callId}"`)) {
			throw new Error("The Agent Session boundary continuation did not advance");
		}
		return fauxAssistantMessage(
			fauxToolCall("read", { path: "read-boundary.txt", offset: nextOffset, limit: 65_536 }, { id: callId }),
			{ stopReason: "toolUse" },
		);
	}
	if (Number(boundaryReceipt.nextOffset) !== Number(boundaryReceipt.byteSize)) {
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
	const faux = createFauxCore({
		api: "faux:room-v2",
		provider: DETERMINISTIC_TEST_PROVIDER,
		models: [{ id: DETERMINISTIC_TEST_MODEL, name: "Room V2 deterministic test model", input: ["text"] }],
		tokensPerSecond: process.env.RAG_IME_PI_DETERMINISTIC_SLOW === "1" ? 10 : undefined,
	});
	if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === CONTEXT_EPOCH_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => contextEpochCanaryResponse));
	} else if (
		process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === PROJECT_TASK_SCENARIO ||
		process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === PROJECT_TOOL_RECOVERY_SCENARIO
	) {
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
