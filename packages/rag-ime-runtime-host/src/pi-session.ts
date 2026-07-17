import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	type PromptOptions,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PiDebugContextRecorder } from "./debug-context.ts";
import { createDiscoveryToolsExtension, diffSkillCatalog, runtimeSkillCatalogRevision } from "./discovery-tools.ts";
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, RuntimeProtocolError } from "./protocol.ts";
import { TOOL_LOAD_TOOL_NAME } from "./runtime-tool-names.ts";
import type { PooledSession } from "./session-pool.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	BackendToolRegistry,
	backendToolSchemaRevision,
	createBackendToolExtension,
	diffBackendToolCatalog,
} from "./tool-bridge.ts";

export interface PiSessionOpenOptions {
	externalSessionId: string;
	cwd: string;
	sessionDir: string;
	sessionFile?: string;
	sessionManager?: SessionManager;
	agentDir: string;
	activePluginDir: string;
	skillPaths: string[];
	modelRuntime: ModelRuntime;
	provider?: string;
	modelId?: string;
	thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	toolManifest?: unknown;
	toolGatewayUrl?: string;
	toolGatewayToken?: string;
	systemPrompt?: string;
	noContextFiles?: boolean;
	emitEvent(event: RuntimeEventEnvelope): void;
}

export interface PreparedPiFork {
	entryId: string;
	selectedText: string;
	branchAnchor: string;
	sessionFile: string;
	sessionManager: SessionManager;
}

export interface PublicPiForkCandidate {
	entryId: string;
	text: string;
	role: "user" | "assistant";
	createdAtMs: number;
}

export interface PiForkRuntimeProfile {
	cwd: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	toolManifest: BackendToolManifest[];
	systemPrompt: string;
	noContextFiles: boolean;
}

const RAG_USER_QUERY_PATTERN = /<rag-ime-user-query>\s*([\s\S]*?)\s*<\/rag-ime-user-query>/i;
const RAG_WRAPPER_PATTERN = /<\/?rag-ime-(?:deep-search-context|user-query)\b/i;

function messageBlocks(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) return [];
	return content.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return messageBlocks(content)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("")
		.trim();
}

function publicUserText(content: unknown): string | undefined {
	const rawText = textFromContent(content);
	const taggedQuery = RAG_USER_QUERY_PATTERN.exec(rawText)?.[1]?.trim();
	if (taggedQuery) return taggedQuery;

	// The wrapper contains private retrieval context. Fail closed unless it carries
	// the explicit public-query tag above.
	if (RAG_WRAPPER_PATTERN.test(rawText)) return undefined;
	if (rawText) return rawText;
	if (messageBlocks(content).some((item) => item.type === "image")) return "非文本消息";
	return undefined;
}

function publicAssistantText(message: Record<string, unknown>): string | undefined {
	const blocks = messageBlocks(message.content);
	if (blocks.some((item) => item.type === "toolCall" || item.type === "tool_call")) {
		return undefined;
	}
	const text = textFromContent(message.content);
	if (text) return text;
	if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
		return message.errorMessage.trim();
	}
	if (blocks.some((item) => item.type === "image")) return "非文本消息";
	return undefined;
}

function entryCreatedAtMs(entryTimestamp: string, messageTimestamp: unknown): number {
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
	const parsed = Date.parse(entryTimestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Restore only schemas explicitly disclosed by tool_load on the active branch. */
export function restoreBackendToolDisclosures(registry: BackendToolRegistry, sessionManager: SessionManager): string[] {
	const restored = new Set<string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = objectRecord(entry.message);
		if (message?.role !== "toolResult" || message.isError === true) continue;
		if (message.toolName !== TOOL_LOAD_TOOL_NAME) continue;

		const details = objectRecord(message.details);
		const loadedTool = objectRecord(details?.tool);
		const loadedName = typeof loadedTool?.name === "string" ? loadedTool.name : "";
		if (registry.get(loadedName)) restored.add(loadedName);
	}
	for (const name of restored) registry.disclose(name);
	return [...restored].sort();
}

function applyBackendToolDisclosure(session: AgentSession, registry: BackendToolRegistry): string[] {
	const backendNames = new Set(registry.list().map((tool) => tool.name));
	const visibleNames = session.getActiveToolNames().filter((name) => !backendNames.has(name));
	visibleNames.push(...registry.disclosed().map((tool) => tool.name));
	const uniqueNames = [...new Set(visibleNames)];
	session.setActiveToolsByName(uniqueNames);
	return uniqueNames;
}

export function publicPiForkCandidates(sourceManager: SessionManager): PublicPiForkCandidate[] {
	const result: PublicPiForkCandidate[] = [];
	for (const entry of sourceManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const text = message.role === "user" ? publicUserText(message.content) : publicAssistantText(message);
		if (!text) continue;
		result.push({
			entryId: entry.id,
			text,
			role: message.role,
			createdAtMs: entryCreatedAtMs(entry.timestamp, message.timestamp),
		});
	}
	return result;
}

export function prepareNativePiFork(sourceManager: SessionManager, entryId: string): PreparedPiFork {
	const selected = sourceManager.getEntry(entryId);
	const candidate = publicPiForkCandidates(sourceManager).find((item) => item.entryId === entryId);
	if (!selected || selected.type !== "message" || !candidate) {
		throw new RuntimeProtocolError(
			"INVALID_FORK_TARGET",
			"Fork entry must identify a public user or assistant message",
		);
	}
	const sourceFile = sourceManager.getSessionFile();
	if (!sourceManager.isPersisted() || !sourceFile) {
		throw new RuntimeProtocolError("SESSION_NOT_PERSISTED", "Conversation forks require a persisted source Session");
	}
	const targetLeafId = candidate.role === "assistant" ? selected.id : selected.parentId;
	const selectedText = candidate.role === "user" ? candidate.text : "";
	let sessionManager: SessionManager;
	let sessionFile: string | undefined;
	if (targetLeafId) {
		sessionManager = SessionManager.open(sourceFile, sourceManager.getSessionDir(), sourceManager.getCwd());
		sessionFile = sessionManager.createBranchedSession(targetLeafId);
	} else {
		sessionManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir());
		sessionFile = sessionManager.newSession({ parentSession: sourceFile });
	}
	if (!sessionFile || sessionFile === sourceFile) {
		throw new RuntimeProtocolError("FORK_FAILED", "Pi did not create a distinct branch transcript");
	}
	return {
		entryId,
		selectedText,
		branchAnchor: targetLeafId ?? "",
		sessionFile,
		sessionManager,
	};
}

export function publicPiRewriteTarget(sourceManager: SessionManager, entryId: string): PublicPiForkCandidate {
	const selected = sourceManager.getEntry(entryId);
	const candidate = publicPiForkCandidates(sourceManager).find((item) => item.entryId === entryId);
	if (!selected || selected.type !== "message" || candidate?.role !== "user") {
		throw new RuntimeProtocolError("INVALID_REWRITE_TARGET", "Rewrite entry must identify a public user message");
	}
	return candidate;
}

export interface ActiveTurn {
	turnId: string;
	clientMessageId?: string;
}

interface PublicCompactionState {
	reason: "manual" | "threshold" | "overflow";
	status: "running" | "completed" | "failed" | "aborted";
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	willRetry?: boolean;
	error?: string;
	updatedAtMs: number;
}

function toSerializableEvent(event: AgentSessionEvent): Record<string, unknown> {
	return { ...(event as unknown as Record<string, unknown>) };
}

function publicSessionModel(model: Model<Api>): Record<string, unknown> {
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

export class PiProductSession implements PooledSession {
	readonly externalSessionId: string;
	readonly cwd: string;
	readonly toolRegistry: BackendToolRegistry;
	readonly noContextFiles: boolean;
	private readonly session: AgentSession;
	private readonly resourceLoader: DefaultResourceLoader;
	private readonly settingsManager: SettingsManager;
	private readonly debugContextRecorder: PiDebugContextRecorder;
	private readonly emitEvent: (event: RuntimeEventEnvelope) => void;
	private unsubscribe: (() => void) | undefined;
	private sequence = 0;
	private activeTurn: ActiveTurn | undefined;
	private latestCompaction: PublicCompactionState | undefined;
	private readonly pendingDecisions = new Map<
		string,
		{ requestId: string; resolve(value: boolean): void; cleanup(): void }
	>();

	private constructor(
		options: PiSessionOpenOptions,
		session: AgentSession,
		registry: BackendToolRegistry,
		resourceLoader: DefaultResourceLoader,
		settingsManager: SettingsManager,
		debugContextRecorder: PiDebugContextRecorder,
	) {
		this.externalSessionId = options.externalSessionId;
		this.cwd = options.cwd;
		this.noContextFiles = options.noContextFiles ?? false;
		this.session = session;
		this.toolRegistry = registry;
		this.resourceLoader = resourceLoader;
		this.settingsManager = settingsManager;
		this.debugContextRecorder = debugContextRecorder;
		this.emitEvent = options.emitEvent;
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
	}

	static async create(options: PiSessionOpenOptions): Promise<PiProductSession> {
		const registry = new BackendToolRegistry();
		if (options.toolManifest !== undefined) registry.sync(options.toolManifest);
		const sessionManager =
			options.sessionManager ??
			(options.sessionFile
				? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
				: SessionManager.create(options.cwd, options.sessionDir));
		restoreBackendToolDisclosures(registry, sessionManager);
		let productSession: PiProductSession | undefined;
		const debugContextRecorder = new PiDebugContextRecorder(
			options.externalSessionId,
			() => productSession?.activeTurn,
			{
				directory: process.env.RAG_IME_PI_DEBUG_CONTEXT_DIR,
				maxBytes: Number.parseInt(process.env.RAG_IME_PI_DEBUG_CONTEXT_MAX_BYTES ?? "", 10),
			},
		);
		const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
		let resourceLoader: DefaultResourceLoader | undefined;
		const getResourceLoader = (): DefaultResourceLoader => {
			if (!resourceLoader) throw new Error("Product session resource loader is not ready");
			return resourceLoader;
		};
		const backendBridge: BackendToolBridgeOptions = {
			sessionId: options.externalSessionId,
			registry,
			gatewayUrl: options.toolGatewayUrl,
			gatewayToken: options.toolGatewayToken,
			waitForDecision: (kind, targetId, details, signal) => {
				if (!productSession) throw new Error("Product session decision bridge is not ready");
				return productSession.waitForDecision(kind, targetId, details, signal);
			},
		};
		resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			additionalExtensionPaths: [options.activePluginDir],
			additionalSkillPaths: options.skillPaths,
			extensionFactories: [
				createDiscoveryToolsExtension({
					getResourceLoader,
					registry,
				}),
				createBackendToolExtension(backendBridge),
				{ name: "rag-ime-debug-context", factory: debugContextRecorder.extension() },
			],
			noExtensions: true,
			noContextFiles: options.noContextFiles ?? false,
			systemPrompt: options.systemPrompt,
		});
		await resourceLoader.reload();
		let model: Model<Api> | undefined;
		if (options.provider || options.modelId) {
			if (!options.provider || !options.modelId) {
				throw new RuntimeProtocolError("INVALID_PARAMS", "provider and modelId must be supplied together");
			}
			model = options.modelRuntime.getModel(options.provider, options.modelId);
			if (!model) {
				throw new RuntimeProtocolError(
					"MODEL_NOT_FOUND",
					`Model not found: ${options.provider}/${options.modelId}`,
				);
			}
		}
		const created = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			modelRuntime: options.modelRuntime,
			model,
			thinkingLevel: options.thinkingLevel,
			noTools: "builtin",
			settingsManager,
			resourceLoader,
			sessionManager,
		});
		// The manifest is already filtered by the Session permission policy. Keep
		// every authorized tool routable while Provider schemas stay progressive.
		created.session.setRegisteredToolExecutionEnabled(true);
		applyBackendToolDisclosure(created.session, registry);
		productSession = new PiProductSession(
			options,
			created.session,
			registry,
			resourceLoader,
			settingsManager,
			debugContextRecorder,
		);
		await created.session.bindExtensions({
			mode: "rpc",
			onError: (error) => {
				productSession.notice({
					type: "extension_error",
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
		return productSession;
	}

	private waitForDecision(
		kind: "approval" | "review",
		targetId: string,
		details: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<boolean> {
		const key = `${kind}:${targetId}`;
		if (this.pendingDecisions.has(key)) {
			throw new RuntimeProtocolError("DECISION_ALREADY_PENDING", `${kind} decision is already pending: ${targetId}`);
		}
		const requestId = randomUUID();
		return new Promise<boolean>((resolveDecision) => {
			const onAbort = () => finish(false);
			const cleanup = () => signal?.removeEventListener("abort", onAbort);
			const finish = (value: boolean) => {
				this.pendingDecisions.delete(key);
				cleanup();
				resolveDecision(value);
			};
			this.pendingDecisions.set(key, { requestId, resolve: finish, cleanup });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emitEvent({
				protocolVersion: PROTOCOL_VERSION,
				event: "agent.event",
				sessionId: this.externalSessionId,
				turnId: this.activeTurn?.turnId,
				clientMessageId: this.activeTurn?.clientMessageId,
				sequence: ++this.sequence,
				payload: {
					type: "extension_ui_request",
					id: requestId,
					method: "confirm",
					title: `${kind === "approval" ? "RAG-IME-APPROVAL" : "RAG-IME-REVIEW"}:${targetId}`,
					message:
						kind === "approval"
							? "请在控制中心核对差异并决定是否继续。"
							: "记忆草案已经生成，请在控制中心逐项审阅。",
					details,
				},
			});
		});
	}

	resolveDecision(kind: "approval" | "review", targetId: string, approved: boolean): string {
		const pending = this.pendingDecisions.get(`${kind}:${targetId}`);
		if (!pending)
			throw new RuntimeProtocolError("DECISION_NOT_PENDING", `${kind} decision is not pending: ${targetId}`);
		pending.resolve(approved);
		return pending.requestId;
	}

	get isIdle(): boolean {
		return this.session.isIdle;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		const turn = this.activeTurn;
		const pendingAssistant =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as unknown as Record<string, unknown>)
				: undefined;
		if (event.type === "compaction_start") {
			this.latestCompaction = {
				reason: event.reason,
				status: "running",
				updatedAtMs: Date.now(),
			};
		} else if (event.type === "compaction_end") {
			this.latestCompaction = {
				reason: event.reason,
				status: event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed",
				tokensBefore: event.result?.tokensBefore,
				estimatedTokensAfter: event.result?.estimatedTokensAfter,
				willRetry: event.willRetry,
				error: event.errorMessage,
				updatedAtMs: Date.now(),
			};
		}
		this.emitEvent({
			protocolVersion: PROTOCOL_VERSION,
			event: "agent.event",
			sessionId: this.externalSessionId,
			turnId: turn?.turnId,
			clientMessageId: turn?.clientMessageId,
			sequence: ++this.sequence,
			payload: {
				...toSerializableEvent(event),
				telemetry: this.telemetry(
					event.type === "compaction_start" ? true : event.type === "compaction_end" ? false : undefined,
					pendingAssistant,
				),
			},
		});
		if (event.type === "agent_settled") this.activeTurn = undefined;
	}

	private telemetry(
		compactionOverride?: boolean,
		pendingAssistant?: Record<string, unknown>,
	): Record<string, unknown> {
		const stats = this.session.getSessionStats();
		const context = this.session.getContextUsage();
		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = context?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		const tokens = context?.tokens ?? null;
		const compactAtTokens = Math.max(0, contextWindow - settings.reserveTokens);
		const latestAssistant = (pendingAssistant ??
			[...this.session.messages].reverse().find((message) => message.role === "assistant")) as
			| {
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						totalTokens?: number;
					};
			  }
			| undefined;
		const latestUsage = latestAssistant?.usage ?? {};
		const latestInput = Math.max(0, Number(latestUsage.input) || 0);
		const latestOutput = Math.max(0, Number(latestUsage.output) || 0);
		const latestCacheRead = Math.max(0, Number(latestUsage.cacheRead) || 0);
		const latestCacheWrite = Math.max(0, Number(latestUsage.cacheWrite) || 0);
		const latestPromptTokens = latestInput + latestCacheRead + latestCacheWrite;
		const pendingUsage = pendingAssistant ? latestUsage : undefined;
		const cumulativeInput = stats.tokens.input + (Number(pendingUsage?.input) || 0);
		const cumulativeOutput = stats.tokens.output + (Number(pendingUsage?.output) || 0);
		const cumulativeCacheRead = stats.tokens.cacheRead + (Number(pendingUsage?.cacheRead) || 0);
		const cumulativeCacheWrite = stats.tokens.cacheWrite + (Number(pendingUsage?.cacheWrite) || 0);
		const entries = this.session.sessionManager.getEntries();
		return {
			schemaVersion: "rag-ime.agent-session-telemetry.v1",
			model: this.session.model ? publicSessionModel(this.session.model) : undefined,
			context: {
				tokens,
				contextWindow,
				percent: context?.percent ?? null,
				remainingTokens: tokens === null ? null : Math.max(0, contextWindow - tokens),
				compactAtTokens,
				tokensUntilCompact: tokens === null ? null : Math.max(0, compactAtTokens - tokens),
				reserveTokens: settings.reserveTokens,
				keepRecentTokens: settings.keepRecentTokens,
				autoCompactEnabled: settings.enabled,
			},
			cumulativeUsage: {
				input: cumulativeInput,
				output: cumulativeOutput,
				cacheRead: cumulativeCacheRead,
				cacheWrite: cumulativeCacheWrite,
				totalTokens: cumulativeInput + cumulativeOutput + cumulativeCacheRead + cumulativeCacheWrite,
			},
			latestUsage: {
				input: latestInput,
				output: latestOutput,
				cacheRead: latestCacheRead,
				cacheWrite: latestCacheWrite,
				totalTokens:
					Math.max(0, Number(latestUsage.totalTokens) || 0) ||
					latestInput + latestOutput + latestCacheRead + latestCacheWrite,
			},
			latestCacheHitPercent: latestPromptTokens > 0 ? (latestCacheRead / latestPromptTokens) * 100 : null,
			isCompacting: compactionOverride ?? this.session.isCompacting,
			compactionCount: entries.filter((entry) => entry.type === "compaction").length,
			latestCompaction: this.latestCompaction,
			updatedAtMs: Date.now(),
		};
	}

	private notice(payload: Record<string, unknown>): void {
		this.emitEvent({
			protocolVersion: PROTOCOL_VERSION,
			event: "runtime.notice",
			sessionId: this.externalSessionId,
			sequence: ++this.sequence,
			payload,
		});
	}

	snapshot(): Record<string, unknown> {
		return {
			sessionId: this.externalSessionId,
			piSessionId: this.session.sessionId,
			cwd: this.cwd,
			sessionFile: this.session.sessionFile,
			sessionName: this.session.sessionName,
			model: this.session.model ? publicSessionModel(this.session.model) : undefined,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: this.session.isIdle,
			isCompacting: this.session.isCompacting,
			telemetry: this.telemetry(),
			activeTurn: this.activeTurn,
			messageQueue: this.messageQueue(),
			sequence: this.sequence,
			toolCatalogRevision: this.toolRegistry.revision(),
			toolSchemaRevision: backendToolSchemaRevision(this.toolRegistry.list()),
			disclosedBackendTools: this.toolRegistry.disclosed().map((tool) => tool.name),
			// Compatibility field for older control-center clients.
			activeBackendTools: this.toolRegistry.disclosed().map((tool) => tool.name),
			skillCatalogRevision: runtimeSkillCatalogRevision(this.resourceLoader.getSkills().skills),
			messages: this.session.messages,
			entries: this.session.sessionManager.getEntries(),
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	debugContext(turnId?: string): Record<string, unknown> {
		const context = this.debugContextRecorder.get(turnId);
		const storage = this.debugContextRecorder.storage();
		return {
			schemaVersion: "rag-ime.pi-debug-context-response.v1",
			sessionId: this.externalSessionId,
			turnId: turnId ?? context?.turnId ?? "",
			available: Boolean(context),
			transient: !storage.persistent,
			storage,
			availableTurns: this.debugContextRecorder.list(),
			context: context ?? null,
			telemetry: this.telemetry(),
		};
	}

	async rewind(entryId: string): Promise<Record<string, unknown>> {
		if (!this.session.isIdle || this.activeTurn) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before rewriting history");
		}
		const target = publicPiRewriteTarget(this.session.sessionManager, entryId);
		const result = await this.session.navigateTree(entryId, { summarize: false });
		if (result.cancelled) {
			throw new RuntimeProtocolError("REWRITE_CANCELLED", "Conversation rewrite was cancelled");
		}
		return {
			entryId,
			editorText: result.editorText ?? target.text,
			leafId: this.session.sessionManager.getLeafId() ?? "",
			snapshot: this.snapshot(),
		};
	}

	listTools(): Array<Record<string, unknown>> {
		const active = new Set(this.session.getActiveToolNames());
		const backend = new Map(this.toolRegistry.list().map((tool) => [tool.name, tool]));
		const registered = this.session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			sourceInfo: tool.sourceInfo,
			active: active.has(tool.name),
			disclosed: active.has(tool.name),
			routable: true,
			catalogOnly: false,
			profile: backend.get(tool.name)?.profile,
			risk: backend.get(tool.name)?.risk,
		}));
		const registeredNames = new Set(registered.map((tool) => tool.name));
		const catalogOnly = this.toolRegistry
			.list()
			.filter((tool) => !registeredNames.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				active: false,
				catalogOnly: true,
				profile: tool.profile,
				risk: tool.risk,
			}));
		return [...registered, ...catalogOnly].sort((left, right) => left.name.localeCompare(right.name));
	}

	listCommands(): Array<Record<string, unknown>> {
		return this.resourceLoader.getSkills().skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			location: skill.sourceInfo?.scope ?? "runtime",
		}));
	}

	forkCandidates(): PublicPiForkCandidate[] {
		if (!this.session.isIdle || this.activeTurn || this.pendingDecisions.size > 0) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before creating a fork");
		}
		return publicPiForkCandidates(this.session.sessionManager);
	}

	prepareFork(entryId: string): PreparedPiFork {
		if (!this.session.isIdle || this.activeTurn || this.pendingDecisions.size > 0) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before creating a fork");
		}
		return prepareNativePiFork(this.session.sessionManager, entryId);
	}

	forkRuntimeProfile(): PiForkRuntimeProfile {
		return {
			cwd: this.cwd,
			provider: this.session.model?.provider,
			modelId: this.session.model?.id,
			thinkingLevel: this.session.thinkingLevel,
			toolManifest: this.toolRegistry.list(),
			systemPrompt: this.session.systemPrompt,
			noContextFiles: this.noContextFiles,
		};
	}

	private registeredToolSchemas(): BackendToolManifest[] {
		return this.session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		}));
	}

	private async appendCatalogChange(
		kind: "skill_catalog_changed" | "tool_catalog_changed" | "runtime_catalog_changed",
		details: Record<string, unknown>,
	): Promise<void> {
		const change = {
			schemaVersion: "rag-ime.runtime-catalog-change.v1",
			kind,
			...details,
		};
		await this.session.sendCustomMessage({
			customType: "rag-ime.runtime-catalog-change",
			content: [
				"<rag-ime-runtime-catalog-change>",
				JSON.stringify(change),
				"</rag-ime-runtime-catalog-change>",
			].join("\n"),
			display: false,
			details: change,
		});
		this.notice({
			type: "runtime_catalog_changed",
			...change,
		});
	}

	async syncTools(manifest: unknown): Promise<BackendToolManifest[]> {
		if (!this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Tools can only be synchronized while the session is idle");
		}
		const before = this.toolRegistry.list();
		const disclosedBefore = new Set(this.toolRegistry.disclosed().map((tool) => tool.name));
		const tools = this.toolRegistry.sync(manifest);
		const diff = diffBackendToolCatalog(before, tools);
		if (diff.previousRevision === diff.revision) return tools;

		const providerSchemaChanged =
			diff.schemaChanged.some((name) => disclosedBefore.has(name)) ||
			diff.removed.some((name) => disclosedBefore.has(name));
		const registryReloaded = diff.added.length > 0 || diff.removed.length > 0 || diff.schemaChanged.length > 0;
		// Catalog shape changes must refresh execution lookup, but the Provider
		// still sees only the explicitly disclosed subset after the reload.
		if (registryReloaded) {
			await this.session.reload();
			applyBackendToolDisclosure(this.session, this.toolRegistry);
		}
		await this.appendCatalogChange("tool_catalog_changed", {
			...diff,
			registryReloaded,
			providerSchemaChanged,
			schemaReloaded: providerSchemaChanged,
		});
		return tools;
	}

	async prompt(options: {
		message: string;
		clientMessageId?: string;
		images?: PromptOptions["images"];
	}): Promise<ActiveTurn> {
		if (!this.session.isIdle || this.activeTurn) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session already has an active turn");
		}
		const turn = { turnId: randomUUID(), clientMessageId: options.clientMessageId };
		this.activeTurn = turn;
		let preflightSettled = false;
		return new Promise<ActiveTurn>((accept, reject) => {
			void this.session
				.prompt(options.message, {
					images: options.images,
					source: "rpc",
					preflightResult: (success) => {
						if (preflightSettled) return;
						preflightSettled = true;
						if (success) accept(turn);
						else reject(new RuntimeProtocolError("PROMPT_REJECTED", "Prompt preflight was rejected"));
					},
				})
				.catch((error) => {
					if (!preflightSettled) {
						preflightSettled = true;
						this.activeTurn = undefined;
						reject(error);
					}
				});
		});
	}

	async queueMessage(options: {
		delivery: "steer" | "followUp";
		message: string;
		clientMessageId?: string;
		images?: PromptOptions["images"];
	}): Promise<Record<string, unknown>> {
		const turn = this.activeTurn;
		if (!turn || this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_IDLE", "Session has no active turn to receive a queued message");
		}
		if (options.delivery === "steer") await this.session.steer(options.message, options.images);
		else await this.session.followUp(options.message, options.images);
		return {
			accepted: true,
			queued: true,
			delivery: options.delivery,
			turnId: turn.turnId,
			clientMessageId: options.clientMessageId,
			messageQueue: this.messageQueue(),
		};
	}

	private messageQueue(): Record<string, unknown> {
		return {
			steering: [...(this.session.getSteeringMessages?.() ?? [])],
			followUp: [...(this.session.getFollowUpMessages?.() ?? [])],
			steeringMode: this.session.steeringMode,
			followUpMode: this.session.followUpMode,
		};
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async compact(customInstructions?: string): Promise<unknown> {
		if (!this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before compaction");
		}
		return this.session.compact(customInstructions);
	}

	async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
		if (!this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before changing models");
		}
		const model = this.session.modelRuntime.getModel(provider, modelId);
		if (!model) throw new RuntimeProtocolError("MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);
		await this.session.setModel(model);
		return publicSessionModel(model);
	}

	setThinkingLevel(level: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>): Record<string, unknown> {
		if (!this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before changing thinking level");
		}
		const supported = this.session.model ? getSupportedThinkingLevels(this.session.model) : ["off"];
		if (!supported.includes(level)) {
			throw new RuntimeProtocolError("THINKING_LEVEL_UNSUPPORTED", `Thinking level is not supported: ${level}`);
		}
		this.session.setThinkingLevel(level);
		return { level: this.session.thinkingLevel, supported };
	}

	async reloadPlugins(): Promise<void> {
		if (!this.session.isIdle) return;
		const skillsBefore = this.resourceLoader.getSkills().skills;
		const toolsBefore = this.registeredToolSchemas();
		await this.session.reload();
		applyBackendToolDisclosure(this.session, this.toolRegistry);
		const skillDiff = diffSkillCatalog(skillsBefore, this.resourceLoader.getSkills().skills);
		const toolDiff = diffBackendToolCatalog(toolsBefore, this.registeredToolSchemas());
		if (
			skillDiff.previousRevision !== skillDiff.revision ||
			toolDiff.previousSchemaRevision !== toolDiff.schemaRevision
		) {
			await this.appendCatalogChange("runtime_catalog_changed", {
				skills: skillDiff,
				tools: toolDiff,
				schemaReloaded: true,
			});
		}
	}

	dispose(): void {
		for (const pending of this.pendingDecisions.values()) {
			pending.cleanup();
			pending.resolve(false);
		}
		this.pendingDecisions.clear();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.debugContextRecorder.clear();
		this.session.dispose();
	}
}

export function normalizeWorkspacePath(path: string): string {
	return resolve(path);
}
