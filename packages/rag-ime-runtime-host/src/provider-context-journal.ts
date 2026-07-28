import { createHash } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
}

/**
 * Owns one Pi Session's Provider-only context.
 *
 * Room and approved Session memory form the append-only, cache-friendly
 * prefix for an epoch. Current input and UI evidence is a replaceable tail:
 * keeping older turn_context blocks would make stale foreground state look
 * simultaneously true and would grow every later Provider request.
 */
export class ProviderContextJournal {
	private epoch: number;
	private epochReason: string;
	private entries: ProviderContextEntry[] = [];
	private contentHashes = new Set<string>();
	private turnContext: ProviderContextEntry | undefined;

	constructor(initialEpoch = 1, initialReason = "session_open") {
		if (!Number.isSafeInteger(initialEpoch) || initialEpoch < 1) {
			throw new Error("Provider context epoch must be a positive safe integer");
		}
		this.epoch = initialEpoch;
		this.epochReason = initialReason.trim() || "session_open";
	}

	project(systemPrompt: string, context: RuntimeContextSnapshot): string {
		this.append("room_context", context.roomContext ?? "");
		this.append("session_memory", context.sessionContext);
		this.replaceTurnContext(context.transientContext);
		return this.render(systemPrompt);
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
		return this.project(systemPrompt, context);
	}

	snapshot(): ProviderContextJournalSnapshot {
		const currentEntries = this.currentEntries();
		return {
			schemaVersion: "rag-ime.provider-context-journal.v1",
			epoch: this.epoch,
			epochReason: this.epochReason,
			entryCount: currentEntries.length,
			contentHashes: currentEntries.map((entry) => entry.contentHash),
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

	private render(systemPrompt: string): string {
		const base = systemPrompt.replace(MANAGED_CONTEXT_BLOCK_PATTERN, "").trimEnd();
		const entries = this.currentEntries();
		if (entries.length === 0) return base;
		const blocks = entries.map((entry) =>
			[`<rag-ime-context type="${entry.kind}">`, entry.body, "</rag-ime-context>"].join("\n"),
		);
		return [base, ...blocks].filter(Boolean).join("\n\n");
	}
}

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
