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
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, RuntimeProtocolError } from "./protocol.ts";
import type { PooledSession } from "./session-pool.ts";
import { type BackendToolManifest, BackendToolRegistry, createBackendToolExtension } from "./tool-bridge.ts";

export interface PiSessionOpenOptions {
	externalSessionId: string;
	cwd: string;
	sessionDir: string;
	sessionFile?: string;
	agentDir: string;
	activePluginDir: string;
	modelRuntime: ModelRuntime;
	provider?: string;
	modelId?: string;
	thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	toolManifest?: unknown;
	toolGatewayUrl?: string;
	toolGatewayToken?: string;
	systemPrompt?: string;
	emitEvent(event: RuntimeEventEnvelope): void;
}

export interface ActiveTurn {
	turnId: string;
	clientMessageId?: string;
}

function toSerializableEvent(event: AgentSessionEvent): Record<string, unknown> {
	return { ...(event as unknown as Record<string, unknown>) };
}

export class PiProductSession implements PooledSession {
	readonly externalSessionId: string;
	readonly cwd: string;
	readonly toolRegistry: BackendToolRegistry;
	private readonly session: AgentSession;
	private readonly emitEvent: (event: RuntimeEventEnvelope) => void;
	private unsubscribe: (() => void) | undefined;
	private sequence = 0;
	private activeTurn: ActiveTurn | undefined;
	private readonly pendingDecisions = new Map<
		string,
		{ requestId: string; resolve(value: boolean): void; cleanup(): void }
	>();

	private constructor(options: PiSessionOpenOptions, session: AgentSession, registry: BackendToolRegistry) {
		this.externalSessionId = options.externalSessionId;
		this.cwd = options.cwd;
		this.session = session;
		this.toolRegistry = registry;
		this.emitEvent = options.emitEvent;
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
	}

	static async create(options: PiSessionOpenOptions): Promise<PiProductSession> {
		const registry = new BackendToolRegistry();
		if (options.toolManifest !== undefined) registry.sync(options.toolManifest);
		let productSession: PiProductSession | undefined;
		const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			additionalExtensionPaths: [options.activePluginDir],
			extensionFactories: [
				createBackendToolExtension({
					sessionId: options.externalSessionId,
					registry,
					gatewayUrl: options.toolGatewayUrl,
					gatewayToken: options.toolGatewayToken,
					waitForDecision: (kind, targetId, details, signal) => {
						if (!productSession) throw new Error("Product session decision bridge is not ready");
						return productSession.waitForDecision(kind, targetId, details, signal);
					},
				}),
			],
			noExtensions: true,
			systemPrompt: options.systemPrompt,
		});
		await resourceLoader.reload();
		const sessionManager = options.sessionFile
			? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
			: SessionManager.create(options.cwd, options.sessionDir);
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
		productSession = new PiProductSession(options, created.session, registry);
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
			model: this.session.model
				? {
						provider: this.session.model.provider,
						id: this.session.model.id,
						name: this.session.model.name,
						thinkingLevels: getSupportedThinkingLevels(this.session.model),
					}
				: undefined,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: this.session.isIdle,
			isCompacting: this.session.isCompacting,
			activeTurn: this.activeTurn,
			sequence: this.sequence,
			messages: this.session.messages,
			entries: this.session.sessionManager.getEntries(),
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	listTools(): Array<Record<string, unknown>> {
		const active = new Set(this.session.getActiveToolNames());
		const backend = new Map(this.toolRegistry.list().map((tool) => [tool.name, tool]));
		return this.session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			sourceInfo: tool.sourceInfo,
			active: active.has(tool.name),
			profile: backend.get(tool.name)?.profile,
			risk: backend.get(tool.name)?.risk,
		}));
	}

	async syncTools(manifest: unknown): Promise<BackendToolManifest[]> {
		if (!this.session.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Tools can only be synchronized while the session is idle");
		}
		const tools = this.toolRegistry.sync(manifest);
		await this.session.reload();
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
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			thinkingLevels: getSupportedThinkingLevels(model),
		};
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
		await this.session.reload();
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
