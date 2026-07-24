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
	required: ["kind", "claim", "scope", "reason"],
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
		reason: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description: "Why this fact is likely to remain useful beyond the current turn.",
		},
	},
	additionalProperties: false,
} as ToolDefinition["parameters"];

export function supportsMemoryCapture(tool: BackendToolManifest | undefined): boolean {
	if (!tool) return false;
	const branches = Array.isArray(tool.parameters.oneOf) ? tool.parameters.oneOf : [];
	return branches.some((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const properties = (value as Record<string, unknown>).properties;
		if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
		const operation = (properties as Record<string, unknown>).op;
		return Boolean(
			operation &&
				typeof operation === "object" &&
				!Array.isArray(operation) &&
				(operation as Record<string, unknown>).const === "capture",
		);
	});
}

export function createMemoryCaptureExtension(options: BackendToolBridgeOptions): InlineExtension {
	return {
		name: "rag-ime-memory-capture",
		factory(pi) {
			if (!supportsMemoryCapture(options.registry.get(MEMORY_CAPTURE_TARGET))) return;
			pi.registerTool(
				createProjectedBackendToolDefinition(options, {
					name: MEMORY_CAPTURE_TOOL_NAME,
					label: "Capture durable memory evidence",
					description:
						"Mark one user-confirmed preference, fact, decision, correction, or reusable pitfall for the existing governed memory pipeline.",
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
							reason: value.reason,
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
