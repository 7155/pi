export type ContextStage = "session_open" | "turn_start" | "continuation_resume" | "after_compaction";
export type ContextPlacement = "stable_system" | "session_system" | "turn_context" | "continuation_context";
export type ContextFailureMode = "required" | "optional";
export type ContextCacheSegment = "stable" | "session" | "turn";

export interface ContextProviderDescriptor {
	id: string;
	version: string;
	stages: readonly ContextStage[];
	placement: ContextPlacement;
	priority: number;
	minTokens: number;
	maxTokens: number;
	failureMode: ContextFailureMode;
	cacheSegment: ContextCacheSegment;
}

export interface ContextProviderRequest {
	sessionId: string;
	runId: string;
	stage: ContextStage;
	queryText?: string;
	allocatedTokens: number;
	previousAssemblyHash?: string;
	scopeTags: Readonly<Record<string, string>>;
	signal: AbortSignal;
}

export interface ContextProvenance {
	sourceId: string;
	sourceRevision?: string;
	receiptId?: string;
}

export interface ContextContribution {
	revision: string;
	content: string;
	contentHash?: string;
	estimatedTokens?: number;
	fetchedAtMs: number;
	expiresAtMs?: number;
	provenance: readonly ContextProvenance[];
}

export interface ContextProvider {
	readonly descriptor: ContextProviderDescriptor;
	read(request: ContextProviderRequest): Promise<ContextContribution | null> | ContextContribution | null;
}

export interface ContextContributionReceipt {
	providerId: string;
	providerVersion: string;
	revision: string;
	placement: ContextPlacement;
	cacheSegment: ContextCacheSegment;
	priority: number;
	allocatedTokens: number;
	estimatedTokens: number;
	contentHash: string;
	fetchedAtMs: number;
	expiresAtMs?: number;
	provenance: readonly ContextProvenance[];
}

export interface ContextOmissionReceipt {
	providerId: string;
	reason: "empty" | "optional_error" | "expired" | "budget_unavailable" | "budget_exceeded";
	detail?: string;
}

export interface ContextAssemblyReceipt {
	schemaVersion: "pi.context-assembly.v1";
	sessionId: string;
	runId: string;
	stage: ContextStage;
	assemblyHash: string;
	tokenBudget: number;
	estimatedTokens: number;
	contributions: ContextContributionReceipt[];
	omissions: ContextOmissionReceipt[];
	assembledAtMs: number;
}

export interface ContextAssembly {
	byPlacement: Readonly<Record<ContextPlacement, string>>;
	receipt: ContextAssemblyReceipt;
}

export interface ContextProviderPipelineOptions {
	estimateTokens?: (content: string) => number;
	now?: () => number;
}

const CONTEXT_STAGES = new Set<ContextStage>(["session_open", "turn_start", "continuation_resume", "after_compaction"]);
const CONTEXT_PLACEMENTS = new Set<ContextPlacement>([
	"stable_system",
	"session_system",
	"turn_context",
	"continuation_context",
]);
const FAILURE_MODES = new Set<ContextFailureMode>(["required", "optional"]);
const CACHE_SEGMENTS = new Set<ContextCacheSegment>(["stable", "session", "turn"]);

function nonEmpty(value: string, name: string): string {
	const result = value.trim();
	if (!result) throw new Error(`${name} must be a non-empty string`);
	return result;
}

function safeInteger(value: number, name: string, allowZero = false): number {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
	}
	return value;
}

function finiteTimestamp(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite timestamp`);
	return value;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function validateDescriptor(descriptor: ContextProviderDescriptor): void {
	const id = nonEmpty(descriptor.id, "provider id");
	const version = nonEmpty(descriptor.version, "provider version");
	if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) throw new Error(`invalid context provider id: ${id}`);
	if (!/^[A-Za-z0-9._:+/-]{1,128}$/u.test(version)) throw new Error(`invalid context provider version: ${version}`);
	if (descriptor.stages.length === 0) throw new Error(`context provider ${descriptor.id} has no stages`);
	if (new Set(descriptor.stages).size !== descriptor.stages.length) {
		throw new Error(`context provider ${descriptor.id} repeats a stage`);
	}
	for (const stage of descriptor.stages) {
		if (!CONTEXT_STAGES.has(stage)) throw new Error(`context provider ${descriptor.id} has an invalid stage`);
	}
	if (!CONTEXT_PLACEMENTS.has(descriptor.placement))
		throw new Error(`invalid context placement: ${descriptor.placement}`);
	if (!FAILURE_MODES.has(descriptor.failureMode))
		throw new Error(`invalid context failure mode: ${descriptor.failureMode}`);
	if (!CACHE_SEGMENTS.has(descriptor.cacheSegment))
		throw new Error(`invalid context cache segment: ${descriptor.cacheSegment}`);
	safeInteger(descriptor.minTokens, "minTokens", true);
	safeInteger(descriptor.maxTokens, "maxTokens");
	if (descriptor.minTokens > descriptor.maxTokens)
		throw new Error(`context provider ${descriptor.id} minTokens exceeds maxTokens`);
	if (!Number.isSafeInteger(descriptor.priority)) throw new Error("priority must be a safe integer");
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeContextBoundary(content: string): string {
	return content.replace(/<\/pi-context>/giu, "&lt;/pi-context&gt;");
}

function renderContribution(providerId: string, revision: string, content: string): string {
	return [
		`<pi-context provider="${escapeAttribute(providerId)}" revision="${escapeAttribute(revision)}">`,
		escapeContextBoundary(content),
		"</pi-context>",
	].join("\n");
}

function validateProvenance(providerId: string, values: readonly ContextProvenance[]): ContextProvenance[] {
	if (values.length === 0) throw new Error(`context provider ${providerId} returned no provenance`);
	return values.map((value) => ({
		sourceId: nonEmpty(value.sourceId, `${providerId}.provenance.sourceId`),
		sourceRevision:
			value.sourceRevision === undefined
				? undefined
				: nonEmpty(value.sourceRevision, `${providerId}.provenance.sourceRevision`),
		receiptId:
			value.receiptId === undefined ? undefined : nonEmpty(value.receiptId, `${providerId}.provenance.receiptId`),
	}));
}

export class ContextProviderPipeline {
	private readonly providers: readonly ContextProvider[];
	private readonly estimateTokens: (content: string) => number;
	private readonly now: () => number;

	constructor(providers: readonly ContextProvider[], options: ContextProviderPipelineOptions = {}) {
		const ids = new Set<string>();
		for (const provider of providers) {
			validateDescriptor(provider.descriptor);
			if (ids.has(provider.descriptor.id))
				throw new Error(`duplicate context provider id: ${provider.descriptor.id}`);
			ids.add(provider.descriptor.id);
		}
		this.providers = [...providers];
		this.estimateTokens = options.estimateTokens ?? ((content) => Math.max(1, Math.ceil(content.length / 4)));
		this.now = options.now ?? (() => Date.now());
	}

	async assemble(
		request: Omit<ContextProviderRequest, "allocatedTokens"> & { tokenBudget: number },
	): Promise<ContextAssembly> {
		safeInteger(request.tokenBudget, "tokenBudget");
		const sessionId = nonEmpty(request.sessionId, "sessionId");
		const runId = nonEmpty(request.runId, "runId");
		if (!CONTEXT_STAGES.has(request.stage)) throw new Error(`invalid context stage: ${request.stage}`);
		const applicable = this.providers
			.filter((provider) => provider.descriptor.stages.includes(request.stage))
			.sort(
				(left, right) =>
					right.descriptor.priority - left.descriptor.priority ||
					left.descriptor.id.localeCompare(right.descriptor.id),
			);
		let remaining = request.tokenBudget;
		const contributions: ContextContributionReceipt[] = [];
		const omissions: ContextOmissionReceipt[] = [];
		const rendered = new Map<ContextPlacement, string[]>();

		for (let index = 0; index < applicable.length; index += 1) {
			if (request.signal.aborted) throw request.signal.reason ?? new Error("context assembly aborted");
			const provider = applicable[index]!;
			const descriptor = provider.descriptor;
			const requiredReserve = applicable
				.slice(index + 1)
				.reduce(
					(total, candidate) =>
						total + (candidate.descriptor.failureMode === "required" ? candidate.descriptor.minTokens : 0),
					0,
				);
			const availableForProvider = Math.max(0, remaining - requiredReserve);
			if (availableForProvider < descriptor.minTokens || availableForProvider === 0) {
				if (descriptor.failureMode === "required") {
					throw new Error(`required context provider ${descriptor.id} has no token budget`);
				}
				omissions.push({ providerId: descriptor.id, reason: "budget_unavailable" });
				continue;
			}
			const allocatedTokens = Math.min(descriptor.maxTokens, availableForProvider);
			let contribution: ContextContribution | null;
			try {
				contribution = await provider.read({
					sessionId,
					runId,
					stage: request.stage,
					queryText: request.queryText,
					allocatedTokens,
					previousAssemblyHash: request.previousAssemblyHash,
					scopeTags: request.scopeTags,
					signal: request.signal,
				});
			} catch (error) {
				if (descriptor.failureMode === "required") throw error;
				omissions.push({
					providerId: descriptor.id,
					reason: "optional_error",
					detail: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const content = contribution?.content.trim() ?? "";
			if (!contribution || !content) {
				if (descriptor.failureMode === "required")
					throw new Error(`required context provider ${descriptor.id} returned empty content`);
				omissions.push({ providerId: descriptor.id, reason: "empty" });
				continue;
			}
			const fetchedAtMs = finiteTimestamp(contribution.fetchedAtMs, `${descriptor.id}.fetchedAtMs`);
			if (contribution.expiresAtMs !== undefined) {
				finiteTimestamp(contribution.expiresAtMs, `${descriptor.id}.expiresAtMs`);
				if (contribution.expiresAtMs <= fetchedAtMs) {
					throw new Error(`context provider ${descriptor.id} expiresAtMs must be later than fetchedAtMs`);
				}
				if (contribution.expiresAtMs <= this.now()) {
					if (descriptor.failureMode === "required")
						throw new Error(`required context provider ${descriptor.id} returned expired content`);
					omissions.push({ providerId: descriptor.id, reason: "expired" });
					continue;
				}
			}
			const measuredTokens = safeInteger(this.estimateTokens(content), `${descriptor.id}.measuredTokens`);
			const reportedTokens =
				contribution.estimatedTokens === undefined
					? 0
					: safeInteger(contribution.estimatedTokens, `${descriptor.id}.estimatedTokens`);
			const estimatedTokens = Math.max(measuredTokens, reportedTokens);
			if (estimatedTokens > allocatedTokens) {
				if (descriptor.failureMode === "required") {
					throw new Error(`required context provider ${descriptor.id} exceeded its token budget`);
				}
				omissions.push({ providerId: descriptor.id, reason: "budget_exceeded" });
				continue;
			}
			const contentHash = await sha256(content);
			if (contribution.contentHash !== undefined && contribution.contentHash !== contentHash) {
				throw new Error(`context provider ${descriptor.id} content hash mismatch`);
			}
			const revision = nonEmpty(contribution.revision, `${descriptor.id}.revision`);
			const receipt: ContextContributionReceipt = {
				providerId: descriptor.id,
				providerVersion: descriptor.version,
				revision,
				placement: descriptor.placement,
				cacheSegment: descriptor.cacheSegment,
				priority: descriptor.priority,
				allocatedTokens,
				estimatedTokens,
				contentHash,
				fetchedAtMs,
				expiresAtMs: contribution.expiresAtMs,
				provenance: validateProvenance(descriptor.id, contribution.provenance),
			};
			contributions.push(receipt);
			const blocks = rendered.get(descriptor.placement) ?? [];
			blocks.push(renderContribution(descriptor.id, revision, content));
			rendered.set(descriptor.placement, blocks);
			remaining -= estimatedTokens;
		}

		const byPlacement = {
			stable_system: (rendered.get("stable_system") ?? []).join("\n\n"),
			session_system: (rendered.get("session_system") ?? []).join("\n\n"),
			turn_context: (rendered.get("turn_context") ?? []).join("\n\n"),
			continuation_context: (rendered.get("continuation_context") ?? []).join("\n\n"),
		} satisfies Record<ContextPlacement, string>;
		const estimatedTokens = contributions.reduce((total, item) => total + item.estimatedTokens, 0);
		const assemblyCore = {
			schemaVersion: "pi.context-assembly.v1" as const,
			sessionId,
			runId,
			stage: request.stage,
			tokenBudget: request.tokenBudget,
			estimatedTokens,
			contributions,
			omissions,
			assembledAtMs: this.now(),
		};
		return {
			byPlacement,
			receipt: {
				...assemblyCore,
				assemblyHash: await sha256(
					canonicalJson({
						stage: request.stage,
						placements: byPlacement,
						contributions: contributions.map((item) => ({
							providerId: item.providerId,
							providerVersion: item.providerVersion,
							revision: item.revision,
							placement: item.placement,
							contentHash: item.contentHash,
						})),
					}),
				),
			},
		};
	}
}
