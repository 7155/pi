import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

export interface ToolLoopProgressTurn {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

export interface ToolLoopProgressGuardOptions {
	maxConsecutiveAllErrorTurns?: number;
	maxRepeatedFailureSignature?: number;
	maxRecoveryWaitMs?: number;
}

export interface ToolLoopProgressStopReceipt {
	schemaVersion: "rag-ime.tool-loop-progress-stop.v1";
	reason: "consecutive_all_error_turns" | "repeated_failure_signature" | "all_error_recovery_timeout";
	consecutiveAllErrorTurns: number;
	repeatedFailureSignature: number;
	toolNames: string[];
}

const DEFAULT_MAX_CONSECUTIVE_ALL_ERROR_TURNS = 8;
const DEFAULT_MAX_REPEATED_FAILURE_SIGNATURE = 3;
const DEFAULT_MAX_RECOVERY_WAIT_MS = 300_000;
const MAX_TRACKED_FAILURE_FAMILIES = 256;

/**
 * Stops only a provider/tool loop that is demonstrably making no progress.
 *
 * Successful tool results clear consecutive-error state, so ordinary long
 * research loops remain unbounded by call count. A recurring failure family
 * remains visible until the external prompt settles, preventing a trivial
 * successful read from hiding the same broken write attempt forever.
 */
export class ToolLoopProgressGuard {
	private readonly maxConsecutiveAllErrorTurns: number;
	private readonly maxRepeatedFailureSignature: number;
	private readonly maxRecoveryWaitMs: number;
	private consecutiveAllErrorTurns = 0;
	private repeatedFailureSignature = 0;
	private readonly failureFamilyCounts = new Map<string, number>();
	private latestFailureToolNames: string[] = [];
	private latestStopReceipt: ToolLoopProgressStopReceipt | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: ToolLoopProgressGuardOptions = {}) {
		this.maxConsecutiveAllErrorTurns = positiveInteger(
			options.maxConsecutiveAllErrorTurns,
			DEFAULT_MAX_CONSECUTIVE_ALL_ERROR_TURNS,
		);
		this.maxRepeatedFailureSignature = positiveInteger(
			options.maxRepeatedFailureSignature,
			DEFAULT_MAX_REPEATED_FAILURE_SIGNATURE,
		);
		this.maxRecoveryWaitMs = positiveInteger(options.maxRecoveryWaitMs, DEFAULT_MAX_RECOVERY_WAIT_MS);
	}

	reset(options: { preserveStopReceipt?: boolean } = {}): void {
		this.clearRecoveryTimeout();
		this.consecutiveAllErrorTurns = 0;
		this.repeatedFailureSignature = 0;
		this.failureFamilyCounts.clear();
		this.latestFailureToolNames = [];
		if (options.preserveStopReceipt !== true) this.latestStopReceipt = undefined;
	}

	shouldStop(turn: ToolLoopProgressTurn): boolean {
		const results = turn.toolResults;
		if (results.length === 0 || results.some((result) => result.isError !== true)) {
			this.clearRecoveryTimeout();
			this.consecutiveAllErrorTurns = 0;
			this.repeatedFailureSignature = 0;
			this.latestFailureToolNames = [];
			this.latestStopReceipt = undefined;
			return false;
		}

		this.consecutiveAllErrorTurns += 1;
		this.latestFailureToolNames = toolNames(turn.message);
		const signature = failureFamilySignature(turn);
		if (!this.failureFamilyCounts.has(signature) && this.failureFamilyCounts.size >= MAX_TRACKED_FAILURE_FAMILIES) {
			const oldest = this.failureFamilyCounts.keys().next().value;
			if (oldest !== undefined) this.failureFamilyCounts.delete(oldest);
		}
		this.repeatedFailureSignature = (this.failureFamilyCounts.get(signature) ?? 0) + 1;
		this.failureFamilyCounts.set(signature, this.repeatedFailureSignature);

		const repeated = this.repeatedFailureSignature >= this.maxRepeatedFailureSignature;
		const exhausted = this.consecutiveAllErrorTurns >= this.maxConsecutiveAllErrorTurns;
		if (!repeated && !exhausted) return false;

		this.latestStopReceipt = {
			schemaVersion: "rag-ime.tool-loop-progress-stop.v1",
			reason: repeated ? "repeated_failure_signature" : "consecutive_all_error_turns",
			consecutiveAllErrorTurns: this.consecutiveAllErrorTurns,
			repeatedFailureSignature: this.repeatedFailureSignature,
			toolNames: [...this.latestFailureToolNames],
		};
		return true;
	}

	armRecoveryTimeout(onTimeout: (receipt: ToolLoopProgressStopReceipt) => void): boolean {
		if (this.consecutiveAllErrorTurns < 1 || this.latestFailureToolNames.length < 1) return false;
		this.clearRecoveryTimeout();
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			const receipt: ToolLoopProgressStopReceipt = {
				schemaVersion: "rag-ime.tool-loop-progress-stop.v1",
				reason: "all_error_recovery_timeout",
				consecutiveAllErrorTurns: this.consecutiveAllErrorTurns,
				repeatedFailureSignature: this.repeatedFailureSignature,
				toolNames: [...this.latestFailureToolNames],
			};
			this.latestStopReceipt = receipt;
			onTimeout(structuredClone(receipt));
		}, this.maxRecoveryWaitMs);
		return true;
	}

	stopReceipt(): ToolLoopProgressStopReceipt | undefined {
		return this.latestStopReceipt ? structuredClone(this.latestStopReceipt) : undefined;
	}

	private clearRecoveryTimeout(): void {
		if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = undefined;
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function toolNames(message: AssistantMessage): string[] {
	return [
		...new Set(
			message.content
				.filter(
					(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
						block.type === "toolCall",
				)
				.map((block) => block.name),
		),
	].sort();
}

function failureFamilySignature(turn: ToolLoopProgressTurn): string {
	const failures = turn.toolResults
		.map((result) => ({
			toolName: result.toolName,
			error: normalizeErrorText(result.content),
		}))
		.sort((left, right) => left.toolName.localeCompare(right.toolName) || left.error.localeCompare(right.error));
	return JSON.stringify(failures);
}

function normalizeErrorText(content: ToolResultMessage["content"]): string {
	return content
		.filter(
			(block): block is Extract<ToolResultMessage["content"][number], { type: "text" }> => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n")
		.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<uuid>")
		.replace(/\b[0-9a-f]{16,}\b/giu, "<hex>")
		.replace(/\b\d{4,}\b/gu, "<number>")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 1_000);
}
