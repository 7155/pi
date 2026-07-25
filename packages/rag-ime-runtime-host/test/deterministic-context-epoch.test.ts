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

function projectContext(tools: string[], history = ""): Context {
	return {
		systemPrompt: projectTaskPrompt,
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
				role: "user",
				content: JSON.stringify(receipt),
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
		offset: 1024,
		nextOffset: 2048,
		byteSize: 2048,
		contentBytes: 1024,
		contentLines: 20,
		modelResultLimitBytes: 50 * 1024,
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
	it("loads, reads, publishes and commits through progressive Tool stages", () => {
		expect(calls(contextEpochCanaryResponse(context(["tool_load"])))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_read" } }),
		]);

		expect(calls(contextEpochCanaryResponse(context(["tool_load", "workspace_read"])))).toEqual([
			expect.objectContaining({ name: "workspace_read", id: "epoch-2-read-a" }),
			expect.objectContaining({ name: "workspace_read", id: "epoch-2-read-b" }),
		]);

		const readHistory = '"id":"epoch-2-read-a"';
		expect(calls(contextEpochCanaryResponse(context(["tool_load", "workspace_read"], readHistory)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "room_post" } }),
			expect.objectContaining({ name: "tool_load", arguments: { name: "room_commit" } }),
		]);

		const roomTools = ["tool_load", "workspace_read", "room_post", "room_commit"];
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
		expect(calls(contextEpochCanaryResponse(messageContext(["tool_load"])))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_read" } }),
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
			tools: ["tool_load", "workspace_read", "room_post", "room_commit"].map(tool),
		} as Context;
		expect(() => contextEpochCanaryResponse(legacyContext)).toThrow("requires explicit AC aliases");
	});

	it("drives a real project through discovery, approved patch, test and settle", () => {
		expect(calls(projectTaskCanaryResponse(projectContext(["tool_load"])))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_list" } }),
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_search" } }),
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_read" } }),
		]);

		const discoveryTools = ["tool_load", "workspace_list", "workspace_search", "workspace_read"];
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools)))).toEqual([
			expect.objectContaining({ name: "workspace_list", id: "project-list" }),
		]);
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, '"id":"project-list"')))).toEqual([
			expect.objectContaining({ name: "workspace_search", id: "project-search" }),
		]);

		const inspected = '"id":"project-list" "id":"project-search" "id":"project-read-app"';
		expect(calls(projectTaskCanaryResponse(projectContext(discoveryTools, inspected)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_patch" } }),
		]);

		const patchTools = [...discoveryTools, "workspace_patch"];
		expect(calls(projectTaskCanaryResponse(projectContext(patchTools, inspected)))).toEqual([
			expect.objectContaining({ name: "workspace_patch", id: "project-patch" }),
		]);

		const patched = JSON.stringify({ history: `${inspected} project-patch`, mutationApplied: true });
		expect(calls(projectTaskCanaryResponse(projectContext(patchTools, patched)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_shell" } }),
		]);

		const shellTools = [...patchTools, "workspace_shell"];
		expect(calls(projectTaskCanaryResponse(projectContext(shellTools, patched)))).toEqual([
			expect.objectContaining({ name: "workspace_shell", id: "project-test" }),
		]);

		const tested = JSON.stringify({
			history: `${patched} project-test`,
			mutationApplied: true,
			exitCode: 0,
		});
		const roomTools = [...shellTools, "room_post", "room_commit"];
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

	it("drives an ordinary Agent Session through progressive discovery and planning", () => {
		expect(calls(agentSessionCanaryResponse(agentContext(["skill_load"])))).toEqual([
			expect.objectContaining({ name: "skill_load", arguments: { name: "test-driven-implementation" } }),
		]);

		const loadedSkill = '<loaded_skill name="test-driven-implementation">';
		expect(calls(agentSessionCanaryResponse(agentContext(["tool_load"], loadedSkill)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_read" } }),
		]);

		const readTool = ["tool_load", "workspace_read"];
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, loadedSkill)))).toEqual([
			expect.objectContaining({ name: "workspace_read", id: "agent-missing-read" }),
		]);

		const afterMissing = `${loadedSkill} "id":"agent-missing-read"`;
		expect(calls(agentSessionCanaryResponse(agentContext(readTool, afterMissing)))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_list" } }),
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_search" } }),
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
		const planTools = ["tool_load", "workspace_read", "workspace_list", "workspace_search", "agent_plan"];
		expect(calls(agentSessionCanaryResponse(agentContext(planTools, `${loadedSkill} ${planHistory}`)))).toEqual([
			expect.objectContaining({
				name: "workspace_read",
				id: "agent-read-boundary-0",
				arguments: expect.objectContaining({
					path: "read-boundary.txt",
					offset: 0,
					limit: 65_536,
				}),
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
		const shellTools = [
			"tool_load",
			"workspace_read",
			"workspace_list",
			"workspace_search",
			"agent_plan",
			"workspace_shell",
		];
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
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext([...shellTools, "workspace_patch"], patchedReceipt, loadedSkill),
				),
			),
		).toEqual([
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
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext([...shellTools, "workspace_patch"], testedReceipt, loadedSkill),
				),
			),
		).toEqual([
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
		expect(
			calls(
				agentSessionCanaryResponse(
					agentReceiptContext([...shellTools, "workspace_patch"], completedItems, loadedSkill),
				),
			),
		).toEqual([
			expect.objectContaining({
				name: "agent_plan",
				id: "agent-plan-complete",
				arguments: expect.objectContaining({ op: "complete" }),
			}),
		]);
	});

	it("routes the deterministic three-member task through collaboration and formal handoff", () => {
		const aTask = [
			"原始需求（不可改写）：",
			"COLLAB-B-REVIEWED",
			"COLLAB-C-ACCEPTED",
			"当前任务：",
			"目标：THREE-MEMBER-ROOM-CANARY",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | A 完成实现并交给 C 验收",
			"- AC-2 | 待验收 | A 完成基线测试",
			"- AC-3 | 待验收 | A 发布实现证据",
			"- AC-4 | 待验收 | B 完成只读复核",
			"- AC-5 | 待验收 | C 完成独立验收",
			"- AC-6 | 待验收 | C 关闭 Root",
		].join("\n");
		const roomState = {
			history: '"id":"collab-a-state"',
			participants: [
				{ participantRef: "P2", capabilitySummary: "reviewer" },
				{ participantRef: "P3", capabilitySummary: "coordinator" },
			],
		};
		const collaborate = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(aTask, ["tool_load", "room_state", "room_collaborate"], roomState),
			),
		)[0];
		expect(collaborate).toMatchObject({
			name: "room_collaborate",
			id: "collab-a-collaborate",
			arguments: {
				targetParticipantRef: "P2",
				intent: "review",
				acceptance: ["AC-4"],
			},
		});

		const aCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					aTask,
					[
						"tool_load",
						"room_state",
						"room_collaborate",
						"workspace_read",
						"workspace_list",
						"workspace_search",
						"workspace_shell",
						"workspace_patch",
						"room_post",
						"room_commit",
					],
					{
						history: [
							'"id":"collab-a-state"',
							'"id":"collab-a-collaborate"',
							'"id":"collab-a-missing-read"',
							'"id":"collab-a-list"',
							'"id":"collab-a-search"',
							'"id":"collab-a-read-app"',
							'"id":"collab-a-baseline-shell"',
							'"id":"collab-a-patch"',
							'"id":"collab-a-regression-shell"',
							'"id":"collab-a-post"',
						].join(" "),
						participants: roomState.participants,
						mutationApplied: true,
						evidenceRef: "execution:a",
					},
				),
			),
		)[0];
		expect(aCommit).toMatchObject({
			name: "room_commit",
			id: "collab-a-commit",
			arguments: {
				decision: "handoff",
				summary: "COLLAB-A-COMMIT-RESULT",
				evidence: [
					{ acceptance: "AC-1", refs: ["execution:a"] },
					{ acceptance: "AC-2", refs: ["execution:a"] },
					{ acceptance: "AC-3", refs: ["execution:a"] },
				],
				residualRisks: ["最终独立验收仍由 C 完成。"],
				targetParticipantRef: "P3",
				intent: "close",
				acceptanceAliases: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"],
			},
		});

		const bTask = [
			"原始需求（不可改写）：THREE-MEMBER-ROOM-CANARY，包含 AC-1 到 AC-6",
			"当前任务：",
			"目标：COLLAB-B-REVIEWED",
			"验收条件（提交证据时使用 AC 编号）：",
			"- AC-1 | 待验收 | B 完成只读复核",
		].join("\n");
		const bCommit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(bTask, ["tool_load", "room_state", "workspace_read", "room_post", "room_commit"], {
					history: [
						'"id":"collab-b-state"',
						'"id":"collab-b-read-app"',
						'"id":"collab-b-read-test"',
						'"id":"collab-b-post"',
					].join(" "),
					acceptanceAliases: [{ acceptance: "AC-1" }],
					evidenceRef: "execution:b",
				}),
			),
		)[0];
		expect(bCommit).toMatchObject({
			name: "room_commit",
			id: "collab-b-commit",
			arguments: {
				decision: "deliver",
				summary: "COLLAB-B-COMMIT-RESULT",
				evidence: [{ acceptance: "AC-1", refs: ["execution:b"] }],
				residualRisks: [],
			},
		});

		const cTask = [
			"原始需求（不可改写）：THREE-MEMBER-ROOM-CANARY",
			"当前任务：",
			"目标：COLLAB-C-ACCEPTED",
			"验收条件 acceptance.criteria",
			"- AC-1 | 待验收 | 独立读取实现",
			"- AC-2 | 待验收 | 独立运行测试",
		].join("\n");
		const commit = calls(
			projectCollaborationCanaryResponse(
				collaborationContext(
					cTask,
					["tool_load", "room_state", "workspace_read", "workspace_shell", "room_post", "room_commit"],
					{
						history: [
							'"id":"collab-c-state"',
							'"id":"collab-c-read-app"',
							'"id":"collab-c-acceptance-shell"',
							'"id":"collab-c-post"',
						].join(" "),
						evidenceRef: "execution:c",
					},
				),
			),
		)[0];
		expect(commit).toMatchObject({
			name: "room_commit",
			id: "collab-c-commit",
			arguments: {
				decision: "deliver",
				summary: "COLLAB-C-COMMIT-RESULT",
				evidence: [
					{ acceptance: "AC-1", refs: ["execution:c"] },
					{ acceptance: "AC-2", refs: ["execution:c"] },
				],
				residualRisks: [],
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
