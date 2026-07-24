import { createHash } from "node:crypto";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RuntimeProtocolError } from "./protocol.ts";
import { RESERVED_RUNTIME_TOOL_NAMES } from "./runtime-tool-names.ts";
import { modelVisibleResult, ToolArtifactBuffer } from "./tool-artifact-buffer.ts";

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const MAX_TOOLS = 256;

export interface BackendToolManifest {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	when?: string[];
	notFor?: string[];
	input?: string;
	output?: string;
	does?: string;
	profile?: string;
	risk?: string;
}

export interface BackendToolCatalogDiff {
	previousRevision: string;
	revision: string;
	previousSchemaRevision: string;
	schemaRevision: string;
	added: string[];
	removed: string[];
	changed: string[];
	schemaChanged: string[];
	metadataChanged: string[];
}

export interface ToolGatewayResponse {
	ok: boolean;
	result?: Record<string, unknown>;
	approval?: Record<string, unknown>;
	error?: string;
}

interface GatewayFetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export class BackendToolRegistry {
	private manifest: BackendToolManifest[] = [];
	private disclosedNames = new Set<string>();
	private loadReceiptIds = new Map<string, string>();

	list(): BackendToolManifest[] {
		return structuredClone(this.manifest);
	}

	disclosed(): BackendToolManifest[] {
		return [...this.disclosedNames]
			.map((name) => this.get(name))
			.filter((tool): tool is BackendToolManifest => tool !== undefined);
	}

	get(name: string): BackendToolManifest | undefined {
		const tool = this.manifest.find((candidate) => candidate.name === name);
		return tool ? structuredClone(tool) : undefined;
	}

	disclose(name: string): BackendToolManifest {
		const tool = this.get(name);
		if (!tool) throw new RuntimeProtocolError("TOOL_NOT_FOUND", `Unknown or unavailable product tool: ${name}`);
		this.disclosedNames.add(name);
		return tool;
	}

	isDisclosed(name: string): boolean {
		return this.disclosedNames.has(name);
	}

	recordLoadReceipt(name: string, receiptId: string): void {
		if (!this.get(name)) throw new RuntimeProtocolError("TOOL_NOT_FOUND", `Unknown product tool: ${name}`);
		if (!receiptId) throw new RuntimeProtocolError("INVALID_TOOL_RECEIPT", "tool_load receipt id is required");
		this.loadReceiptIds.set(name, receiptId);
	}

	loadReceipt(name: string): string | undefined {
		return this.loadReceiptIds.get(name);
	}

	governedLoadReceipts(): Array<{ name: string; receiptId: string }> {
		return this.disclosed()
			.map((tool) => ({ name: tool.name, receiptId: this.loadReceiptIds.get(tool.name) ?? "" }))
			.filter((item) => item.receiptId.length > 0);
	}

	rebindableLoadReceipts(): Array<{ name: string; receiptId: string }> {
		return [...this.loadReceiptIds].map(([name, receiptId]) => ({ name, receiptId }));
	}

	revision(): string {
		return backendToolCatalogRevision(this.manifest);
	}

	sync(value: unknown): BackendToolManifest[] {
		if (!Array.isArray(value)) {
			throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", "Tool manifest must be an array");
		}
		if (value.length > MAX_TOOLS) {
			throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool manifest exceeds ${MAX_TOOLS} tools`);
		}
		const names = new Set<string>();
		const manifest = value
			.map((item, index): BackendToolManifest => {
				if (typeof item !== "object" || item === null || Array.isArray(item)) {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool ${index} must be an object`);
				}
				const record = item as Record<string, unknown>;
				if (typeof record.name !== "string" || !TOOL_NAME_PATTERN.test(record.name)) {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool ${index} has an invalid name`);
				}
				if (names.has(record.name)) {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Duplicate tool name: ${record.name}`);
				}
				if (RESERVED_RUNTIME_TOOL_NAMES.has(record.name)) {
					throw new RuntimeProtocolError(
						"INVALID_TOOL_MANIFEST",
						`Tool name is reserved by the runtime host: ${record.name}`,
					);
				}
				names.add(record.name);
				if (typeof record.description !== "string" || record.description.length === 0) {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool ${record.name} needs a description`);
				}
				if (
					typeof record.parameters !== "object" ||
					record.parameters === null ||
					Array.isArray(record.parameters) ||
					(record.parameters as Record<string, unknown>).type !== "object"
				) {
					throw new RuntimeProtocolError(
						"INVALID_TOOL_MANIFEST",
						`Tool ${record.name} parameters must be a JSON object schema`,
					);
				}
				if (record.profile !== undefined && typeof record.profile !== "string") {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool ${record.name} profile must be a string`);
				}
				if (record.risk !== undefined && typeof record.risk !== "string") {
					throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool ${record.name} risk must be a string`);
				}
				for (const key of ["when", "notFor"] as const) {
					if (
						record[key] !== undefined &&
						(!Array.isArray(record[key]) ||
							record[key].length === 0 ||
							record[key].some((value) => typeof value !== "string" || !value.trim()))
					) {
						throw new RuntimeProtocolError(
							"INVALID_TOOL_MANIFEST",
							`Tool ${record.name} ${key} must be a non-empty string array`,
						);
					}
				}
				for (const key of ["input", "output", "does"] as const) {
					if (record[key] !== undefined && (typeof record[key] !== "string" || !record[key].trim())) {
						throw new RuntimeProtocolError(
							"INVALID_TOOL_MANIFEST",
							`Tool ${record.name} ${key} must be a non-empty string`,
						);
					}
				}
				return {
					name: record.name,
					description: record.description,
					parameters: canonicalJson(record.parameters) as Record<string, unknown>,
					when: record.when as string[] | undefined,
					notFor: record.notFor as string[] | undefined,
					input: record.input as string | undefined,
					output: record.output as string | undefined,
					does: record.does as string | undefined,
					profile: record.profile,
					risk: record.risk,
				};
			})
			.sort((left, right) => left.name.localeCompare(right.name));
		this.disclosedNames = new Set([...this.disclosedNames].filter((name) => names.has(name)));
		this.loadReceiptIds = new Map([...this.loadReceiptIds].filter(([name]) => names.has(name)));
		this.manifest = manifest;
		return this.list();
	}
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalJson);
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalJson(record[key])]),
		);
	}
	return value;
}

export function backendToolCatalogRevision(tools: BackendToolManifest[]): string {
	const canonical = tools
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((tool) => canonicalJson(tool));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function backendToolSchemaRevision(tools: BackendToolManifest[]): string {
	const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	return backendToolCatalogRevision(schemas);
}

export function diffBackendToolCatalog(
	before: BackendToolManifest[],
	after: BackendToolManifest[],
): BackendToolCatalogDiff {
	const previousByName = new Map(before.map((tool) => [tool.name, tool]));
	const nextByName = new Map(after.map((tool) => [tool.name, tool]));
	const added = [...nextByName.keys()].filter((name) => !previousByName.has(name)).sort();
	const removed = [...previousByName.keys()].filter((name) => !nextByName.has(name)).sort();
	const changed = [...nextByName.keys()]
		.filter((name) => {
			const previous = previousByName.get(name);
			const next = nextByName.get(name);
			return (
				previous !== undefined &&
				next !== undefined &&
				backendToolCatalogRevision([previous]) !== backendToolCatalogRevision([next])
			);
		})
		.sort();
	const schemaChanged = changed.filter((name) => {
		const previous = previousByName.get(name);
		const next = nextByName.get(name);
		return (
			previous !== undefined &&
			next !== undefined &&
			backendToolSchemaRevision([previous]) !== backendToolSchemaRevision([next])
		);
	});
	const schemaChangedSet = new Set(schemaChanged);
	const metadataChanged = changed.filter((name) => !schemaChangedSet.has(name));
	return {
		previousRevision: backendToolCatalogRevision(before),
		revision: backendToolCatalogRevision(after),
		previousSchemaRevision: backendToolSchemaRevision(before),
		schemaRevision: backendToolSchemaRevision(after),
		added,
		removed,
		changed,
		schemaChanged,
		metadataChanged,
	};
}

export interface BackendToolBridgeOptions {
	sessionId: string;
	registry: BackendToolRegistry;
	gatewayUrl?: string;
	gatewayToken?: string;
	roomCapability?: Record<string, unknown>;
	waitForDecision?(
		kind: "approval" | "review",
		targetId: string,
		details: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<boolean>;
}

export async function requestProductGateway(
	options: BackendToolBridgeOptions,
	path: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<ToolGatewayResponse> {
	if (!options.gatewayUrl) throw new Error("RAG_IME_TOOL_GATEWAY_URL is not configured");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (options.gatewayToken) headers["X-RAG-IME-Agent-Token"] = options.gatewayToken;
	const executeSuffix = "/tool/execute";
	const base = options.gatewayUrl.endsWith(executeSuffix)
		? options.gatewayUrl.slice(0, -executeSuffix.length)
		: options.gatewayUrl.replace(/\/$/u, "");
	const response = (await fetch(path === "execute" ? options.gatewayUrl : `${base}/tool/${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	})) as GatewayFetchResponse;
	const payload = (await response.json()) as ToolGatewayResponse;
	if (!response.ok || !payload.ok) throw new Error(payload.error || `Tool gateway returned HTTP ${response.status}`);
	return payload;
}

export async function requestGovernedToolLoad(
	options: BackendToolBridgeOptions,
	toolName: string,
	receiptId: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	if (!options.roomCapability) return undefined;
	if (!options.registry.get(toolName)) {
		throw new RuntimeProtocolError("TOOL_NOT_FOUND", `Unknown product tool: ${toolName}`);
	}
	const governed = await requestProductGateway(
		options,
		"load",
		{
			sessionId: options.sessionId,
			receiptId,
			toolName,
			createdAtMs: Date.now(),
		},
		signal,
	);
	const result = governed.result;
	const governedReceiptId = typeof result?.receiptId === "string" ? result.receiptId : "";
	if (!governedReceiptId) {
		throw new RuntimeProtocolError("INVALID_TOOL_RECEIPT", `Room tool receipt load failed: ${toolName}`);
	}
	return result;
}

export async function requestGovernedToolLoads(
	options: BackendToolBridgeOptions,
	loads: ReadonlyArray<{ name: string; receiptId: string }>,
	signal?: AbortSignal,
): Promise<Array<Record<string, unknown> | undefined>> {
	if (loads.length < 1 || loads.length > 4) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "Room tool load batch must contain one to four items");
	}
	if (!options.roomCapability) return loads.map(() => undefined);
	if (loads.length === 1) {
		return [await requestGovernedToolLoad(options, loads[0].name, loads[0].receiptId, signal)];
	}
	for (const load of loads) {
		if (!options.registry.get(load.name)) {
			throw new RuntimeProtocolError("TOOL_NOT_FOUND", `Unknown product tool: ${load.name}`);
		}
	}
	const governed = await requestProductGateway(
		options,
		"load",
		{
			sessionId: options.sessionId,
			loads: loads.map((load) => ({
				receiptId: load.receiptId,
				toolName: load.name,
			})),
			createdAtMs: Date.now(),
		},
		signal,
	);
	const items = governed.result?.items;
	if (!Array.isArray(items) || items.length !== loads.length) {
		throw new RuntimeProtocolError("INVALID_TOOL_RECEIPT", "Room tool load batch returned an invalid receipt set");
	}
	return items.map((item, index) => {
		if (
			typeof item !== "object" ||
			item === null ||
			Array.isArray(item) ||
			(item as Record<string, unknown>).receiptId !== loads[index].receiptId ||
			(item as Record<string, unknown>).toolName !== loads[index].name
		) {
			throw new RuntimeProtocolError(
				"INVALID_TOOL_RECEIPT",
				`Room tool load batch receipt does not match request: ${loads[index].name}`,
			);
		}
		return item as Record<string, unknown>;
	});
}

/** Rebind disclosed schemas to the active Dispatch without reinjecting them. */
export async function rebindGovernedToolReceipts(
	options: BackendToolBridgeOptions,
	dispatchId: string,
): Promise<Array<{ name: string; receiptId: string }>> {
	if (!options.roomCapability || !options.gatewayUrl) return [];
	const rebound: Array<{ name: string; receiptId: string }> = [];
	for (const item of options.registry.rebindableLoadReceipts()) {
		const result = await requestGovernedToolLoad(options, item.name, `load:rebind:${dispatchId}:${item.name}`);
		const receiptId = String(result?.receiptId ?? "");
		options.registry.recordLoadReceipt(item.name, receiptId);
		rebound.push({ name: item.name, receiptId });
	}
	return rebound;
}

async function executeGatewayTool(
	options: BackendToolBridgeOptions,
	tool: BackendToolManifest,
	toolCallId: string,
	args: unknown,
	signal: AbortSignal | undefined,
	artifacts: ToolArtifactBuffer,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const prepared = artifacts.prepare(tool.name, args);
	const payload = await requestProductGateway(
		options,
		"execute",
		{
			schemaVersion: "rag-ime.agent-tool-call.v1",
			sessionId: options.sessionId,
			toolCallId,
			tool: tool.name,
			args: prepared.arguments,
			...(options.roomCapability ? { roomCapability: options.roomCapability } : {}),
			...(options.registry.loadReceipt(tool.name) ? { loadReceiptId: options.registry.loadReceipt(tool.name) } : {}),
		},
		signal,
	);
	artifacts.acknowledge(prepared.deliveryKeys);
	const result = payload.result ?? {};
	if (result.reviewRequired === true) {
		const run = typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : {};
		const runId = String(run.runId ?? result.runId ?? "");
		if (!runId || !options.waitForDecision) throw new Error("Product review bridge is unavailable");
		const reviewed = await options.waitForDecision("review", runId, result, signal);
		const summary = reviewed
			? "控制中心已完成本次草案审阅。本轮不要继续调用记忆维护工具，请简要确认后结束。"
			: "用户暂缓了本次草案审阅，未应用变更。本轮不要继续调用记忆维护工具，请简要确认后结束。";
		const agentBlocks = artifacts.capture(result);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						modelVisibleResult({ summary, reviewState: reviewed ? "reviewed" : "deferred", runId }),
					),
				},
			],
			details: {
				...result,
				reviewState: reviewed ? "reviewed" : "deferred",
				runId,
				...(agentBlocks.length > 0 ? { agentBlocks } : {}),
			},
		};
	}
	if (result.approvalRequired === true) {
		const approval =
			typeof result.approval === "object" && result.approval !== null
				? (result.approval as Record<string, unknown>)
				: {};
		const approvalId = String(approval.approvalId ?? result.approvalId ?? "");
		if (!approvalId || !options.waitForDecision) throw new Error("Product approval bridge is unavailable");
		const approved = await options.waitForDecision("approval", approvalId, result, signal);
		let resolved: Record<string, unknown> = approval;
		try {
			const lookup = await requestProductGateway(
				options,
				"approval-result",
				{
					schemaVersion: "rag-ime.agent-approval-result-request.v1",
					sessionId: options.sessionId,
					approvalId,
				},
				signal,
			);
			if (lookup.approval) resolved = lookup.approval;
		} catch (error) {
			if (approved) throw error;
		}
		const approvalState = String(resolved.state ?? (approved ? "approved" : "rejected"));
		const receipt =
			typeof resolved.receipt === "object" && resolved.receipt !== null
				? (resolved.receipt as Record<string, unknown>)
				: undefined;
		const summary = String(
			receipt?.summary ??
				(approvalState === "applied" ? "受控操作已应用。" : "用户拒绝、审批失效或操作失败，未应用变更。"),
		);
		const agentBlocks = artifacts.capture(result, resolved, receipt);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(modelVisibleResult({ summary, approvalState, receipt: receipt ?? null })),
				},
			],
			details: {
				...result,
				approvalState,
				approval: resolved,
				...(agentBlocks.length > 0 ? { agentBlocks } : {}),
			},
		};
	}
	const agentBlocks = artifacts.capture(result);
	return {
		content: [{ type: "text", text: JSON.stringify(modelVisibleResult(result)) }],
		details: { ...result, toolName: tool.name, ...(agentBlocks.length > 0 ? { agentBlocks } : {}) },
	};
}

export function createBackendToolDefinition(
	options: BackendToolBridgeOptions,
	tool: BackendToolManifest,
	artifacts = new ToolArtifactBuffer(),
): ToolDefinition {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters as ToolDefinition["parameters"],
		executionMode: "parallel",
		execute: async (toolCallId, args, signal) =>
			executeGatewayTool(options, tool, toolCallId, args, signal, artifacts),
	};
}

export function createProjectedBackendToolDefinition(
	options: BackendToolBridgeOptions,
	projection: {
		name: string;
		label: string;
		description: string;
		parameters: ToolDefinition["parameters"];
		targetToolName: string;
		mapArguments(args: unknown): Record<string, unknown>;
	},
	artifacts = new ToolArtifactBuffer(),
): ToolDefinition {
	const target = options.registry.get(projection.targetToolName);
	if (!target) {
		throw new RuntimeProtocolError(
			"TOOL_NOT_FOUND",
			`Projected runtime tool target is unavailable: ${projection.targetToolName}`,
		);
	}
	return {
		name: projection.name,
		label: projection.label,
		description: projection.description,
		parameters: projection.parameters,
		executionMode: "parallel",
		execute: async (toolCallId, args, signal) =>
			executeGatewayTool(options, target, toolCallId, projection.mapArguments(args), signal, artifacts),
	};
}

export function createBackendToolExtension(options: BackendToolBridgeOptions): InlineExtension {
	const artifacts = new ToolArtifactBuffer();
	return {
		name: "rag-ime-backend-tools",
		factory(pi) {
			// Register the complete session-authorized catalog for execution lookup.
			// Provider visibility is narrowed separately by AgentSession.active tools.
			for (const tool of options.registry.list()) {
				pi.registerTool(createBackendToolDefinition(options, tool, artifacts));
			}
		},
	};
}
