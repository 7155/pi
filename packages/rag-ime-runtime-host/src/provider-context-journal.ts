import { createHash } from "node:crypto";
import type { ContextAssembly, ContextAssemblyReceipt, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RuntimeContextSnapshot } from "./transient-context.ts";

const MANAGED_CONTEXT_BLOCK_PATTERN =
	/\n*<rag-ime-context\s+type="(?:room_context|session_memory|turn_context)"(?=[\s>])[^>]*>[\s\S]*?<\/rag-ime-context>/g;

type ProviderContextKind = "room_context" | "session_memory" | "turn_context";

interface ProviderContextEntry {
	kind: ProviderContextKind;
	body: string;
	contentHash: string;
}

export interface ProviderContextJournalSnapshot {
	schemaVersion: "rag-ime.provider-context-journal.v1";
	epoch: number;
	epochReason: string;
	entryCount: number;
	contentHashes: string[];
	assemblyHash?: string;
	assemblyReceipt?: ContextAssemblyReceipt;
}

function managedBlock(kind: ProviderContextKind, body: string): string {
	const value = body.trim().replace(/<\/rag-ime-context>/giu, "&lt;/rag-ime-context&gt;");
	return value ? [`<rag-ime-context type="${kind}">`, value, "</rag-ime-context>"].join("\n") : "";
}

function withoutManagedContext(systemPrompt: string): string {
	return systemPrompt.replace(MANAGED_CONTEXT_BLOCK_PATTERN, "").trimEnd();
}

/**
 * Owns one Pi Session's Provider-only context rendering.
 *
 * Legacy string callers retain the original append-within-epoch behavior.
 * New ContextProvider callers use `projectAssembly()`, which renders exactly
 * one current receipted assembly and therefore cannot accumulate stale Room,
 * Memory, Knowledge, or WorkDocument snapshots across turns.
 */
export class ProviderContextJournal {
	private epoch: number;
	private epochReason: string;
	private entries: ProviderContextEntry[] = [];
	private contentHashes = new Set<string>();
	private turnContext: ProviderContextEntry | undefined;
	private latestAssembly?: ContextAssemblyReceipt;

	constructor(initialEpoch = 1, initialReason = "session_open") {
		if (!Number.isSafeInteger(initialEpoch) || initialEpoch < 1) {
			throw new Error("Provider context epoch must be a positive safe integer");
		}
		this.epoch = initialEpoch;
		this.epochReason = initialReason.trim() || "session_open";
	}

	/** Compatibility path for existing string-based Runtime hosts. */
	project(systemPrompt: string, context: RuntimeContextSnapshot): string {
		this.latestAssembly = undefined;
		this.append("room_context", context.roomContext ?? "");
		this.append("session_memory", context.sessionContext);
		this.replaceTurnContext(context.transientContext);
		return this.renderLegacy(systemPrompt);
	}

	/** Preferred path: render the exact current ContextProvider assembly. */
	projectAssembly(systemPrompt: string, assembly: ContextAssembly): string {
		this.latestAssembly = structuredClone(assembly.receipt);
		const turn = [assembly.byPlacement.turn_context, assembly.byPlacement.continuation_context]
			.filter(Boolean)
			.join("\n\n");
		const blocks = [
			managedBlock("room_context", assembly.byPlacement.stable_system),
			managedBlock("session_memory", assembly.byPlacement.session_system),
			managedBlock("turn_context", turn),
		].filter(Boolean);
		return [withoutManagedContext(systemPrompt), ...blocks].filter(Boolean).join("\n\n");
	}

	clearTurnContext(): void {
		this.turnContext = undefined;
	}

	beginEpoch(
		reason: "compaction" | "task_switch" | "session_restart" | "history_rewrite" | "session_memory_refresh",
		systemPrompt: string,
		context: RuntimeContextSnapshot,
		targetEpoch?: number,
	): string {
		const nextEpoch = targetEpoch ?? this.epoch + 1;
		if (!Number.isSafeInteger(nextEpoch) || nextEpoch !== this.epoch + 1) {
			throw new Error("Provider context epoch transition is stale or non-monotonic");
		}
		this.epoch = nextEpoch;
		this.epochReason = reason;
		this.entries = [];
		this.contentHashes.clear();
		this.turnContext = undefined;
		this.latestAssembly = undefined;
		return this.project(systemPrompt, context);
	}

	snapshot(): ProviderContextJournalSnapshot {
		const currentEntries = this.currentEntries();
		return {
			schemaVersion: "rag-ime.provider-context-journal.v1",
			epoch: this.epoch,
			epochReason: this.epochReason,
			entryCount: this.latestAssembly?.contributions.length ?? currentEntries.length,
			contentHashes: this.latestAssembly
				? this.latestAssembly.contributions.map((entry) => entry.contentHash)
				: currentEntries.map((entry) => entry.contentHash),
			assemblyHash: this.latestAssembly?.assemblyHash,
			assemblyReceipt: this.latestAssembly ? structuredClone(this.latestAssembly) : undefined,
		};
	}

	private append(kind: ProviderContextKind, value: string): void {
		const body = value.trim();
		if (!body) return;
		const contentHash = createHash("sha256").update(`${kind}\0${body}`).digest("hex");
		if (this.contentHashes.has(contentHash)) return;
		this.contentHashes.add(contentHash);
		this.entries.push({ kind, body, contentHash });
	}

	private replaceTurnContext(value: string): void {
		const body = value.trim();
		if (!body) {
			this.turnContext = undefined;
			return;
		}
		this.turnContext = {
			kind: "turn_context",
			body,
			contentHash: createHash("sha256").update(`turn_context\0${body}`).digest("hex"),
		};
	}

	private currentEntries(): ProviderContextEntry[] {
		return this.turnContext ? [...this.entries, this.turnContext] : this.entries;
	}

	private renderLegacy(systemPrompt: string): string {
		const base = withoutManagedContext(systemPrompt);
		const blocks = this.currentEntries().map((entry) => managedBlock(entry.kind, entry.body));
		return [base, ...blocks].filter(Boolean).join("\n\n");
	}
}

/** Existing compatibility extension. */
export function createProviderContextJournalExtension(
	journal: ProviderContextJournal,
	getContext: () => RuntimeContextSnapshot,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const context = getContext();
			const systemPrompt = journal.project(event.systemPrompt, context);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		});
	};
}

/** Preferred extension for deterministic, provenance-bearing ContextProviders. */
export function createContextProviderJournalExtension(
	journal: ProviderContextJournal,
	assemble: (input: { prompt: string; signal?: AbortSignal }) => Promise<ContextAssembly>,
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", async (event, context) => {
			const assembly = await assemble({ prompt: event.prompt, signal: context.signal });
			const systemPrompt = journal.projectAssembly(event.systemPrompt, assembly);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		});
	};
}
