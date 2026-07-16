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
import { createDiscoveryToolsExtension, diffSkillCatalog, runtimeSkillCatalogRevision } from "./discovery-tools.ts";
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, RuntimeProtocolError } from "./protocol.ts";
import type { PooledSession } from "./session-pool.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	BackendToolRegistry,
	backendToolSchemaRevision,
	createBackendToolDefinition,
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
	return content.filter(
		(item): item is Record<string, unknown> => typeof item === "object" && item !== null,
	);
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

export function publicPiForkCandidates(sourceManager: SessionManager): PublicPiForkCandidate[] {
	const result: PublicPiForkCandidate[] = [];
	for (const entry of sourceManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const text =
			message.role === "user" ? publicUserText(message.content) : publicAssistantText(message);
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

export interface ActiveTurn {
	turnId: string;
	clientMessageId?: string;
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
	private readonly emitEvent: (event: RuntimeEventEnvelope) => void;
	private unsubscribe: (() => void) | undefined;
	private sequence = 0;
	private activeTurn: ActiveTurn | undefined;
	private readonly pendingDecisions = new Map<
		string,
		{ requestId: string; resolve(value: boolean): void; cleanup(): void }
	>();

	private constructor(
		options: PiSessionOpenOptions,
		session: AgentSession,
		registry: BackendToolRegistry,
		resourceLoader: DefaultResourceLoader,
	) {
		this.externalSessionId = options.externalSessionId;
		this.cwd = options.cwd;
		this.noContextFiles = options.noContextFiles ?? false;
		this.session = session;
		this.toolRegistry = registry;
		this.resourceLoader = resourceLoader;
		this.emitEvent = options.emitEvent;
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
	}

	static async create(options: PiSessionOpenOptions): Promise<PiProductSession> {
		const registry = new BackendToolRegistry();
		if (options.toolManifest !== undefined) registry.sync(options.toolManifest);
		let productSession: PiProductSession | undefined;
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
					createBackendTool: (tool) => createBackendToolDefinition(backendBridge, tool),
				}),
				createBackendToolExtension(backendBridge),
			],
			noExtensions: true,
			noContextFiles: options.noContextFiles ?? false,
			systemPrompt: options.systemPrompt,
		});
		await resourceLoader.reload();
		const sessionManager =
			options.sessionManager ??
			(options.sessionFile
				? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
				: SessionManager.create(options.cwd, options.sessionDir));
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
		productSession = new PiProductSession(options, created.session, registry, resourceLoader);
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
		this.emitEvent({
			protocolVersion: PROTOCOL_VERSION,
			event: "agent.event",
			sessionId: this.externalSessionId,
			turnId: turn?.turnId,
			clientMessageId: turn?.clientMessageId,
			sequence: ++this.sequence,
			payload: toSerializableEvent(event),
		});
		if (event.type === "agent_settled") this.activeTurn = undefined;
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
			activeTurn: this.activeTurn,
			sequence: this.sequence,
			toolCatalogRevision: this.toolRegistry.revision(),
			toolSchemaRevision: backendToolSchemaRevision(this.toolRegistry.list()),
			activeBackendTools: this.toolRegistry.active().map((tool) => tool.name),
			skillCatalogRevision: runtimeSkillCatalogRevision(this.resourceLoader.getSkills().skills),
			messages: this.session.messages,
			entries: this.session.sessionManager.getEntries(),
			leafId: this.session.sessionManager.getLeafId(),
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
		const activeBefore = new Set(this.toolRegistry.active().map((tool) => tool.name));
		const tools = this.toolRegistry.sync(manifest);
		const diff = diffBackendToolCatalog(before, tools);
		if (diff.previousRevision === diff.revision) return tools;

		const activeSchemaChanged =
			diff.schemaChanged.some((name) => activeBefore.has(name)) ||
			diff.removed.some((name) => activeBefore.has(name));
		// Catalog-only changes remain discoverable through tool_search without
		// rebuilding the active Provider tool prefix.
		if (activeSchemaChanged) {
			await this.session.reload();
		}
		await this.appendCatalogChange("tool_catalog_changed", {
			...diff,
			schemaReloaded: activeSchemaChanged,
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
		this.session.dispose();
	}
}

export function normalizeWorkspacePath(path: string): string {
	return resolve(path);
}
