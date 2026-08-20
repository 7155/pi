import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import sessionWorkflowExtension from "../pi-packages/session-workflow/index.ts";

type Handler = (...args: unknown[]) => unknown;

function harness(entries: Array<Record<string, unknown>> = []) {
	const commands = new Map<string, { handler: (args: string, context: never) => unknown }>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Handler>();
	const appended: Array<Record<string, unknown>> = [];
	const notifications: string[] = [];
	const context = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, value: string) => value },
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: (message: string) => notifications.push(message),
		},
		sessionManager: { getEntries: () => entries },
	};
	sessionWorkflowExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, context: never) => unknown }) {
			commands.set(name, command);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			appended.push(entry);
		},
	} as never);
	return { commands, tools, handlers, appended, notifications, context };
}

describe("Session Workflow Pi Package", () => {
	it("owns durable Goal, Plan and Todo state without injecting a persona", async () => {
		const test = harness();
		expect([...test.commands.keys()].sort()).toEqual(["goal", "plan", "todos", "workflow"]);
		expect([...test.tools.keys()]).toEqual(["session_workflow"]);

		await test.commands.get("goal")!.handler("Ship the optional Package", test.context as never);
		await test.commands.get("plan")!.handler("Inspect lifecycle; Implement state; Verify reload", test.context as never);
		const result = await test.tools.get("session_workflow")!.execute(
			"workflow-step",
			{ action: "set_step", step: 1, status: "completed" } as never,
			undefined,
			undefined,
			test.context as never,
		);
		expect(result.details).toMatchObject({
			goal: { objective: "Ship the optional Package", status: "active" },
			steps: [
				{ id: 1, text: "Inspect lifecycle", status: "completed" },
				{ id: 2, text: "Implement state", status: "pending" },
				{ id: 3, text: "Verify reload", status: "pending" },
			],
		});

		const beforeStart = await test.handlers.get("before_agent_start")!();
		expect(beforeStart).toMatchObject({
			message: { customType: "paw-session-workflow-context", display: false },
		});
		const contextText = (beforeStart as { message: { content: string } }).message.content;
		expect(contextText).toContain("[SESSION WORKFLOW]");
		expect(contextText).not.toMatch(/persona|澄·远/iu);
		expect(test.appended.length).toBeGreaterThanOrEqual(3);

		const restored = harness([...test.appended]);
		await restored.handlers.get("session_start")!(
			{ type: "session_start", reason: "startup" },
			restored.context,
		);
		await restored.commands.get("workflow")!.handler("", restored.context as never);
		expect(restored.notifications.at(-1)).toContain("Ship the optional Package");
		expect(restored.notifications.at(-1)).toContain("✓ Inspect lifecycle");
	});
});
