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

const nativeCodingTools = ["read", "grep", "find", "ls", "edit", "write", "bash"];

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

function projectContext(tools: string[], history = "", marker = "PROJECT-TASK-CANARY"): Context {
	return {
		systemPrompt: projectTaskPrompt.replaceAll("PROJECT-TASK-CANARY", marker),
		messages: history ? ([{ role: "user", content: history, timestamp: 1 }] as Context["messages"]) : [],
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
			expect.objectContaining({ name: "edit", id: "project-patch" }),
		]);

		const patched = JSON.stringify({ history: `${inspected} project-patch`, mutationApplied: true });
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, patched)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-test" }),
		]);

		const tested = JSON.stringify({
			history: `${patched} project-test`,
			mutationApplied: true,
			exitCode: 0,
		});
		const roomTools = [...discoveryTools, "room_post", "room_commit"];
		expect(calls(projectTaskCanaryResponse(projectContext(roomTools, tested)))).toEqual([
			expect.objectContaining({ name: "room_post", id: "project-post" }),
		]);
		const commit = calls(
			projectTaskCanaryResponse(
				projectContext(
					roomTools,
					JSON.stringify({
						history: `${tested} project-post`,
						mutationApplied: true,
						exitCode: 0,
					}),
				),
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
		expect(repair).toEqual([expect.objectContaining({ name: "edit", id: "project-patch" })]);
		expect(repair.some((call) => call.id === "project-missing-read")).toBe(false);

		const patched = JSON.stringify({
			history: `${failedBaseline} "id":"project-patch"`,
			mutationApplied: true,
			exitCode: 1,
		});
		expect(calls(projectTaskCanaryResponse(projectContext(tools, patched, recoveryMarker)))).toEqual([
			expect.objectContaining({ name: "bash", id: "project-test" }),
		]);
	});

	it("drives an ordinary Agent Session through progressive discovery and planning", () => {
		expect(calls(agentSessionCanaryResponse(agentContext(["skill_load", ...nativeCodingTools])))).toEqual([
			expect.objectContaining({ name: "skill_load", arguments: { name: "test-driven-implementation" } }),
		]);

		const loadedSkill = '<loaded_skill name="test-driven-implementation">';
		const readTool = ["tool_load", ...nativeCodingTools];
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, loadedSkill)))).toEqual([
			expect.objectContaining({ name: "read", id: "agent-missing-read" }),
		]);

		const afterMissing = `${loadedSkill} "id":"agent-missing-read"`;
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, afterMissing)))).toEqual([
			expect.objectContaining({ name: "ls", id: "agent-list" }),
		]);

		const planHistory = [
			afterMissing,
			'"id":"agent-list"',
			'"id":"agent-search"',
			'"id":"agent-read-app"',
			'"id":"agent-plan-baseline"',
			'"id":"agent-plan-patch"',
			'"id":"agent-plan-regression"',
		].join(" ");
		const planTools = ["tool_load", ...nativeCodingTools, "agent_plan"];
		expect(calls(agentSessionCanaryResponse(agentContext(planTools, `${loadedSkill} ${planHistory}`)))).toEqual([
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
						planTools,
						{
							history: planHistory,
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
					agentReceiptContext(planTools, completeBoundaryReceipt(planHistory), loadedSkill),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-review",
				arguments: { op: "submit_review", note: expect.any(String) },
			}),
		]);

		const firstPlanItem = calls(
			agentSessionCanaryResponse(
				agentReceiptContext(
					planTools,
					completeBoundaryReceipt(`${afterMissing} "id":"agent-list" "id":"agent-search" "id":"agent-read-app"`),
					loadedSkill,
				),
			),
		)[0];
		expect(firstPlanItem).toMatchObject({
			name: "agent_plan",
			id: "agent-plan-baseline",
			arguments: {
				op: "update",
				itemId: "agent-plan-item-baseline",
				status: "pending",
			},
		});
	});

	it("completes every ordinary Agent plan item before final delivery", () => {
		const loadedSkill = '<loaded_skill name="test-driven-implementation">';
		const baseHistory = [
			loadedSkill,
			'"id":"agent-missing-read"',
			'"id":"agent-list"',
			'"id":"agent-search"',
			'"id":"agent-read-app"',
			'"id":"agent-plan-baseline"',
			'"id":"agent-plan-patch"',
			'"id":"agent-plan-regression"',
			'"id":"agent-plan-review"',
			"原生控制中心已经批准当前执行计划",
			'"id":"agent-baseline-shell"',
		].join(" ");
		const shellTools = ["tool_load", ...nativeCodingTools, "agent_plan"];
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext(shellTools, completeBoundaryReceipt(baseHistory), loadedSkill),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-baseline-done",
				arguments: {
					op: "update",
					itemId: "agent-plan-item-baseline",
					status: "completed",
				},
			}),
		]);

		const patchedReceipt = {
			...completeBoundaryReceipt(`${baseHistory} "id":"agent-plan-baseline-done" "id":"agent-patch"`),
			mutationApplied: true,
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, patchedReceipt, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-patch-done",
				arguments: {
					op: "update",
					itemId: "agent-plan-item-patch",
					status: "completed",
				},
			}),
		]);

		const testedReceipt = {
			...completeBoundaryReceipt(
				`${JSON.stringify(patchedReceipt)} "id":"agent-plan-patch-done" "id":"agent-regression-shell"`,
			),
			mutationApplied: true,
			exitCode: 0,
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, testedReceipt, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-regression-done",
				arguments: {
					op: "update",
					itemId: "agent-plan-item-regression",
					status: "completed",
				},
			}),
		]);

		const completedItems = {
			...completeBoundaryReceipt(`${JSON.stringify(testedReceipt)} "id":"agent-plan-regression-done"`),
			mutationApplied: true,
			exitCode: 0,
		};
		expect(calls(agentSessionCanaryResponse(agentReceiptContext(shellTools, completedItems, loadedSkill)))).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-complete",
				arguments: expect.objectContaining({ op: "complete" }),
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
				question: expect.stringContaining("最小版本"),
				resumeCondition: expect.any(String),
				publicSummary: expect.any(String),
			},
		});

		const answers = [
			"先做一个最小可运行的终端界面：有清晰的标题、输入区和结果区；不用安装新依赖，启动后能直接使用。",
			"优先保证键盘操作、状态反馈和基本错误提示，先不加入网络同步或复杂主题。",
			"交付时保留现有项目约定，只改实现所需内容，并给出可复现的验证结果。",
		].join(" ");
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
		const definition = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(alignmentTask, ["room_state", "room_define"], {
					history:
						`${alignedHistory} "id":"room-full-auto-alignment-search-define" ` +
						'"id":"room-full-auto-alignment-load-define"',
					participants,
				}),
			),
		)[0];
		expect(definition).toMatchObject({
			name: "room_define",
			id: "room-full-auto-alignment-define",
			arguments: {
				implementationParticipantRef: "P-B",
				requirements: expect.arrayContaining([expect.stringContaining("键盘操作")]),
				acceptanceCriteria: expect.arrayContaining([
					expect.objectContaining({ fullNameZh: "启动后显示并可使用最小界面" }),
				]),
			},
		});
		const alignmentDefinedHistory = `${alignedHistory} "id":"room-full-auto-alignment-define" "id":"room-full-auto-alignment-defined-state"`;
		const alignmentEvidenceReads = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					alignmentTask,
					["room_state", "room_define", "room_collaborate", ...nativeCodingTools],
					{
						history: alignmentDefinedHistory,
						participants,
						acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
						evidenceRef: "definition:receipt",
					},
				),
			),
		);
		expect(alignmentEvidenceReads.map((call) => call.id)).toEqual([
			"room-full-auto-alignment-evidence-read-a",
			"room-full-auto-alignment-evidence-read-b",
			"room-full-auto-alignment-evidence-read-c",
			"room-full-auto-alignment-evidence-read-d",
		]);
		const alignmentEvidenceHistory = `${alignmentDefinedHistory} ${alignmentEvidenceReads.map((call) => `"id":"${call.id}"`).join(" ")}`;
		const alignmentCollaborate = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					alignmentTask,
					["room_state", "room_define", "room_collaborate", ...nativeCodingTools],
					{
						history: alignmentEvidenceHistory,
						participants,
						acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
						evidenceRef: "definition:receipt",
					},
				),
			),
		)[0];
		expect(alignmentCollaborate).toMatchObject({
			name: "room_collaborate",
			id: "room-full-auto-alignment-collaborate",
			arguments: {
				targetParticipantRef: "P-B",
				intent: "execute",
				workspacePolicy: "isolated_writable",
				acceptance: ["AC-1"],
			},
		});
		const alignmentWait = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					alignmentTask,
					["room_state", "room_define", "room_collaborate", "room_commit", ...nativeCodingTools],
					{
						history: `${alignmentEvidenceHistory} "id":"room-full-auto-alignment-collaborate"`,
						participants,
						acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
						evidenceRef: "definition:receipt",
					},
				),
			),
		)[0];
		expect(alignmentWait).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-alignment-wait-child",
			arguments: {
				decision: "wait",
				waitingFor: "participant",
				waitingForParticipantRef: "P-B",
				resumeCondition: expect.any(String),
				evidence: [
					{
						acceptance: "AC-1",
						refs: ["execution:invoke:room-full-auto-alignment-evidence-read-a"],
					},
					{
						acceptance: "AC-2",
						refs: ["execution:invoke:room-full-auto-alignment-evidence-read-b"],
					},
					{
						acceptance: "AC-3",
						refs: ["execution:invoke:room-full-auto-alignment-evidence-read-c"],
					},
					{
						acceptance: "AC-4",
						refs: ["execution:invoke:room-full-auto-alignment-evidence-read-d"],
					},
				],
			},
		});
		const alignmentStopsForChild = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					alignmentTask,
					["room_state", "room_define", "room_collaborate", "room_commit", ...nativeCodingTools],
					{
						history:
							`${alignmentEvidenceHistory} ` +
							'"id":"room-full-auto-alignment-collaborate" ' +
							'"id":"room-full-auto-alignment-wait-child"',
						participants,
						acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
						pendingIntegrations: [],
					},
				),
			),
		);
		expect(alignmentStopsForChild).toEqual([]);
		const resumedIntegrationState = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(alignmentTask, ["room_state", "room_integrate"], {
					history:
						`${alignmentEvidenceHistory} ` +
						'"id":"room-full-auto-alignment-collaborate" ' +
						'"id":"room-full-auto-alignment-wait-child" 这是恢复轮次',
					participants,
					acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4"],
					childTaskId: "task:room-full-auto-child",
					pendingIntegrations: [],
				}),
			),
		)[0];
		expect(resumedIntegrationState).toMatchObject({
			name: "room_state",
			id: "room-full-auto-integration-state",
		});

		const childTask = [
			"当前任务：",
			"- 目标：ROOM-FULL-AUTO-CHILD",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | 有界实现",
		].join("\n");
		const childTools = ["room_state", "read", "edit", "bash", "room_commit"];
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
			name: "edit",
			id: "room-full-auto-child-patch",
			arguments: { path: "calculator.py" },
		});

		const childTest = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(childTask, childTools, {
					history: `${childStateHistory} "id":"room-full-auto-child-read" "id":"room-full-auto-child-patch"`,
					participants,
					acceptanceAliases: ["AC-1"],
					mutationApplied: true,
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
					mutationApplied: true,
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

		const integrationHandoffReview = calls(
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
		expect(integrationHandoffReview).toMatchObject({
			name: "room_commit",
			id: "room-full-auto-integration-handoff-review",
			arguments: {
				decision: "handoff",
				targetParticipantRef: "P-C",
				intent: "review",
				evidence: expect.arrayContaining([
					{
						acceptance: "AC-1",
						refs: ["execution:invoke:room-full-auto-integration-read-integrated-a"],
					},
				]),
			},
		});
		const integrationStopsAfterHandoff = calls(
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
						'"id":"room-full-auto-integration-handoff-review"',
					].join(" "),
				}),
			),
		);
		expect(integrationStopsAfterHandoff).toEqual([]);
		const resumedAfterReviewHandoff = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(integrationTask, integrationTools, {
					...integrationBase,
					history: [
						'"id":"room-full-auto-alignment-wait-child"',
						'"id":"room-full-auto-integration-handoff-review"',
						"这是恢复轮次",
					].join(" "),
				}),
			),
		)[0];
		expect(resumedAfterReviewHandoff).toMatchObject({
			name: "room_state",
			id: "room-full-auto-await-review-state",
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
					history: [
						'"id":"room-full-auto-integration-handoff-review"',
						'"id":"room-full-auto-review-commit"',
						'"id":"room-full-auto-await-review-state"',
					].join(" "),
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

	it("summarizes and recovers an ordinary Agent Session without tools", () => {
		const summary = agentSessionCanaryResponse(
			agentContext(
				[],
				"The messages above are a conversation to summarize. Create a structured context checkpoint summary.",
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
