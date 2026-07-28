import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MEMORY_CAPTURE_TOOL_NAME } from "./runtime-tool-names.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	createProjectedBackendToolDefinition,
	requestGovernedToolLoad,
} from "./tool-bridge.ts";

const MEMORY_CAPTURE_TARGET = "ime_memory";

const MEMORY_CAPTURE_PARAMETERS = {
	type: "object",
	required: ["kind", "claim", "scope", "basis", "futureUse"],
	properties: {
		kind: {
			type: "string",
			enum: ["preference", "fact", "decision", "correction", "pitfall"],
			description: "Choose only preference, fact, decision, correction, or pitfall.",
		},
		claim: {
			type: "string",
			minLength: 1,
			maxLength: 800,
			description:
				"One independently understandable statement that remains true outside this conversation. Do not copy a long passage.",
		},
		scope: {
			type: "string",
			enum: ["user", "project"],
			description:
				"Use user only for information that applies across projects. Use project for facts and constraints local to the current project.",
		},
		basis: {
			type: "string",
			enum: [
				"explicit_user_request",
				"explicit_user_statement",
				"user_correction",
				"repeated_user_signal",
				"verified_outcome",
			],
			description:
				"explicit_user_request means the user asked to remember it; explicit_user_statement means the user stated it; user_correction means the user corrected it; repeated_user_signal requires at least two independent signals visible in the current context; verified_outcome requires successful Tool or runtime evidence.",
		},
		futureUse: {
			type: "string",
			minLength: 1,
			maxLength: 300,
			description: "State when and how a future Session should use this candidate. Do not restate the claim.",
		},
		supersedes: {
			type: "string",
			maxLength: 800,
			description: "Only for correction: the old statement being corrected, never an internal memory ID.",
		},
	},
	additionalProperties: false,
} as ToolDefinition["parameters"];

export function supportsMemoryCapture(tool: BackendToolManifest | undefined): boolean {
	return Boolean(
		tool?.runtimeProjections?.some(
			(projection) => projection.name === MEMORY_CAPTURE_TOOL_NAME && projection.operation === "capture",
		),
	);
}

export function createMemoryCaptureExtension(options: BackendToolBridgeOptions): InlineExtension {
	return {
		name: "rag-ime-memory-capture",
		factory(pi) {
			if (!supportsMemoryCapture(options.registry.get(MEMORY_CAPTURE_TARGET))) return;
			pi.registerTool(
				createProjectedBackendToolDefinition(options, {
					name: MEMORY_CAPTURE_TOOL_NAME,
					label: "Propose one memory candidate",
					description:
						"Propose one evidence-backed preference, fact, decision, correction, or reusable pitfall for governed review. Use only when a later Session would otherwise need the user to repeat a stable fact, preference, decision, correction, or verified pitfall. The runtime owns the Evidence identity: never guess Atom, Book, relationship, or Evidence IDs. Submit the same fact at most once per turn and at most three candidates in a turn, prioritizing future behavioral impact. In a Room, only public evidence-backed delivery, decision, or project conclusions qualify. Do not capture one-off requests, temporary progress, Tool logs, transient failures, guesses, sensitive information, generic praise, greetings, long source passages, private Room process, or the model's unconfirmed advice. A call creates only a governed candidate, never durable memory; do not announce that you remembered it. On failure, keep the receipt, continue the main task, and do not retry in a loop.",
					parameters: MEMORY_CAPTURE_PARAMETERS,
					targetToolName: MEMORY_CAPTURE_TARGET,
					mapArguments(args) {
						const value =
							typeof args === "object" && args !== null && !Array.isArray(args)
								? (args as Record<string, unknown>)
								: {};
						return {
							op: "capture",
							kind: value.kind,
							claim: value.claim,
							captureScope: value.scope,
							basis: value.basis,
							futureUse: value.futureUse,
							...(value.supersedes ? { supersedes: value.supersedes } : {}),
						};
					},
					projectModelResult(result) {
						return {
							summary: result.summary,
							candidate: result.candidate,
							createsDurableMemory: false,
							...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
							...(typeof result.retryable === "boolean" ? { retryable: result.retryable } : {}),
						};
					},
				}),
			);
		},
	};
}

export async function prepareGovernedMemoryCapture(options: BackendToolBridgeOptions): Promise<void> {
	if (!options.roomCapability || !options.gatewayUrl) return;
	if (!supportsMemoryCapture(options.registry.get(MEMORY_CAPTURE_TARGET))) return;
	const receipt = await requestGovernedToolLoad(
		options,
		MEMORY_CAPTURE_TARGET,
		bootstrapReceiptId(options, "memory-capture", MEMORY_CAPTURE_TARGET),
	);
	options.registry.recordLoadReceipt(MEMORY_CAPTURE_TARGET, String(receipt?.receiptId ?? ""));
}

function bootstrapReceiptId(options: BackendToolBridgeOptions, purpose: string, toolName: string): string {
	const manifestHash = String(options.roomCapability?.manifestHash ?? "").slice(0, 16) || "room";
	return `load:bootstrap:${options.sessionId}:${manifestHash}:${purpose}:${toolName}`;
}
