import { type AgentTool, runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import {
	NestedToolCallRunner,
	type NestedToolExecutionEvent,
} from "../../../packages/coding-agent/src/core/nested-tool-calls.ts";
import { wrapToolDefinition } from "../../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { executeCodemode } from "../../../packages/coding-agent/src/extensions/codemode/execute.ts";
import { createAskExtension } from "../src/ask.ts";

describe("codemode PAW ask serialization", () => {
	it.each(["answer", "dismiss"] as const)(
		"waits for the actual question %s before running a parallel probe",
		async (completion) => {
			let answer!: (value: string | undefined) => void;
			const response = new Promise<string | undefined>((resolve) => {
				answer = resolve;
			});
			let questionPending = false;
			const probePendingStates: boolean[] = [];
			const tools: AgentTool[] = [];
			const extension = createAskExtension({
				requestQuestions: async () => {
					questionPending = true;
					try {
						return await response;
					} finally {
						questionPending = false;
					}
				},
			});
			await (typeof extension === "function" ? extension : extension.factory)({
				registerTool: (definition: ToolDefinition) => {
					tools.push(wrapToolDefinition(definition));
				},
			} as ExtensionAPI);
			tools.push({
				name: "probe",
				label: "Probe",
				description: "Observe the pending question",
				parameters: Type.Object({}),
				execute: async () => {
					probePendingStates.push(questionPending);
					return { content: [{ type: "text", text: "probe finished" }], details: {} };
				},
			});
			expect(tools[0].executionMode).toBe("sequential");
			const events: NestedToolExecutionEvent[] = [];
			const runner = new NestedToolCallRunner({
				getTools: () => tools,
				isSequential: () => false,
				emit: async (event) => {
					events.push(event);
				},
				runToolCall: (toolCall, _parentId, signal, onUpdate) =>
					runToolCall(toolCall, {
						tools,
						signal,
						onUpdate,
						assistantMessage: fauxAssistantMessage(""),
						context: { messages: [], tools },
					}),
			});
			const context = {
				tools,
				sessionManager: { getBranch: () => [] },
				executeTool: ((name, args, options) => runner.execute("script", name, args, options)) satisfies
					ExtensionToolContext["executeTool"],
			} as unknown as ExtensionToolContext;
			const controller = new AbortController();
			const execution = executeCodemode(
				"script",
				{
					code: `const results = await Promise.all([
				tools.ask({ questions: [{ id: "choice", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] }),
				tools.probe({})
			]); results.forEach(text);`,
				},
				controller.signal,
				undefined,
				context,
			);
			try {
				await expect
					.poll(
						() =>
							questionPending &&
							events.some((event) => event.type === "tool_execution_start" && event.toolName === "probe"),
					)
					.toBe(true);
				expect(probePendingStates).toEqual([]);
				answer(
					completion === "answer" ? JSON.stringify({ answers: { choice: { selected: ["Yes"] } } }) : undefined,
				);
				const result = await execution;
				expect(result.isError).not.toBe(true);
				expect(result.details.calls.map((call) => [call.id, call.status])).toEqual([
					["script/1", "ok"],
					["script/2", "ok"],
				]);
				expect(probePendingStates).toEqual([false]);
				await runner.drain("script");
				expect(runner.takeRecord("script")?.calls).toMatchObject({
					complete: true,
					calls: [
						{
							name: "ask",
							status: "ok",
							result: { details: { answered: completion === "answer", cancelled: completion === "dismiss" } },
						},
						{ name: "probe", status: "ok" },
					],
				});
			} finally {
				answer(undefined);
				controller.abort();
				await execution;
				await runner.drain("script");
			}
		},
	);
});
