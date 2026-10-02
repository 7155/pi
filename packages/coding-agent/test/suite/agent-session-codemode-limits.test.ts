import { readFileSync, rmSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_OUTPUT_ITEMS } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolDetails,
	createCodemodeTool,
} from "../../src/extensions/codemode/tool.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("codemode output exhaustion", () => {
	const harnesses: Harness[] = [];
	const spillFiles: string[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const path of spillFiles.splice(0)) rmSync(path, { force: true });
	});

	it("keeps the failure explanation visible even with a zero-token display budget", async () => {
		const tool = createCodemodeTool();
		const result = await tool.execute("limited", {
			code: `// @options: {"max_output_tokens": 0}\ntext("real partial output"); for (let i = 0; i < ${DEFAULT_MAX_OUTPUT_ITEMS}; i++) text("");`,
		});
		const path = result.details.fullOutputPath;
		if (path) spillFiles.push(path);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Script limit exceeded: Output limit exceeded");
		expect(path).toBeDefined();
		expect(readFileSync(path!, "utf8")).toContain("real partial output");
	});

	it("drains an already running native child and retains its real receipt before returning a limit failure", async () => {
		let started!: () => void;
		let cancelled!: () => void;
		let release!: () => void;
		const hasStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hasCancelled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const canDrain = new Promise<void>((resolve) => {
			release = resolve;
		});
		let physicallyDrained = false;
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool({
						name: "slow",
						label: "Slow",
						description: "Wait for cancellation and cleanup",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal) => {
							started();
							await new Promise<void>((resolve) => {
								if (signal?.aborted) resolve();
								else signal?.addEventListener("abort", () => resolve(), { once: true });
							});
							cancelled();
							await canDrain;
							physicallyDrained = true;
							return {
								content: [{ type: "text", text: "cleanup completed" }],
								details: { drained: true },
								isError: true,
							};
						},
					});
					pi.registerTool({
						name: "started",
						label: "Started",
						description: "Wait until the child is running",
						parameters: Type.Object({}),
						outputSchema: Type.Object({ ready: Type.Boolean() }),
						execute: async () => {
							await hasStarted;
							return {
								content: [{ type: "text", text: "started" }],
								structuredContent: { ready: true },
								details: {},
							};
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `tools.slow({}); const ready = await tools.started({}); text("ready=" + ready.ready); store("discarded", true); for (let i = 0; i < ${DEFAULT_MAX_OUTPUT_ITEMS}; i++) text("");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		let settled = false;
		const execution = harness.session.prompt("run").then(() => {
			settled = true;
		});
		try {
			await hasCancelled;
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(settled).toBe(false);
			expect(physicallyDrained).toBe(false);
		} finally {
			release();
			await execution;
		}
		const result = getToolResult(harness, "codemode");
		expect(physicallyDrained).toBe(true);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("ready=true");
		expect(getMessageText(result)).toContain("Script limit exceeded: Output limit exceeded");
		const calls = (result.details as unknown as CodemodeToolDetails).calls;
		expect(calls).toMatchObject([
			{ name: "slow", status: "cancelled" },
			{ name: "started", status: "ok" },
		]);
		expect(calls.every((call) => call.id.startsWith(`${result.toolCallId}/`) && !call.id.endsWith("?"))).toBe(true);
		expect(result.nestedCalls?.calls.find((call) => call.name === "slow")).toMatchObject({
			id: calls[0].id,
			result: { content: [{ type: "text", text: "cleanup completed" }], details: { drained: true } },
		});
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE),
		).toBe(false);
	});
});
