import { createHash } from "node:crypto";
import {
	type ContextAssembly,
	type ContextAssemblyReceipt,
	type ContextContribution,
	type ContextProvider,
	type ContextProviderDescriptor,
	ContextProviderPipeline,
	type ContextProviderRequest,
} from "./context-provider.ts";
import type { RuntimeContextSnapshot } from "./transient-context.ts";

export interface ProductContextProviderOptions {
	sessionId: string;
	getRunId(): string;
	getRoomContext(): string;
	getRoomRecoveryContext?(): string;
	getSessionContext(): string;
	getTurnContext(): string;
	getRoomRevision?(): string;
	getRoomRecoveryRevision?(): string;
	getSessionRevision?(): string;
	getTurnRevision?(): string;
	isRoomBound(): boolean;
	/** Fixed at Session construction so required Room context cannot silently become optional. */
	roomRequired?: boolean;
	tokenBudget?: number;
	/** WorkDocument, Knowledge, role-book, and other product-owned sources plug in here. */
	additionalProviders?: readonly ContextProvider[];
	now?: () => number;
}

export interface ProductContextAssembly {
	context: RuntimeContextSnapshot;
	assembly: ContextAssembly;
	receipt: ContextAssemblyReceipt;
}

interface InlineContextValue {
	content: string;
	revision?: string;
	receiptId?: string;
	sourceId?: string;
	sourceRevision?: string;
}

function contentRevision(prefix: string, content: string): string {
	return `${prefix}:${createHash("sha256").update(content).digest("hex")}`;
}

function inlineProvider(
	descriptor: ContextProviderDescriptor,
	read: (request: ContextProviderRequest) => InlineContextValue,
	now: () => number,
): ContextProvider {
	return {
		descriptor,
		read: (request) => {
			const value = read(request);
			const content = value.content.trim();
			if (!content) return null;
			const revision = value.revision?.trim() || contentRevision(descriptor.id, content);
			return {
				revision,
				content,
				fetchedAtMs: now(),
				provenance: [
					{
						sourceId: value.sourceId?.trim() || descriptor.id,
						sourceRevision: value.sourceRevision?.trim() || revision,
						receiptId: value.receiptId,
					},
				],
			} satisfies ContextContribution;
		},
	};
}

/**
 * Thin PAW adapter over Pi's product-neutral ContextProvider pipeline.
 *
 * Room remains product authority. Pi only receives a deterministic, receipted
 * assembly for one run. Existing mutable fields stay as compatibility inputs;
 * new WorkDocument, Knowledge, Memory, and role-book sources register through
 * `additionalProviders` instead of adding more prompt-concatenation branches.
 */
export class ProductContextProvider {
	private readonly options: ProductContextProviderOptions;
	private readonly pipeline: ContextProviderPipeline;
	private lastReceipt?: ContextAssemblyReceipt;

	constructor(options: ProductContextProviderOptions) {
		this.options = options;
		const roomRequired = options.roomRequired ?? options.isRoomBound();
		const now = options.now ?? (() => Date.now());
		const roomValue = (): InlineContextValue => {
			const current = options.getRoomContext().trim();
			if (current) {
				return {
					content: current,
					revision: options.getRoomRevision?.(),
					sourceId: "paw.room",
				};
			}
			const recovery = options.getRoomRecoveryContext?.().trim() ?? "";
			return {
				content: recovery,
				revision: options.getRoomRecoveryRevision?.(),
				sourceId: "paw.room-recovery",
			};
		};
		const providers: ContextProvider[] = [
			inlineProvider(
				{
					id: "paw.room",
					version: "1",
					stages: ["turn_start", "continuation_resume", "after_compaction"],
					placement: "stable_system",
					priority: 400,
					minTokens: roomRequired ? 1 : 0,
					maxTokens: 64_000,
					failureMode: roomRequired ? "required" : "optional",
					cacheSegment: "stable",
				},
				roomValue,
				now,
			),
			inlineProvider(
				{
					id: "paw.room-recovery",
					version: "1",
					stages: ["turn_start", "continuation_resume", "after_compaction"],
					placement: "continuation_context",
					priority: 350,
					minTokens: 0,
					maxTokens: 48_000,
					failureMode: "optional",
					cacheSegment: "session",
				},
				() => {
					const current = options.getRoomContext().trim();
					const recovery = options.getRoomRecoveryContext?.().trim() ?? "";
					return {
						// When current Room context is absent, the stable provider already
						// consumed recovery as its fail-closed fallback. Do not inject twice.
						content: current && recovery !== current ? recovery : "",
						revision: options.getRoomRecoveryRevision?.(),
						sourceId: "paw.room-recovery",
					};
				},
				now,
			),
			inlineProvider(
				{
					id: "paw.session-memory",
					version: "1",
					stages: ["turn_start", "continuation_resume", "after_compaction"],
					placement: "session_system",
					priority: 200,
					minTokens: 0,
					maxTokens: 32_000,
					failureMode: "optional",
					cacheSegment: "session",
				},
				() => ({
					content: options.getSessionContext(),
					revision: options.getSessionRevision?.(),
					sourceId: "paw.session-memory",
				}),
				now,
			),
			inlineProvider(
				{
					id: "paw.turn",
					version: "1",
					stages: ["turn_start", "continuation_resume"],
					placement: "turn_context",
					priority: 100,
					minTokens: 0,
					maxTokens: 16_000,
					failureMode: "optional",
					cacheSegment: "turn",
				},
				() => ({
					content: options.getTurnContext(),
					revision: options.getTurnRevision?.(),
					sourceId: "paw.turn",
				}),
				now,
			),
			...(options.additionalProviders ?? []),
		];
		this.pipeline = new ContextProviderPipeline(providers, { now });
	}

	async assemble(options: {
		stage: "turn_start" | "continuation_resume" | "after_compaction";
		queryText?: string;
		signal?: AbortSignal;
	}): Promise<ProductContextAssembly> {
		const signal = options.signal ?? new AbortController().signal;
		const assembly = await this.pipeline.assemble({
			sessionId: this.options.sessionId,
			runId: this.options.getRunId().trim() || `${this.options.sessionId}:preflight`,
			stage: options.stage,
			queryText: options.queryText,
			tokenBudget: this.options.tokenBudget ?? 48_000,
			previousAssemblyHash: this.lastReceipt?.assemblyHash,
			scopeTags: {
				product: "personal-agent-workbench",
				roomBound: String(this.options.isRoomBound()),
			},
			signal,
		});
		this.lastReceipt = assembly.receipt;
		return {
			context: {
				roomContext: assembly.byPlacement.stable_system,
				sessionContext: assembly.byPlacement.session_system,
				transientContext: [assembly.byPlacement.turn_context, assembly.byPlacement.continuation_context]
					.filter(Boolean)
					.join("\n\n"),
			},
			assembly,
			receipt: assembly.receipt,
		};
	}

	snapshot(): ContextAssemblyReceipt | undefined {
		return this.lastReceipt ? structuredClone(this.lastReceipt) : undefined;
	}
}
