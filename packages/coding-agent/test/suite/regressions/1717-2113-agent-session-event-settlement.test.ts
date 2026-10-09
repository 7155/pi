import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createEchoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

describe("regressions #1717/#2113: agent session event settlement", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("publishes one message_end with its persisted entry ID after one extension event", async () => {
		const extensionRoles: string[] = [];
		const observed: Array<{ role: string; entryId: unknown; persisted: boolean }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						extensionRoles.push(event.message.role);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const entryId = "entryId" in event ? event.entryId : undefined;
			observed.push({
				role: event.message.role,
				entryId,
				persisted: harness.sessionManager
					.getBranch()
					.some((entry) => entry.id === entryId && entry.type === "message" && entry.message === event.message),
			});
		});
		harness.setResponses([fauxAssistantMessage("same public answer")]);
		await harness.session.prompt("public input");
		expect(observed.map((event) => event.role)).toEqual(extensionRoles);
		expect(observed.filter((event) => event.role === "assistant")).toHaveLength(1);
		expect(observed.every((event) => typeof event.entryId === "string" && event.persisted)).toBe(true);
	});

	it("does not notify a completed message or invent an ID when persistence fails", async () => {
		const extensionMessages: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						extensionMessages.push(event.message);
					});
				},
			],
		});
		harnesses.push(harness);
		const message = fauxAssistantMessage("public fixture");
		const originalLeaf = harness.sessionManager.getLeafId();
		const append = vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation(() => {
			throw new Error("owned append failed");
		});
		const eventOwner = harness.session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: typeof message }): Promise<void>;
		};
		await expect(eventOwner._handleAgentEvent({ type: "message_end", message })).rejects.toThrow(
			"owned append failed",
		);
		expect(extensionMessages).toEqual([message]);
		expect(harness.eventsOfType("message_end")).toHaveLength(0);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		append.mockRestore();
	});

	it("keeps the original append failure visible through the existing run failure and settlement", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let rejectedOriginal = false;
		const append = vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
			if (message.role === "assistant" && !rejectedOriginal) {
				rejectedOriginal = true;
				throw new Error("owned original append failed");
			}
			return appendMessage(message);
		});
		harness.setResponses([fauxAssistantMessage("original must not notify completion")]);
		await harness.session.prompt("public failure boundary");
		const completed = harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		expect(completed).toHaveLength(1);
		expect(completed[0]?.message).toMatchObject({
			stopReason: "error",
			errorMessage: "owned original append failed",
		});
		expect(completed[0]?.entryId).toEqual(expect.any(String));
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
		append.mockRestore();
	});

	it("keeps persisted assistant/toolResult message order when extension message_end handlers yield", async () => {
		const harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" }), fauxToolCall("echo", { text: "two" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run tools");

		const branchMessages = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		expect(branchMessages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const assistantEntries = harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "assistant")
			.map((event) => event.entryId);
		expect(assistantEntries).toHaveLength(2);
		expect(new Set(assistantEntries).size).toBe(2);
		expect(assistantEntries.every((id) => typeof id === "string")).toBe(true);
		const firstToolResultIndex = branchMessages.findIndex((message) => message.role === "toolResult");
		expect(firstToolResultIndex).toBeGreaterThan(0);
		expect(branchMessages[firstToolResultIndex - 1]?.role).toBe("assistant");
	});

	it("runs tool_call handlers after the assistant tool-use message is settled in the session", async () => {
		let harness: Harness;
		const branchRolesAtToolCall: string[][] = [];
		harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						branchRolesAtToolCall.push(
							harness.sessionManager
								.getBranch()
								.filter((entry) => entry.type === "message")
								.map((entry) => entry.message.role),
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run tool");

		expect(branchRolesAtToolCall).toEqual([["system", "user", "assistant"]]);
	});
});
