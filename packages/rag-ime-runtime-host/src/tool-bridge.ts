import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RuntimeProtocolError } from "./protocol.ts";

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const MAX_TOOLS = 256;

export interface BackendToolManifest {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	profile?: string;
	risk?: string;
}

interface ToolGatewayResponse {
	ok: boolean;
	result?: Record<string, unknown>;
	approval?: Record<string, unknown>;
	error?: string;
}

export class BackendToolRegistry {
	private manifest: BackendToolManifest[] = [];

	list(): BackendToolManifest[] {
		return structuredClone(this.manifest);
	}

	sync(value: unknown): BackendToolManifest[] {
		if (!Array.isArray(value)) {
			throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", "Tool manifest must be an array");
		}
		if (value.length > MAX_TOOLS) {
			throw new RuntimeProtocolError("INVALID_TOOL_MANIFEST", `Tool manifest exceeds ${MAX_TOOLS} tools`);
		}
		const names = new Set<string>();
		const manifest = value.map((item, index): BackendToolManifest => {
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
			return {
				name: record.name,
				description: record.description,
				parameters: structuredClone(record.parameters as Record<string, unknown>),
				profile: record.profile,
				risk: record.risk,
			};
		});
		this.manifest = manifest;
		return this.list();
	}
}

export interface BackendToolBridgeOptions {
	sessionId: string;
	registry: BackendToolRegistry;
	gatewayUrl?: string;
	gatewayToken?: string;
	waitForDecision?(
		kind: "approval" | "review",
		targetId: string,
		details: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<boolean>;
}

async function gatewayRequest(
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
	const response = await fetch(path === "execute" ? options.gatewayUrl : `${base}/tool/${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	const payload = (await response.json()) as ToolGatewayResponse;
	if (!response.ok || !payload.ok) throw new Error(payload.error || `Tool gateway returned HTTP ${response.status}`);
	return payload;
}

async function executeGatewayTool(
	options: BackendToolBridgeOptions,
	tool: BackendToolManifest,
	toolCallId: string,
	args: unknown,
	signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const payload = await gatewayRequest(
		options,
		"execute",
		{
			schemaVersion: "rag-ime.agent-tool-call.v1",
			sessionId: options.sessionId,
			toolCallId,
			tool: tool.name,
			args,
		},
		signal,
	);
	const result = payload.result ?? {};
	if (result.reviewRequired === true) {
		const run = typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : {};
		const runId = String(run.runId ?? result.runId ?? "");
		if (!runId || !options.waitForDecision) throw new Error("Product review bridge is unavailable");
		const reviewed = await options.waitForDecision("review", runId, result, signal);
		const summary = reviewed
			? "控制中心已完成本次草案审阅。本轮不要继续调用记忆维护工具，请简要确认后结束。"
			: "用户暂缓了本次草案审阅，未应用变更。本轮不要继续调用记忆维护工具，请简要确认后结束。";
		return {
			content: [
				{ type: "text", text: JSON.stringify({ summary, reviewState: reviewed ? "reviewed" : "deferred", runId }) },
			],
			details: { ...result, reviewState: reviewed ? "reviewed" : "deferred", runId },
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
			const lookup = await gatewayRequest(
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
		return {
			content: [{ type: "text", text: JSON.stringify({ summary, approvalState, receipt: receipt ?? null }) }],
			details: { ...result, approvalState, approval: resolved },
		};
	}
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
	};
}

export function createBackendToolExtension(options: BackendToolBridgeOptions): InlineExtension {
	return {
		name: "rag-ime-backend-tools",
		factory(pi) {
			for (const tool of options.registry.list()) {
				pi.registerTool({
					name: tool.name,
					label: tool.name,
					description: tool.description,
					parameters: tool.parameters as ToolDefinition["parameters"],
					execute: async (toolCallId, args, signal) => executeGatewayTool(options, tool, toolCallId, args, signal),
				});
			}
		},
	};
}
