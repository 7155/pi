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
const PROJECT_TASK_SCENARIO = "project-task";

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

function containsField(value: unknown, field: string, expected: unknown): boolean {
	if (Array.isArray(value)) return value.some((item) => containsField(item, field, expected));
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record[field] === expected || Object.values(record).some((item) => containsField(item, field, expected));
}

function contextHasJsonField(context: Context, field: string, expected: unknown): boolean {
	for (const source of stringsIn(context.messages)) {
		try {
			if (containsField(JSON.parse(source) as unknown, field, expected)) return true;
		} catch {}
	}
	return false;
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

function executionReceiptIds(serialized: string, limit = 2): string[] {
	return [...serialized.matchAll(/"executionReceiptId":"([^"]+)"/gu)]
		.map((match) => match[1])
		.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
		.slice(-limit);
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

/** Drive an approved read, patch, test, publish and settle task in an isolated project. */
export function projectTaskCanaryResponse(context: Context): AssistantMessage {
	const task = currentRoomTask(context);
	if (!task || !JSON.stringify(task).includes("PROJECT-TASK-CANARY")) {
		return fauxAssistantMessage("A managed PROJECT-TASK-CANARY dispatch is required.");
	}
	const serialized = contextText(context);
	const tools = activeToolNames(context);
	const requiredDiscoveryTools = ["workspace_list", "workspace_search", "workspace_read"];
	const missingDiscoveryTools = requiredDiscoveryTools.filter((name) => !tools.has(name));
	if (missingDiscoveryTools.length > 0) {
		return fauxAssistantMessage(
			missingDiscoveryTools.map((name) => fauxToolCall("tool_load", { name }, { id: `project-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-list")) {
		return fauxAssistantMessage(
			fauxToolCall("workspace_list", { op: "list", path: ".", depth: 2, limit: 50 }, { id: "project-list" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-search")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_search",
				{
					op: "search",
					query: "ROOM_PROJECT_TASK",
					path: ".",
					mode: "both",
					caseSensitive: true,
					limit: 20,
				},
				{ id: "project-search" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-read-app")) {
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "calculator.py", offset: 0, limit: 16_384 },
					{ id: "project-read-app" },
				),
				fauxToolCall(
					"workspace_read",
					{ op: "read", path: "test_calculator.py", offset: 0, limit: 16_384 },
					{ id: "project-read-test" },
				),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (!tools.has("workspace_patch")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_patch" }, { id: "project-load-patch" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-patch")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_patch",
				{
					op: "apply",
					path: "calculator.py",
					oldText: '    raise NotImplementedError("ROOM_PROJECT_TASK")',
					newText:
						"    if not values:\n        return []\n    minimum = min(values)\n    return [value - minimum for value in values]",
					expectedOccurrences: 1,
				},
				{ id: "project-patch" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "mutationApplied", true)) {
		throw new Error("The approved project patch did not produce an applied receipt");
	}
	if (!tools.has("workspace_shell")) {
		return fauxAssistantMessage(
			fauxToolCall("tool_load", { name: "workspace_shell" }, { id: "project-load-shell" }),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-test")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"workspace_shell",
				{
					op: "run",
					command: "/usr/bin/python3 -m unittest -v",
					cwd: ".",
					timeoutSeconds: 30,
					allowNetwork: false,
				},
				{ id: "project-test" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!contextHasJsonField(context, "exitCode", 0)) {
		throw new Error("The approved project test command did not pass");
	}
	const missingRoomTools = ["room_post", "room_commit"].filter((name) => !tools.has(name));
	if (missingRoomTools.length > 0) {
		return fauxAssistantMessage(
			missingRoomTools.map((name) => fauxToolCall("tool_load", { name }, { id: `project-load-${name}` })),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-post")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"room_post",
				{ content: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。" },
				{ id: "project-post" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (!serialized.includes("project-commit")) {
		const requirementCoverage = acceptanceCriterionIds(task);
		if (requirementCoverage.length === 0) {
			throw new Error("The project canary requires explicit acceptance criterion ids");
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"room_commit",
				{
					decision: "deliver",
					result: "PROJECT-CANARY-OK；实现已完成，隔离测试全部通过。",
					evidenceRefs: executionReceiptIds(serialized, 8),
					requirementCoverage,
				},
				{ id: "project-commit" },
			),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage("PROJECT-CANARY-OK");
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
	} else if (process.env.RAG_IME_PI_DETERMINISTIC_SCENARIO === PROJECT_TASK_SCENARIO) {
		faux.setResponses(Array.from({ length: 96 }, () => projectTaskCanaryResponse));
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
