import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("cycles xhigh before max when both are supported", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		harness.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max" };

		expect(harness.session.getAvailableThinkingLevels()).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		harness.session.setThinkingLevel("high");
		expect(harness.session.cycleThinkingLevel()).toBe("xhigh");
		expect(harness.session.cycleThinkingLevel()).toBe("max");
		expect(harness.session.cycleThinkingLevel()).toBe("off");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [{ type: "text", text: "patched result" }],
						details: { patched: true },
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.details?.patched === true),
		).toBeDefined();
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(harness.session.systemPrompt).not.toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("does not strand a system prompt when an idle continuation replay is already complete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const providerPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("initial");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("repaired");
			},
		]);
		const basePrompt = harness.session.systemPrompt;

		await harness.session.prompt("start");
		const first = await harness.session.followUpWithSystemPrompt("repair", "managed repair prompt", undefined, {
			id: "repair:1",
			idempotencyKey: "repair-key:1",
		});
		expect(first.state).toBe("pending");
		await harness.session.waitForIdle();

		expect(providerPrompts).toEqual([basePrompt, "managed repair prompt"]);
		expect(harness.session.systemPrompt).toBe(basePrompt);

		const duplicate = await harness.session.followUpWithSystemPrompt("repair", "must not be installed", undefined, {
			id: "repair:duplicate",
			idempotencyKey: "repair-key:1",
		});
		expect(duplicate).toMatchObject({ id: "repair:1", state: "completed" });
		expect(harness.session.systemPrompt).toBe(basePrompt);
		expect(providerPrompts).toHaveLength(2);
	});

	it("clears only the owned system prompt when a pending idle continuation is cancelled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("initial");
			},
		]);
		const basePrompt = harness.session.systemPrompt;

		await harness.session.prompt("start");
		const pending = await harness.session.followUpWithSystemPrompt("repair", "managed repair prompt", undefined, {
			id: "repair:cancel",
			idempotencyKey: "repair-key:cancel",
		});
		expect(pending.state).toBe("pending");
		expect(harness.session.systemPrompt).toBe(basePrompt);

		const cancellation = harness.session.cancelContinuation({ id: pending.id }, "test_cancel_before_delivery");
		expect(cancellation.cancelledIds).toEqual([pending.id]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.waitForIdle();

		expect(providerCalls).toBe(1);
		expect(harness.session.systemPrompt).toBe(basePrompt);
	});

	it("rejects a per-run system prompt for a stale cancellation generation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(
			harness.session.followUpWithSystemPrompt("repair", "managed repair prompt", undefined, {
				cancelGeneration: 7,
			}),
		).rejects.toThrow("stale cancellation generation");
		expect(harness.session.listContinuations()).toHaveLength(0);
	});

	it("leases a per-run system prompt only to its exact continuation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const providerPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("initial");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("urgent");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("repair");
			},
		]);
		const basePrompt = harness.session.systemPrompt;

		await harness.session.prompt("start");
		await harness.session.followUpWithSystemPrompt("repair", "managed repair prompt", undefined, {
			id: "repair:owned",
			idempotencyKey: "repair-key:owned",
			priority: 0,
		});
		await harness.session.followUp("urgent normal follow-up", undefined, {
			id: "normal:urgent",
			idempotencyKey: "normal-key:urgent",
			priority: 10,
		});
		await harness.session.waitForIdle();

		expect(providerPrompts).toEqual([basePrompt, basePrompt, "managed repair prompt"]);
		expect(harness.session.systemPrompt).toBe(basePrompt);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
