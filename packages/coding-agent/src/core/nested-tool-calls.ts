/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "@earendil-works/pi-ai";
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: oversized arguments and results
 * are omitted, calls beyond the count are dropped, and the record is marked incomplete.
 * Result eviction keeps the latest completions, including final validation receipts.
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxResultBytesPerCall: 256 * 1024,
	maxResultBytesTotal: 2 * 1024 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	private resultBytes = 0;
	/** Completion order, so later validation receipts survive a large earlier result set. */
	private readonly retainedResults: NestedToolCallRecord[] = [];
	/** Summed usage of every nested result, including calls dropped from the record. */
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(
		record: NestedToolCallRecord | undefined,
		isError: boolean,
		errorText: string,
		result?: AgentToolResult<unknown>,
	): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
		if (!result) return;
		try {
			// Capture only the actual child pipeline return. Outer script output and
			// tool-authored call summaries are never used to reconstruct this receipt.
			const json = JSON.stringify({
				content: result.content,
				details: result.details,
				structuredContent: result.structuredContent,
			});
			const bytes = encoder.encode(json).length;
			record.resultBytes = bytes;
			if (bytes > NESTED_CALL_LIMITS.maxResultBytesPerCall) {
				record.resultUnavailable = "size_limit";
				this.complete = false;
				return;
			}
			while (this.resultBytes + bytes > NESTED_CALL_LIMITS.maxResultBytesTotal) {
				const previous = this.retainedResults.shift();
				if (!previous) break;
				this.resultBytes -= previous.resultBytes ?? 0;
				delete previous.result;
				previous.resultUnavailable = "size_limit";
				this.complete = false;
			}
			record.result = JSON.parse(json) as JsonObject;
			this.resultBytes += bytes;
			this.retainedResults.push(record);
		} catch {
			// Receipt storage must not turn an already completed side effect into a
			// retryable tool failure when a third-party result is not JSON-shaped.
			record.resultUnavailable = "not_serializable";
			this.complete = false;
		}
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => structuredClone(call));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** Defaults to the calling tool's signal. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	/** Physical child calls, shared by all descendants of a model-issued call. */
	pending: Set<Promise<AgentToolCallOutcome>>;
	nextId: number;
	/** The running caller lends its scheduling slot to its children until they finish. */
	owner?: ScheduledCall;
}

interface ScheduledCall {
	/** Root first; common ancestors are reentrant, not competing calls. */
	path: ScheduledCall[];
	order: number;
	exclusive: boolean;
	children: number;
	running: boolean;
	admit: (run: boolean) => void;
}

function competingCalls(a: ScheduledCall, b: ScheduledCall): boolean {
	let common = 0;
	while (common < Math.min(a.path.length, b.path.length) && a.path[common] === b.path[common]) common++;
	// A call cannot wait for its own ancestor to finish.
	if (common === a.path.length || common === b.path.length) return false;
	return a.path.slice(common).some((call) => call.exclusive) || b.path.slice(common).some((call) => call.exclusive);
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	private readonly scheduled = new Set<ScheduledCall>();
	private nextOrder = 0;

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = { recorder: new NestedCallRecorder(), pending: new Set(), nextId: 1 };
			this.scopes.set(callerId, scope);
		}
		const promise = this.executeCall(callerId, name, args, options, scope);
		scope.pending.add(promise);
		void promise.then(
			() => scope.pending.delete(promise),
			() => scope.pending.delete(promise),
		);
		return promise;
	}

	private dispatch(): void {
		const active = [...this.scheduled].filter((call) => call.running && call.children === 0);
		const waiting = [...this.scheduled].filter((call) => !call.running);
		// Finish an earlier caller's descendants before a later outer barrier. Otherwise the
		// barrier would wait for the caller while its children wait behind the barrier.
		waiting.sort((a, b) => {
			for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
				if (a.path[i] !== b.path[i]) return a.path[i].order - b.path[i].order;
			}
			return a.path.length - b.path.length;
		});
		const blocked: ScheduledCall[] = [];
		for (const call of waiting) {
			if (
				active.some((other) => competingCalls(call, other)) ||
				blocked.some((other) => competingCalls(call, other))
			) {
				blocked.push(call);
				continue;
			}
			call.running = true;
			active.push(call);
			call.admit(true);
		}
	}

	private release(call: ScheduledCall): void {
		if (!this.scheduled.delete(call)) return;
		const parent = call.path.at(-2);
		if (parent) parent.children--;
		this.dispatch();
	}

	private async executeCall(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions,
		scope: CallScope,
	): Promise<AgentToolCallOutcome> {
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		let admit!: ScheduledCall["admit"];
		const admitted = new Promise<boolean>((resolve) => {
			admit = resolve;
		});
		const scheduled: ScheduledCall = {
			path: [...(scope.owner?.path ?? [])],
			order: this.nextOrder++,
			exclusive:
				this.host.isSequential() ||
				this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential",
			children: 0,
			running: false,
			admit,
		};
		scheduled.path.push(scheduled);
		if (scope.owner) scope.owner.children++;
		this.scheduled.add(scheduled);
		const cancelWaiting = () => {
			if (scheduled.running) return;
			scheduled.admit(false);
			this.release(scheduled);
		};
		options.signal?.addEventListener("abort", cancelWaiting, { once: true });
		if (options.signal?.aborted) cancelWaiting();
		else this.dispatch();
		let outcome: AgentToolCallOutcome;
		try {
			await this.host.emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: name,
				args: toolCall.arguments,
				parentToolCallId: callerId,
			});
			if (!(await admitted) || options.signal?.aborted) {
				outcome = {
					toolCall,
					result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
					isError: true,
				};
			} else {
				this.scopes.set(toolCall.id, {
					recorder: scope.recorder,
					pending: scope.pending,
					nextId: 1,
					owner: scheduled,
				});
				outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
					options.onUpdate?.(partialResult);
					await this.host.emit({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: name,
						args: toolCall.arguments,
						partialResult,
						parentToolCallId: callerId,
					});
				});
			}
		} finally {
			options.signal?.removeEventListener("abort", cancelWaiting);
			this.scopes.delete(toolCall.id);
			this.release(scheduled);
		}

		scope.recorder.finish(record, outcome.isError, textOf(outcome.result), outcome.result);
		// Usage is counted through the recorder, not again from the retained result body.
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			parentToolCallId: callerId,
		});
		return outcome;
	}

	/** Abort acknowledgement does not prove that a child's tool pipeline drained. */
	async drain(toolCallId: string): Promise<void> {
		const scope = this.scopes.get(toolCallId);
		if (!scope) return;
		while (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}
}
