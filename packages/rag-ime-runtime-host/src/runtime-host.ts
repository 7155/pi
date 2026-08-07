import { existsSync, readdirSync } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, isAbsolute as pathIsAbsolute, relative, resolve, sep } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { configureHttpDispatcher, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { pendingRoomCancellationSurfaces, roomCancellationSurfaces } from "./cancellation-receipts.ts";
import { PiProductSession } from "./pi-session.ts";
import { ManagedPluginManager } from "./plugin-manager.ts";
import {
	PROTOCOL_NAME,
	PROTOCOL_VERSION,
	parseRoomCancelParams,
	type RoomCancelParams,
	type RuntimeEventEnvelope,
	RuntimeProtocolError,
	type RuntimeRequest,
	sameRoomCancelLineage,
} from "./protocol.ts";
import type { RoomResourceLimits } from "./room-resource-limits.ts";
import { BoundedSessionPool } from "./session-pool.ts";
import {
	codexPluginSkillCatalogNames,
	loadSkillRoutingCardCatalog,
	type SkillRoutingCardCatalog,
} from "./skill-routing-cards.ts";
import { decodeRuntimePrompt } from "./transient-context.ts";

const HOST_VERSION = "1.0.0";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const COMPLETION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const RUNTIME_PRIMITIVE_CAPABILITIES = Object.freeze({
	continuationEnvelope: "2",
	continuationLease: "1",
	cancelScope: "1",
	runScope: "1",
	agentSettledReceipt: "2",
	contextProvider: "1",
	sessionAwaitSettled: true,
	sessionContinuationQueue: true,
	sessionCancelOperationRegistry: true,
	sessionCancelOperations: Object.freeze({
		provider: true,
		tool: true,
		retrySleep: true,
		manualCompaction: true,
		autoCompaction: true,
		branchSummary: true,
		bashProcess: true,
		continuationTimer: true,
	}),
	roomTypes: true,
});

export interface RuntimeHostOptions {
	agentDir: string;
	sessionDir: string;
	pluginsRoot: string;
	pluginInbox: string;
	skillPaths?: string[];
	piSkillPaths?: string[];
	codexSkillPaths?: string[];
	skillRoutingCards?: SkillRoutingCardCatalog;
	maxSessions: number;
	toolGatewayUrl?: string;
	toolGatewayToken?: string;
	pluginApprovalToken?: string;
	allowedWorkspaceRoots?: string[];
	modelRuntime?: ModelRuntime;
	emitEvent(event: RuntimeEventEnvelope): void;
}

interface RoomCancelOperation {
	lineage: RoomCancelParams;
	cancelled?: { cancelledIds: string[]; abortRequired: boolean };
	receipt?: Record<string, unknown>;
	inFlight?: Promise<Record<string, unknown>>;
}

function roomCancelFenceKey(lineage: Pick<RoomCancelParams, "sessionId" | "rootId" | "dispatchId">): string {
	return `${lineage.sessionId}\u001f${lineage.rootId}\u001f${lineage.dispatchId}`;
}

function requiredString(params: Record<string, unknown>, key: string, maximum = 4096): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string, maximum = 4096): string | undefined {
	const value = params[key];
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > maximum) {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a string`);
	}
	return value.trim() || undefined;
}

function optionalBoolean(params: Record<string, unknown>, key: string, fallback = false): boolean {
	const value = params[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a boolean`);
	}
	return value;
}

function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
	const value = params[key];
	if (typeof value !== "boolean") {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a boolean`);
	}
	return value;
}

function sessionIdParam(params: Record<string, unknown>, key: string): string {
	const sessionId = requiredString(params, key, 200);
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} contains unsupported characters`);
	}
	return sessionId;
}

function requiredSessionId(params: Record<string, unknown>): string {
	return sessionIdParam(params, "sessionId");
}

function completionIdParam(params: Record<string, unknown>): string {
	const requestId = requiredString(params, "requestId", 200);
	if (!COMPLETION_ID_PATTERN.test(requestId)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "requestId contains unsupported characters");
	}
	return requestId;
}

function optionalTimeoutMs(params: Record<string, unknown>): number {
	const value = params.timeoutMs;
	if (value === undefined || value === null) return 120_000;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 300_000) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "timeoutMs must be an integer between 1000 and 300000");
	}
	return value;
}

function requiredGeneration(params: Record<string, unknown>): number {
	return requiredNonNegativeInteger(params, "generation");
}

function requiredNonNegativeInteger(params: Record<string, unknown>, key: string): number {
	const value = params[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new RuntimeProtocolError("INVALID_PARAMS", `${key} must be a non-negative safe integer`);
	}
	return value;
}

function optionalRoomCapability(params: Record<string, unknown>): Record<string, unknown> | undefined {
	const value = params.roomCapability;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomCapability must be an object");
	}
	const record = value as Record<string, unknown>;
	for (const key of ["manifestId", "promptCompileReceiptId", "promptPlanHash"] as const) {
		if (typeof record[key] !== "string" || !record[key]) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `roomCapability.${key} is required`);
		}
	}
	if (typeof record.manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.manifestHash)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomCapability.manifestHash must be sha256 hex");
	}
	if (
		typeof record.capabilityEpoch !== "number" ||
		!Number.isSafeInteger(record.capabilityEpoch) ||
		record.capabilityEpoch < 0
	) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomCapability.capabilityEpoch is invalid");
	}
	if (
		record.contextEpoch !== undefined &&
		(typeof record.contextEpoch !== "number" || !Number.isSafeInteger(record.contextEpoch) || record.contextEpoch < 1)
	) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomCapability.contextEpoch is invalid");
	}
	return structuredClone(record);
}

function optionalRoomProviderContext(params: Record<string, unknown>): Record<string, unknown> | undefined {
	const value = params.roomProviderContext;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomProviderContext must be an object");
	}
	const record = value as Record<string, unknown>;
	for (const key of ["journalId", "projectionHash"] as const) {
		if (typeof record[key] !== "string" || !record[key]) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `roomProviderContext.${key} is required`);
		}
	}
	if (
		typeof record.throughSequence !== "number" ||
		!Number.isSafeInteger(record.throughSequence) ||
		record.throughSequence < 0
	) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomProviderContext.throughSequence is invalid");
	}
	return structuredClone(record);
}

function optionalRoomSkillPolicy(params: Record<string, unknown>): Record<string, unknown> | undefined {
	const value = params.roomSkillPolicy;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomSkillPolicy must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.selection !== "required" || typeof record.skillId !== "string" || !record.skillId) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomSkillPolicy must name one required Skill");
	}
	if (typeof record.skillHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.skillHash)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomSkillPolicy.skillHash must be sha256 hex");
	}
	return structuredClone(record);
}

function optionalRoomResourceLimits(params: Record<string, unknown>): RoomResourceLimits | undefined {
	const value = params.roomResourceLimits;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomResourceLimits must be an object");
	}
	const record = value as Record<string, unknown>;
	const result = {} as RoomResourceLimits;
	for (const key of ["deadlineAtMs", "maxOutputTokens", "maxToolCost", "retryRemaining", "repairRemaining"] as const) {
		const entry = record[key];
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `roomResourceLimits.${key} is invalid`);
		}
		result[key] = entry;
	}
	for (const key of ["maxInputTokens", "maxToolCalls"] as const) {
		const entry = record[key];
		if (entry === undefined) continue;
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1) {
			throw new RuntimeProtocolError("INVALID_PARAMS", `roomResourceLimits.${key} is invalid`);
		}
		result[key] = entry;
	}
	if (result.deadlineAtMs <= Date.now() || result.maxOutputTokens < 1) {
		throw new RuntimeProtocolError("ROOM_RESOURCE_LIMIT_EXHAUSTED", "Room resource limit is already exhausted");
	}
	return result;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !pathIsAbsolute(child));
}

function publicModel(model: ReturnType<ModelRuntime["getModels"]>[number]): Record<string, unknown> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevels: getSupportedThinkingLevels(model),
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export class RagImeRuntimeHost {
	readonly modelRuntime: ModelRuntime;
	readonly sessions: BoundedSessionPool<PiProductSession>;
	readonly plugins: ManagedPluginManager;
	private readonly options: RuntimeHostOptions;
	private readonly allowedWorkspaceRoots: string[];
	private readonly completions = new Map<string, AbortController>();
	private readonly roomReceipts = new Map<string, Record<string, unknown>>();
	private readonly roomCancelOperations = new Map<string, RoomCancelOperation>();
	private readonly roomCancelFences = new Map<string, RoomCancelParams>();
	private completionSequence = 0;

	private constructor(options: RuntimeHostOptions, modelRuntime: ModelRuntime) {
		this.options = options;
		this.modelRuntime = modelRuntime;
		this.sessions = new BoundedSessionPool(options.maxSessions);
		this.plugins = new ManagedPluginManager({
			pluginsRoot: options.pluginsRoot,
			inboxRoot: options.pluginInbox,
			approvalToken: options.pluginApprovalToken,
		});
		this.allowedWorkspaceRoots = (options.allowedWorkspaceRoots ?? []).map((path) => resolve(path));
	}

	static async create(options: RuntimeHostOptions): Promise<RagImeRuntimeHost> {
		await Promise.all([
			mkdir(options.agentDir, { recursive: true, mode: 0o700 }),
			mkdir(options.sessionDir, { recursive: true, mode: 0o700 }),
			mkdir(options.pluginsRoot, { recursive: true, mode: 0o700 }),
			mkdir(options.pluginInbox, { recursive: true, mode: 0o700 }),
		]);
		if (!options.modelRuntime) {
			// Importing coding-agent loads npm undici, whose default dispatcher
			// replaces Node's env-aware dispatcher. Reinstall Pi's configured
			// dispatcher before creating the production model runtime so both
			// WebSocket and SSE Provider traffic honor HTTP(S)_PROXY.
			configureHttpDispatcher();
		}
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(options.agentDir, "auth.json"),
				modelsPath: join(options.agentDir, "models.json"),
				allowModelNetwork: false,
			}));
		const host = new RagImeRuntimeHost(options, modelRuntime);
		await host.plugins.initialize();
		return host;
	}

	async dispose(): Promise<void> {
		for (const controller of this.completions.values()) controller.abort();
		this.completions.clear();
		this.roomReceipts.clear();
		this.roomCancelOperations.clear();
		this.roomCancelFences.clear();
		await this.sessions.dispose();
	}

	private clearRoomStateForSession(sessionId: string): void {
		for (const [key, receipt] of this.roomReceipts) {
			if (receipt.sessionId === sessionId) this.roomReceipts.delete(key);
		}
		for (const [cancelId, operation] of this.roomCancelOperations) {
			if (operation.lineage.sessionId === sessionId) this.roomCancelOperations.delete(cancelId);
		}
		for (const [key, lineage] of this.roomCancelFences) {
			if (lineage.sessionId === sessionId) this.roomCancelFences.delete(key);
		}
	}

	private params(request: RuntimeRequest): Record<string, unknown> {
		return request.params ?? {};
	}

	private emitCompletionNotice(requestId: string, payload: Record<string, unknown>): void {
		this.completionSequence += 1;
		this.options.emitEvent({
			protocolVersion: PROTOCOL_VERSION,
			event: "runtime.notice",
			sessionId: requestId,
			sequence: this.completionSequence,
			payload: { requestId, ...payload },
		});
	}

	private session(params: Record<string, unknown>): PiProductSession {
		const sessionId = requiredSessionId(params);
		const session = this.sessions.get(sessionId);
		if (!session) throw new RuntimeProtocolError("SESSION_NOT_FOUND", `Session is not open: ${sessionId}`);
		return session;
	}

	private async applyRoomCancel(
		lineage: RoomCancelParams,
		operation: RoomCancelOperation,
		target: PiProductSession,
	): Promise<Record<string, unknown>> {
		operation.cancelled ??= target.cancelRoom(lineage);
		const abortReceipt = operation.cancelled.abortRequired ? await target.abortRoom(lineage) : undefined;
		if (abortReceipt && abortReceipt.turnId !== lineage.turnId) {
			throw new RuntimeProtocolError(
				"ROOM_CANCEL_LINEAGE_MISMATCH",
				"Room abort receipt does not match the requested active turn",
			);
		}
		const cancellationSurfaces = roomCancellationSurfaces(
			lineage.sessionId,
			operation.cancelled.cancelledIds,
			abortReceipt,
		);
		const pendingTargets = pendingRoomCancellationSurfaces(cancellationSurfaces);
		const receipt = {
			schemaVersion: "wisdom-weasel.room-runtime-receipt.v1",
			receiptKind: "cancel_applied",
			status: "applied",
			cancelId: lineage.cancelId,
			rootId: lineage.rootId,
			dispatchId: lineage.dispatchId,
			generation: lineage.generation,
			sessionId: lineage.sessionId,
			turnId: lineage.turnId,
			capabilityEpoch: lineage.capabilityEpoch,
			cancelledContinuationIds: [...operation.cancelled.cancelledIds],
			activeRunAborted: operation.cancelled.abortRequired,
			pendingTargets,
			cancellationSurfaces,
			sessionAbortReceipt: abortReceipt,
		};
		operation.receipt = receipt;
		if (pendingTargets.length === 0) target.finishRoomCancel(lineage.rootId, lineage.generation, lineage.cancelId);
		return receipt;
	}

	private async workspace(value: unknown): Promise<string> {
		if (typeof value !== "string" || !value.trim()) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "cwd must be a non-empty string");
		}
		let workspace: string;
		try {
			workspace = await realpath(resolve(value));
		} catch {
			throw new RuntimeProtocolError("WORKSPACE_NOT_FOUND", `Workspace does not exist: ${value}`);
		}
		if (!(await stat(workspace)).isDirectory()) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "cwd must refer to a directory");
		}
		if (this.allowedWorkspaceRoots.length && !this.allowedWorkspaceRoots.some((root) => isInside(root, workspace))) {
			throw new RuntimeProtocolError("WORKSPACE_DENIED", "Workspace is outside the configured roots");
		}
		return workspace;
	}

	private async reloadPlugins(): Promise<void> {
		await Promise.allSettled(this.sessions.list().map(async (session) => session.reloadPlugins()));
	}

	async handle(request: RuntimeRequest): Promise<unknown> {
		const params = this.params(request);
		switch (request.method) {
			case "hello":
				return {
					protocol: PROTOCOL_NAME,
					protocolVersion: PROTOCOL_VERSION,
					hostVersion: HOST_VERSION,
					piVersion: "0.80.7",
					capabilities: {
						multiSession: true,
						maxSessions: this.sessions.maxSessions,
						concurrentControlPlane: true,
						settledEvents: true,
						dynamicTools: true,
						sessionControlState: true,
						sessionSnapshot: true,
						conversationFork: true,
						managedPlugins: true,
						pluginDrafts: true,
						managedSkills: true,
						commandCatalog: true,
						debugContext: true,
						persistentDebugContext: Boolean(process.env.RAG_IME_PI_DEBUG_CONTEXT_DIR),
						conversationRewrite: true,
						activeTurnMessaging: true,
						statelessCompletion: true,
						transientContext: true,
						runtimePrimitives: RUNTIME_PRIMITIVE_CAPABILITIES,
					},
				};
			case "health":
				return {
					ok: true,
					protocolVersion: PROTOCOL_VERSION,
					openSessions: this.sessions.size,
					maxSessions: this.sessions.maxSessions,
					modelError: this.modelRuntime.getError() ?? "",
				};
			case "models.list": {
				// models.json contains connection/selection references, while Pi owns
				// the live catalog capabilities. Re-read the file on every catalog
				// request so product clients never need to cache or duplicate them.
				try {
					await this.modelRuntime.reloadConfig();
				} catch {
					// reloadConfig records configuration and availability failures for
					// the public error field; return the runtime's resulting snapshot.
				}
				let models: Model<Api>[];
				try {
					models = [...(await this.modelRuntime.getAvailable())];
				} catch {
					models = [...this.modelRuntime.getAvailableSnapshot()];
				}
				models.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
				return { models: models.map(publicModel), error: this.modelRuntime.getError() ?? "" };
			}
			case "completion.once": {
				const requestId = completionIdParam(params);
				const provider = requiredString(params, "provider", 80);
				const modelId = requiredString(params, "modelId", 200);
				const thinkingLevel = requiredString(params, "thinkingLevel", 20) as ModelThinkingLevel;
				const timeoutMs = optionalTimeoutMs(params);
				if (!THINKING_LEVELS.has(thinkingLevel)) {
					throw new RuntimeProtocolError("INVALID_PARAMS", `Unsupported thinkingLevel: ${thinkingLevel}`);
				}
				if (this.completions.has(requestId)) {
					throw new RuntimeProtocolError("REQUEST_ALREADY_ACTIVE", `Completion is already active: ${requestId}`);
				}

				const controller = new AbortController();
				this.completions.set(requestId, controller);
				const started = performance.now();
				try {
					// Re-read Pi's local configuration for every request. The product only
					// stores a model reference; Pi remains the model/capability authority.
					try {
						await this.modelRuntime.reloadConfig();
					} catch {
						// Use the resulting availability snapshot so the caller receives the
						// concrete model/configuration error below instead of stale metadata.
					}
					let available: readonly Model<Api>[];
					try {
						available = await this.modelRuntime.getAvailable();
					} catch {
						available = this.modelRuntime.getAvailableSnapshot();
					}
					const model = available.find((entry) => entry.provider === provider && entry.id === modelId);
					if (!model) {
						throw new RuntimeProtocolError(
							"MODEL_NOT_AVAILABLE",
							`Pi model is not available: ${provider}/${modelId}`,
							{ modelError: this.modelRuntime.getError() ?? "" },
						);
					}
					if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) {
						throw new RuntimeProtocolError(
							"THINKING_NOT_SUPPORTED",
							`Pi model ${provider}/${modelId} does not support ${thinkingLevel} thinking`,
						);
					}
					if (params.images !== undefined) {
						throw new RuntimeProtocolError(
							"INVALID_PARAMS",
							"Stateless completion does not accept images; provide semantic Context Packet text",
						);
					}
					if (controller.signal.aborted) {
						throw new RuntimeProtocolError("REQUEST_ABORTED", "Stateless completion was cancelled");
					}
					const message = requiredString(params, "message", 64_000);
					const context: Context = {
						messages: [
							{
								role: "user",
								content: message,
								timestamp: Date.now(),
							},
						],
					};
					const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;
					const stream = this.modelRuntime.streamSimple(model, context, {
						...(reasoning ? { reasoning } : {}),
						cacheRetention: "none",
						maxRetries: 0,
						maxTokens: Math.min(model.maxTokens, 4096),
						signal: controller.signal,
						timeoutMs,
					});
					let response: AssistantMessage | undefined;
					let firstTokenMs = 0;
					let reasoningStartedAtMs = 0;
					let reasoningEndedAtMs = 0;
					let reasoningChars = 0;
					let lastReasoningProgressChars = 0;
					for await (const event of stream) {
						if (controller.signal.aborted) break;
						if (event.type === "thinking_start") {
							if (reasoningStartedAtMs <= 0) {
								reasoningStartedAtMs = Math.max(1, Math.round(performance.now() - started));
								this.emitCompletionNotice(requestId, {
									type: "completion_reasoning_progress",
									phase: "started",
									totalChars: 0,
									elapsedMs: reasoningStartedAtMs,
								});
							}
							continue;
						}
						if (event.type === "thinking_delta") {
							reasoningChars += event.delta.length;
							if (reasoningStartedAtMs <= 0) {
								reasoningStartedAtMs = Math.max(1, Math.round(performance.now() - started));
								this.emitCompletionNotice(requestId, {
									type: "completion_reasoning_progress",
									phase: "started",
									totalChars: 0,
									elapsedMs: reasoningStartedAtMs,
								});
							}
							if (reasoningChars - lastReasoningProgressChars >= 128) {
								lastReasoningProgressChars = reasoningChars;
								this.emitCompletionNotice(requestId, {
									type: "completion_reasoning_progress",
									phase: "streaming",
									totalChars: reasoningChars,
									elapsedMs: Math.max(1, Math.round(performance.now() - started)),
								});
							}
							continue;
						}
						if (event.type === "thinking_end") {
							reasoningChars = Math.max(reasoningChars, event.content.length);
							reasoningEndedAtMs = Math.max(1, Math.round(performance.now() - started));
							this.emitCompletionNotice(requestId, {
								type: "completion_reasoning_progress",
								phase: "completed",
								totalChars: reasoningChars,
								elapsedMs: reasoningEndedAtMs,
							});
							continue;
						}
						if (event.type === "text_delta" && event.delta) {
							if (firstTokenMs <= 0) {
								firstTokenMs = Math.max(1, Math.round(performance.now() - started));
							}
							this.emitCompletionNotice(requestId, {
								type: "completion_text_delta",
								delta: event.delta,
								elapsedMs: Math.max(1, Math.round(performance.now() - started)),
							});
							continue;
						}
						if (event.type === "done") {
							response = event.message;
						} else if (event.type === "error") {
							response = event.error;
						}
					}
					response ??= await stream.result();
					if (response.stopReason === "error" || response.stopReason === "aborted") {
						throw new RuntimeProtocolError(
							response.stopReason === "aborted" ? "REQUEST_ABORTED" : "COMPLETION_FAILED",
							response.errorMessage || `Stateless completion ${response.stopReason}`,
						);
					}
					if (response.stopReason === "toolUse") {
						throw new RuntimeProtocolError("UNEXPECTED_TOOL_USE", "Stateless completion cannot call tools");
					}
					const text = response.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("")
						.trim();
					if (!text) {
						throw new RuntimeProtocolError("EMPTY_COMPLETION", "Stateless completion returned no text");
					}
					return {
						requestId,
						text,
						provider,
						modelId,
						thinkingLevel,
						usage: response.usage,
						stopReason: response.stopReason,
						firstTokenMs,
						reasoningChars,
						reasoningElapsedMs:
							reasoningStartedAtMs > 0
								? Math.max(
										0,
										(reasoningEndedAtMs || Math.round(performance.now() - started)) - reasoningStartedAtMs,
									)
								: 0,
						elapsedMs: Math.max(0, Math.round(performance.now() - started)),
					};
				} finally {
					this.completions.delete(requestId);
				}
			}
			case "completion.cancel": {
				const requestId = completionIdParam(params);
				const controller = this.completions.get(requestId);
				controller?.abort();
				return { requestId, cancelled: controller !== undefined };
			}
			case "session.open": {
				const sessionId = requiredSessionId(params);
				const cwd = await this.workspace(params.cwd);
				const provider = optionalString(params, "provider", 80);
				const modelId = optionalString(params, "modelId", 200);
				const thinking = optionalString(params, "thinkingLevel", 20);
				if (thinking && !THINKING_LEVELS.has(thinking as ModelThinkingLevel)) {
					throw new RuntimeProtocolError("INVALID_PARAMS", `Unsupported thinkingLevel: ${thinking}`);
				}
				const sessionFile = optionalString(params, "sessionFile", 4096);
				if (sessionFile && !isInside(resolve(this.options.sessionDir), resolve(sessionFile))) {
					throw new RuntimeProtocolError(
						"SESSION_PATH_DENIED",
						"sessionFile is outside the managed session directory",
					);
				}
				const opened = await this.sessions.open(sessionId, async () =>
					PiProductSession.create({
						externalSessionId: sessionId,
						cwd,
						sessionDir: this.options.sessionDir,
						sessionFile,
						agentDir: this.options.agentDir,
						activePluginDir: this.plugins.activeDir,
						skillPaths: this.options.skillPaths ?? [],
						piSkillPaths: this.options.piSkillPaths ?? [],
						codexSkillPaths: this.options.codexSkillPaths ?? [],
						skillRoutingCards: this.options.skillRoutingCards,
						piSkillsEnabled: optionalBoolean(params, "piSkillsEnabled"),
						codexSkillsEnabled: optionalBoolean(params, "codexSkillsEnabled"),
						modelRuntime: this.modelRuntime,
						provider,
						modelId,
						thinkingLevel: thinking as ModelThinkingLevel | undefined,
						toolManifest: params.toolManifest ?? [],
						roomCapability: optionalRoomCapability(params),
						toolGatewayUrl: this.options.toolGatewayUrl,
						toolGatewayToken: this.options.toolGatewayToken,
						systemPrompt: optionalString(params, "systemPrompt", 64_000),
						sessionContext: optionalString(params, "sessionContext", 256_000),
						roomContext: optionalString(params, "roomContext", 256_000),
						roomRecoveryContext: optionalString(params, "roomRecoveryContext", 256_000),
						roomProviderContext: optionalRoomProviderContext(params),
						roomSkillPolicy: optionalRoomSkillPolicy(params),
						roomResourceLimits: optionalRoomResourceLimits(params),
						noContextFiles: optionalBoolean(params, "noContextFiles"),
						emitEvent: this.options.emitEvent,
					}),
				);
				if (opened.evictedSessionId) this.clearRoomStateForSession(opened.evictedSessionId);
				return {
					// Opening a long-lived Session must never serialize its full
					// transcript onto the shared JSONL control lane. Explicit
					// session.snapshot remains available to history consumers.
					snapshot: opened.session.openSnapshot(),
					evictedSessionId: opened.evictedSessionId,
					roomSkillLoad: opened.session.roomSkillLoadReceipt(),
				};
			}
			case "session.control_state":
				return this.session(params).controlState();
			case "session.await_settled":
				return await this.session(params).awaitSettled(requiredString(params, "turnId", 240), {
					allowSuspended: optionalBoolean(params, "allowSuspended"),
					timeoutMs: params.timeoutMs === undefined ? undefined : requiredNonNegativeInteger(params, "timeoutMs"),
				});
			case "session.snapshot":
				return this.session(params).snapshot();
			case "session.debug.context":
				return this.session(params).debugContext(optionalString(params, "turnId", 240));
			case "session.commands":
				return { commands: this.session(params).listCommands() };
			case "session.fork.candidates":
				return { items: this.session(params).forkCandidates() };
			case "session.fork": {
				const sourceSessionId = requiredSessionId(params);
				const targetSessionId = sessionIdParam(params, "targetSessionId");
				if (sourceSessionId === targetSessionId) {
					throw new RuntimeProtocolError("INVALID_PARAMS", "Conversation fork target must differ from its source");
				}
				const source = this.session(params);
				if (this.sessions.get(targetSessionId)) {
					throw new RuntimeProtocolError("SESSION_ALREADY_OPEN", `Session is already open: ${targetSessionId}`);
				}
				const prepared = source.prepareFork(requiredString(params, "entryId", 240));
				const profile = source.forkRuntimeProfile();
				let targetCreated = false;
				try {
					const opened = await this.sessions.open(targetSessionId, async () =>
						PiProductSession.create({
							externalSessionId: targetSessionId,
							cwd: profile.cwd,
							sessionDir: this.options.sessionDir,
							sessionManager: prepared.sessionManager,
							agentDir: this.options.agentDir,
							activePluginDir: this.plugins.activeDir,
							skillPaths: this.options.skillPaths ?? [],
							piSkillPaths: this.options.piSkillPaths ?? [],
							codexSkillPaths: this.options.codexSkillPaths ?? [],
							skillRoutingCards: this.options.skillRoutingCards,
							piSkillsEnabled: profile.piSkillsEnabled,
							codexSkillsEnabled: profile.codexSkillsEnabled,
							modelRuntime: this.modelRuntime,
							provider: profile.provider,
							modelId: profile.modelId,
							thinkingLevel: profile.thinkingLevel,
							toolManifest: profile.toolManifest,
							roomCapability: profile.roomCapability,
							toolGatewayUrl: this.options.toolGatewayUrl,
							toolGatewayToken: this.options.toolGatewayToken,
							systemPrompt: profile.systemPrompt,
							noContextFiles: profile.noContextFiles,
							emitEvent: this.options.emitEvent,
						}),
					);
					if (opened.evictedSessionId) this.clearRoomStateForSession(opened.evictedSessionId);
					if (!opened.created) {
						throw new RuntimeProtocolError("SESSION_ALREADY_OPEN", `Session is already open: ${targetSessionId}`);
					}
					targetCreated = true;
					return {
						sourceSessionId,
						targetSessionId,
						entryId: prepared.entryId,
						selectedText: prepared.selectedText,
						branchAnchor: prepared.branchAnchor,
						snapshot: opened.session.snapshot(),
						evictedSessionId: opened.evictedSessionId,
					};
				} catch (error) {
					if (targetCreated) await this.sessions.close(targetSessionId);
					await rm(prepared.sessionFile, { force: true });
					throw error;
				}
			}
			case "session.rewind":
				return this.session(params).rewind(requiredString(params, "entryId", 240));
			case "session.prompt": {
				const prompt = decodeRuntimePrompt(requiredString(params, "message", 1_000_000));
				return this.session(params).prompt({
					message: prompt.message,
					sessionContext: prompt.sessionContext,
					transientContext: prompt.transientContext,
					clientMessageId: optionalString(params, "clientMessageId", 128),
					images: Array.isArray(params.images) ? (params.images as never) : undefined,
				});
			}
			case "session.steer":
				return this.session(params).queueMessage({
					delivery: "steer",
					message: requiredString(params, "message", 1_000_000),
					clientMessageId: optionalString(params, "clientMessageId", 128),
					images: Array.isArray(params.images) ? (params.images as never) : undefined,
				});
			case "session.follow_up":
				return this.session(params).queueMessage({
					delivery: "followUp",
					message: requiredString(params, "message", 1_000_000),
					clientMessageId: optionalString(params, "clientMessageId", 128),
					images: Array.isArray(params.images) ? (params.images as never) : undefined,
				});
			case "session.abort":
				return this.session(params).abort();
			case "session.compact":
				return this.session(params).compact(optionalString(params, "instructions", 4000));
			case "session.model.set":
				return this.session(params).setModel(
					requiredString(params, "provider", 80),
					requiredString(params, "modelId", 200),
				);
			case "session.thinking.set": {
				const level = requiredString(params, "level", 20);
				if (!THINKING_LEVELS.has(level as ModelThinkingLevel)) {
					throw new RuntimeProtocolError("INVALID_PARAMS", `Unsupported thinking level: ${level}`);
				}
				return this.session(params).setThinkingLevel(level as ModelThinkingLevel);
			}
			case "session.close": {
				const sessionId = requiredSessionId(params);
				const closed = await this.sessions.close(sessionId);
				if (closed) this.clearRoomStateForSession(sessionId);
				return { closed };
			}
			case "room.dispatch": {
				const sessionId = requiredSessionId(params);
				const dispatchId = requiredString(params, "dispatchId", 240);
				const rootId = requiredString(params, "rootId", 240);
				const generation = requiredGeneration(params);
				const capabilityEpoch = requiredNonNegativeInteger(params, "capabilityEpoch");
				const dispatchAttempt = requiredNonNegativeInteger(params, "dispatchAttempt");
				const idempotencyKey = requiredString(params, "idempotencyKey", 512);
				const receiptKey = `${rootId}\u001f${idempotencyKey}`;
				const existing = this.roomReceipts.get(receiptKey);
				if (existing) return { ...existing, duplicate: true };
				const cancelFence = this.roomCancelFences.get(roomCancelFenceKey({ sessionId, rootId, dispatchId }));
				if (cancelFence) {
					throw new RuntimeProtocolError(
						"ROOM_DISPATCH_CANCELLED",
						generation <= cancelFence.generation
							? "Room Dispatch is cancelling or already cancelled at this generation"
							: "A cancelled Room Dispatch cannot be resumed; create a new Dispatch identity",
					);
				}
				const accepted = await this.session(params).dispatchRoom({
					message: requiredString(params, "message", 1_000_000),
					dispatchId,
					rootId,
					generation,
					capabilityEpoch,
					dispatchAttempt,
					sessionContext: optionalString(params, "sessionContext", 256_000),
					roomContext: optionalString(params, "roomContext", 256_000),
					roomRecoveryContext: optionalString(params, "roomRecoveryContext", 256_000),
					roomProviderContext: optionalRoomProviderContext(params),
					roomCapability: optionalRoomCapability(params),
					roomResourceLimits: optionalRoomResourceLimits(params),
				});
				const receipt = {
					schemaVersion: "wisdom-weasel.room-runtime-receipt.v1",
					receiptKind: "dispatch_accepted",
					status: "accepted",
					rootId,
					dispatchId,
					generation,
					capabilityEpoch,
					sessionId,
					...accepted,
				};
				this.roomReceipts.set(receiptKey, receipt);
				return receipt;
			}
			case "room.cancel": {
				const lineage = parseRoomCancelParams(params);
				const existingOperation = this.roomCancelOperations.get(lineage.cancelId);
				if (existingOperation && !sameRoomCancelLineage(existingOperation.lineage, lineage)) {
					throw new RuntimeProtocolError(
						"ROOM_CANCEL_LINEAGE_MISMATCH",
						"Room cancellation reuses cancelId with different runtime lineage",
					);
				}
				if (
					existingOperation?.receipt &&
					Array.isArray(existingOperation.receipt.pendingTargets) &&
					existingOperation.receipt.pendingTargets.length === 0
				) {
					return structuredClone(existingOperation.receipt);
				}
				const acceptedLineage = [...this.roomReceipts.values()].some(
					(receipt) =>
						receipt.receiptKind === "dispatch_accepted" &&
						receipt.status === "accepted" &&
						receipt.sessionId === lineage.sessionId &&
						receipt.rootId === lineage.rootId &&
						receipt.dispatchId === lineage.dispatchId &&
						receipt.turnId === lineage.turnId &&
						receipt.capabilityEpoch === lineage.capabilityEpoch &&
						typeof receipt.generation === "number" &&
						receipt.generation <= lineage.generation,
				);
				if (!acceptedLineage) {
					throw new RuntimeProtocolError(
						"ROOM_CANCEL_LINEAGE_MISMATCH",
						"Room cancellation does not match an active Room dispatch receipt",
					);
				}
				const target = this.session(params);
				const operation = existingOperation ?? { lineage: structuredClone(lineage) };
				if (!existingOperation) {
					this.roomCancelOperations.set(lineage.cancelId, operation);
					this.roomCancelFences.set(roomCancelFenceKey(lineage), structuredClone(lineage));
				}
				if (operation.inFlight) return structuredClone(await operation.inFlight);
				const run = this.applyRoomCancel(lineage, operation, target);
				operation.inFlight = run;
				try {
					return structuredClone(await run);
				} catch (error) {
					if (!operation.cancelled) {
						this.roomCancelOperations.delete(lineage.cancelId);
						const fenceKey = roomCancelFenceKey(lineage);
						if (this.roomCancelFences.get(fenceKey)?.cancelId === lineage.cancelId) {
							this.roomCancelFences.delete(fenceKey);
						}
					}
					throw error;
				} finally {
					if (operation.inFlight === run) operation.inFlight = undefined;
				}
			}
			case "approval.resolve":
				return {
					requestId: this.session(params).resolveDecision(
						"approval",
						requiredString(params, "approvalId", 240),
						params.approved === true,
					),
				};
			case "review.resolve":
				return {
					requestId: this.session(params).resolveDecision(
						"review",
						requiredString(params, "runId", 240),
						params.reviewed === true,
					),
				};
			case "ui.resolve": {
				const response = params.response;
				if (typeof response !== "object" || response === null || Array.isArray(response)) {
					throw new RuntimeProtocolError("INVALID_PARAMS", "response must be an object");
				}
				return this.session(params).resolveUI(
					requiredString(params, "requestId", 240),
					response as Record<string, unknown>,
				);
			}
			case "tools.list":
				return { tools: this.session(params).listTools() };
			case "tools.sync":
				return { tools: await this.session(params).syncTools(params.tools) };
			case "plugins.list":
				return { plugins: await this.plugins.list() };
			case "plugins.create":
				return this.plugins.createDraft({
					draftId: requiredString(params, "draftId", 64),
					manifest: params.manifest,
					files: params.files as Record<string, string>,
				});
			case "plugins.validate":
				return this.plugins.validate(requiredString(params, "sourcePath"));
			case "plugins.install": {
				const plugin = await this.plugins.install({
					sourcePath: requiredString(params, "sourcePath"),
					expectedDigest: requiredString(params, "expectedDigest", 64),
					approvalToken: optionalString(params, "approvalToken", 1024),
					enable: params.enable === true,
				});
				await this.reloadPlugins();
				return plugin;
			}
			case "plugins.enable": {
				const plugin = await this.plugins.enable(
					requiredString(params, "pluginId", 64),
					optionalString(params, "approvalToken", 1024),
					requiredString(params, "expectedActiveDigest", 64),
					requiredBoolean(params, "expectedEnabled"),
				);
				await this.reloadPlugins();
				return plugin;
			}
			case "plugins.disable": {
				const plugin = await this.plugins.disable(
					requiredString(params, "pluginId", 64),
					optionalString(params, "approvalToken", 1024),
					requiredString(params, "expectedActiveDigest", 64),
					requiredBoolean(params, "expectedEnabled"),
				);
				await this.reloadPlugins();
				return plugin;
			}
			case "plugins.rollback": {
				const plugin = await this.plugins.rollback(
					requiredString(params, "pluginId", 64),
					optionalString(params, "approvalToken", 1024),
					requiredString(params, "expectedActiveDigest", 64),
					requiredString(params, "targetDigest", 64),
				);
				await this.reloadPlugins();
				return plugin;
			}
		}
	}
}

function childDirectories(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
	} catch {
		return [];
	}
}

function discoverCatalogedCodexPluginSkills(codexHome: string, catalog: SkillRoutingCardCatalog): string[] {
	const cacheRoot = join(codexHome, "plugins", "cache");
	const paths: string[] = [];
	for (const marketplace of childDirectories(cacheRoot)) {
		const marketplaceRoot = join(cacheRoot, marketplace);
		for (const pluginName of childDirectories(marketplaceRoot)) {
			const pluginRoot = join(marketplaceRoot, pluginName);
			const newestVersion = childDirectories(pluginRoot).at(-1);
			if (newestVersion) {
				const skillsRoot = join(pluginRoot, newestVersion, "skills");
				for (const skillName of childDirectories(skillsRoot)) {
					const matchesCatalog = codexPluginSkillCatalogNames(pluginName, skillName).some(
						(name) => catalog[name] !== undefined,
					);
					const skillPath = join(skillsRoot, skillName);
					if (matchesCatalog && existsSync(join(skillPath, "SKILL.md"))) paths.push(skillPath);
				}
			}
		}
	}
	return [...new Set(paths)];
}

export function runtimeHostOptionsFromEnvironment(
	emitEvent: (event: RuntimeEventEnvelope) => void,
): RuntimeHostOptions {
	const appSupport = resolve(
		process.env.RAG_IME_APP_SUPPORT_DIR || join(homedir(), "Library", "Application Support", "RagIme"),
	);
	const agentDir = resolve(process.env.RAG_IME_PI_AGENT_DIR || join(appSupport, "Agent", "config"));
	const roots = (process.env.RAG_IME_WORKSPACE_ROOTS ?? "")
		.split(process.platform === "win32" ? ";" : ":")
		.map((value) => value.trim())
		.filter(Boolean);
	const maxSessionsValue = Number.parseInt(process.env.RAG_IME_PI_MAX_SESSIONS || "8", 10);
	const configuredSkillPaths = (process.env.RAG_IME_PI_SKILL_PATHS ?? "")
		.split(delimiter)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => resolve(value));
	const configuredPiSkillPaths = (process.env.RAG_IME_PI_USER_SKILL_PATHS ?? "")
		.split(delimiter)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => resolve(value));
	const piAgentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
	const configuredCodexSkillPaths = (process.env.RAG_IME_CODEX_SKILL_PATHS ?? "")
		.split(delimiter)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => resolve(value));
	const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
	const routingCardsPath = (process.env.RAG_IME_PI_SKILL_ROUTING_CARDS ?? "").trim();
	const skillRoutingCards = routingCardsPath ? loadSkillRoutingCardCatalog(resolve(routingCardsPath)) : {};
	const codexDefaults = [
		join(codexHome, "skills", ".system"),
		join(codexHome, "skills"),
		join(homedir(), ".agents", "skills"),
		...discoverCatalogedCodexPluginSkills(codexHome, skillRoutingCards),
	];
	return {
		agentDir,
		sessionDir: resolve(process.env.RAG_IME_PI_SESSION_DIR || join(appSupport, "Agent", "sessions")),
		pluginsRoot: resolve(process.env.RAG_IME_PI_PLUGINS_DIR || join(appSupport, "Agent", "plugins")),
		pluginInbox: resolve(process.env.RAG_IME_PI_PLUGIN_INBOX || join(appSupport, "Agent", "plugin-inbox")),
		skillPaths: [...new Set(configuredSkillPaths)],
		piSkillPaths: [...new Set(configuredPiSkillPaths.length ? configuredPiSkillPaths : [join(piAgentDir, "skills")])],
		codexSkillPaths: [...new Set(configuredCodexSkillPaths.length ? configuredCodexSkillPaths : codexDefaults)],
		skillRoutingCards,
		maxSessions: Number.isInteger(maxSessionsValue) && maxSessionsValue > 0 ? Math.min(maxSessionsValue, 32) : 8,
		toolGatewayUrl: process.env.RAG_IME_TOOL_GATEWAY_URL,
		toolGatewayToken: process.env.RAG_IME_TOOL_GATEWAY_TOKEN,
		pluginApprovalToken: process.env.RAG_IME_PLUGIN_APPROVAL_TOKEN,
		allowedWorkspaceRoots: roots,
		emitEvent,
	};
}
