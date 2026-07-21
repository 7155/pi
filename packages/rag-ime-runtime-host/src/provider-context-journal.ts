import { createHash } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { formatLocalTimestamp, type RuntimeContextSnapshot } from "./transient-context.ts";

const MANAGED_CONTEXT_BLOCK_PATTERN =
	/\n*<rag-ime-context\s+type="(?:session_memory|turn_context)"(?=[\s>])[^>]*>[\s\S]*?<\/rag-ime-context>/g;

type ProviderContextKind = "session_memory" | "turn_context";

interface ProviderContextEntry {
	kind: ProviderContextKind;
	body: string;
	contentHash: string;
	observedAt: string;
}

export interface ProviderContextJournalSnapshot {
	schemaVersion: "rag-ime.provider-context-journal.v1";
	epoch: number;
	epochReason: string;
	entryCount: number;
	contentHashes: string[];
}

/** Owns the immutable Provider-only prefix for one Pi Session. */
export class ProviderContextJournal {
	private epoch = 1;
	private epochReason = "session_open";
	private entries: ProviderContextEntry[] = [];
	private contentHashes = new Set<string>();

	project(systemPrompt: string, context: RuntimeContextSnapshot, now: Date = new Date()): string {
		this.append("session_memory", context.sessionContext, now);
		this.append("turn_context", context.transientContext, now);
		return this.render(systemPrompt);
	}

	beginEpoch(
		reason: "compaction" | "session_restart" | "history_rewrite",
		systemPrompt: string,
		context: RuntimeContextSnapshot,
		now: Date = new Date(),
	): string {
		this.epoch += 1;
		this.epochReason = reason;
		this.entries = [];
		this.contentHashes.clear();
		return this.project(systemPrompt, context, now);
	}

	snapshot(): ProviderContextJournalSnapshot {
		return {
			schemaVersion: "rag-ime.provider-context-journal.v1",
			epoch: this.epoch,
			epochReason: this.epochReason,
			entryCount: this.entries.length,
			contentHashes: this.entries.map((entry) => entry.contentHash),
		};
	}

	private append(kind: ProviderContextKind, value: string, now: Date): void {
		const body = value.trim();
		if (!body) return;
		const contentHash = createHash("sha256").update(`${kind}\0${body}`).digest("hex");
		if (this.contentHashes.has(contentHash)) return;
		this.contentHashes.add(contentHash);
		this.entries.push({ kind, body, contentHash, observedAt: formatLocalTimestamp(now) });
	}

	private render(systemPrompt: string): string {
		const base = systemPrompt.replace(MANAGED_CONTEXT_BLOCK_PATTERN, "").trimEnd();
		if (this.entries.length === 0) return base;
		const blocks = this.entries.map((entry) =>
			[
				`<rag-ime-context type="${entry.kind}" observed_at="${entry.observedAt}">`,
				entry.body,
				"</rag-ime-context>",
			].join("\n"),
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
			if (!context.sessionContext.trim() && !context.transientContext.trim()) return;
			return {
				systemPrompt: journal.project(event.systemPrompt, context),
			};
		});
	};
}
