import type { Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { contextEpochCanaryResponse } from "../src/deterministic-test-adapter.ts";

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

function calls(response: ReturnType<typeof contextEpochCanaryResponse>) {
	return response.content.filter((item) => item.type === "toolCall");
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
});
