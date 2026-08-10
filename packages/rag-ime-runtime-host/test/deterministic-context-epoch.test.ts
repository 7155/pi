import type { Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	agentSessionCanaryResponse,
	contextEpochCanaryResponse,
	projectCollaborationCanaryResponse,
	projectTaskCanaryResponse,
} from "../src/deterministic-test-adapter.ts";

const tool = (name: string): Tool => ({
	name,
	description: name,
	parameters: { type: "object" },
});

const nativeCodingTools = ["read", "grep", "find", "ls", "bash"];

const taskPrompt = `<room-fact kind="dispatch_state">## Room 任务
当前任务：
- 预期产物：CANARY-2-OK
	验收条件（提交证据时使用 AC 编号）：
	- AC-1 | 待验收 | 有界读取第一份源码
	- AC-2 | 待验收 | 有界读取第二份源码
	- AC-3 | 待验收 | 公开结果并提交
</room-fact>`;

function context(tools: string[], history = ""): Context {
	return {
		systemPrompt: taskPrompt,
		messages: history ? ([{ role: "user", content: history, timestamp: 1 }] as Context["messages"]) : [],
		tools: tools.map(tool),
	};
}

function messageContext(tools: string[]): Context {
	return {
		systemPrompt: "stable system prompt",
		messages: [{ role: "user", content: taskPrompt, timestamp: 1 }] as Context["messages"],
		tools: tools.map(tool),
	};
}

function calls(response: ReturnType<typeof contextEpochCanaryResponse>) {
	return response.content.filter((item) => item.type === "toolCall");
}

const projectTaskPrompt = `<room-fact kind="dispatch_state">## Room 任务
原始需求（不可改写）：
- 执行 PROJECT-TASK-CANARY。
当前任务：
- 目标：PROJECT-TASK-CANARY
	验收条件（提交证据时使用 AC 编号）：
	- AC-1 | 待验收 | 修改并测试
	- AC-2 | 待验收 | 公开结果并提交
</room-fact>`;

function projectContext(
	tools: string[],
	history: string | Record<string, unknown> = "",
	marker = "PROJECT-TASK-CANARY",
): Context {
	return {
		systemPrompt: projectTaskPrompt.replaceAll("PROJECT-TASK-CANARY", marker),
		messages: history
			? ([
					{ role: "user", content: typeof history === "string" ? history : JSON.stringify(history), timestamp: 1 },
				] as Context["messages"])
			: [],
		tools: tools.map(tool),
	};
}

function agentContext(tools: string[], history = "", systemPrompt = ""): Context {
	return {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: `AGENT-SESSION-RESILIENCE ${history}`,
				timestamp: 1,
			},
		] as Context["messages"],
		tools: tools.map(tool),
	};
}

function agentReceiptContext(tools: string[], receipt: Record<string, unknown>, systemPrompt = ""): Context {
	return {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: "AGENT-SESSION-RESILIENCE",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "agent-read-boundary-result",
				toolName: "read",
				content: [{ type: "text", text: String(receipt.content ?? "") }],
				details: { ...receipt, toolName: "workspace_read" },
				isError: false,
				timestamp: 2,
			},
		] as Context["messages"],
		tools: tools.map(tool),
	};
}

function completeBoundaryReceipt(history: string): Record<string, unknown> {
	return {
		history,
		path: "/workspace/read-boundary.txt",
		content: "final boundary segment\n",
		startLine: 4001,
		endLine: 4001,
		nextLineOffset: null,
		size: 2048,
		truncated: false,
	};
}

function collaborationContext(task: string, tools: string[], history: Record<string, unknown> = {}): Context {
	return {
		systemPrompt: `<room-fact kind="dispatch_state">${task}</room-fact>`,
		messages: [
			{
				role: "user",
				content: JSON.stringify(history),
				timestamp: 1,
			},
		] as Context["messages"],
		tools: tools.map(tool),
	};
}

describe("deterministic context epoch Provider", () => {
	it("uses resident native reads, then publishes and commits through progressive Room stages", () => {
		expect(calls(contextEpochCanaryResponse(context(["tool_load", ...nativeCodingTools])))).toEqual([
			expect.objectContaining({ name: "read", id: "epoch-2-read-a" }),
			expect.objectContaining({ name: "read", id: "epoch-2-read-b" }),
		]);

		const readHistory = '"id":"epoch-2-read-a"';
		expect(calls(contextEpochCanaryResponse(context(["tool_load", ...nativeCodingTools], readHistory)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "room_post" } }),
			expect.objectContaining({ name: "tool_load", arguments: { name: "room_commit" } }),
		]);

		const roomTools = ["tool_load", ...nativeCodingTools, "room_post", "room_commit"];
		expect(calls(contextEpochCanaryResponse(context(roomTools, readHistory)))).toEqual([
			expect.objectContaining({ name: "room_post", id: "epoch-2-post" }),
		]);

		const commit = calls(contextEpochCanaryResponse(context(roomTools, `${readHistory} "id":"epoch-2-post"`)))[0];
		expect(commit).toMatchObject({
			name: "room_commit",
			id: "epoch-2-commit",
			arguments: {
				decision: "deliver",
				summary: "CANARY-2-OK；两份指定源码已完成有界读取。",
				evidence: [
					{ acceptance: "AC-1", refs: ["epoch-2-read-a", "epoch-2-read-b"] },
					{ acceptance: "AC-2", refs: ["epoch-2-read-a", "epoch-2-read-b"] },
					{ acceptance: "AC-3", refs: ["epoch-2-read-a", "epoch-2-read-b"] },
				],
				residualRisks: [],
			},
		});
	});

	it("finds provider-only Room facts outside the stable system prompt", () => {
		expect(calls(contextEpochCanaryResponse(messageContext(["tool_load", ...nativeCodingTools])))).toEqual([
			expect.objectContaining({ name: "read", id: "epoch-2-read-a" }),
			expect.objectContaining({ name: "read", id: "epoch-2-read-b" }),
		]);
	});

	it("rejects an older JSON task projection that exposes database criterion ids", () => {
		const legacyPrompt = `<room-fact kind="dispatch_state">${JSON.stringify({
			acceptance: { criteria: [{ criterionId: "legacy:1" }] },
			task: { expectedOutput: "CANARY-7-OK" },
		})}</room-fact>`;
		const legacyContext = {
			systemPrompt: legacyPrompt,
			messages: [{ role: "user", content: '"id":"epoch-7-read-a" "id":"epoch-7-post"', timestamp: 1 }],
			tools: ["tool_load", ...nativeCodingTools, "room_post", "room_commit"].map(tool),
		} as Context;
		expect(() => contextEpochCanaryResponse(legacyContext)).toThrow("requires explicit AC aliases");
	});

	it("drives a real project through discovery, approved patch, test and settle", () => {
		const discoveryTools = ["tool_load", ...nativeCodingTools];
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools)))).toEqual([
			expect.objectContaining({ name: "ls", id: "project-list" }),
		]);
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, '"id":"project-list"')))).toEqual([
			expect.objectContaining({ name: "find", id: "project-find" }),
		]);
		expect(
			calls(projectTaskCanaryResponse(projectContext(discoveryTools, '"id":"project-list" "id":"project-find"'))),
		).toEqual([expect.objectContaining({ name: "grep", id: "project-search" })]);

		const inspected = '"id":"project-list" "id":"project-find" "id":"project-search" "id":"project-read-app"';
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, inspected)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-patch" }),
		]);

		const patched = {
			history: `${inspected} project-patch`,
			role: "toolResult",
			toolCallId: "project-patch",
			toolName: "bash",
			isError: false,
		};
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, patched)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-test" }),
		]);

		const tested = {
			history: `${JSON.stringify(patched)} project-test`,
			patchResult: patched,
			exitCode: 0,
		};
		const roomTools = [...discoveryTools, "room_post", "room_commit"];
		expect(calls(projectTaskCanaryResponse(projectContext(roomTools, tested)))).toEqual([
			expect.objectContaining({ name: "room_post", id: "project-post" }),
		]);
		const commit = calls(
			projectTaskCanaryResponse(
				projectContext(roomTools, {
					history: `${JSON.stringify(tested)} project-post`,
					patchResult: patched,
					exitCode: 0,
				}),
			),
		)[0];
		expect(commit).toMatchObject({
			name: "room_commit",
			id: "project-commit",
			arguments: {
				decision: "deliver",
				summary: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。",
				evidence: [
					{ acceptance: "AC-1", refs: ["project-test"] },
					{ acceptance: "AC-2", refs: ["project-test"] },
				],
				residualRisks: [],
			},
		});
	});

	it("recovers from one failed native read and baseline test without retrying either call", () => {
		const recoveryMarker = "PROJECT-TOOL-RECOVERY-CANARY";
		const tools = ["tool_load", ...nativeCodingTools];
		expect(calls(projectTaskCanaryResponse(projectContext(tools, "", recoveryMarker)))).toEqual([
			expect.objectContaining({
				name: "read",
				id: "project-missing-read",
				arguments: { path: "missing_requirements.md", offset: 0, limit: 16_384 },
			}),
		]);

		const afterMissingRead = '"id":"project-missing-read"';
		expect(calls(projectTaskCanaryResponse(projectContext(tools, afterMissingRead, recoveryMarker)))).toEqual([
			expect.objectContaining({ name: "ls", id: "project-list" }),
		]);
		expect(
			calls(
				projectTaskCanaryResponse(projectContext(tools, `${afterMissingRead} "id":"project-list"`, recoveryMarker)),
			),
		).toEqual([expect.objectContaining({ name: "find", id: "project-find" })]);
		expect(
			calls(
				projectTaskCanaryResponse(
					projectContext(tools, `${afterMissingRead} "id":"project-list" "id":"project-find"`, recoveryMarker),
				),
			),
		).toEqual([expect.objectContaining({ name: "grep", id: "project-search" })]);
		const inspected = `${afterMissingRead} "id":"project-list" "id":"project-find" "id":"project-search" "id":"project-read-app"`;
		expect(calls(projectTaskCanaryResponse(projectContext(tools, inspected, recoveryMarker)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-baseline-test" }),
		]);

		const failedBaseline = JSON.stringify({
			history: `${inspected} "id":"project-baseline-test"`,
			exitCode: 1,
		});
		const repair = calls(projectTaskCanaryResponse(projectContext(tools, failedBaseline, recoveryMarker)));
		expect(repair).toEqual([expect.objectContaining({ name: "bash", id: "project-patch" })]);
		expect(repair.some((call) => call.id === "project-missing-read")).toBe(false);

		const patched = {
			history: `${failedBaseline} "id":"project-patch"`,
			role: "toolResult",
			toolCallId: "project-patch",
			toolName: "bash",
			isError: false,
			exitCode: 1,
		};
		expect(calls(projectTaskCanaryResponse(projectContext(tools, patched, recoveryMarker)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-test" }),
		]);
	});

	it("drives an ordinary Agent Session through progressive discovery and planning", () => {
		expect(calls(agentSessionCanaryResponse(agentContext(["skill_load", ...nativeCodingTools])))).toEqual([
			expect.objectContaining({ name: "skill_load", arguments: { name: "implementation-execution" } }),
		]);

		const loadedSkill = '<loaded_skill name="implementation-execution">';
		const readTool = ["tool_load", ...nativeCodingTools];
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, loadedSkill)))).toEqual([
			expect.objectContaining({ name: "read", id: "agent-missing-read" }),
		]);

		const afterMissing = `${loadedSkill} "id":"agent-missing-read"`;
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, afterMissing)))).toEqual([
			expect.objectContaining({ name: "ls", id: "agent-list" }),
		]);

		const todoHistory = [afterMissing, '"id":"agent-list"', '"id":"agent-search"', '"id":"agent-read-app"'].join(" ");
		const todoTools = ["tool_load", ...nativeCodingTools, "todo"];
		expect(calls(agentSessionCanaryResponse(agentContext(todoTools, `${loadedSkill} ${todoHistory}`)))).toEqual([
			expect.objectContaining({
				name: "read",
				id: "agent-read-boundary-1",
				arguments: expect.objectContaining({
					path: "read-boundary.txt",
					offset: 1,
					limit: 1_000,
				}),
			}),
		]);
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext(
						todoTools,
						{
							history: todoHistory,
							path: "/workspace/read-boundary.txt",
							content: "line\n".repeat(1_000),
							startLine: 1,
							endLine: 1_000,
							nextLineOffset: 1_001,
							size: 25_000,
							truncated: true,
						},
						loadedSkill,
					),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "read",
				id: "agent-read-boundary-1001",
				arguments: { path: "read-boundary.txt", offset: 1_001, limit: 1_000 },
			}),
		]);
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext(
						todoTools,
						completeBoundaryReceipt(`${todoHistory} "id":"agent-todo-init"`),
						loadedSkill,
					),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "todo",
				id: "agent-todo-baseline-start",
				arguments: { op: "start", task: "运行失败基线测试" },
			}),
		]);

		const firstPlanItem = calls(
			agentSessionCanaryResponse(
				agentReceiptContext(
					todoTools,
					completeBoundaryReceipt(`${afterMissing} "id":"agent-list" "id":"agent-search" "id":"agent-read-app"`),
					loadedSkill,
				),
			),
		)[0];
		expect(firstPlanItem).toMatchObject({
			name: "todo",
			id: "agent-todo-init",
			arguments: {
				op: "init",
				list: [
					{
						phase: "实现与验证",
						items: ["运行失败基线测试", "精确修改 normalize_scores", "运行回归测试并交付"],
					},
				],
			},
		});
	});

	it("completes every ordinary Agent Todo item before final delivery", () => {
		const loadedSkill = '<loaded_skill name="implementation-execution">';
		const baseHistory = [
			loadedSkill,
			'"id":"agent-missing-read"',
			'"id":"agent-list"',
			'"id":"agent-search"',
			'"id":"agent-read-app"',
			'"id":"agent-todo-init"',
			'"id":"agent-todo-baseline-start"',
			'"id":"agent-baseline-shell"',
		].join(" ");
		const shellTools = ["tool_load", ...nativeCodingTools, "todo"];
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext(shellTools, { ...completeBoundaryReceipt(baseHistory), exitCode: 1 }, loadedSkill),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "todo",
				id: "agent-todo-baseline-done",
				arguments: {
					op: "done",
					task: "运行失败基线测试",
				},
			}),
		]);

		const patchedReceipt = {
			...completeBoundaryReceipt(
				`${baseHistory} "id":"agent-todo-baseline-done" "id":"agent-todo-patch-start" "id":"agent-patch"`,
			),
			patchResult: {
				role: "toolResult",
				toolCallId: "agent-patch",
				toolName: "bash",
				isError: false,
			},
			exitCode: 1,
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, patchedReceipt, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "todo",
				id: "agent-todo-patch-done",
				arguments: {
					op: "done",
					task: "精确修改 normalize_scores",
				},
			}),
		]);

		const testedReceipt = {
			...completeBoundaryReceipt(
				`${JSON.stringify(patchedReceipt)} "id":"agent-todo-patch-done" "id":"agent-todo-regression-start" "id":"agent-regression-shell"`,
			),
			patchResult: patchedReceipt.patchResult,
			exitCode: 0,
			baselineFailure: {
				toolCallId: "agent-baseline-shell",
				toolName: "bash",
				isError: true,
			},
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, testedReceipt, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "todo",
				id: "agent-todo-regression-checkpoint",
				arguments: {
					op: "checkpoint",
					task: "运行回归测试并交付",
					checkpoint: "回归测试通过，准备交付",
					references: [{ kind: "test", label: "普通 Session 回归", reference: "test_calculator.py" }],
				},
			}),
		]);

		const completedItems = {
			...completeBoundaryReceipt(`${JSON.stringify(testedReceipt)} "id":"agent-todo-regression-checkpoint"`),
			patchResult: patchedReceipt.patchResult,
			exitCode: 0,
			baselineFailure: {
				toolCallId: "agent-baseline-shell",
				toolName: "bash",
				isError: true,
			},
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, completedItems, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "todo",
				id: "agent-todo-regression-done",
				arguments: { op: "done", task: "运行回归测试并交付" },
			}),
		]);
	});

	it("drives clarification, definition, bounded collaboration, review, and reporter delivery", () => {
		const participants = [
			{ participantRef: "P-A", capabilitySummary: "coordinator" },
			{ participantRef: "P-B", capabilitySummary: "implementer" },
			{ participantRef: "P-C", capabilitySummary: "reviewer" },
		];
		const alignmentTask = [
			"原始需求（不可改写）：",
			"- 写 TUI",
			"当前任务：",
			"- 目标：写 TUI",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 完成需求对齐",
		].join("\n");
		const stateHistory = '"id":"room-full-auto-alignment-state"';
		const firstWait = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(alignmentTask, ["room_state", "room_commit"], {
					history: stateHistory,
					participants,
				}),
			),
		)[0];
		expect(firstWait).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-alignment-wait-1",
			arguments: {
				decision: "wait",
				waitingFor: "user",
				questionKind: "bounded",
				question: expect.stringContaining("最小版本"),
				questionOptions: [
					{
						value: "minimum",
						label: "先完成最小可用界面",
						description: expect.any(String),
						recommended: true,
					},
					{
						value: "polish",
						label: "先做完整视觉和主题",
						description: expect.any(String),
					},
				],
				resumeCondition: expect.any(String),
				publicSummary: expect.any(String),
			},
		});

		const answers = [
			"先做一个最小可运行的终端界面：有清晰的标题、输入区和结果区；不用安装新依赖，启动后能直接使用。",
			"优先保证键盘操作、状态反馈和基本错误提示，先不加入网络同步或复杂主题。",
			"交付时保留现有项目约定，只改实现所需内容，并给出可复现的验证结果。",
		].join(" ");
		const definitionRequirements = [
			{ requirementRef: "requirement:tui", statement: "写 TUI" },
			{ requirementRef: "requirement:layout", statement: "显示标题、输入区和结果区" },
			{ requirementRef: "requirement:feedback", statement: "提供键盘操作、状态与错误反馈" },
			{ requirementRef: "requirement:verification", statement: "提供可重复执行的验证结果" },
		];
		const alignedHistory = `${stateHistory} ${answers}`;
		expect(
			calls(
				projectCollaborationCanaryResponse(
					collaborationContext(alignmentTask, ["room_state", "tool_search", "tool_load"], {
						history: alignedHistory,
						participants,
					}),
				),
			)[0],
		).toMatchObject({
			name: "tool_search",
			id: "room-full-auto-alignment-search-define",
			arguments: { query: "room_define" },
		});
		expect(
			calls(
				projectCollaborationCanaryResponse(
					collaborationContext(alignmentTask, ["room_state", "tool_search", "tool_load"], {
						history: `${alignedHistory} "id":"room-full-auto-alignment-search-define"`,
						participants,
					}),
				),
			)[0],
		).toMatchObject({
			name: "tool_load",
			id: "room-full-auto-alignment-load-define",
			arguments: { name: "room_define" },
		});
		const definitionStateHistory =
			`${alignedHistory} "id":"room-full-auto-alignment-search-define" ` +
			'"id":"room-full-auto-alignment-load-define"';
		expect(
			calls(
				projectCollaborationCanaryResponse(
					collaborationContext(alignmentTask, ["room_state", "room_define"], {
						history: definitionStateHistory,
						participants,
					}),
				),
			)[0],
		).toMatchObject({
			name: "room_state",
			id: "room-full-auto-alignment-definition-state",
		});
		const definition = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(alignmentTask, ["room_state", "room_define"], {
					history: `${definitionStateHistory} "id":"room-full-auto-alignment-definition-state"`,
					participants,
					definitionRequirements,
				}),
			),
		)[0];
		expect(definition).toMatchObject({
			name: "room_define",
			id: "room-full-auto-alignment-define",
			arguments: {
				implementationParticipantRef: "P-B",
				entrySurface: expect.any(String),
				primaryInteraction: expect.any(String),
				observableCompletion: expect.any(String),
				requirements: expect.arrayContaining([expect.stringContaining("键盘操作")]),
				acceptanceCriteria: definitionRequirements.map((requirement) =>
					expect.objectContaining({ requirementRef: requirement.requirementRef }),
				),
				executionPlan: expect.objectContaining({
					featureTasks: [
						expect.objectContaining({
							participantRef: "P-B",
							workspacePolicy: "isolated_writable",
						}),
					],
				}),
				independentReviewRequired: true,
			},
		});
		const afterDefinition = projectCollaborationCanaryResponse(
			collaborationContext(alignmentTask, ["room_state", "room_define"], {
				history: `${alignedHistory} "id":"room-full-auto-alignment-define"`,
				participants,
				records: [
					{
						role: "toolResult",
						toolCallId: "room-full-auto-alignment-define",
						toolName: "room_define",
						isError: false,
					},
				],
			}),
		);
		expect(calls(afterDefinition)).toEqual([]);
		expect(afterDefinition.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("开始行动") }),
		]);

		const childTask = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-CHILD",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 有界实现",
		].join("\n");
		const childTools = ["room_state", "read", "bash", "room_commit"];
		const childStateHistory = '"id":"room-full-auto-child-state"';
		const childRead = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(childTask, childTools, {
					history: childStateHistory,
					participants,
					acceptanceAliases: ["AC-1"],
					evidenceRef: "child:state",
				}),
			),
		)[0];
		expect(childRead).toMatchObject({
			name: "read",
			id: "room-full-auto-child-read",
			arguments: { path: "calculator.py" },
		});

		const childPatch = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(childTask, childTools, {
					history: `${childStateHistory} "id":"room-full-auto-child-read"`,
					participants,
					acceptanceAliases: ["AC-1"],
					evidenceRef: "child:read",
				}),
			),
		)[0];
		expect(childPatch).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-patch",
			arguments: { command: expect.stringContaining('Path("calculator.py")') },
		});

		const childTest = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(childTask, childTools, {
					history: `${childStateHistory} "id":"room-full-auto-child-read" "id":"room-full-auto-child-patch"`,
					participants,
					acceptanceAliases: ["AC-1"],
					records: [
						{
							role: "toolResult",
							toolCallId: "room-full-auto-child-patch",
							toolName: "bash",
							isError: false,
						},
					],
					evidenceRef: "child:patch",
				}),
			),
		)[0];
		expect(childTest).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-test",
			arguments: { command: "/usr/bin/python3 -m unittest -v" },
		});

		const childCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(childTask, childTools, {
					history: [
						childStateHistory,
						'"id":"room-full-auto-child-read"',
						'"id":"room-full-auto-child-patch"',
						'"id":"room-full-auto-child-test"',
					].join(" "),
					participants,
					acceptanceAliases: ["AC-1"],
					records: [
						{
							role: "toolResult",
							toolCallId: "room-full-auto-child-patch",
							toolName: "bash",
							isError: false,
						},
					],
					exitCode: 0,
					evidenceRef: "execution:invoke:room-full-auto-child-test",
				}),
			),
		)[0];
		expect(childCommit).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-child-commit",
			arguments: {
				decision: "deliver",
				evidence: [
					{
						acceptance: "AC-1",
						refs: ["execution:invoke:room-full-auto-child-test"],
					},
				],
			},
		});

		const integrationTask = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-INTEGRATION",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 有界实现",
			"- AC-2 | 待验收 | 集成验证",
		].join("\n");
		const integrationTools = ["room_state", "room_integrate", "read", "bash", "room_commit"];
		const integrationBase = {
			participants,
			acceptanceAliases: ["AC-1", "AC-2"],
			childTaskId: "task:room-full-auto-child",
			pendingIntegrations: [{ childTaskId: "task:room-full-auto-child" }],
		};
		const integrationState = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, integrationTools, {
					...integrationBase,
					history: '"id":"room-full-auto-alignment-wait-child"',
				}),
			),
		)[0];
		expect(integrationState).toMatchObject({
			name: "room_state",
			id: "room-full-auto-integration-state",
		});

		const integrate = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, integrationTools, {
					...integrationBase,
					history: '"id":"room-full-auto-alignment-wait-child" ' + '"id":"room-full-auto-integration-state"',
				}),
			),
		)[0];
		expect(integrate).toMatchObject({
			name: "room_integrate",
			id: "room-full-auto-integration-integrate",
			arguments: { childTaskId: "task:room-full-auto-child" },
		});

		const integratedState = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, integrationTools, {
					...integrationBase,
					history: [
						'"id":"room-full-auto-alignment-wait-child"',
						'"id":"room-full-auto-integration-state"',
						'"id":"room-full-auto-integration-integrate"',
					].join(" "),
				}),
			),
		)[0];
		expect(integratedState).toMatchObject({
			name: "room_state",
			id: "room-full-auto-integration-integrated-state",
		});

		const integratedRead = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, [...integrationTools, ...nativeCodingTools], {
					...integrationBase,
					history: [
						'"id":"room-full-auto-alignment-wait-child"',
						'"id":"room-full-auto-integration-state"',
						'"id":"room-full-auto-integration-integrate"',
						'"id":"room-full-auto-integration-integrated-state"',
					].join(" "),
				}),
			),
		);
		expect(integratedRead).toEqual([
			expect.objectContaining({ name: "read", id: "room-full-auto-integration-read-integrated-a" }),
			expect.objectContaining({ name: "read", id: "room-full-auto-integration-read-integrated-b" }),
			expect.objectContaining({ name: "read", id: "room-full-auto-integration-read-integrated-c" }),
		]);

		const integratedTest = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, [...integrationTools, ...nativeCodingTools], {
					...integrationBase,
					history: [
						'"id":"room-full-auto-alignment-wait-child"',
						'"id":"room-full-auto-integration-state"',
						'"id":"room-full-auto-integration-integrate"',
						'"id":"room-full-auto-integration-integrated-state"',
						'"id":"room-full-auto-integration-read-integrated-a"',
						'"id":"room-full-auto-integration-read-integrated-b"',
						'"id":"room-full-auto-integration-read-integrated-c"',
					].join(" "),
				}),
			),
		)[0];
		expect(integratedTest).toMatchObject({
			name: "bash",
			id: "room-full-auto-integration-integrated-shell",
		});

		const integrationCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, integrationTools, {
					...integrationBase,
					history: [
						'"id":"room-full-auto-alignment-wait-child"',
						'"id":"room-full-auto-integration-state"',
						'"id":"room-full-auto-integration-integrate"',
						'"id":"room-full-auto-integration-integrated-state"',
						'"id":"room-full-auto-integration-read-integrated-a"',
						'"id":"room-full-auto-integration-read-integrated-b"',
						'"id":"room-full-auto-integration-read-integrated-c"',
						'"id":"room-full-auto-integration-integrated-shell"',
					].join(" "),
					exitCode: 0,
					evidenceRef: "execution:invoke:room-full-auto-integration-integrated-shell",
				}),
			),
		)[0];
		expect(integrationCommit).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-integration-commit",
			arguments: {
				decision: "deliver",
				evidence: expect.arrayContaining([
					{
						acceptance: "AC-1",
						refs: ["execution:invoke:room-full-auto-integration-read-integrated-a"],
					},
				]),
			},
		});

		const reviewTask = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-REVIEW",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 独立检查实现",
			"- AC-2 | 待验收 | 复跑验证",
		].join("\n");
		const reviewTools = ["room_state", "read", "room_commit"];
		const reviewBase = {
			participants,
			records: [
				{
					schemaVersion: "wisdom-weasel.room-state-tool.v1",
					acceptanceAliases: [
						{ acceptance: "AC-1", evidenceRefs: ["implementation:verified"] },
						{ acceptance: "AC-2", evidenceRefs: ["implementation:verified"] },
					],
				},
			],
		};
		const reviewReadApp = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(reviewTask, reviewTools, {
					...reviewBase,
					history: '"id":"room-full-auto-review-state"',
				}),
			),
		);
		expect(reviewReadApp).toEqual([
			expect.objectContaining({ name: "read", id: "room-full-auto-review-read-app" }),
			expect.objectContaining({ name: "read", id: "room-full-auto-review-read-test" }),
			expect.objectContaining({ name: "read", id: "room-full-auto-review-read-contract" }),
		]);

		const reviewRead = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(reviewTask, reviewTools, {
					...reviewBase,
					history: [
						'"id":"room-full-auto-review-state"',
						'"id":"room-full-auto-review-read-app"',
						'"id":"room-full-auto-review-read-test"',
						'"id":"room-full-auto-review-read-contract"',
					].join(" "),
				}),
			),
		)[0];
		expect(reviewRead).toMatchObject({
			name: "read",
			id: "room-full-auto-review-review-read",
		});

		const reviewCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(reviewTask, reviewTools, {
					...reviewBase,
					history: [
						'"id":"room-full-auto-review-state"',
						'"id":"room-full-auto-review-read-app"',
						'"id":"room-full-auto-review-read-test"',
						'"id":"room-full-auto-review-read-contract"',
						'"id":"room-full-auto-review-review-read"',
					].join(" "),
					records: [...reviewBase.records, { evidenceRef: "execution:invoke:room-full-auto-review-review-read" }],
				}),
			),
		)[0];
		expect(reviewCommit).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-review-commit",
			arguments: {
				decision: "deliver",
				evidence: expect.arrayContaining([
					{ acceptance: "AC-1", refs: ["execution:invoke:room-full-auto-review-read-app"] },
				]),
				reviewFindings: [],
			},
		});
		const reviewStopsAfterCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(reviewTask, reviewTools, {
					...reviewBase,
					history: [
						'"id":"room-full-auto-review-state"',
						'"id":"room-full-auto-review-read-app"',
						'"id":"room-full-auto-review-read-test"',
						'"id":"room-full-auto-review-read-contract"',
						'"id":"room-full-auto-review-review-read"',
						'"id":"room-full-auto-review-commit"',
					].join(" "),
				}),
			),
		);
		expect(reviewStopsAfterCommit).toEqual([]);

		const finalTask = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-DELIVERY",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | Reporter 最终交付",
		].join("\n");
		const finalDelivery = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(finalTask, ["room_state", "room_commit"], {
					history: ['"id":"room-full-auto-review-commit"', '"id":"room-full-auto-await-review-state"'].join(" "),
					records: [
						{
							schemaVersion: "wisdom-weasel.room-state-tool.v1",
							acceptanceAliases: [{ acceptance: "AC-1", evidenceRefs: ["review:test"] }],
						},
						{ evidenceRef: "review:test" },
					],
				}),
			),
		)[0];
		expect(finalDelivery).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-await-review-deliver",
			arguments: {
				decision: "deliver",
				publicSummary: expect.stringContaining("独立复核"),
				evidence: [{ acceptance: "AC-1", refs: ["review:test"] }],
			},
		});
	});

	it("uses the current report projection instead of stale integration history", () => {
		const task = [
			"原始需求（不可改写）：",
			"- 写 TUI",
			"当前任务：",
			"- 目标：结合已经完成的工作、验收证据和复核结论，向用户给出最终回复。",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 唯一最终交付",
		].join("\n");
		const value = collaborationContext(task, ["room_state", "room_commit"], {
			history: '"id":"room-full-auto-integration-commit"',
			records: [
				{
					currentResponsibility: {
						taskKind: "work",
						planTaskKind: "integration",
					},
				},
			],
		});
		value.systemPrompt +=
			'\n<pi-context provider="paw.room-recovery">' +
			'{"authoritativeProjectionRef":{"taskId":"room-report-task:current"}}' +
			"</pi-context>";

		expect(calls(projectCollaborationCanaryResponse(value))).toEqual([
			expect.objectContaining({
				name: "room_state",
				id: "room-full-auto-await-review-state",
			}),
		]);
	});

	it("uses the current integration projection instead of stale alignment history", () => {
		const task = [
			"原始需求（不可改写）：",
			"- 写 TUI",
			"当前任务：",
			"- 目标：合入已完成的界面功能后，重新运行验证并核对共享结果。",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 集成实现结果",
		].join("\n");
		const participants = [
			{ participantRef: "P-A", capabilitySummary: "coordinator" },
			{ participantRef: "P-B", capabilitySummary: "implementer" },
			{ participantRef: "P-C", capabilitySummary: "reviewer" },
		];
		const oldAlignmentState = {
			currentResponsibility: {
				taskKind: "work",
				planTaskKind: "",
			},
		};
		const successfulDefinition = {
			role: "toolResult",
			toolCallId: "room-full-auto-alignment-define",
			toolName: "room_define",
			isError: false,
		};
		const history = [
			'"id":"room-full-auto-alignment-state"',
			'"id":"room-full-auto-alignment-define"',
			"先做一个最小可运行的终端界面：有清晰的标题、输入区和结果区；不用安装新依赖，启动后能直接使用。",
			"优先保证键盘操作、状态反馈和基本错误提示，先不加入网络同步或复杂主题。",
			"交付时保留现有项目约定，只改实现所需内容，并给出可复现的验证结果。",
		].join(" ");
		const currentProjection = (records: Record<string, unknown>[], currentHistory = history): Context => {
			const value = collaborationContext(task, ["room_state", "room_define", "room_integrate"], {
				history: currentHistory,
				participants,
				acceptanceAliases: ["AC-1"],
				records,
			});
			value.systemPrompt +=
				'\n<pi-context provider="paw.room-recovery">' +
				'{"authoritativeProjectionRef":{"taskId":"room-task:integration:current"}}' +
				"</pi-context>";
			return value;
		};

		expect(
			calls(projectCollaborationCanaryResponse(currentProjection([oldAlignmentState, successfulDefinition]))),
		).toEqual([
			expect.objectContaining({
				name: "room_state",
				id: "room-full-auto-integration-state",
			}),
		]);

		const integrationState = {
			currentResponsibility: {
				taskKind: "work",
				planTaskKind: "integration",
			},
			childTaskId: "room-task:feature:delivered",
		};
		const afterState = currentProjection(
			[oldAlignmentState, successfulDefinition, integrationState],
			`${history} "id":"room-full-auto-integration-state"`,
		);
		expect(calls(projectCollaborationCanaryResponse(afterState))).toEqual([
			expect.objectContaining({
				name: "room_integrate",
				id: "room-full-auto-integration-integrate",
				arguments: { childTaskId: "room-task:feature:delivered" },
			}),
		]);
	});

	it("binds every implementation acceptance item to its own verification receipt", () => {
		const participants = [
			{ participantRef: "P-A", capabilitySummary: "coordinator" },
			{ participantRef: "P-B", capabilitySummary: "implementer" },
			{ participantRef: "P-C", capabilitySummary: "reviewer" },
		];
		const task = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-CHILD",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 基础行为",
			"- AC-2 | 待验收 | 边界行为",
			"- AC-3 | 待验收 | 空输入行为",
			"- AC-4 | 待验收 | 完整回归",
		].join("\n");
		const tools = ["room_state", "read", "bash", "room_commit"];
		const base = {
			participants,
			acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
			records: [
				{
					role: "toolResult",
					toolCallId: "room-full-auto-child-patch",
					toolName: "bash",
					isError: false,
				},
			],
			exitCode: 0,
		};
		const prefix = [
			'"id":"room-full-auto-child-state"',
			'"id":"room-full-auto-child-read"',
			'"id":"room-full-auto-child-patch"',
		];
		const responseFor = (history: string[]) =>
			calls(
				projectCollaborationCanaryResponse(
					collaborationContext(task, tools, { ...base, history: history.join(" ") }),
				),
			)[0];

		expect(responseFor(prefix)).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-test",
			arguments: { command: "/usr/bin/python3 -m unittest -v" },
		});
		expect(() =>
			projectCollaborationCanaryResponse(
				collaborationContext(task, tools, {
					...base,
					history: [...prefix, '"id":"room-full-auto-child-test"'].join(" "),
					records: [
						{
							role: "toolResult",
							toolCallId: "room-full-auto-child-patch",
							toolName: "bash",
							isError: false,
						},
						{
							executionReceiptId: "execution:invoke:session-child:dispatch-child:room-full-auto-child-test",
							status: "failed",
						},
					],
				}),
			),
		).toThrow("implementation child verification failed");
		expect(responseFor([...prefix, '"id":"room-full-auto-child-test"'])).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-verify-2",
			arguments: { command: "/usr/bin/python3 -m unittest -v" },
		});
		expect(
			responseFor([...prefix, '"id":"room-full-auto-child-test"', '"id":"room-full-auto-child-verify-2"']),
		).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-verify-3",
			arguments: { command: "/usr/bin/python3 -m unittest -v" },
		});
		expect(
			responseFor([
				...prefix,
				'"id":"room-full-auto-child-test"',
				'"id":"room-full-auto-child-verify-2"',
				'"id":"room-full-auto-child-verify-3"',
			]),
		).toMatchObject({
			name: "bash",
			id: "room-full-auto-child-verify-4",
			arguments: { command: "/usr/bin/python3 -m unittest -v" },
		});

		const commit = responseFor([
			...prefix,
			'"id":"room-full-auto-child-test"',
			'"id":"room-full-auto-child-verify-2"',
			'"id":"room-full-auto-child-verify-3"',
			'"id":"room-full-auto-child-verify-4"',
		]);
		expect(commit).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-child-commit",
			arguments: {
				decision: "deliver",
				evidence: [
					{ acceptance: "AC-1", refs: ["execution:invoke:room-full-auto-child-test"] },
					{ acceptance: "AC-2", refs: ["execution:invoke:room-full-auto-child-verify-2"] },
					{ acceptance: "AC-3", refs: ["execution:invoke:room-full-auto-child-verify-3"] },
					{ acceptance: "AC-4", refs: ["execution:invoke:room-full-auto-child-verify-4"] },
				],
			},
		});

		const repairHistory = [
			...prefix,
			'"id":"room-full-auto-child-test"',
			'"id":"room-full-auto-child-verify-2"',
			'"id":"room-full-auto-child-verify-3"',
			'"id":"room-full-auto-child-verify-4"',
			'"id":"room-full-auto-child-commit"',
			'<room-work-follow-up source="system" kind="repair_commit">重新提交验收证据。</room-work-follow-up>',
		];
		const receiptRecords = [
			{
				role: "toolResult",
				toolCallId: "room-full-auto-child-patch",
				toolName: "bash",
				isError: false,
			},
			{
				evidenceRef: "execution:invoke:session-child:dispatch-child:room-full-auto-child-verify-4",
			},
		];
		const repairedState = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(task, tools, {
					...base,
					history: repairHistory.join(" "),
					records: receiptRecords,
				}),
			),
		)[0];
		expect(repairedState).toMatchObject({
			name: "room_state",
			id: "room-full-auto-child-repair-state",
		});
		const repairedCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(task, tools, {
					...base,
					history: [...repairHistory, '"id":"room-full-auto-child-repair-state"'].join(" "),
					records: receiptRecords,
				}),
			),
		)[0];
		expect(repairedCommit).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-child-repair-commit",
			arguments: {
				evidence: [
					{
						acceptance: "AC-1",
						refs: ["execution:invoke:session-child:dispatch-child:room-full-auto-child-test"],
					},
					{
						acceptance: "AC-2",
						refs: ["execution:invoke:session-child:dispatch-child:room-full-auto-child-verify-2"],
					},
					{
						acceptance: "AC-3",
						refs: ["execution:invoke:session-child:dispatch-child:room-full-auto-child-verify-3"],
					},
					{
						acceptance: "AC-4",
						refs: ["execution:invoke:session-child:dispatch-child:room-full-auto-child-verify-4"],
					},
				],
			},
		});
	});

	it("retries a rejected Room definition instead of advancing to workspace work", () => {
		const participants = [
			{ participantRef: "P-A", capabilitySummary: "coordinator" },
			{ participantRef: "P-B", capabilitySummary: "implementer" },
			{ participantRef: "P-C", capabilitySummary: "reviewer" },
		];
		const alignmentTask = [
			"原始需求（不可改写）：",
			"- 写 TUI",
			"当前任务：",
			"- 目标：写 TUI",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 完成需求对齐",
		].join("\n");
		const answers = [
			"先做一个最小可运行的终端界面：有清晰的标题、输入区和结果区；不用安装新依赖，启动后能直接使用。",
			"优先保证键盘操作、状态反馈和基本错误提示，先不加入网络同步或复杂主题。",
			"交付时保留现有项目约定，只改实现所需内容，并给出可复现的验证结果。",
		].join(" ");
		const rejectedDefinitionResponse = projectCollaborationCanaryResponse(
			collaborationContext(alignmentTask, ["room_state", "room_define"], {
				history:
					answers +
					' "id":"room-full-auto-alignment-state" ' +
					'"id":"room-full-auto-alignment-definition-state" ' +
					'"id":"room-full-auto-alignment-define" ' +
					'"id":"room-full-auto-alignment-defined-state"',
				participants,
				definitionRequirements: [
					{ requirementRef: "requirement:tui", statement: "写 TUI" },
					{ requirementRef: "requirement:layout", statement: "显示标题、输入区和结果区" },
					{ requirementRef: "requirement:feedback", statement: "提供键盘操作、状态与错误反馈" },
					{ requirementRef: "requirement:verification", statement: "提供可重复执行的验证结果" },
				],
				records: [
					{
						role: "toolResult",
						toolCallId: "room-full-auto-alignment-define",
						toolName: "room_define",
						isError: true,
					},
				],
			}),
		);

		expect(calls(rejectedDefinitionResponse)).toEqual([
			expect.objectContaining({
				name: "room_state",
				id: "room-full-auto-alignment-definition-retry-state",
			}),
		]);

		const retriedDefinition = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(alignmentTask, ["room_state", "room_define"], {
					history:
						answers +
						' "id":"room-full-auto-alignment-state" ' +
						'"id":"room-full-auto-alignment-definition-state" ' +
						'"id":"room-full-auto-alignment-define" ' +
						'"id":"room-full-auto-alignment-definition-retry-state"',
					participants,
					definitionRequirements: [
						{ requirementRef: "requirement:tui", statement: "写 TUI" },
						{ requirementRef: "requirement:layout", statement: "显示标题、输入区和结果区" },
						{ requirementRef: "requirement:feedback", statement: "提供键盘操作、状态与错误反馈" },
						{ requirementRef: "requirement:verification", statement: "提供可重复执行的验证结果" },
					],
					records: [
						{
							role: "toolResult",
							toolCallId: "room-full-auto-alignment-define",
							toolName: "room_define",
							isError: true,
						},
					],
				}),
			),
		)[0];
		expect(retriedDefinition).toMatchObject({
			name: "room_define",
			id: "room-full-auto-alignment-define",
			arguments: expect.objectContaining({
				entrySurface: expect.any(String),
				primaryInteraction: expect.any(String),
				observableCompletion: expect.any(String),
				executionPlan: expect.any(Object),
				independentReviewRequired: true,
			}),
		});
	});

	it("summarizes and recovers an ordinary Agent Session without tools", () => {
		const summary = agentSessionCanaryResponse(
			agentContext(
				[],
				"This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.",
				"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.",
			),
		);
		expect(summary.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("AGENT-SESSION-RESILIENCE completed") }),
		]);

		const recovered = agentSessionCanaryResponse(agentContext([], "压缩恢复检查 AGENT-SESSION-RECOVERY-OK"));
		expect(recovered.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("AGENT-SESSION-RECOVERY-OK") }),
		]);
	});
});
