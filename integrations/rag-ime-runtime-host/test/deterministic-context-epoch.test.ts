import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentSessionCanaryResponse, lightRoomCanaryResponse } from "../src/deterministic-test-adapter.ts";

const tool = (name: string): Tool => ({
	name,
	description: name,
	parameters: { type: "object" },
});

const nativeCodingTools = ["read", "grep", "find", "ls", "bash"];

function calls(response: AssistantMessage) {
	return response.content.filter((item) => item.type === "toolCall");
}

function roomToolResult(toolCallId: string, result: Record<string, unknown>): Context["messages"][number] {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "room_partner",
		content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }],
		details: { ok: true, result },
		isError: false,
		timestamp: 2,
	} as Context["messages"][number];
}

function lightRoomContext(results: Context["messages"] = [], includeTool = true): Context {
	return {
		systemPrompt: "LIGHT-ROOM-CANARY",
		messages: [{ role: "user", content: "Run LIGHT-ROOM-CANARY.", timestamp: 1 }, ...results] as Context["messages"],
		tools: includeTool ? [tool("room_partner")] : [],
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

describe("deterministic Session and light Room Provider", () => {
	it("uses only direct room_partner list, delegate, and result post before normal Session completion", () => {
		expect(calls(lightRoomCanaryResponse(lightRoomContext()))).toEqual([
			expect.objectContaining({ name: "room_partner", id: "light-room-list", arguments: { op: "list" } }),
		]);

		const listed = [
			roomToolResult("light-room-list", {
				operation: "list",
				partners: [{ participantId: "participant:partner", displayName: "伙伴" }],
			}),
		];
		expect(calls(lightRoomCanaryResponse(lightRoomContext(listed)))).toEqual([
			expect.objectContaining({
				name: "room_partner",
				id: "light-room-delegate",
				arguments: expect.objectContaining({
					op: "delegate",
					targetParticipantId: "participant:partner",
				}),
			}),
		]);

		const delegated = [
			...listed,
			roomToolResult("light-room-delegate", {
				operation: "delegate",
				status: "completed",
				content: "LIGHT-ROOM-PARTNER-OK",
			}),
		];
		expect(calls(lightRoomCanaryResponse(lightRoomContext(delegated)))).toEqual([
			expect.objectContaining({
				name: "room_partner",
				id: "light-room-post",
				arguments: expect.objectContaining({ op: "post", kind: "result" }),
			}),
		]);

		const posted = [
			...delegated,
			roomToolResult("light-room-post", {
				operation: "post",
				kind: "result",
				postId: "room-post:test",
			}),
		];
		expect(lightRoomCanaryResponse(lightRoomContext(posted)).content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("LIGHT-ROOM-CANARY-OK") }),
		]);
	});

	it("requires room_partner to be an already-active direct Room tool", () => {
		expect(() => lightRoomCanaryResponse(lightRoomContext([], false))).toThrow(
			"A Room-bound Session must expose the direct room_partner tool",
		);
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
				arguments: { path: "read-boundary.txt", offset: 1, limit: 1_000 },
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
				arguments: { op: "done", task: "运行失败基线测试" },
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
				arguments: { op: "done", task: "精确修改 normalize_scores" },
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
				arguments: expect.objectContaining({ op: "checkpoint", task: "运行回归测试并交付" }),
			}),
		]);
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
