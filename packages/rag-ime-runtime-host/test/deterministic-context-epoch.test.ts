import type { Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { contextEpochCanaryResponse, projectTaskCanaryResponse } from "../src/deterministic-test-adapter.ts";

const tool = (name: string): Tool => ({
	name,
	description: name,
	parameters: { type: "object" },
});

const taskPrompt = `<room-fact kind="dispatch_state">${JSON.stringify({
	acceptance: {
		criteria: [{ criterionId: "criterion:1" }, { criterionId: "criterion:2" }, { criterionId: "criterion:3" }],
	},
	task: { expectedOutput: "CANARY-2-OK" },
})}</room-fact>`;

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

const projectTaskPrompt = `<room-fact kind="dispatch_state">${JSON.stringify({
	acceptance: {
		criteria: [{ criterionId: "project:1" }, { criterionId: "project:2" }],
	},
	task: { objective: "PROJECT-TASK-CANARY" },
})}</room-fact>`;

function projectContext(tools: string[], history = ""): Context {
	return {
		systemPrompt: projectTaskPrompt,
		messages: history ? ([{ role: "user", content: history, timestamp: 1 }] as Context["messages"]) : [],
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
});
