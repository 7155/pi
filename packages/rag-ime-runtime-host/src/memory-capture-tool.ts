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
		},
		claim: {
			type: "string",
			minLength: 1,
			maxLength: 800,
			description: "One independently understandable fact that may remain useful in a later Session.",
		},
		scope: {
			type: "string",
			enum: ["user", "project"],
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
			description: "The evidence class supporting this candidate.",
		},
		futureUse: {
			type: "string",
			minLength: 1,
			maxLength: 300,
			description: "How this single claim should help a later Session.",
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
						"Propose one evidence-backed preference, fact, decision, correction, or reusable pitfall for governed review. Use for explicit or stable user signals that should change a later Session. Do not use for one-off requests, workflow progress, model guesses, sensitive content, or batch curation. This never writes durable memory directly.",
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
