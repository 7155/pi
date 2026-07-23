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
验收条件 acceptance.criteria（提交时原样使用 criterionId）：
- criterionId: "criterion:1" | 待验收 | 有界读取第一份源码
- criterionId: "criterion:2" | 待验收 | 有界读取第二份源码
- criterionId: "criterion:3" | 待验收 | 公开结果并提交
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
验收条件 acceptance.criteria（提交时原样使用 criterionId）：
- criterionId: "project:1" | 待验收 | 修改并测试
- criterionId: "project:2" | 待验收 | 公开结果并提交
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
				requirementCoverage: ["criterion:1", "criterion:2", "criterion:3"],
			},
		});
	});

	it("finds provider-only Room facts outside the stable system prompt", () => {
		expect(calls(contextEpochCanaryResponse(messageContext(["tool_load"])))).toEqual([
			expect.objectContaining({ name: "tool_load", arguments: { name: "workspace_read" } }),
		]);
	});

	it("keeps compatibility with an older JSON task projection without requiring it", () => {
		const legacyPrompt = `<room-fact kind="dispatch_state">${JSON.stringify({
			acceptance: { criteria: [{ criterionId: "legacy:1" }] },
			task: { expectedOutput: "CANARY-7-OK" },
		})}</room-fact>`;
		const legacyContext = {
			systemPrompt: legacyPrompt,
			messages: [{ role: "user", content: '"id":"epoch-7-read-a" "id":"epoch-7-post"', timestamp: 1 }],
			tools: ["tool_load", "workspace_read", "room_post", "room_commit"].map(tool),
		} as Context;
		const commit = calls(contextEpochCanaryResponse(legacyContext))[0];
		expect(commit).toMatchObject({
			name: "room_commit",
			arguments: { requirementCoverage: ["legacy:1"] },
		});
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
			arguments: { requirementCoverage: ["project:1", "project:2"] },
		});
	});

	it("drives an ordinary Agent Session through progressive discovery and planning", () => {
		expect(calls(agentSessionCanaryResponse(agentContext(["skill_load"])))).toEqual([
			expect.objectContaining({ name: "skill_load", arguments: { name: "room-test-driven-implementation" } }),
		]);

		const loadedSkill = '<loaded_skill name="room-test-driven-implementation">';
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
				name: "agent_plan",
				id: "agent-plan-review",
				arguments: { op: "submit_review", note: expect.any(String) },
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
			"验收条件 acceptance.criteria",
			'criterionId: "criterion:a"',
		].join("\n");
		const roomState = {
			history: '"id":"collab-a-state"',
			participants: [
				{ id: "participant:reviewer", collaborationRole: "reviewer" },
				{ id: "participant:coordinator", collaborationRole: "coordinator" },
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
				targetParticipantId: "participant:reviewer",
				intentKind: "review",
				acceptanceCriterionIds: [],
			},
		});

		const cTask = [
			"原始需求（不可改写）：THREE-MEMBER-ROOM-CANARY",
			"当前任务：",
			"目标：COLLAB-C-ACCEPTED",
			"验收条件 acceptance.criteria",
			'criterionId: "criterion:1"',
			'criterionId: "criterion:2"',
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
						executionReceiptId: "execution:c",
					},
				),
			),
		)[0];
		expect(commit).toMatchObject({
			name: "room_commit",
			id: "collab-c-commit",
			arguments: {
				decision: "deliver",
				result: "COLLAB-C-COMMIT-RESULT",
				requirementCoverage: ["criterion:1", "criterion:2"],
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
