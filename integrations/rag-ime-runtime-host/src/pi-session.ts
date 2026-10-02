import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model, type ModelsClassifierOptions } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	DefaultResourceLoader,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ModelRuntime,
	type McpStatusSnapshot,
	loadMcpConfig,
	type PromptOptions,
	SessionManager,
	SettingsManager,
	type SlashCommandInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type AskWireRequest, createAskExtension } from "./ask.ts";
import { PiDebugContextRecorder } from "./debug-context.ts";
import {
	createDiscoveryToolsExtension,
	diffSkillCatalog,
	loadSkill,
	runtimeSkillCatalogRevision,
} from "./discovery-tools.ts";
import { createLifecycleHookController } from "./lifecycle-hooks.ts";
import { createMemoryCaptureExtension, prepareGovernedMemoryCapture } from "./memory-capture-tool.ts";
import { bootstrapNativeWorkspaceToolTargets, createNativeWorkspaceToolsExtension } from "./native-workspace-tools.ts";
import { ProductContextProvider } from "./product-context-provider.ts";
import {
	PROTOCOL_VERSION,
	type RoomCancelParams,
	type RuntimeEventEnvelope,
	RuntimeProtocolError,
	sameRoomCancelLineage,
} from "./protocol.ts";
import { createContextProviderJournalExtension, ProviderContextJournal } from "./provider-context-journal.ts";
import { roomSkillPromptFocus, roomToolPromptFocus } from "./room-prompt-catalog.ts";
import { createRoomResourceLimitExtension, type RoomResourceLimits } from "./room-resource-limits.ts";
import { ASK_TOOL_NAME, TOOL_LOAD_TOOL_NAME } from "./runtime-tool-names.ts";
import { createSessionContextRefreshExtension } from "./session-context-refresh.ts";
import type { PooledSession } from "./session-pool.ts";
import { applySkillRoutingCardCatalog, type SkillRoutingCardCatalog } from "./skill-routing-cards.ts";
import {
	createThresholdCompactionContinuationController,
	type ThresholdCompactionContinuationController,
} from "./threshold-compaction-continuation.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	BackendToolRegistry,
	backendToolSchemaRevision,
	createBackendToolExtension,
	diffBackendToolCatalog,
	rebindGovernedToolReceipts,
} from "./tool-bridge.ts";
import { ToolLoopProgressGuard } from "./tool-loop-progress-guard.ts";
import { ToolResultStore } from "./tool-result-store.ts";
import {
	type AgentSettledReceiptV2,
	type PiTurnSettlementReceipt,
	persistedTurnSettlement,
	TURN_SETTLEMENT_CUSTOM_TYPE,
	TurnSettlementTracker,
} from "./turn-settlement.ts";
import { MANAGED_CLASSIFIER } from "./classification.ts";
import { createWorkflowControlExtension } from "./workflow-control.ts";

export interface PiSessionOpenOptions {
	externalSessionId: string;
	cwd: string;
	sessionDir: string;
	sessionFile?: string;
	sessionManager?: SessionManager;
	agentDir: string;
	activePluginDir: string;
	skillPaths: string[];
	piSkillPaths: string[];
	codexSkillPaths: string[];
	skillRoutingCards?: SkillRoutingCardCatalog;
	piSkillsEnabled?: boolean;
	codexSkillsEnabled?: boolean;
	modelRuntime: ModelRuntime;
	classifierOptions?: ModelsClassifierOptions;
	provider?: string;
	modelId?: string;
	thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	codemodeMode?: "on" | "only" | "off";
	toolManifest?: unknown;
	nativeMcpExecutionAllowed?: boolean;
	roomCapability?: Record<string, unknown>;
	toolGatewayUrl?: string;
	toolGatewayToken?: string;
	systemPrompt?: string;
	sessionContext?: string;
	roomContext?: string;
	roomRecoveryContext?: string;
	roomProviderContext?: Record<string, unknown>;
	roomSkillPolicy?: unknown;
	roomResourceLimits?: RoomResourceLimits;
	isPackageCapabilityEnabled?(capability: string): boolean;
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
	codemodeMode: "on" | "only" | "off";
	toolManifest: BackendToolManifest[];
	nativeMcpExecutionAllowed: boolean;
	roomCapability?: Record<string, unknown>;
	systemPrompt: string;
	noContextFiles: boolean;
	piSkillsEnabled: boolean;
	codexSkillsEnabled: boolean;
}

async function managedLegacyExtensionPaths(activePluginDir: string): Promise<string[]> {
	try {
		const entries = await readdir(activePluginDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]s)$/u.test(entry.name))
			.map((entry) => resolve(activePluginDir, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export interface RoomSkillLoadReceipt {
	schemaVersion: "rag-ime.skill-load.v1";
	name: string;
	catalogRevision: string;
	contentRevision: string;
	loadReason: "stage_required";
}

interface ActiveRoomDispatch {
	dispatchId: string;
	rootId: string;
	generation: number;
	dispatchAttempt: number;
	runtimeTurnId?: string;
	capabilityEpoch: number;
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

function requiredRoomSkill(value: unknown): { skillId: string; skillHash: string } | undefined {
	if (value === undefined) return undefined;
	const policy = objectRecord(value);
	const skillId = typeof policy?.skillId === "string" ? policy.skillId.trim() : "";
	const skillHash = typeof policy?.skillHash === "string" ? policy.skillHash.trim().toLowerCase() : "";
	if (policy?.selection !== "required" || !skillId || !/^[a-f0-9]{64}$/u.test(skillHash)) {
		throw new RuntimeProtocolError("INVALID_PARAMS", "roomSkillPolicy must pin one exact required Skill revision");
	}
	return { skillId, skillHash };
}

/** Restore only schemas explicitly disclosed by tool_load on the active branch. */
export function restoreBackendToolDisclosures(registry: BackendToolRegistry, sessionManager: SessionManager): string[] {
	const restored: string[] = [];
	const restoredNames = new Set<string>();
	const restore = (value: unknown, governedValue?: unknown) => {
		const loadedTool = objectRecord(value);
		const loadedName = typeof loadedTool?.name === "string" ? loadedTool.name : "";
		// A previously disclosed product tool may later become an internal
		// execution target behind a runtime-native tool. Old session branches
		// must stay resumable without re-exposing that internal schema.
		if (!registry.getDiscoverable(loadedName)) return;
		if (!restoredNames.has(loadedName)) {
			restoredNames.add(loadedName);
			restored.push(loadedName);
		}
		const governed = objectRecord(governedValue);
		if (typeof governed?.receiptId === "string") registry.recordLoadReceipt(loadedName, governed.receiptId);
	};
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = objectRecord(entry.message);
		if (message?.role !== "toolResult" || message.isError === true) continue;
		if (message.toolName !== TOOL_LOAD_TOOL_NAME) continue;

		const details = objectRecord(message.details);
		restore(details?.tool, details?.governedReceipt);
		if (Array.isArray(details?.tools)) {
			for (const item of details.tools) {
				const loaded = objectRecord(item);
				restore(loaded?.tool, loaded?.governedReceipt);
			}
		}
	}
	for (const name of restored) registry.disclose(name);
	return restored;
}

function applyBackendToolDisclosure(session: AgentSession, registry: BackendToolRegistry, roomBound = false): string[] {
	const backendNames = new Set(registry.list().map((tool) => tool.name));
	const visibleNames = session
		.getActiveToolNames()
		.filter((name) => !backendNames.has(name) && (!roomBound || name !== ASK_TOOL_NAME));
	if (!roomBound && session.getAllTools().some((tool) => tool.name === ASK_TOOL_NAME))
		visibleNames.push(ASK_TOOL_NAME);
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

export interface PiPromptReceipt extends ActiveTurn {
	disposition: "started" | "queued" | "handled";
	settlement?: PiTurnSettlementReceipt;
}

interface PromptPreflight {
	turn: ActiveTurn;
	operation: PiAgentAbortOperation;
	cancelled: boolean;
	nativeRun: boolean;
	done: Promise<void>;
	finish(): void;
}

const TURN_BINDING_CUSTOM_TYPE = "rag-ime.pi-turn-binding";
const PACKAGE_COMMAND_RESULT_CUSTOM_TYPE = "paw-pi-package-command-result";
const EXACT_TURN_CANCEL_CUSTOM_TYPE = "rag-ime.pi-exact-turn-cancel";

function persistedActiveTurn(value: unknown): ActiveTurn | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	if (source.schemaVersion !== "rag-ime.pi-turn-binding.v1" || typeof source.turnId !== "string") return undefined;
	if (source.state === "retired") return undefined;
	const turnId = source.turnId.trim();
	if (!turnId) return undefined;
	return {
		turnId,
		clientMessageId:
			typeof source.clientMessageId === "string" ? source.clientMessageId.trim() || undefined : undefined,
	};
}

export interface PiSessionAbortReceipt {
	schemaVersion: "rag-ime.pi-session-abort-receipt.v1";
	sessionId: string;
	turnId: string;
	cancelledDecisionIds: string[];
	cancelledUIRequestIds: string[];
	lifecycle: PiAgentAbortReceipt;
}

export interface PiExactTurnCancelReceipt {
	schemaVersion: "rag-ime.pi-exact-turn-cancel.v1";
	sessionId: string;
	turnId: string;
	clientMessageId: string;
	cancelId: string;
	state: "accepted" | "rejected" | "unknown";
	receiptId?: string;
	phase?: "requested" | "settled" | "failed";
	reason?: string;
	runtimeReceipt?: PiSessionAbortReceipt;
	persistencePending?: boolean;
}

export interface PiAgentAbortOperation {
	operationId: string;
	kind: string;
	registeredAt: number;
}

/** Product-facing cancellation proof derived from Pi 0.84 public controls. */
export interface PiAgentAbortReceipt {
	schemaVersion: "pi.agent-abort-receipt.v1";
	scopeId: string;
	generation: number;
	reason: "user_abort" | "retired_turn_recovery" | "interrupted_turn_recovery";
	cancelledContinuationIds: string[];
	cancelledOperationIds: string[];
	failedOperationIds: string[];
	operations: PiAgentAbortOperation[];
	pendingOperations: PiAgentAbortOperation[];
	drained: boolean;
	idle: boolean;
	source: "runtime_host_adapter";
}

interface AppliedRoomCancel {
	lineage: RoomCancelParams;
	cancelledIds: string[];
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

function sha256Json(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function terminalAssistant(messages: readonly unknown[]): Record<string, unknown> | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = objectRecord(messages[index]);
		if (message?.role === "assistant") return message;
	}
	return undefined;
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

function recallMessageText(message: Record<string, unknown>, maximum = 1200): string {
	const limit = Math.max(1, Math.min(maximum, 4_000));
	const content = message.content;
	if (typeof content === "string") return content.trim().slice(0, limit);
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is Record<string, unknown> =>
				typeof block === "object" &&
				block !== null &&
				!Array.isArray(block) &&
				(block.type === "text" || block.type === "output_text"),
		)
		.map((block) => String(block.text ?? "").trim())
		.filter(Boolean)
		.join("\n")
		.slice(0, limit);
}

function uiConfirmationValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	const affirmative = [
		"yes",
		"y",
		"true",
		"confirm",
		"confirmed",
		"allow",
		"approve",
		"是",
		"确认",
		"同意",
		"允许",
		"批准",
		"保留",
	];
	const negative = ["no", "n", "false", "cancel", "deny", "reject", "否", "取消", "不同意", "拒绝", "不允许", "删除"];
	const matches = (candidate: string) =>
		normalized === candidate || normalized.startsWith(`${candidate}，`) || normalized.startsWith(`${candidate},`);
	if (affirmative.some(matches)) return true;
	if (negative.some(matches)) return false;
	throw new RuntimeProtocolError(
		"INVALID_UI_RESPONSE",
		"Confirm UI response must explicitly approve or reject the request",
	);
}

const productManagedTheme = new Proxy({} as Theme, {
	get: (_target, property) => {
		if (property === "name") return "product-managed";
		return (...args: unknown[]) => String(args.at(-1) ?? "");
	},
});

export class PiProductSession implements PooledSession {
	readonly externalSessionId: string;
	readonly cwd: string;
	readonly toolRegistry: BackendToolRegistry;
	readonly roomSkillLoad: RoomSkillLoadReceipt | undefined;
	readonly noContextFiles: boolean;
	readonly piSkillsEnabled: boolean;
	readonly codexSkillsEnabled: boolean;
	private readonly codemodeState: { mode: "on" | "only" | "off" };
	private readonly mcpState: { allowed: boolean; snapshot?: McpStatusSnapshot };
	get codemodeMode(): "on" | "only" | "off" { return this.codemodeState.mode; }
	private roomCapability?: Record<string, unknown>;
	private readonly session: AgentSession;
	private readonly resourceLoader: DefaultResourceLoader;
	private readonly settingsManager: SettingsManager;
	private readonly debugContextRecorder: PiDebugContextRecorder;
	private readonly providerContextJournal: ProviderContextJournal;
	private readonly productContextProvider: ProductContextProvider;
	private readonly turnSettlements: TurnSettlementTracker;
	private readonly thresholdCompactionContinuation?: ThresholdCompactionContinuationController;
	private readonly backendBridge: BackendToolBridgeOptions;
	private readonly emitEvent: (event: RuntimeEventEnvelope) => void;
	private unsubscribe: (() => void) | undefined;
	private pluginReloadPending = false;
	private pluginReloadInFlight: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;
	private sequence = 0;
	private activeTurn: ActiveTurn | undefined;
	private recoveredTurnBindingId: string | undefined;
	private activeRoom: ActiveRoomDispatch | undefined;
	private roomContext = "";
	private roomRecoveryContext = "";
	private sessionContext = "";
	private sessionContextRefreshRevision = 0;
	private transientContext = "";
	private roomProviderContext?: Record<string, unknown>;
	private roomResourceLimits?: RoomResourceLimits;
	private roomToolCalls = 0;
	private roomToolCost = 0;
	private settlementGeneration = 0;
	private abortGeneration = 0;
	private abortingTurnIds?: Set<string>;
	private promptPreflight?: PromptPreflight;
	private activeSourceLoopId = "";
	private sourceLoopOrdinal = 0;
	private readonly roomContinuationIds = new Set<string>();
	private latestCompaction: PublicCompactionState | undefined;
	private toolLoopProgressGuard?: ToolLoopProgressGuard;
	private readonly pendingDecisions = new Map<
		string,
		{ requestId: string; resolve(value: boolean): void; cleanup(): void }
	>();
	private readonly pendingUIRequests = new Map<
		string,
		{
			method: "select" | "confirm" | "input" | "editor";
			options?: string[];
			resolve(response: Record<string, unknown>): void;
			cancel(): void;
		}
	>();
	private readonly appliedRoomCancels = new Map<string, AppliedRoomCancel>();
	private exactTurnCancels?: Map<string, PiExactTurnCancelReceipt>;

	private constructor(
		options: PiSessionOpenOptions,
		session: AgentSession,
		registry: BackendToolRegistry,
		resourceLoader: DefaultResourceLoader,
		settingsManager: SettingsManager,
		debugContextRecorder: PiDebugContextRecorder,
		providerContextJournal: ProviderContextJournal,
		productContextProvider: ProductContextProvider,
		thresholdCompactionContinuation: ThresholdCompactionContinuationController,
		backendBridge: BackendToolBridgeOptions,
		roomSkillLoad: RoomSkillLoadReceipt | undefined,
		codemodeState: { mode: "on" | "only" | "off" },
		mcpState: { allowed: boolean; snapshot?: McpStatusSnapshot },
	) {
		this.externalSessionId = options.externalSessionId;
		this.codemodeState = codemodeState;
		this.mcpState = mcpState;
		this.cwd = options.cwd;
		this.noContextFiles = options.noContextFiles ?? false;
		this.piSkillsEnabled = options.piSkillsEnabled ?? false;
		this.codexSkillsEnabled = options.codexSkillsEnabled ?? false;
		this.roomCapability = options.roomCapability ? structuredClone(options.roomCapability) : undefined;
		this.roomResourceLimits = options.roomResourceLimits ? structuredClone(options.roomResourceLimits) : undefined;
		this.session = session;
		this.toolRegistry = registry;
		this.roomSkillLoad = roomSkillLoad;
		this.resourceLoader = resourceLoader;
		this.settingsManager = settingsManager;
		this.debugContextRecorder = debugContextRecorder;
		this.providerContextJournal = providerContextJournal;
		this.productContextProvider = productContextProvider;
		this.thresholdCompactionContinuation = thresholdCompactionContinuation;
		// The product Session survives Runtime upgrades while Pi's append-only
		// transcript has its own durable identity. Keep both identities explicit:
		// the outer Turn receipt belongs to the product Session and the nested
		// Agent receipt remains cryptographically bound to the Pi transcript.
		this.turnSettlements = new TurnSettlementTracker(options.externalSessionId, session.sessionId);
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== TURN_SETTLEMENT_CUSTOM_TYPE) continue;
			const persisted = persistedTurnSettlement(entry.data);
			if (persisted) this.turnSettlements.restore(persisted);
		}
		const latestTurnBinding = [...session.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === TURN_BINDING_CUSTOM_TYPE);
		if (latestTurnBinding?.type === "custom") {
			const recoveredTurn = persistedActiveTurn(latestTurnBinding.data);
			const recoveredSettlement = recoveredTurn ? this.turnSettlements.get(recoveredTurn.turnId) : undefined;
			if (recoveredTurn && (!recoveredSettlement || recoveredSettlement.receipt.disposition === "suspended")) {
				this.activeTurn = recoveredTurn;
				this.recoveredTurnBindingId = latestTurnBinding.id;
			}
		}
		this.backendBridge = backendBridge;
		this.emitEvent = options.emitEvent;
		const inheritedFinishTurn = session.agent.finishTurn;
		session.agent.finishTurn = async (context, signal) => {
			const decision = await inheritedFinishTurn?.(context, signal);
			if (decision?.action === "end") return decision;
			return this.observeToolLoopTurn(context) ? { action: "end" } : (decision ?? undefined);
		};
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
	}

	private progressGuard(): ToolLoopProgressGuard {
		this.toolLoopProgressGuard ??= new ToolLoopProgressGuard();
		return this.toolLoopProgressGuard;
	}

	private observeToolLoopTurn(context: Parameters<ToolLoopProgressGuard["shouldStop"]>[0]): boolean {
		const guard = this.progressGuard();
		const shouldStop = guard.shouldStop(context);
		if (shouldStop) {
			this.emitToolLoopNoProgress(guard.stopReceipt());
			return true;
		}
		const expectedTurnId = this.activeTurn?.turnId;
		const expectedDispatchId = this.activeRoom?.dispatchId;
		if (!expectedTurnId || !expectedDispatchId) return false;
		guard.armRecoveryTimeout((receipt) => {
			if (this.activeTurn?.turnId !== expectedTurnId || this.activeRoom?.dispatchId !== expectedDispatchId) {
				return;
			}
			this.emitToolLoopNoProgress(receipt);
			// AgentSession.abort() signals the exact active Provider operation before
			// waiting for lifecycle drain. Do not await that drain inside the timer;
			// the ordinary settlement path remains the durable terminal owner.
			void this.session.abort().catch(() => undefined);
		});
		return false;
	}

	private emitToolLoopNoProgress(receipt: ReturnType<ToolLoopProgressGuard["stopReceipt"]>): void {
		this.emitEvent({
			protocolVersion: PROTOCOL_VERSION,
			event: "agent.event",
			sessionId: this.externalSessionId,
			turnId: this.activeTurn?.turnId,
			clientMessageId: this.activeTurn?.clientMessageId,
			sequence: ++this.sequence,
			payload: {
				type: "tool_loop_no_progress",
				message: "Tool Loop 未能从失败结果恢复，已按受管无进展策略停止。请检查最后一项未完成原因后再重试。",
				...receipt,
			},
		});
	}

	private refreshBackendToolDisclosure(roomBound = this.roomCapability !== undefined): void {
		const registry = this.toolRegistry;
		const session = this.session;
		if (
			!registry ||
			!session ||
			typeof session.getActiveToolNames !== "function" ||
			typeof session.getAllTools !== "function" ||
			typeof session.setActiveToolsByName !== "function"
		) {
			return;
		}
		applyBackendToolDisclosure(session, registry, roomBound);
	}

	static async create(options: PiSessionOpenOptions): Promise<PiProductSession> {
		const roomBound = options.roomCapability !== undefined;
		const codemodeMode = options.codemodeMode ?? "on";
		const codemodeState = { mode: codemodeMode };
		const mcpState: { allowed: boolean; snapshot?: McpStatusSnapshot } = {
			allowed: options.nativeMcpExecutionAllowed === true,
		};
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
				maxCallsPerTurn: Number.parseInt(process.env.RAG_IME_PI_DEBUG_CONTEXT_MAX_CALLS ?? "", 10),
				contributionRefs: [
					...(options.roomCapability ? [{ kind: "room-capability", ...options.roomCapability }] : []),
					...(options.roomProviderContext
						? [{ kind: "room-provider-context", ...options.roomProviderContext }]
						: []),
					...(options.roomSkillPolicy ? [{ kind: "room-skill", ...options.roomSkillPolicy }] : []),
				],
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
			roomCapability: options.roomCapability,
			sourceLoopId: () => productSession?.activeSourceLoopId ?? "",
			executionBinding: () => productSession?.activeTurn ? {
				turnId: productSession.activeTurn.turnId,
				clientMessageId: productSession.activeTurn.clientMessageId ?? "",
			} : undefined,
			resultStore: new ToolResultStore(
				resolve(
					options.sessionDir,
					"tool-results",
					createHash("sha256").update(options.externalSessionId).digest("hex").slice(0, 24),
				),
			),
			waitForDecision: (kind, targetId, details, signal) => {
				if (!productSession) throw new Error("Product session decision bridge is not ready");
				return productSession.waitForDecision(kind, targetId, details, signal);
			},
		};
		const selectedSkillPaths = [
			...options.skillPaths,
			...(options.piSkillsEnabled ? options.piSkillPaths : []),
			...(options.codexSkillsEnabled ? options.codexSkillPaths : []),
		];
		const lifecycleHooks = createLifecycleHookController({
			bridge: backendBridge,
			stateDirectory: resolve(options.sessionDir, ".lifecycle-hooks"),
			isManagedRoom: () =>
				Boolean(
					productSession?.roomCapability ||
						productSession?.roomContext.trim() ||
						productSession?.roomRecoveryContext.trim() ||
						productSession?.roomSkillLoadReceipt() ||
						productSession?.roomToolRecoveryReceipt(),
				),
		});
		const initialContextEpoch = Number(options.roomCapability?.contextEpoch ?? 1);
		const initialContextEpochReason = String(options.roomCapability?.contextEpochReason ?? "session_open");
		const providerContextJournal = new ProviderContextJournal(initialContextEpoch, initialContextEpochReason);
		const productContextProvider = new ProductContextProvider({
			sessionId: options.externalSessionId,
			roomRequired: roomBound,
			getRunId: () => productSession?.activeTurn?.turnId ?? `${options.externalSessionId}:preflight`,
			getRoomContext: () => productSession?.roomContext ?? options.roomContext ?? "",
			getRoomRecoveryContext: () => productSession?.roomRecoveryContext ?? options.roomRecoveryContext ?? "",
			getSessionContext: () => productSession?.sessionContext ?? options.sessionContext ?? "",
			getTurnContext: () => productSession?.transientContext ?? "",
			getRoomRevision: () => String(productSession?.roomCapability?.contextEpoch ?? initialContextEpoch),
			getRoomRecoveryRevision: () =>
				`recovery:${String(productSession?.roomCapability?.contextEpoch ?? initialContextEpoch)}`,
			getSessionRevision: () => `memory:${productSession?.sessionContextRefreshRevision ?? 0}`,
			getTurnRevision: () => productSession?.activeTurn?.turnId ?? "turn:pending",
			isRoomBound: () => Boolean(productSession?.roomCapability ?? options.roomCapability),
		});
		const thresholdCompactionContinuation = createThresholdCompactionContinuationController({
			text: [
				'<managed-compaction-continuation origin="threshold-compaction" continuation-limit="1">',
				"Pi 原生阈值压缩已经完成。立即从压缩摘要与现有 Tool 证据继续原始用户任务。",
				"不要重复已经完成的写入、Shell、桌面动作或提交；先复用现有回执。",
				"如果原任务实际上已经完成，只给出一次简洁最终结果并停止，不要启动新任务。",
				"</managed-compaction-continuation>",
			].join("\n"),
			limit: 1,
		});
		let requiredSkillPrompt = "";
		const loadedSkillNames = new Set<string>();
		const skillPromptFocus = roomSkillPromptFocus(options.roomSkillPolicy) ?? [];
		const toolPromptFocus = roomToolPromptFocus(options.roomSkillPolicy) ?? [];
		const legacyExtensionPaths = await managedLegacyExtensionPaths(options.activePluginDir);
		resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			// Managed legacy plugins publish one immutable shim per enabled plugin.
			// Passing the containing directory as one extension makes Pi attempt to
			// import a nonexistent index.ts whenever the directory is empty.
			additionalExtensionPaths: legacyExtensionPaths,
			additionalSkillPaths: selectedSkillPaths,
			// Pi Package settings are the authoritative source for optional Skill
			// plugins. Product Skill roots remain additive and independently gated.
			noSkills: false,
			extensionsOverride: (base) => ({
				...base,
				// The managed host loads only inline/temporary product extensions and
				// extensions from enabled Pi Packages. Ambient ~/.pi and project
				// extensions remain outside this Session unless installed as a Package.
				extensions: base.extensions.filter(
					(extension) => extension.sourceInfo.scope === "temporary" || extension.sourceInfo.origin === "package"
						|| extension.path === "builtin:mcp",
				),
			}),
			skillsOverride: (base) =>
				applySkillRoutingCardCatalog(
					{
						...base,
						// Explicit product/Pi/Codex paths are temporary inputs. Package
						// Skills are allowed only while their Package is enabled. Do not
						// inherit unrelated global or project Skill directories.
						skills: base.skills.filter(
							(skill) => skill.sourceInfo.scope === "temporary" || skill.sourceInfo.origin === "package",
						),
					},
					options.skillRoutingCards ?? {},
					{
					focusNames: skillPromptFocus,
					loadedNames: [...loadedSkillNames],
					},
				),
			extensionFactories: [
				{
					name: "mcp", builtin: true, replaceable: true,
					factory: createMcpExtension({
						executionAllowed: () => mcpState.allowed,
						codemodeActivationAllowed: () => codemodeState.mode !== "off",
						loadConfig: (ctx) => {
							const config = loadMcpConfig({ agentDir: options.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
							return codemodeState.mode === "off" ? { ...config, autoEnableCodemode: false } : config;
						},
						onStatusChange: (snapshot) => { mcpState.snapshot = snapshot; },
					}),
				},
				{
					name: "builtin:codemode",
					builtin: true,
					factory: createCodemodeExtension({ get mode() { return codemodeState.mode === "only" ? "only" : "on"; }, models: {allowed: [MANAGED_CLASSIFIER]}, classifierOptions: options.classifierOptions }),
				},
				...(roomBound
					? []
					: [
							createAskExtension({
								requestQuestions: (toolCallId, request, signal) => {
									if (!productSession) throw new Error("Product session Ask bridge is not ready");
									return productSession.requestAskQuestions(toolCallId, request, signal);
								},
							}),
						]),
				createDiscoveryToolsExtension({
					getResourceLoader,
					nativeMcpSearch: true,
					registry,
					gateway: backendBridge,
					focusToolNames: toolPromptFocus,
					getLoadedSkillNames: () => [...loadedSkillNames],
				}),
				createMemoryCaptureExtension(backendBridge),
				createBackendToolExtension(backendBridge),
				createNativeWorkspaceToolsExtension({
					...backendBridge,
					cwd: options.cwd,
				}),
				createSessionContextRefreshExtension({
					bridge: backendBridge,
					getSessionContext: () => productSession?.sessionContext ?? "",
					setSessionContext: (value) => {
						if (productSession) {
							productSession.sessionContext = value.trim();
							productSession.sessionContextRefreshRevision += 1;
						}
					},
					getRoomContext: () => productSession?.roomContext ?? "",
					getRoomRecoveryContext: () => productSession?.roomRecoveryContext ?? "",
					setRoomRecoveryContext: (value) => {
						if (productSession) productSession.roomRecoveryContext = value.trim();
					},
					getRecentMessages: () => productSession?.recentMessagesForContext() ?? [],
					getRoomSkillRecovery: () => productSession?.roomSkillLoadReceipt(),
					getRoomToolRecovery: () => productSession?.roomToolRecoveryReceipt(),
					getAgentSkillRecovery: () => {
						const items = debugContextRecorder.loadedSkillRecoveryReceipts();
						return items.length > 0 ? { schemaVersion: "rag-ime.agent-skill-recovery.v1", items } : undefined;
					},
					getAgentToolRecovery: () => {
						const items = registry.disclosed().map((tool) => ({
							name: tool.name,
							schemaRevision: backendToolSchemaRevision([tool]),
						}));
						return items.length > 0
							? {
									schemaVersion: "rag-ime.agent-tool-recovery.v1",
									catalogRevision: registry.revision(),
									items,
								}
							: undefined;
					},
					providerContextJournal,
					assembleProviderContext: async ({ systemPrompt }) => {
						const assembled = await productContextProvider.assemble({ stage: "after_compaction" });
						return providerContextJournal.projectAssembly(systemPrompt, assembled.assembly);
					},
				}),
				createWorkflowControlExtension({
					bridge: backendBridge,
					// The optional Session Workflow Package owns Goal/Plan/Todo state.
					// Keep the older PAW gateway adapter behind a distinct compatibility
					// capability so installing the Package cannot create two workflow owners.
					isEnabled: () => options.isPackageCapabilityEnabled?.("product-workflow-gateway") ?? false,
					hasActiveRoom: () => productSession?.activeRoom !== undefined,
					onProjectComplete: (details) => lifecycleHooks.projectComplete(details),
				}),
				createRoomResourceLimitExtension(
					() => productSession?.authorizeRoomToolCall() ?? { allowed: false, reason: "Room Session is not ready" },
				),
				lifecycleHooks.extension,
				createContextProviderJournalExtension(
					providerContextJournal,
					async ({ prompt, signal }) =>
						(await productContextProvider.assemble({ stage: "turn_start", queryText: prompt, signal })).assembly,
				),
				thresholdCompactionContinuation.extension,
				{ name: "rag-ime-debug-context", factory: debugContextRecorder.extension() },
			],
			noExtensions: false,
			noContextFiles: options.noContextFiles ?? false,
			systemPrompt: options.systemPrompt,
			systemPromptOverride: (base) => [base?.trim(), requiredSkillPrompt].filter(Boolean).join("\n\n") || undefined,
		});
		await resourceLoader.reload();
		await bootstrapNativeWorkspaceToolTargets(backendBridge);
		await prepareGovernedMemoryCapture(backendBridge);
		let roomSkillLoad: RoomSkillLoadReceipt | undefined;
		const requiredSkill = requiredRoomSkill(options.roomSkillPolicy);
		if (requiredSkill) {
			const loaded = await loadSkill(resourceLoader.getSkills().skills, { name: requiredSkill.skillId });
			const contentRevision = String(loaded.details.contentRevision ?? "");
			const catalogRevision = String(loaded.details.catalogRevision ?? "");
			if (contentRevision !== requiredSkill.skillHash) {
				throw new RuntimeProtocolError(
					"SKILL_REVISION_MISMATCH",
					`Required Room Skill revision changed: ${requiredSkill.skillId}`,
				);
			}
			requiredSkillPrompt = loaded.text;
			loadedSkillNames.add(requiredSkill.skillId);
			roomSkillLoad = {
				schemaVersion: "rag-ime.skill-load.v1",
				name: requiredSkill.skillId,
				catalogRevision,
				contentRevision,
				loadReason: "stage_required",
			};
			// Rebuild only the resource projection so the exact loaded body becomes
			// part of the managed system prompt before AgentSession is created.
			await resourceLoader.reload();
		}
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
			// Room output accounting is a Kernel budget, not Provider model
			// metadata. Keep the catalog model intact and enforce the Room limit
			// from actual response receipts instead of mutating model.maxTokens.
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
		if (codemodeMode !== "off") {
			created.session.setActiveToolsByName([...created.session.getActiveToolNames(), "codemode"]);
		}
		applyBackendToolDisclosure(created.session, registry, roomBound);
		productSession = new PiProductSession(
			options,
			created.session,
			registry,
			resourceLoader,
			settingsManager,
			debugContextRecorder,
			providerContextJournal,
			productContextProvider,
			thresholdCompactionContinuation,
			backendBridge,
			roomSkillLoad,
			codemodeState,
			mcpState,
		);
		productSession.sessionContext = options.sessionContext?.trim() ?? "";
		productSession.roomContext = options.roomContext?.trim() ?? "";
		productSession.roomRecoveryContext = options.roomRecoveryContext?.trim() ?? productSession.roomContext;
		productSession.roomProviderContext = options.roomProviderContext
			? structuredClone(options.roomProviderContext)
			: undefined;
		await created.session.bindExtensions({
			mode: "rpc",
			uiContext: productSession.extensionUIContext(),
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

	requestAskQuestions(toolCallId: string, request: AskWireRequest, signal?: AbortSignal): Promise<string | undefined> {
		if (this.roomCapability !== undefined) {
			return Promise.reject(
				new Error("Room-bound Sessions route user questions through the facilitator Room wait path"),
			);
		}
		const payload = JSON.stringify(request);
		return this.requestUI(
			"editor",
			{
				title: `RAG-IME-QUESTIONS:${toolCallId}`,
				prefill: payload,
				defaultValue: payload,
			},
			(response) =>
				response.cancelled === true ? undefined : typeof response.value === "string" ? response.value : undefined,
			undefined,
			{ signal },
		);
	}

	private extensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) =>
				this.requestUI(
					"select",
					{ title, options: [...options], timeout: opts?.timeout },
					(response) =>
						response.cancelled === true
							? undefined
							: typeof response.value === "string"
								? response.value
								: undefined,
					undefined,
					opts,
				),
			confirm: (title, message, opts) =>
				this.requestUI(
					"confirm",
					{ title, message, timeout: opts?.timeout },
					(response) =>
						response.cancelled === true
							? false
							: typeof response.confirmed === "boolean"
								? response.confirmed
								: false,
					false,
					opts,
				),
			input: (title, placeholder, opts) =>
				this.requestUI(
					"input",
					{ title, placeholder, timeout: opts?.timeout },
					(response) =>
						response.cancelled === true
							? undefined
							: typeof response.value === "string"
								? response.value
								: undefined,
					undefined,
					opts,
				),
			editor: (title, prefill) =>
				this.requestUI(
					"editor",
					{ title, prefill, defaultValue: prefill },
					(response) =>
						response.cancelled === true
							? undefined
							: typeof response.value === "string"
								? response.value
								: undefined,
					undefined,
				),
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return productManagedTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI is managed by the product" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	private requestUI<T>(
		method: "select" | "confirm" | "input" | "editor",
		payload: Record<string, unknown>,
		parse: (response: Record<string, unknown>) => T,
		defaultValue: T,
		opts?: ExtensionUIDialogOptions,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const requestId = randomUUID();
		return new Promise<T>((resolveRequest) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: T) => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", cancel);
				this.pendingUIRequests.delete(requestId);
				resolveRequest(value);
			};
			const cancel = () => finish(defaultValue);
			if (opts?.timeout) timeoutId = setTimeout(cancel, opts.timeout);
			opts?.signal?.addEventListener("abort", cancel, { once: true });
			const options = Array.isArray(payload.options) ? payload.options.map((value) => String(value)) : undefined;
			this.pendingUIRequests.set(requestId, {
				method,
				options,
				resolve: (response) => finish(parse(response)),
				cancel,
			});
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
					method,
					...payload,
				},
			});
		});
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

	resolveUI(requestId: string, response: Record<string, unknown>): Record<string, unknown> {
		const uiRequest = this.pendingUIRequests.get(requestId);
		if (uiRequest) {
			if (uiRequest.method === "select" && response.cancelled !== true) {
				if (typeof response.value !== "string") {
					throw new RuntimeProtocolError("INVALID_UI_RESPONSE", "Select UI response must include a value");
				}
				if (uiRequest.options?.length && !uiRequest.options.includes(response.value)) {
					throw new RuntimeProtocolError("INVALID_UI_RESPONSE", "Selected value was not offered");
				}
			}
			if (
				(uiRequest.method === "input" || uiRequest.method === "editor") &&
				response.cancelled !== true &&
				typeof response.value !== "string"
			) {
				throw new RuntimeProtocolError("INVALID_UI_RESPONSE", "Text UI response must include a value");
			}
			if (uiRequest.method === "confirm" && response.cancelled !== true && typeof response.confirmed !== "boolean") {
				throw new RuntimeProtocolError("INVALID_UI_RESPONSE", "Confirm UI response must include confirmed");
			}
			uiRequest.resolve(response);
			return { requestId, resolved: true };
		}
		const pending = [...this.pendingDecisions.values()].find((item) => item.requestId === requestId);
		if (!pending) {
			throw new RuntimeProtocolError("UI_REQUEST_NOT_PENDING", `UI request is not pending: ${requestId}`);
		}
		let confirmed: boolean;
		if (response.cancelled === true) {
			confirmed = false;
		} else if (typeof response.confirmed === "boolean") {
			confirmed = response.confirmed;
		} else if (typeof response.value === "string") {
			confirmed = uiConfirmationValue(response.value);
		} else {
			throw new RuntimeProtocolError(
				"INVALID_UI_RESPONSE",
				"Confirm UI response must include confirmed, value, or cancelled",
			);
		}
		pending.resolve(confirmed);
		return { requestId, resolved: true };
	}

	get isIdle(): boolean {
		return this.session.isIdle && !this.promptPreflight;
	}

	private createSettlementReceipt(turn: ActiveTurn): AgentSettledReceiptV2 {
		const messages = this.session.messages;
		const entries = this.session.sessionManager.getBranch();
		const assistant = terminalAssistant(messages);
		const nativeStopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : "";
		// Aborting during a tool leaves the preceding assistant at toolUse.
		// The native agent_settled event proves drain; the exact accepted abort
		// identity supplies the cause without rewriting that historical message.
		const abortRequested = this.abortingTurnIds?.has(turn.turnId) === true;
		const disposition: AgentSettledReceiptV2["disposition"] = abortRequested ? "aborted" : !assistant
			? "failed"
			: nativeStopReason === "error"
				? "failed"
				: nativeStopReason === "aborted"
					? "aborted"
					: "completed";
		const stopReason = abortRequested ? "user_abort" : nativeStopReason || "missing_assistant_message";
		const terminalContinuationIds = [...this.roomContinuationIds];
		const finalMessage = assistant
			? structuredClone(assistant)
			: {
					role: "assistant",
					stopReason,
					errorMessage: "Pi settled without an assistant message",
				};
		const settledAtMs = Date.now();
		const generation = ++this.settlementGeneration;
		return {
			schemaVersion: "pi.agent-settled.v2",
			receiptId: `pi-settled:${randomUUID()}`,
			sessionId: this.session.sessionId,
			runId: turn.turnId,
			scopeId: `${this.session.sessionId}:${turn.turnId}`,
			generation,
			disposition,
			stopReason,
			transcript: {
				messageCount: messages.length,
				entryCount: entries.length,
				lineageHash: sha256Json(entries.map((entry) => entry.id)),
				contentHash: sha256Json(messages),
			},
			continuations: {
				generation,
				pendingIds: [],
				readyIds: [],
				scheduledIds: [],
				leasedIds: [],
				terminalIds: terminalContinuationIds,
				terminalIdsOmitted: 0,
				idsHash: sha256Json(terminalContinuationIds),
				counts: {
					pending: 0,
					leased: 0,
					completed: terminalContinuationIds.length,
					cancelled: 0,
					expired: 0,
					failed: 0,
				},
			},
			operations: { pending: 0, pendingByKind: {}, registeredByKind: {} },
			settledAtMs,
			aborted: disposition === "aborted",
			pendingOperations: 0,
			operationCounts: {},
			finalMessage,
		};
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.recoveredTurnBindingId = undefined;
		const turn = this.activeTurn;
		const preflight = this.promptPreflight;
		if (event.type === "agent_start" && preflight && preflight.turn.turnId === turn?.turnId) preflight.nativeRun = true;
		// A command's nested run may end while its outer handler or another
		// command-owned admission is still pending. Publish its terminal once
		// startTurnPrompt observes the command and native lifecycle both drained.
		if (event.type === "agent_settled" && preflight) return;
		if (event.type === "message_start" && event.message.role === "assistant") {
			const timestamp = Number((event.message as unknown as Record<string, unknown>).timestamp);
			this.sourceLoopOrdinal += 1;
			this.activeSourceLoopId = Number.isFinite(timestamp)
				? `pi:message:assistant:${Math.trunc(timestamp)}`
				: `pi:loop:${this.externalSessionId}:${this.sourceLoopOrdinal}`;
		}
		let settlementReceipt: AgentSettledReceiptV2 | undefined;
		if (event.type === "agent_settled" && turn?.turnId && !preflight) {
			settlementReceipt = this.createSettlementReceipt(turn);
			this.abortingTurnIds?.delete(turn.turnId);
			const previous = this.turnSettlements.get(turn.turnId, turn.clientMessageId);
			const settlement = this.turnSettlements.record(turn, settlementReceipt);
			if (previous?.receipt.receiptId !== settlement.receipt.receiptId) {
				this.session.sessionManager.appendCustomEntry(TURN_SETTLEMENT_CUSTOM_TYPE, settlement);
			}
		}
		const pendingAssistant =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as unknown as Record<string, unknown>)
				: undefined;
		if (event.type === "compaction_start") {
			this.debugContextRecorder.beginLifecycle("compaction", {
				reason: event.reason,
			});
			this.latestCompaction = {
				reason: event.reason,
				status: "running",
				updatedAtMs: Date.now(),
			};
		} else if (event.type === "compaction_end") {
			const compactionStatus = event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed";
			this.debugContextRecorder.endLifecycle("compaction", compactionStatus, event.errorMessage);
			this.latestCompaction = {
				reason: event.reason,
				status: compactionStatus,
				tokensBefore: event.result?.tokensBefore,
				estimatedTokensAfter: event.result?.estimatedTokensAfter,
				willRetry: event.willRetry,
				error: event.errorMessage,
				updatedAtMs: Date.now(),
			};
		} else if (event.type === "auto_retry_start" && this.activeRoom) {
			const retryLimit = this.roomResourceLimits?.retryRemaining;
			if (retryLimit !== undefined && event.attempt > retryLimit) {
				const dispatchId = this.activeRoom.dispatchId;
				queueMicrotask(() => {
					if (this.activeRoom?.dispatchId === dispatchId) this.session.abortRetry();
				});
			}
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
				...(settlementReceipt ? { receipt: settlementReceipt } : {}),
				telemetry: this.telemetry(
					event.type === "compaction_start" ? true : event.type === "compaction_end" ? false : undefined,
					pendingAssistant,
				),
			},
		});
		if (event.type === "agent_settled" && !preflight) {
			// Keep the terminal no-progress receipt available in the idle
			// snapshot. A new prompt/Dispatch clears it before the next run.
			this.progressGuard().reset({ preserveStopReceipt: true });
			this.activeTurn = undefined;
			this.activeRoom = undefined;
			this.roomContinuationIds.clear();
			this.transientContext = "";
			this.providerContextJournal.clearTurnContext();
			this.activeSourceLoopId = "";
			queueMicrotask(() => {
				void this.drainPluginReload().catch((error) => {
					this.notice({
						type: "runtime_catalog_reload_failed",
						error: error instanceof Error ? error.message : String(error),
					});
				});
			});
		}
	}

	async awaitSettled(
		turnId: string,
		options: { allowSuspended?: boolean; timeoutMs?: number; expectedClientMessageId?: string } = {},
	): Promise<PiTurnSettlementReceipt> {
		return await this.turnSettlements.wait(turnId, options);
	}

	settlement(turnId: string, expectedClientMessageId?: string): PiTurnSettlementReceipt | undefined {
		return this.turnSettlements.get(turnId, expectedClientMessageId);
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
			toolLoopProgressStop: this.progressGuard().stopReceipt(),
			updatedAtMs: Date.now(),
		};
	}

	private recentMessagesForContext(): Array<{ role: "user" | "assistant"; text: string }> {
		const result: Array<{ role: "user" | "assistant"; text: string }> = [];
		let preservedOriginalRequirement = false;
		for (const message of this.session.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const preserveAsOriginal = message.role === "user" && !preservedOriginalRequirement;
			const text = recallMessageText(
				message as unknown as Record<string, unknown>,
				preserveAsOriginal ? 4_000 : 1_200,
			);
			if (text) result.push({ role: message.role, text });
			if (preserveAsOriginal && text) preservedOriginalRequirement = true;
		}
		if (result.length <= 8) return result;
		const firstUser = result.find((message) => message.role === "user");
		const tail = result.slice(-7);
		if (!firstUser || tail.includes(firstUser)) return result.slice(-8);
		return [firstUser, ...tail];
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

	controlState(): Record<string, unknown> {
		return {
			schemaVersion: "rag-ime.pi-session-control-state.v1",
			sessionId: this.externalSessionId,
			codemodeMode: this.codemodeMode,
			isIdle: this.isIdle,
			isCompacting: this.session.isCompacting,
			activeTurn: this.activeTurn,
			roomCapability: this.roomCapability ? structuredClone(this.roomCapability) : undefined,
			activeRoom: this.activeRoom ? structuredClone(this.activeRoom) : undefined,
			turnSettlement: this.activeTurn
				? this.turnSettlements.get(this.activeTurn.turnId)
				: this.turnSettlements.latest(),
			contextAssembly: this.productContextProvider.snapshot(),
			sequence: this.sequence,
		};
	}

	openSnapshot(): Record<string, unknown> {
		return {
			sessionId: this.externalSessionId,
			piSessionId: this.session.sessionId,
			cwd: this.cwd,
			sessionFile: this.session.sessionFile,
			sessionName: this.session.sessionName,
			model: this.session.model ? publicSessionModel(this.session.model) : undefined,
			thinkingLevel: this.session.thinkingLevel,
			codemodeMode: this.codemodeMode,
			isIdle: this.isIdle,
			isCompacting: this.session.isCompacting,
			telemetry: this.telemetry(),
			activeTurn: this.activeTurn,
			messageQueue: this.messageQueue(),
			sequence: this.sequence,
			toolCatalogRevision: this.toolRegistry.revision(),
			toolSchemaRevision: backendToolSchemaRevision(this.toolRegistry.list()),
			toolManifest: this.toolRegistry.list(),
			roomCapability: this.roomCapability ? structuredClone(this.roomCapability) : undefined,
			activeRoom: this.activeRoom ? structuredClone(this.activeRoom) : undefined,
			turnSettlement: this.activeTurn
				? this.turnSettlements.get(this.activeTurn.turnId)
				: this.turnSettlements.latest(),
			contextAssembly: this.productContextProvider.snapshot(),
			toolLoopProgressStop: this.progressGuard().stopReceipt(),
			roomProviderContext: this.roomProviderContext ? structuredClone(this.roomProviderContext) : undefined,
			disclosedBackendTools: this.toolRegistry.disclosed().map((tool) => tool.name),
			// Compatibility field for older control-center clients.
			activeBackendTools: this.toolRegistry.disclosed().map((tool) => tool.name),
			skillCatalogRevision: runtimeSkillCatalogRevision(this.resourceLoader.getSkills().skills),
			roomSkillLoad: this.roomSkillLoadReceipt(),
			piSkillsEnabled: this.piSkillsEnabled,
			codexSkillsEnabled: this.codexSkillsEnabled,
			messageCount: this.session.messages.length,
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	snapshot(): Record<string, unknown> {
		return {
			...this.openSnapshot(),
			messages: this.session.messages,
			entries: this.session.sessionManager.getEntries(),
		};
	}

	debugContext(turnId?: string): Record<string, unknown> {
		const context = this.debugContextRecorder.get(turnId);
		const storage = this.debugContextRecorder.storage();
		const modelCalls = Array.isArray(context?.modelCalls) ? context.modelCalls : [];
		const contributionRefs = Array.isArray(context?.contributionRefs) ? context.contributionRefs : [];
		const latestCall = modelCalls.at(-1);
		const pending = this.messageQueue();
		const contextProjection = latestCall
			? {
					schemaVersion: "rag-ime.context-assembly-projection.v1",
					stablePrefixMessages: latestCall.contextDelta.commonPrefixMessages,
					stablePrefixBytes: latestCall.contextDelta.prefixBytes,
					dynamicTailMessages: latestCall.contextDelta.addedMessageCount,
					dynamicTailBytes: latestCall.contextDelta.deltaBytes,
					sealedMessages: contributionRefs.length,
					pendingMessages:
						(Array.isArray(pending.steering) ? pending.steering.length : 0) +
						(Array.isArray(pending.followUp) ? pending.followUp.length : 0),
					compactionState: this.latestCompaction?.status ?? "not_started",
					providerContextJournal: this.providerContextJournal.snapshot(),
					recoveryState: contributionRefs.some((item) => item.kind === "room-provider-context")
						? "ready"
						: "not_required",
					sourceRefs: contributionRefs,
				}
			: undefined;
		return {
			schemaVersion: "rag-ime.pi-debug-context-response.v1",
			sessionId: this.externalSessionId,
			turnId: turnId ?? context?.turnId ?? "",
			available: Boolean(context),
			transient: !storage.persistent,
			storage,
			availableTurns: this.debugContextRecorder.list(),
			currentProviderContext: {
				systemPrompt: this.session.systemPrompt,
				providerContextJournal: this.providerContextJournal.snapshot(),
				disclosedBackendTools: this.toolRegistry.disclosed().map((tool) => tool.name),
			},
			context: context ? { ...context, contextProjection } : null,
			transcript: this.transcriptInspectionReceipt(),
			telemetry: this.telemetry(),
		};
	}

	private transcriptInspectionReceipt(): Record<string, unknown> {
		try {
			const sessionFile = this.session.sessionFile;
			if (!sessionFile) throw new Error("session transcript is unavailable");
			const bytes = readFileSync(sessionFile);
			const lines = bytes
				.toString("utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0);
			const entryTypes: string[] = [];
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as { type?: unknown };
					entryTypes.push(String(parsed.type ?? "unknown"));
				} catch {
					entryTypes.push("invalid");
				}
			}
			return {
				schemaVersion: "rag-ime.pi-session-jsonl-receipt.v1",
				sha256: createHash("sha256").update(bytes).digest("hex"),
				bytes: bytes.length,
				lineCount: lines.length,
				entryTypes,
				leafId: this.session.sessionManager.getLeafId() ?? "",
				contentIncluded: false,
			};
		} catch {
			return {
				schemaVersion: "rag-ime.pi-session-jsonl-receipt.v1",
				available: false,
				contentIncluded: false,
				error: "session transcript is unavailable",
			};
		}
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
		this.toolRegistry.clearExplicitDisclosures();
		restoreBackendToolDisclosures(this.toolRegistry, this.session.sessionManager);
		applyBackendToolDisclosure(this.session, this.toolRegistry, this.roomCapability !== undefined);
		return {
			entryId,
			editorText: result.editorText ?? target.text,
			leafId: this.session.sessionManager.getLeafId() ?? "",
			snapshot: this.snapshot(),
		};
	}

	roomSkillLoadReceipt(): Record<string, unknown> | undefined {
		if (!this.roomSkillLoad) return undefined;
		return { ...structuredClone(this.roomSkillLoad) };
	}

	roomToolRecoveryReceipt(): Record<string, unknown> | undefined {
		const items = this.toolRegistry.governedLoadReceipts();
		if (items.length === 0) return undefined;
		return {
			schemaVersion: "rag-ime.room-tool-recovery.v1",
			items,
		};
	}

	listTools(): Array<Record<string, unknown>> {
		const active = new Set(this.session.getActiveToolNames());
		const callable = new Set(this.session.getCallableToolNames());
		const backend = new Map(this.toolRegistry.list().map((tool) => [tool.name, tool]));
		const registered = this.session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			exposure: tool.exposure,
			...(tool.namespace ? { namespace: { name: tool.namespace.name } } : {}),
			sourceInfo: tool.sourceInfo,
			active: active.has(tool.name),
			disclosed: active.has(tool.name),
			routable: callable.has(tool.name),
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

	nativeCapabilities(): Record<string, unknown> {
		const snapshot = this.mcpState.allowed ? this.mcpState.snapshot : undefined;
		const mcpExposures = new Map(snapshot?.servers.flatMap((server) => server.tools.map((tool) => [tool.name, tool.exposure] as const)) ?? []);
		return {
			schemaVersion: "rag-ime.pi-native-capabilities.v1",
			codemodeMode: this.codemodeMode,
			mcp: snapshot?.active ? { available: true, ...structuredClone(snapshot) } : {
				available: false, servers: [], policyAllowed: this.mcpState.allowed,
			},
			tools: this.listTools().filter((tool) => mcpExposures.has(String(tool.name))).map((tool) => ({
				name: tool.name, description: tool.description, parameters: tool.parameters,
				namespace: tool.namespace, exposure: mcpExposures.get(String(tool.name)), nativeToolExposure: tool.exposure,
				active: tool.active, routable: tool.routable,
			})),
		};
	}

	listCommands(): Array<Record<string, unknown>> {
		const commands = (this.session as AgentSession & { slashCommands: ReadonlyArray<SlashCommandInfo> }).slashCommands;
		return commands.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			location: command.sourceInfo.scope,
		}));
	}

	async invokeCommand(commandText: string): Promise<Record<string, unknown>> {
		const command = commandText.trim();
		if (!command.startsWith("/") || /[\r\n]/u.test(command)) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "Session command must be one slash-command line");
		}
		const separator = command.indexOf(" ");
		const name = separator === -1 ? command.slice(1) : command.slice(1, separator);
		const registered = this.listCommands().find(
			(candidate) => candidate.name === name && candidate.source === "extension",
		);
		if (!registered) {
			throw new RuntimeProtocolError(
				"COMMAND_NOT_FOUND",
				`No enabled Pi Package command is registered as /${name}`,
			);
		}

		const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
		const handled = await (
			this.session as AgentSession & { executeSlashCommand(text: string): Promise<boolean> }
		).executeSlashCommand(command);
		if (!handled) {
			throw new RuntimeProtocolError("COMMAND_NOT_FOUND", `Pi did not handle /${name}`);
		}
		this.session.sessionManager.flushPendingEntries();
		const receipts = this.session.sessionManager.getEntries().flatMap((entry) => {
			if (
				before.has(entry.id) ||
				entry.type !== "custom" ||
				entry.customType !== PACKAGE_COMMAND_RESULT_CUSTOM_TYPE
			) {
				return [];
			}
			return [structuredClone(entry.data)];
		});
		const result = receipts.at(-1);
		return {
			schemaVersion: "rag-ime.pi-package-command-invocation.v1",
			command,
			name,
			handled: true,
			result:
				result && typeof result === "object" && !Array.isArray(result)
					? result
					: {
							schemaVersion: "rag-ime.pi-package-command-result.v1",
							command: name,
							message: `/${name} completed.`,
						  },
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	resourceDiagnostics(): Record<string, unknown> {
		const extensions = this.resourceLoader.getExtensions();
		const skills = this.resourceLoader.getSkills();
		return {
			extensions: {
				loaded: extensions.extensions.map((extension) => ({
					path: extension.path,
					source: extension.sourceInfo.source,
					scope: extension.sourceInfo.scope,
					origin: extension.sourceInfo.origin,
				})),
				errors: extensions.errors.map((error) => ({ ...error })),
			},
			skills: {
				diagnostics: skills.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			},
		};
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
			codemodeMode: this.codemodeMode,
			toolManifest: this.toolRegistry.list(),
			nativeMcpExecutionAllowed: this.mcpState.allowed,
			roomCapability: this.roomCapability ? structuredClone(this.roomCapability) : undefined,
			systemPrompt: this.session.systemPrompt,
			noContextFiles: this.noContextFiles,
			piSkillsEnabled: this.piSkillsEnabled,
			codexSkillsEnabled: this.codexSkillsEnabled,
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

	async syncTools(manifest: unknown, nativeMcpExecutionAllowed = this.mcpState.allowed): Promise<BackendToolManifest[]> {
		if (!this.session.isIdle || this.activeTurn || this.pluginReloadInFlight) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Tools can only be synchronized while the session is idle");
		}
		const registrySnapshot = this.toolRegistry.snapshot();
		const before = registrySnapshot.manifest;
		const disclosedBefore = new Set(this.toolRegistry.disclosed().map((tool) => tool.name));
		const tools = this.toolRegistry.sync(manifest);
		const diff = diffBackendToolCatalog(before, tools);
		const mcpPolicyChanged = this.mcpState.allowed !== nativeMcpExecutionAllowed;
		// Revoke before awaiting reload, so stale direct/deferred/codemode tool
		// references cannot execute with the old authority. Never restore an
		// earlier grant if reload fails.
		this.mcpState.allowed = nativeMcpExecutionAllowed;
		if (diff.previousRevision === diff.revision && !mcpPolicyChanged) return tools;

		const providerSchemaChanged =
			diff.schemaChanged.some((name) => disclosedBefore.has(name)) ||
			diff.removed.some((name) => disclosedBefore.has(name));
		const registryReloaded = mcpPolicyChanged || diff.added.length > 0 || diff.removed.length > 0 || diff.schemaChanged.length > 0;
		// Catalog shape changes must refresh execution lookup, but the Provider
		// still sees only the explicitly disclosed subset after the reload.
		if (registryReloaded) {
			try {
				await this.session.reload();
				applyBackendToolDisclosure(this.session, this.toolRegistry, this.roomCapability !== undefined);
			} catch (error) {
				this.toolRegistry.restore(registrySnapshot);
				this.mcpState.allowed = false;
				applyBackendToolDisclosure(this.session, this.toolRegistry, this.roomCapability !== undefined);
				throw error;
			}
		}
		await this.appendCatalogChange("tool_catalog_changed", {
			...diff,
			nativeMcpExecutionAllowed,
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
		sessionContext?: string;
		transientContext?: string;
	}): Promise<PiPromptReceipt> {
		if (!this.isIdle || this.activeTurn || this.disposePromise) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session already has an active turn");
		}
		this.progressGuard().reset();
		this.thresholdCompactionContinuation?.beginExternalPrompt();
		const turn = { turnId: randomUUID(), clientMessageId: options.clientMessageId };
		this.recoveredTurnBindingId = undefined;
		this.activeTurn = turn;
		// Publish the product turn identity before Pi starts its native run so the
		// terminal agent_settled event can be fenced to this exact request.
		if (this.activeRoom) this.activeRoom.runtimeTurnId = turn.turnId;
		const previousSessionContext = this.sessionContext;
		const nextSessionContext =
			options.sessionContext !== undefined ? options.sessionContext.trim() : previousSessionContext;
		const nextTransientContext = options.transientContext?.trim() ?? "";
		if (
			!this.activeRoom &&
			options.sessionContext !== undefined &&
			previousSessionContext.length > 0 &&
			previousSessionContext !== nextSessionContext
		) {
			// ProviderContextJournal is append-only inside an epoch.  A changed
			// ordinary-Session memory snapshot must therefore start a new epoch;
			// otherwise superseded Atom text from the previous turn remains in
			// the Provider system prompt beside the replacement.
			this.providerContextJournal.beginEpoch("session_memory_refresh", this.session.systemPrompt, {
				roomContext: this.roomContext,
				sessionContext: nextSessionContext,
				transientContext: nextTransientContext,
			});
		}
		if (options.sessionContext !== undefined) {
			this.sessionContext = nextSessionContext;
		}
		this.transientContext = nextTransientContext;
		return this.startTurnPrompt(turn, options.message, { images: options.images, source: "rpc" });
	}

	private clearTurn(turn: ActiveTurn): void {
		if (this.activeTurn?.turnId !== turn.turnId) return;
		this.activeTurn = undefined;
		if (this.activeRoom?.runtimeTurnId === turn.turnId) this.activeRoom = undefined;
		this.transientContext = "";
		this.providerContextJournal.clearTurnContext();
	}

	private settlePromptPreflight(preflight: PromptPreflight): PiTurnSettlementReceipt | undefined {
		const { turn } = preflight;
		if (this.activeTurn?.turnId !== turn.turnId) return this.turnSettlements.get(turn.turnId, turn.clientMessageId);
		const previous = this.turnSettlements.get(turn.turnId, turn.clientMessageId);
		if (previous) return previous;
		const receipt: AgentSettledReceiptV2 & { origin: "prompt_preflight" } = {
			...this.createSettlementReceipt(turn), origin: "prompt_preflight",
		};
		if (!preflight.nativeRun) {
			receipt.disposition = preflight.cancelled ? "aborted" : "completed";
			receipt.aborted = preflight.cancelled;
			receipt.stopReason = preflight.cancelled ? "prompt_preflight_cancelled" : "prompt_handled";
			delete receipt.finalMessage;
		}
		const settlement: PiTurnSettlementReceipt = {
			schemaVersion: "rag-ime.pi-turn-settlement.v1", sessionId: this.externalSessionId,
			runtimeSessionId: this.session.sessionId, ...turn, receipt,
		};
		this.session.sessionManager.appendCustomEntry(TURN_SETTLEMENT_CUSTOM_TYPE, settlement);
		this.session.sessionManager.flushPendingEntries();
		this.turnSettlements.restore(settlement);
		this.emitEvent({ protocolVersion: PROTOCOL_VERSION, event: "agent.event", sessionId: this.externalSessionId,
			...turn, sequence: ++this.sequence, payload: { type: "agent_settled", origin: "prompt_preflight", receipt } });
		this.abortingTurnIds?.delete(turn.turnId);
		this.clearTurn(turn);
		return settlement;
	}

	private startTurnPrompt(turn: ActiveTurn, message: string, options: PromptOptions): Promise<PiPromptReceipt> {
		if (this.promptPreflight) throw new RuntimeProtocolError("SESSION_BUSY", "Prompt preflight is still pending");
		let finish!: () => void;
		const preflight: PromptPreflight = { turn, cancelled: false, nativeRun: false,
			operation: { operationId: `prompt-preflight:${turn.turnId}:${randomUUID()}`, kind: "prompt_preflight", registeredAt: Date.now() },
			done: new Promise<void>(resolveDone => { finish = resolveDone; }), finish: () => finish() };
		this.promptPreflight = preflight;
		let accepted = false;
		let disposition: PiPromptReceipt["disposition"] | undefined;
		return new Promise<PiPromptReceipt>((accept, reject) => {
			void this.session.prompt(message, { ...options, preflightResult: result => {
				disposition = result;
				if (result === "handled") return; // Commands may already have performed an effect.
				if (preflight.cancelled || this.disposePromise || this.activeTurn?.turnId !== turn.turnId) {
					throw new RuntimeProtocolError("PROMPT_ADMISSION_CANCELLED", "Prompt admission was cancelled before the Agent run");
				}
				if (options.expandPromptTemplates !== false) {
					this.session.sessionManager.appendCustomEntry(TURN_BINDING_CUSTOM_TYPE, { schemaVersion: "rag-ime.pi-turn-binding.v1", ...turn });
				}
				if (this.promptPreflight === preflight) this.promptPreflight = undefined;
				preflight.finish();
				accepted = true;
				accept({ ...turn, disposition: result });
			} }).then(async () => {
				if (!accepted) {
					await this.session.waitForIdle();
					if (this.promptPreflight === preflight) this.promptPreflight = undefined;
					if (disposition !== "handled") throw new RuntimeProtocolError("PROMPT_REJECTED", "Prompt ended without an admission disposition");
					const settlement = this.settlePromptPreflight(preflight);
					accept({ ...turn, disposition, settlement });
				}
			}, async error => {
				if (accepted) return;
				// A failing outer admission may have started extension-owned work.
				// Its error does not prove that a nested preflight or run has drained.
				await this.session.waitForIdle();
				if (this.promptPreflight === preflight) this.promptPreflight = undefined;
				if ((preflight.cancelled || preflight.nativeRun) && !this.disposePromise) this.settlePromptPreflight(preflight);
				else this.clearTurn(turn);
				reject(preflight.cancelled ? new RuntimeProtocolError("PROMPT_ADMISSION_CANCELLED", "Prompt admission was cancelled before the Agent run") : error);
			}).catch(reject).finally(() => preflight.finish());
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
		const continuationId = options.clientMessageId?.trim() || `continuation:${randomUUID()}`;
		if (options.delivery === "steer") {
			await this.session.steer(options.message, options.images);
		} else {
			await this.session.followUp(options.message, options.images);
		}
		return {
			accepted: true,
			queued: true,
			delivery: options.delivery,
			turnId: turn.turnId,
			clientMessageId: options.clientMessageId,
			continuationId,
			messageQueue: this.messageQueue(),
		};
	}

	async dispatchRoom(options: {
		message: string;
		dispatchId: string;
		rootId: string;
		generation: number;
		dispatchAttempt: number;
		capabilityEpoch: number;
		sessionContext?: string;
		roomContext?: string;
		roomRecoveryContext?: string;
		roomProviderContext?: Record<string, unknown>;
		roomCapability?: Record<string, unknown>;
		roomResourceLimits?: RoomResourceLimits;
	}): Promise<Record<string, unknown>> {
		this.assertRoomDispatchResources();
		if (this.promptPreflight) throw new RuntimeProtocolError("SESSION_BUSY", "Prompt preflight is still pending");
		if (this.activeRoom && this.activeRoom.dispatchId !== options.dispatchId) {
			throw new RuntimeProtocolError("ROOM_SESSION_BUSY", "Room Session already owns another active Dispatch");
		}
		this.beginRoomDispatch(options);
		if (options.sessionContext !== undefined) {
			this.sessionContext = options.sessionContext.trim();
		}
		if (options.roomContext !== undefined) {
			this.roomContext = options.roomContext.trim();
		}
		if (options.roomRecoveryContext !== undefined) {
			this.roomRecoveryContext = options.roomRecoveryContext.trim();
		}
		if (options.roomCapability !== undefined) {
			const requestedEpoch = Number(options.roomCapability.contextEpoch);
			const currentEpoch = this.providerContextJournal.snapshot().epoch;
			if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < currentEpoch) {
				throw new RuntimeProtocolError(
					"ROOM_CONTEXT_EPOCH_INVALID",
					"Room Dispatch context epoch is stale or invalid",
				);
			}
			if (requestedEpoch > currentEpoch) {
				if (String(options.roomCapability.contextEpochReason ?? "") !== "task_switch") {
					throw new RuntimeProtocolError(
						"ROOM_CONTEXT_EPOCH_INVALID",
						"Room Dispatch may advance context only for a task switch",
					);
				}
				this.providerContextJournal.beginEpoch(
					"task_switch",
					this.session.systemPrompt,
					{
						sessionContext: this.sessionContext,
						roomContext: this.roomContext,
						transientContext: "",
					},
					requestedEpoch,
				);
			}
		}
		if (options.roomProviderContext !== undefined) {
			this.roomProviderContext = structuredClone(options.roomProviderContext);
		}
		if (options.roomCapability !== undefined) {
			this.roomCapability = structuredClone(options.roomCapability);
			this.backendBridge.roomCapability = structuredClone(options.roomCapability);
			this.refreshBackendToolDisclosure(true);
		}
		if (options.roomResourceLimits !== undefined) {
			this.roomResourceLimits = structuredClone(options.roomResourceLimits);
		}
		try {
			await rebindGovernedToolReceipts(this.backendBridge, options.dispatchId);
		} catch (error) {
			if (this.activeRoom?.dispatchId === options.dispatchId) {
				this.activeRoom = undefined;
			}
			throw error;
		}
		if (!this.activeTurn) {
			try {
				const turn = await this.prompt({ message: options.message });
				if (this.activeRoom?.dispatchId === options.dispatchId) {
					this.activeRoom.runtimeTurnId = turn.turnId;
				}
				return {
					delivery: turn.disposition === "handled" ? "handled" : "prompt",
					turnId: turn.turnId,
					disposition: turn.disposition,
					...(turn.settlement ? { settlement: turn.settlement } : {}),
					roomSkillLoad: this.roomSkillLoadReceipt(),
					providerContextReceipt: this.roomProviderContext
						? {
								...structuredClone(this.roomProviderContext),
								providerRequestId: turn.turnId,
							}
						: undefined,
				};
			} catch (error) {
				if (this.activeRoom?.dispatchId === options.dispatchId) {
					this.activeRoom = undefined;
				}
				throw error;
			}
		}
		return this.queueRoomContinuation(options);
	}

	private async queueRoomContinuation(options: {
		message: string;
		dispatchId: string;
		rootId: string;
		generation: number;
		dispatchAttempt: number;
	}): Promise<Record<string, unknown>> {
		const turnId = this.activeTurn?.turnId;
		if (!turnId) {
			throw new Error("room continuation requires an active turn");
		}
		const continuationId = `room-continuation:${options.dispatchId}:${options.dispatchAttempt}:${randomUUID()}`;
		if (this.session.isIdle) {
			// An idle repair starts a native Pi prompt so before_agent_start can
			// assemble the latest governed context. Resolve after preflight rather
			// than waiting for the entire Provider run.
			const turn = this.activeTurn;
			if (!turn) throw new RuntimeProtocolError("SESSION_IDLE", "Room continuation requires its original turn");
			const admission = await this.startTurnPrompt(turn, options.message, { source: "rpc", expandPromptTemplates: false });
			if (admission.disposition === "handled") return { delivery: "handled", ...admission };
		} else {
			await this.session.followUp(options.message);
		}
		this.roomContinuationIds.add(continuationId);
		return {
			delivery: "followUp",
			turnId,
			continuationId,
			roomSkillLoad: this.roomSkillLoadReceipt(),
		};
	}

	private beginRoomDispatch(options: ActiveRoomDispatch & { roomResourceLimits?: RoomResourceLimits }): void {
		this.progressGuard().reset();
		this.activeRoom = {
			dispatchId: options.dispatchId,
			rootId: options.rootId,
			generation: options.generation,
			dispatchAttempt: options.dispatchAttempt,
			runtimeTurnId: this.activeTurn?.turnId,
			capabilityEpoch: options.capabilityEpoch,
		};
		this.roomToolCalls = 0;
		this.roomToolCost = 0;
		this.roomContinuationIds.clear();
	}

	authorizeRoomToolCall(): { allowed: boolean; reason?: string } {
		if (!this.roomResourceLimits) return { allowed: true };
		if (Date.now() >= this.roomResourceLimits.deadlineAtMs) {
			return { allowed: false, reason: "Room wall-clock deadline exceeded" };
		}
		if (
			this.roomResourceLimits.maxToolCalls !== undefined &&
			this.roomToolCalls >= this.roomResourceLimits.maxToolCalls
		) {
			return { allowed: false, reason: "Room tool-call limit exhausted" };
		}
		if (this.roomToolCost + 1 > this.roomResourceLimits.maxToolCost) {
			return { allowed: false, reason: "Room tool-cost limit exhausted" };
		}
		this.roomToolCalls += 1;
		this.roomToolCost += 1;
		return { allowed: true };
	}

	private assertRoomDispatchResources(): void {
		const limits = this.roomResourceLimits;
		if (!limits) return;
		if (Date.now() >= limits.deadlineAtMs) {
			throw new RuntimeProtocolError("ROOM_DEADLINE_EXCEEDED", "Room wall-clock deadline exceeded");
		}
		const maxInputTokens = limits.maxInputTokens;
		if (maxInputTokens !== undefined) {
			const contextTokens = this.session.getContextUsage()?.tokens ?? 0;
			if (contextTokens > maxInputTokens) {
				throw new RuntimeProtocolError("ROOM_INPUT_LIMIT_EXCEEDED", "Room input-token limit exceeded");
			}
		}
	}

	cancelRoom(lineage: RoomCancelParams): { cancelledIds: string[]; abortRequired: boolean } {
		const replay = this.appliedRoomCancels.get(lineage.cancelId);
		if (replay) {
			if (!sameRoomCancelLineage(replay.lineage, lineage)) {
				throw new RuntimeProtocolError(
					"ROOM_CANCEL_LINEAGE_MISMATCH",
					"Room cancellation does not match the active Room runtime lineage",
				);
			}
			return { cancelledIds: [...replay.cancelledIds], abortRequired: true };
		}
		const active = this.activeRoom;
		if (
			!active ||
			lineage.sessionId !== this.externalSessionId ||
			lineage.rootId !== active.rootId ||
			lineage.dispatchId !== active.dispatchId ||
			lineage.turnId !== active.runtimeTurnId ||
			lineage.turnId !== this.activeTurn?.turnId ||
			lineage.capabilityEpoch !== active.capabilityEpoch ||
			lineage.generation < active.generation
		) {
			throw new RuntimeProtocolError(
				"ROOM_CANCEL_LINEAGE_MISMATCH",
				"Room cancellation does not match the active Room runtime lineage",
			);
		}
		this.session.clearQueue();
		const cancelledIds = [...this.roomContinuationIds];
		this.roomContinuationIds.clear();
		this.appliedRoomCancels.set(lineage.cancelId, {
			lineage: structuredClone(lineage),
			cancelledIds,
		});
		return {
			cancelledIds,
			abortRequired: true,
		};
	}

	finishRoomCancel(rootId: string, generation: number, cancelId?: string): void {
		if (cancelId) this.appliedRoomCancels.delete(cancelId);
		if (this.activeRoom?.rootId !== rootId || this.activeRoom.generation > generation) return;
		if (!this.isIdle) return;
		this.activeTurn = undefined;
		this.activeRoom = undefined;
		this.roomContinuationIds.clear();
		this.transientContext = "";
		this.providerContextJournal.clearTurnContext();
	}

	private messageQueue(): Record<string, unknown> {
		return {
			steering: [...(this.session.getSteeringMessages?.() ?? [])],
			followUp: [...(this.session.getFollowUpMessages?.() ?? [])],
			steeringMode: this.session.steeringMode,
			followUpMode: this.session.followUpMode,
		};
	}

	private recoveryResourcesDrained(): boolean {
		return !this.activeRoom && !this.disposePromise && !this.pluginReloadInFlight &&
			this.isIdle === true && this.session.isStreaming === false &&
			this.session.isRetrying === false && this.session.isCompacting === false && this.session.isBashRunning === false &&
			this.session.pendingMessageCount === 0 && this.session.agent.state.isStreaming === false &&
			this.session.agent.state.pendingToolCalls.size === 0 && !this.session.agent.hasQueuedMessages() &&
			this.pendingDecisions.size === 0 && this.pendingUIRequests.size === 0 && this.roomContinuationIds.size === 0;
	}

	private retireDrainedTurn(activeTurn: ActiveTurn): void {
		const turnId = activeTurn.turnId;
		// Retire only the drained turn observed before abort. Keep a durable
		// tombstone so reopening a crashed Session cannot revive its binding.
		this.session.sessionManager.appendCustomEntry(TURN_BINDING_CUSTOM_TYPE, {
			schemaVersion: "rag-ime.pi-turn-binding.v1",
			...activeTurn,
			state: "retired",
			reason: "explicit_abort",
			retiredAtMs: Date.now(),
		});
		this.session.sessionManager.flushPendingEntries();
		this.activeTurn = undefined;
		if (this.activeRoom?.runtimeTurnId === turnId) this.activeRoom = undefined;
		this.transientContext = "";
		this.providerContextJournal.clearTurnContext();
		this.recoveredTurnBindingId = undefined;
	}

	private async abortWithTurnId(turnId: string): Promise<PiSessionAbortReceipt> {
		const activeTurn = this.activeTurn;
		if (activeTurn && activeTurn.turnId !== turnId) {
			throw new RuntimeProtocolError("TURN_BINDING_MISMATCH", "Cancellation no longer matches the active turn");
		}
		const preflight = this.promptPreflight?.turn.turnId === turnId ? this.promptPreflight : undefined;
		if (preflight) preflight.cancelled = true;
		if (activeTurn?.turnId === turnId && (!this.session.isIdle || preflight)) {
			(this.abortingTurnIds ??= new Set()).add(turnId);
		}
		const cancelledUIRequestIds = [...this.pendingUIRequests.keys()];
		for (const pending of [...this.pendingUIRequests.values()]) pending.cancel();

		const cancelledDecisionIds = [...this.pendingDecisions.values()].map((pending) => pending.requestId);
		for (const pending of [...this.pendingDecisions.values()]) pending.resolve(false);

		const registeredAt = Date.now();
		const operations: PiAgentAbortOperation[] = [];
		if (preflight) operations.push(preflight.operation);
		const register = (kind: string) => {
			operations.push({
				operationId: `abort:${kind}:${turnId || this.externalSessionId}:${randomUUID()}`,
				kind,
				registeredAt,
			});
		};
		if (this.session.isStreaming) register("provider");
		if (this.session.isRetrying) register("retry_sleep");
		if (this.session.isCompacting) register("compaction_or_branch_summary");
		if (this.session.isBashRunning) register("bash_process");

		this.session.clearQueue();
		const cancelledContinuationIds = [...this.roomContinuationIds];
		this.roomContinuationIds.clear();
		this.session.abortBash();
		this.session.abortCompaction();
		this.session.abortBranchSummary();
		this.session.abortRetry();
		const nativeAbort = this.session.abort();
		if (preflight) void nativeAbort.catch(() => undefined);
		else {
			await nativeAbort;
			await this.session.waitForIdle();
		}
		const stillPending = new Set<string>();
		if (this.promptPreflight === preflight && preflight) stillPending.add("prompt_preflight");
		if (this.session.isStreaming) stillPending.add("provider");
		if (this.session.isRetrying) stillPending.add("retry_sleep");
		if (this.session.isCompacting) stillPending.add("compaction_or_branch_summary");
		if (this.session.isBashRunning) stillPending.add("bash_process");
		const pendingOperations = operations.filter((operation) => stillPending.has(operation.kind));
		const failedOperationIds = pendingOperations.map((operation) => operation.operationId);
		const cancelledOperationIds = operations
			.filter((operation) => !stillPending.has(operation.kind))
			.map((operation) => operation.operationId);
		const idle = this.isIdle;
		const lifecycle: PiAgentAbortReceipt = {
			schemaVersion: "pi.agent-abort-receipt.v1",
			scopeId: `${this.session.sessionId}:${turnId || "idle"}`,
			generation: ++this.abortGeneration,
			reason: "user_abort",
			cancelledContinuationIds,
			cancelledOperationIds,
			failedOperationIds,
			operations,
			pendingOperations,
			drained: idle && pendingOperations.length === 0,
			idle,
			source: "runtime_host_adapter",
		};
		if (activeTurn?.turnId === turnId && this.activeTurn?.turnId === turnId && idle && lifecycle.drained) {
			this.retireDrainedTurn(activeTurn);
		}
		return {
			schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
			sessionId: this.externalSessionId,
			turnId,
			cancelledDecisionIds,
			cancelledUIRequestIds,
			lifecycle,
		};
	}

	abort(expected?: { turnId?: string; clientMessageId: string }): Promise<PiSessionAbortReceipt> {
		// Comparison and native signalling share one synchronous call; no await
		// lets a replacement turn acquire a Stop intended for an earlier run.
		if (expected && (!this.activeTurn ||
			(expected.turnId !== undefined && this.activeTurn.turnId !== expected.turnId) ||
			(this.activeTurn.clientMessageId ?? "") !== expected.clientMessageId)) {
			throw new RuntimeProtocolError("ABORT_TARGET_MISMATCH", "Requested Stop target is no longer active");
		}
		return this.abortWithTurnId(this.activeTurn?.turnId ?? "");
	}

	abortExact(options: {
		turnId: string;
		clientMessageId: string;
		cancelId: string;
		lookupOnly?: boolean;
		recoverRetiredOnly?: boolean;
		recoverInterruptedOnly?: boolean;
	}): PiExactTurnCancelReceipt {
		const { turnId, clientMessageId, cancelId } = options;
		if (!turnId || !clientMessageId || !cancelId) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "Exact cancellation requires turn, command and cancel identities");
		}
		if (options.recoverRetiredOnly && options.recoverInterruptedOnly) {
			throw new RuntimeProtocolError("INVALID_PARAMS", "Choose one exact recovery phase");
		}
		const receipts = (this.exactTurnCancels ??= new Map());
		let previous = receipts.get(cancelId);
		if (!previous) {
			for (const entry of [...this.session.sessionManager.getEntries()].reverse()) {
				if (entry.type !== "custom" || entry.customType !== EXACT_TURN_CANCEL_CUSTOM_TYPE) continue;
				const value = objectRecord(entry.data);
				if (value?.cancelId !== cancelId || value.sessionId !== this.externalSessionId) continue;
				if (value.schemaVersion !== "rag-ime.pi-exact-turn-cancel.v1" ||
					(value.state !== "accepted" && value.state !== "rejected") ||
					typeof value.receiptId !== "string" || !value.receiptId ||
					typeof value.turnId !== "string" || typeof value.clientMessageId !== "string") {
					throw new RuntimeProtocolError("INVALID_CANCEL_RECEIPT", "Persisted cancellation receipt is invalid");
				}
				previous = value as unknown as PiExactTurnCancelReceipt;
				receipts.set(cancelId, previous);
				break;
			}
		}
		if (previous) {
			if (previous.turnId !== turnId || previous.clientMessageId !== clientMessageId) {
				throw new RuntimeProtocolError("CANCEL_IDENTITY_MISMATCH", "Cancellation identity was reused for a different turn");
			}
			return structuredClone(previous);
		}
		const receipt: PiExactTurnCancelReceipt = {
			schemaVersion: "rag-ime.pi-exact-turn-cancel.v1", sessionId: this.externalSessionId,
			turnId, clientMessageId, cancelId, state: "unknown",
		};
		if (options.lookupOnly) return receipt;
		if (options.recoverInterruptedOnly) {
			const latest = [...this.session.sessionManager.getBranch()].reverse()
				.find(entry => entry.type === "custom" && entry.customType === TURN_BINDING_CUSTOM_TYPE);
			const binding = latest?.type === "custom" ? objectRecord(latest.data) : undefined;
			const reject = (reason: string): PiExactTurnCancelReceipt => ({ ...receipt, state: "rejected", reason });
			if (!latest?.id || latest.id !== this.recoveredTurnBindingId ||
				binding?.schemaVersion !== "rag-ime.pi-turn-binding.v1" || binding.state === "retired" ||
				binding.turnId !== turnId || binding.clientMessageId !== clientMessageId ||
				this.activeTurn?.turnId !== turnId || this.activeTurn.clientMessageId !== clientMessageId ||
				this.turnSettlements.get(turnId, clientMessageId)) {
				return reject("requested_turn_is_not_the_cold_recovered_binding");
			}
			if (!this.recoveryResourcesDrained()) return reject("interrupted_turn_resources_not_drained");
			// No await, cancellation control or queue clearing between the actual
			// resource check and retirement. A newly active turn cannot be cancelled.
			this.retireDrainedTurn(this.activeTurn);
			receipt.state = "accepted";
			receipt.phase = "settled";
			receipt.receiptId = `pi-exact-cancel:interrupted:${sha256Json([this.externalSessionId, turnId, clientMessageId, cancelId])}`;
			receipt.runtimeReceipt = {
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1", sessionId: this.externalSessionId, turnId,
				cancelledDecisionIds: [], cancelledUIRequestIds: [], lifecycle: {
					schemaVersion: "pi.agent-abort-receipt.v1", scopeId: `${this.session.sessionId}:${turnId}`,
					generation: ++this.abortGeneration, reason: "interrupted_turn_recovery", source: "runtime_host_adapter",
					cancelledContinuationIds: [], cancelledOperationIds: [], failedOperationIds: [],
					operations: [], pendingOperations: [], drained: true, idle: true,
				},
			};
			receipts.set(cancelId, receipt);
			try {
				this.session.sessionManager.appendCustomEntry(EXACT_TURN_CANCEL_CUSTOM_TYPE, structuredClone(receipt));
				this.session.sessionManager.flushPendingEntries();
			} catch { receipt.persistencePending = true; }
			return structuredClone(receipt);
		}
		if (options.recoverRetiredOnly) {
			// This is journal repair, never a fallback to aborting a live turn.
			// Only the latest binding on this transcript branch may be repaired.
			const entries = this.session.sessionManager.getBranch();
			const latest = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === TURN_BINDING_CUSTOM_TYPE);
			const binding = latest?.type === "custom" ? objectRecord(latest.data) : undefined;
			const reject = (reason: string): PiExactTurnCancelReceipt => ({ ...receipt, state: "rejected", reason });
			if (!latest?.id || binding?.schemaVersion !== "rag-ime.pi-turn-binding.v1" ||
				binding.state !== "retired" || binding.reason !== "explicit_abort" ||
				binding.turnId !== turnId || binding.clientMessageId !== clientMessageId ||
				typeof binding.retiredAtMs !== "number" || !Number.isFinite(binding.retiredAtMs)) {
				return reject("requested_turn_is_not_the_latest_retired_binding");
			}
			if (this.activeTurn || !this.recoveryResourcesDrained()) {
				// Do not persist transient rejection: the same recovery identity may
				// be checked again after the actual Runtime resources have drained.
				return reject("retired_turn_resources_not_drained");
			}
			let settlement = this.turnSettlements.get(turnId, clientMessageId);
			if (!settlement) {
				for (const entry of [...entries].reverse()) {
					if (entry.type !== "custom" || entry.customType !== TURN_SETTLEMENT_CUSTOM_TYPE) continue;
					const value = persistedTurnSettlement(entry.data);
					if (value?.sessionId === this.externalSessionId && value.runtimeSessionId === this.session.sessionId &&
						value.turnId === turnId && value.clientMessageId === clientMessageId) { settlement = value; break; }
				}
			}
			if (settlement && settlement.receipt.disposition !== "aborted") return reject("turn_already_has_a_settlement");
			if (!settlement) {
				const recovered = this.createSettlementReceipt({ turnId, clientMessageId });
				recovered.receiptId = `pi-settled:retired:${sha256Json([this.externalSessionId, this.session.sessionId, turnId, clientMessageId, latest.id])}`;
				recovered.disposition = "aborted";
				recovered.aborted = true;
				recovered.stopReason = "retired_turn_recovered";
				// A prior assistant message is not this retired turn's final result.
				delete recovered.finalMessage;
				settlement = { schemaVersion: "rag-ime.pi-turn-settlement.v1", sessionId: this.externalSessionId,
					runtimeSessionId: this.session.sessionId, turnId, clientMessageId, receipt: recovered };
				this.session.sessionManager.appendCustomEntry(TURN_SETTLEMENT_CUSTOM_TYPE, settlement);
			}
			// Flush before resolving any waiter or claiming successful recovery.
			// A retry can finish flushing the same journal entry after storage failure.
			this.session.sessionManager.flushPendingEntries();
			this.turnSettlements.restore(settlement);
			receipt.state = "accepted";
			receipt.phase = "settled";
			receipt.receiptId = `pi-exact-cancel:retired:${sha256Json([this.externalSessionId, turnId, clientMessageId, cancelId])}`;
			receipt.runtimeReceipt = {
				schemaVersion: "rag-ime.pi-session-abort-receipt.v1", sessionId: this.externalSessionId, turnId,
				cancelledDecisionIds: [], cancelledUIRequestIds: [], lifecycle: {
					schemaVersion: "pi.agent-abort-receipt.v1", scopeId: settlement.receipt.scopeId,
					generation: ++this.abortGeneration, reason: "retired_turn_recovery", source: "runtime_host_adapter",
					cancelledContinuationIds: [], cancelledOperationIds: [], failedOperationIds: [],
					operations: [], pendingOperations: [], drained: true, idle: true,
				},
			};
			receipts.set(cancelId, receipt);
			try {
				this.session.sessionManager.appendCustomEntry(EXACT_TURN_CANCEL_CUSTOM_TYPE, structuredClone(receipt));
				this.session.sessionManager.flushPendingEntries();
			} catch { receipt.persistencePending = true; }
			return structuredClone(receipt);
		}
		const matches = this.activeTurn?.turnId === turnId && this.activeTurn.clientMessageId === clientMessageId;
		receipt.state = matches ? "accepted" : "rejected";
		receipt.receiptId = `pi-exact-cancel:${randomUUID()}`;
		receipts.set(cancelId, receipt);
		const persist = () => {
			try {
				this.session.sessionManager.appendCustomEntry(EXACT_TURN_CANCEL_CUSTOM_TYPE, structuredClone(receipt));
				this.session.sessionManager.flushPendingEntries();
				delete receipt.persistencePending;
			} catch {
				// An admitted cancellation remains admitted when projection storage
				// fails. The exact in-memory receipt remains queryable without replay.
				receipt.persistencePending = true;
			}
		};
		if (!matches) {
			receipt.reason = "requested_turn_is_not_active";
			persist();
			return structuredClone(receipt);
		}
		// No await separates identity comparison from signalling Pi's native
		// abort controls. A reused Session can never be cancelled by this request.
		receipt.phase = "requested";
		const preflight = this.promptPreflight?.turn.turnId === turnId ? this.promptPreflight : undefined;
		const cancellation = this.abortWithTurnId(turnId);
		persist();
		void cancellation.then(async (runtimeReceipt) => {
			receipt.runtimeReceipt = runtimeReceipt;
			// Native abort completion retains its existing phase contract; a
			// preflight is additional work that native abort did not wait for.
			receipt.phase = preflight && !runtimeReceipt.lifecycle.drained ? "requested" : "settled";
			persist();
			if (!runtimeReceipt.lifecycle.drained && preflight) {
				await preflight.done;
				const settlement = this.turnSettlements.get(turnId, clientMessageId);
				if (!settlement || settlement.receipt.pendingOperations !== 0) return;
				const lifecycle = runtimeReceipt.lifecycle;
				const pendingOperations = lifecycle.pendingOperations.filter(operation => operation.operationId !== preflight.operation.operationId);
				receipt.runtimeReceipt = { ...runtimeReceipt, lifecycle: { ...lifecycle, pendingOperations,
					cancelledOperationIds: lifecycle.operations.filter(operation => !pendingOperations.includes(operation)).map(operation => operation.operationId),
					drained: pendingOperations.length === 0, idle: pendingOperations.length === 0 } };
				receipt.phase = pendingOperations.length === 0 ? "settled" : "requested";
			}
			persist();
		}, (error: unknown) => {
			receipt.phase = "failed";
			receipt.reason = error instanceof Error ? error.message : String(error);
			persist();
		});
		return structuredClone(receipt);
	}

	abortRoom(lineage: RoomCancelParams): Promise<PiSessionAbortReceipt> {
		const applied = this.appliedRoomCancels.get(lineage.cancelId);
		if (!applied || !sameRoomCancelLineage(applied.lineage, lineage)) {
			throw new RuntimeProtocolError(
				"ROOM_CANCEL_LINEAGE_MISMATCH",
				"Room cancellation does not match the active Room runtime lineage",
			);
		}
		return this.abortWithTurnId(lineage.turnId);
	}

	async compact(customInstructions?: string): Promise<unknown> {
		if (!this.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before compaction");
		}
		const refreshRevisionBefore = this.sessionContextRefreshRevision;
		const contextEpochBefore = this.providerContextJournal.snapshot().epoch;
		const result = await this.session.compact(customInstructions);
		const compactionEntry = [...this.session.sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "compaction");
		const contextEpochAfter = this.providerContextJournal.snapshot().epoch;
		if (this.roomCapability && contextEpochAfter > contextEpochBefore) {
			this.roomCapability = {
				...this.roomCapability,
				contextEpoch: contextEpochAfter,
				contextEpochReason: "compaction",
			};
			this.backendBridge.roomCapability = structuredClone(this.roomCapability);
		}
		return {
			...result,
			contextRefreshApplied: this.sessionContextRefreshRevision > refreshRevisionBefore,
			compactionEntryId: compactionEntry?.id,
			contextEpochBefore,
			contextEpochAfter,
		};
	}

	async setModel(provider: string, modelId: string, maxTokens?: number): Promise<Record<string, unknown>> {
		if (!this.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before changing models");
		}
		const model = this.session.modelRuntime.getModel(provider, modelId);
		if (!model) throw new RuntimeProtocolError("MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);
		const selected =
			maxTokens === undefined
				? model
				: {
						...model,
						maxTokens: Math.min(maxTokens, model.maxTokens > 0 ? model.maxTokens : maxTokens),
					};
		await this.session.setModel(selected);
		return publicSessionModel(selected);
	}

	setThinkingLevel(level: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>): Record<string, unknown> {
		if (!this.isIdle) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before changing thinking level");
		}
		const supported = this.session.model ? getSupportedThinkingLevels(this.session.model) : ["off"];
		if (!supported.includes(level)) {
			throw new RuntimeProtocolError("THINKING_LEVEL_UNSUPPORTED", `Thinking level is not supported: ${level}`);
		}
		this.session.setThinkingLevel(level);
		return { level: this.session.thinkingLevel, supported };
	}

	setCodemodeMode(mode: "on" | "only" | "off"): Record<string, unknown> {
		if (!this.session.isIdle || this.activeTurn || this.pluginReloadInFlight) {
			throw new RuntimeProtocolError("SESSION_BUSY", "Session must be idle before changing codemode");
		}
		const tools = this.session.getActiveToolNames().filter(name => name !== "codemode");
		this.codemodeState.mode = mode;
		this.session.setActiveToolsByName(mode === "off" ? tools : [...tools, "codemode"]);
		return { codemodeMode: this.codemodeMode };
	}

	private async performPluginReload(): Promise<void> {
		const skillsBefore = this.resourceLoader.getSkills().skills;
		const toolsBefore = this.registeredToolSchemas();
		await this.session.reload();
		applyBackendToolDisclosure(this.session, this.toolRegistry, this.roomCapability !== undefined);
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

	private async drainPluginReload(): Promise<void> {
		if (!this.pluginReloadPending || !this.isIdle || this.disposePromise) return;
		if (this.pluginReloadInFlight) return await this.pluginReloadInFlight;
		const operation = (async () => {
			while (this.pluginReloadPending && this.isIdle && !this.disposePromise) {
				this.pluginReloadPending = false;
				try {
					await this.performPluginReload();
				} catch (error) {
					this.pluginReloadPending = true;
					throw error;
				}
			}
		})();
		this.pluginReloadInFlight = operation;
		try {
			await operation;
		} finally {
			if (this.pluginReloadInFlight === operation) this.pluginReloadInFlight = undefined;
		}
	}

	async reloadPlugins(): Promise<void> {
		this.pluginReloadPending = true;
		await this.drainPluginReload();
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeInternal();
		return this.disposePromise;
	}

	private async disposeInternal(): Promise<void> {
		const preflight = this.promptPreflight;
		if (preflight) preflight.cancelled = true;
		this.progressGuard().reset();
		this.turnSettlements.dispose();
		for (const pending of this.pendingUIRequests.values()) pending.cancel();
		this.pendingUIRequests.clear();
		for (const pending of this.pendingDecisions.values()) {
			pending.cleanup();
			pending.resolve(false);
		}
		this.pendingDecisions.clear();
		this.transientContext = "";
		this.providerContextJournal.clearTurnContext();
		try {
			await this.session.abort();
			await preflight?.done;
		} catch {
			// Continue shutdown even if the active Provider or Tool ignored abort.
		}
		try {
			if (this.session.hasExtensionHandlers("session_shutdown")) {
				await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			}
		} finally {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.debugContextRecorder.clear();
			this.session.dispose();
		}
	}
}

export function normalizeWorkspacePath(path: string): string {
	return resolve(path);
}
