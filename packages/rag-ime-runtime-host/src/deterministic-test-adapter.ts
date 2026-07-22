import {
	type AssistantMessage,
	type Context,
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const DETERMINISTIC_TEST_PROVIDER = "rag-ime-deterministic";
export const DETERMINISTIC_TEST_MODEL = "room-v2-test";
const CONTEXT_EPOCH_SCENARIO = "context-epoch";

function contextText(context: Context): string {
	return JSON.stringify({ systemPrompt: context.systemPrompt ?? "", messages: context.messages });
}

function activeToolNames(context: Context): Set<string> {
	return new Set((context.tools ?? []).map((tool) => tool.name));
}

function stringsIn(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap(stringsIn);
	}
	return [];
}

function currentRoomTask(context: Context): Record<string, unknown> | undefined {
	for (const source of [context.systemPrompt ?? "", ...stringsIn(context.messages)]) {
		const match = source.match(/<room-fact kind="dispatch_state">([\s\S]*?)<\/room-fact>/u);
		if (!match) continue;
		try {
			const value = JSON.parse(match[1]) as unknown;
			if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
		} catch {}
	}
	return undefined;
}

function currentEpochMarker(task: Record<string, unknown>): string {
	const match = JSON.stringify(task).match(/CANARY-(\d+)-OK/u);
	return match?.[1] ?? "";
}

function acceptanceCriterionIds(task: Record<string, unknown>): string[] {
	const acceptance = task.acceptance;
	if (typeof acceptance !== "object" || acceptance === null) return [];
	const criteria = (acceptance as Record<string, unknown>).criteria;
	if (!Array.isArray(criteria)) return [];
	return criteria
		.map((criterion) =>
			typeof criterion === "object" && criterion !== null
				? String((criterion as Record<string, unknown>).criterionId ?? "")
				: "",
		)
		.filter(Boolean);
}

function executionReceiptIds(serialized: string): string[] {
	return [...serialized.matchAll(/"executionReceiptId":"([^"]+)"/gu)]
		.map((match) => match[1])
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
		.slice(-2);
}

/** Drive the real discovery, product Tool and settle loops for the API epoch canary. */
export function contextEpochCanaryResponse(context: Context): AssistantMessage {
	const task = currentRoomTask(context);
	const epoch = task ? currentEpochMarker(task) : "";
	if (!task || !epoch) {
		return fauxAssistantMessage(
			"Preserve the original requirement, current task, acceptance criteria, blockers, handoff, and exact Skill and Tool receipts.",
		);
	}
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	const prefix = `epoch-${epoch}`;
	if (!tools.has("workspace_read")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_read" }, { id: `${prefix}-load-read` }),
			{
				stopReason: "toolUse",
			},
		);
	}
	if (!serialized.includes(`${prefix}-read-a`)) {
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "rag_ime/agent_service.py", offset: 0, limit: 65_536 },
					{ id: `${prefix}-read-a` },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "rag_ime/agent_room_kernel.py", offset: 0, limit: 65_536 },
					{ id: `${prefix}-read-b` },
				),
			],
			{ stopReason: "toolUse" },
		);
	}
	const missingRoomTools = ["room_post", "room_commit"].filter((name) => !tools.has(name));
	if (missingRoomTools.length > 0) {
		return fauxAssistantMessage(
			missingRoomTools.map((name) => fauxToolCall("tool_load", { name }, { id: `${prefix}-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes(`${prefix}-post`)) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_post",
				{ content: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。` },
				{ id: `${prefix}-post` },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes(`${prefix}-commit`)) {
		const requirementCoverage = acceptanceCriterionIds(task);
		if (requirementCoverage.length === 0) {
			throw new Error("The context epoch canary requires explicit acceptance criterion ids");
		}
		const receipts = executionReceiptIds(serialized);
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					result: `CANARY-${epoch}-OK；两份指定源码已完成有界读取。`,
					evidenceRefs: receipts.length > 0 ? receipts : [`${prefix}-read-a`, `${prefix}-read-b`],
					requirementCoverage,
				},
				{ id: `${prefix}-commit` },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(`CANARY-${epoch}-OK`);
}

/** Test-only Provider adapter. It drives the real Pi Session and tool loop without network access. */
export async function createDeterministicTestModelRuntime(): Promise<ModelRuntime> {
	if (process.env.NODE_ENV !== "test" || process.env.RAG_IME_PI_DETERMINISTIC_ADAPTER !== "room-v2") {
		throw new Error("The deterministic Room Provider is available only under the explicit test gate");
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	const faux = createFauxCore({
		api: "faux:room-v2",
		provider: DETERMINISTIC_TEST_PROVIDER,
		models: [{ id: DETERMINISTIC_TEST_MODEL, name: "Room V2 deterministic test model", input: ["text"] }],
		tokensPerSecond: process.env.RAG_IME_PI_DETERMINISTIC_SLOW === "1" ? 10 : undefined,
	});
	if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === CONTEXT_EPOCH_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => contextEpochCanaryResponse));
	} else {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json", limit: 4 }, { id: "deterministic-read" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Room dispatch inspected the workspace and settled."),
		]);
	}
	const model = faux.getModel();
	runtime.registerProvider(DETERMINISTIC_TEST_PROVIDER, {
		name: "Room V2 deterministic test Provider",
		baseUrl: "http://localhost.invalid",
		api: model.api,
		apiKey: "test-only",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
	return runtime;
}
