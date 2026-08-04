import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

export interface ToolLoopProgressTurn {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

export interface ToolLoopProgressGuardOptions {
	maxConsecutiveAllErrorTurns?: number;
	maxRepeatedFailureSignature?: number;
}

export interface ToolLoopProgressStopReceipt {
	schemaVersion: "rag-ime.tool-loop-progress-stop.v1";
	reason: "consecutive_all_error_turns" | "repeated_failure_signature";
	consecutiveAllErrorTurns: number;
	repeatedFailureSignature: number;
	toolNames: string[];
}

const DEFAULT_MAX_CONSECUTIVE_ALL_ERROR_TURNS = 8;
const DEFAULT_MAX_REPEATED_FAILURE_SIGNATURE = 3;

/**
 * Stops only a provider/tool loop that is demonstrably making no progress.
 *
 * A successful tool result resets the complete guard. Ordinary long research
 * loops therefore remain unbounded by call count, while repeated governed
 * failures cannot consume the session forever.
 */
export class ToolLoopProgressGuard {
	private readonly maxConsecutiveAllErrorTurns: number;
	private readonly maxRepeatedFailureSignature: number;
	private consecutiveAllErrorTurns = 0;
	private repeatedFailureSignature = 0;
	private previousFailureSignature = "";
	private latestStopReceipt: ToolLoopProgressStopReceipt | undefined;

	constructor(options: ToolLoopProgressGuardOptions = {}) {
		this.maxConsecutiveAllErrorTurns = positiveInteger(
			options.maxConsecutiveAllErrorTurns,
			DEFAULT_MAX_CONSECUTIVE_ALL_ERROR_TURNS,
		);
		this.maxRepeatedFailureSignature = positiveInteger(
			options.maxRepeatedFailureSignature,
			DEFAULT_MAX_REPEATED_FAILURE_SIGNATURE,
		);
	}

	reset(): void {
		this.consecutiveAllErrorTurns = 0;
		this.repeatedFailureSignature = 0;
		this.previousFailureSignature = "";
		this.latestStopReceipt = undefined;
	}

	shouldStop(turn: ToolLoopProgressTurn): boolean {
		const results = turn.toolResults;
		if (results.length === 0 || results.some((result) => result.isError !== true)) {
			this.reset();
			return false;
		}

		this.consecutiveAllErrorTurns += 1;
		const signature = failureSignature(turn);
		if (signature === this.previousFailureSignature) {
			this.repeatedFailureSignature += 1;
		} else {
			this.previousFailureSignature = signature;
			this.repeatedFailureSignature = 1;
		}

		const repeated = this.repeatedFailureSignature >= this.maxRepeatedFailureSignature;
		const exhausted = this.consecutiveAllErrorTurns >= this.maxConsecutiveAllErrorTurns;
		if (!repeated && !exhausted) return false;

		this.latestStopReceipt = {
			schemaVersion: "rag-ime.tool-loop-progress-stop.v1",
			reason: repeated ? "repeated_failure_signature" : "consecutive_all_error_turns",
			consecutiveAllErrorTurns: this.consecutiveAllErrorTurns,
			repeatedFailureSignature: this.repeatedFailureSignature,
			toolNames: toolNames(turn.message),
		};
		return true;
	}

	stopReceipt(): ToolLoopProgressStopReceipt | undefined {
		return this.latestStopReceipt ? structuredClone(this.latestStopReceipt) : undefined;
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

function failureSignature(turn: ToolLoopProgressTurn): string {
	const calls = new Map(
		turn.message.content
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
					block.type === "toolCall",
			)
			.map((block) => [block.id, block]),
	);
	const failures = turn.toolResults.map((result) => {
		const call = calls.get(result.toolCallId);
		return {
			toolName: result.toolName,
			arguments: canonicalValue(call?.arguments),
			error: normalizeErrorText(result.content),
		};
	});
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

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalValue(child)]),
	);
}
