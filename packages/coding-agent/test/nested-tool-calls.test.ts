import type { AgentTool, AgentToolCall } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	NESTED_CALL_LIMITS,
	NestedCallRecorder,
	type NestedToolCallHost,
	NestedToolCallRunner,
	type NestedToolExecutionEvent,
} from "../src/core/nested-tool-calls.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function tool(name: string, execute: AgentTool["execute"], sequential = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		executionMode: sequential ? "sequential" : undefined,
		execute,
	};
}

function createRunner(tools: AgentTool[], options: { sequential?: boolean } = {}) {
	const events: NestedToolExecutionEvent[] = [];
	const host: NestedToolCallHost = {
		getTools: () => tools,
		isSequential: () => options.sequential ?? false,
		runToolCall: async (toolCall, _parentId, signal, onUpdate) => {
			const tool = tools.find((candidate) => candidate.name === toolCall.name);
			if (!tool) {
				return {
					toolCall,
					result: { content: [{ type: "text", text: `Tool ${toolCall.name} not found` }], details: {} },
					isError: true,
				};
			}
			const result = await tool.execute(
				toolCall.id,
				toolCall.arguments,
				signal,
				(partial) => void onUpdate(partial),
			);
			return { toolCall, result, isError: result.isError === true };
		},
		emit: async (event) => {
			events.push(event);
		},
	};
	return { runner: new NestedToolCallRunner(host), events };
}

describe("NestedToolCallRunner", () => {
	it("assigns ids below the caller, emits events with the parent id, and records the calls", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const { runner, events } = createRunner([echo]);
		const updates: unknown[] = [];

		const first = await runner.execute("call", "echo", { a: 1 }, { onUpdate: (partial) => updates.push(partial) });
		const missing = await runner.execute("call", "missing", {});

		expect(first.toolCall.id).toBe("call/1");
		expect(missing).toMatchObject({ toolCall: { id: "call/2" }, isError: true });
		expect(updates).toHaveLength(1);
		expect(events.map((event) => [event.type, event.toolCallId, event.parentToolCallId])).toEqual([
			["tool_execution_start", "call/1", "call"],
			["tool_execution_update", "call/1", "call"],
			["tool_execution_end", "call/1", "call"],
			["tool_execution_start", "call/2", "call"],
			["tool_execution_end", "call/2", "call"],
		]);
		expect(runner.takeRecord("call")?.calls).toEqual({
			calls: [
				{
					id: "call/1",
					name: "echo",
					arguments: { a: 1 },
					status: "ok",
					durationMs: expect.any(Number),
					result: { content: [{ type: "text", text: "ok" }], details: {} },
					resultBytes: expect.any(Number),
				},
				{
					id: "call/2",
					name: "missing",
					arguments: {},
					status: "error",
					durationMs: expect.any(Number),
					error: "Tool missing not found",
					result: { content: [{ type: "text", text: "Tool missing not found" }], details: {} },
					resultBytes: expect.any(Number),
				},
			],
			complete: true,
		});
		// The record is taken once.
		expect(runner.takeRecord("call")).toBeUndefined();
		expect(runner.takeRecord("other")).toBeUndefined();
	});

	it("records calls of nested tools on the model-issued call", async () => {
		const leaf: AgentTool = {
			name: "leaf",
			label: "Leaf",
			description: "Leaf",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		};
		const tools: AgentTool[] = [leaf];
		const { runner } = createRunner(tools);
		tools.push({
			name: "middle",
			label: "Middle",
			description: "Calls leaf",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				await runner.execute(toolCallId, "leaf", {});
				return { content: [], details: {} };
			},
		});

		await runner.execute("call", "middle", {});

		expect(runner.takeRecord("call")?.calls?.calls.map((call) => call.id)).toEqual(["call/1", "call/1/1"]);
	});

	it("sums the usage of nested results at every depth", async () => {
		const leaf: AgentTool = {
			name: "leaf",
			label: "Leaf",
			description: "Leaf",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {}, usage: usage(10, 0.01) };
			},
		};
		const plain: AgentTool = { ...leaf, name: "plain", execute: async () => ({ content: [], details: {} }) };
		const tools: AgentTool[] = [leaf, plain];
		const { runner } = createRunner(tools);
		tools.push({
			name: "middle",
			label: "Middle",
			description: "Calls leaf",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				await runner.execute(toolCallId, "leaf", {});
				// Its own usage only: the leaf's usage is counted once, by the recorder.
				return { content: [], details: {}, usage: usage(5, 0.005) };
			},
		});

		await runner.execute("call", "middle", {});
		await runner.execute("call", "leaf", {});
		await runner.execute("call", "plain", {});
		await runner.execute("free", "plain", {});

		const summary = runner.takeRecord("call");
		expect(summary?.usage?.input).toBe(25);
		expect(summary?.usage?.cost.total).toBeCloseTo(0.025, 10);
		expect(runner.takeRecord("free")).toMatchObject({ calls: { complete: true }, usage: undefined });
	});

	it("serializes concurrent calls to sequential tools", async () => {
		let active = 0;
		let maxActive = { sequential: 0, parallel: 0 };
		const makeTool = (name: "sequential" | "parallel"): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			executionMode: name === "sequential" ? "sequential" : undefined,
			async execute() {
				active++;
				maxActive = { ...maxActive, [name]: Math.max(maxActive[name], active) };
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return { content: [], details: {} };
			},
		});
		const { runner } = createRunner([makeTool("sequential"), makeTool("parallel")]);

		await Promise.all([1, 2, 3].map(() => runner.execute("call", "sequential", {})));
		await Promise.all([1, 2, 3].map(() => runner.execute("call", "parallel", {})));

		expect(maxActive).toEqual({ sequential: 1, parallel: 3 });
	});

	it("drains parallel calls before a sequential call and blocks later parallel calls", async () => {
		const before = gate();
		const exclusive = gate();
		const trace: string[] = [];
		const { runner } = createRunner([
			tool("before", async () => {
				trace.push("before:start");
				await before.promise;
				trace.push("before:end");
				return { content: [], details: {} };
			}),
			tool(
				"exclusive",
				async () => {
					trace.push("exclusive:start");
					await exclusive.promise;
					trace.push("exclusive:end");
					return { content: [], details: {} };
				},
				true,
			),
			tool("after", async () => {
				trace.push("after");
				return { content: [], details: {} };
			}),
		]);
		const first = runner.execute("one", "before", {});
		await nextTurn();
		const second = runner.execute("two", "exclusive", {});
		const third = runner.execute("three", "after", {});
		try {
			await nextTurn();
			expect(trace).toEqual(["before:start"]);
			before.release();
			await first;
			await nextTurn();
			expect(trace).toEqual(["before:start", "before:end", "exclusive:start"]);
			exclusive.release();
			await Promise.all([second, third]);
			expect(trace).toEqual(["before:start", "before:end", "exclusive:start", "exclusive:end", "after"]);
		} finally {
			before.release();
			exclusive.release();
			await Promise.allSettled([first, second, third]);
		}
	});

	it.each([false, true])(
		"keeps recursive sibling barriers without waiting on the parent (sequential=%s)",
		async (sequential) => {
			const exclusive = gate();
			const trace: string[] = [];
			const tools = [
				tool(
					"exclusive",
					async () => {
						trace.push("exclusive:start");
						await exclusive.promise;
						trace.push("exclusive:end");
						return { content: [], details: {} };
					},
					true,
				),
				tool("after", async () => {
					trace.push("after");
					return { content: [], details: {} };
				}),
			];
			const { runner } = createRunner(tools, { sequential });
			tools.push(
				tool(
					"parent",
					async (id) => {
						await Promise.all([runner.execute(id, "exclusive", {}), runner.execute(id, "after", {})]);
						return { content: [], details: {} };
					},
					true,
				),
			);
			const call = runner.execute("root", "parent", {});
			try {
				await nextTurn();
				expect(trace).toEqual(["exclusive:start"]);
			} finally {
				exclusive.release();
			}
			await call;
			expect(trace).toEqual(["exclusive:start", "exclusive:end", "after"]);
		},
	);

	it("allows parallel descendants of an exclusive parent to run concurrently", async () => {
		const finish = gate();
		let active = 0;
		const tools = [
			tool("leaf", async () => {
				active++;
				await finish.promise;
				return { content: [], details: {} };
			}),
		];
		const { runner } = createRunner(tools);
		tools.push(
			tool(
				"parent",
				async (id) => {
					await Promise.all([runner.execute(id, "leaf", {}), runner.execute(id, "leaf", {})]);
					return { content: [], details: {} };
				},
				true,
			),
		);
		const call = runner.execute("root", "parent", {});
		try {
			await nextTurn();
			expect(active).toBe(2);
		} finally {
			finish.release();
		}
		await call;
	});

	it("lets a running parent finish nested work ahead of a queued outer barrier", async () => {
		const spawn = gate();
		const trace: string[] = [];
		const tools = [
			tool(
				"leaf",
				async () => {
					trace.push("leaf");
					return { content: [], details: {} };
				},
				true,
			),
		];
		const { runner } = createRunner(tools);
		tools.push(
			tool("parent", async (id) => {
				await spawn.promise;
				await runner.execute(id, "leaf", {});
				trace.push("parent:end");
				return { content: [], details: {} };
			}),
		);
		const parent = runner.execute("root", "parent", {});
		await nextTurn();
		const outer = runner.execute("root", "leaf", {});
		spawn.release();
		await Promise.all([parent, outer]);
		expect(trace).toEqual(["leaf", "parent:end", "leaf"]);
	}, 1000);

	it("does not deadlock when parallel parents both await exclusive descendants", async () => {
		const spawn = gate();
		const trace: string[] = [];
		const tools = [
			tool(
				"leaf",
				async (id) => {
					trace.push(id);
					await nextTurn();
					return { content: [], details: {} };
				},
				true,
			),
		];
		const { runner } = createRunner(tools);
		tools.push(
			tool("parent", async (id) => {
				await spawn.promise;
				await runner.execute(id, "leaf", {});
				trace.push(`${id}:end`);
				return { content: [], details: {} };
			}),
		);
		const calls = [runner.execute("root", "parent", {}), runner.execute("root", "parent", {})];
		await nextTurn();
		spawn.release();
		await Promise.all(calls);
		expect(trace).toEqual(["root/1/1", "root/1:end", "root/2/1", "root/2:end"]);
	}, 1000);

	it.each([false, true])(
		"keeps an unawaited child inside its ancestor's barrier (exclusive parent=%s)",
		async (exclusiveParent) => {
			const finish = gate();
			const trace: string[] = [];
			const tools = [
				tool("child", async () => {
					trace.push("child:start");
					await finish.promise;
					trace.push("child:end");
					return { content: [], details: {} };
				}),
				tool(
					"later",
					async () => {
						trace.push("later");
						return { content: [], details: {} };
					},
					!exclusiveParent,
				),
			];
			const { runner } = createRunner(tools);
			tools.push(
				tool(
					"parent",
					async (id) => {
						void runner.execute(id, "child", {});
						return { content: [], details: {} };
					},
					exclusiveParent,
				),
			);
			await runner.execute("root", "parent", {});
			const later = runner.execute("another-root", "later", {});
			try {
				await nextTurn();
				expect(trace).toEqual(["child:start"]);
			} finally {
				finish.release();
			}
			await Promise.all([later, runner.drain("root")]);
			expect(trace).toEqual(["child:start", "child:end", "later"]);
			expect(runner.takeRecord("root")?.calls?.complete).toBe(true);
		},
	);

	it("keeps an aborted running tool's barrier until its physical work finishes", async () => {
		const finish = gate();
		const controller = new AbortController();
		let laterRan = false;
		const { runner } = createRunner([
			tool(
				"exclusive",
				async () => {
					await finish.promise;
					return { content: [], details: {} };
				},
				true,
			),
			tool("later", async () => {
				laterRan = true;
				return { content: [], details: {} };
			}),
		]);
		const running = runner.execute("root", "exclusive", {}, { signal: controller.signal });
		await nextTurn();
		controller.abort();
		const later = runner.execute("root", "later", {});
		try {
			await nextTurn();
			expect(laterRan).toBe(false);
		} finally {
			finish.release();
		}
		await Promise.all([running, later]);
		expect(laterRan).toBe(true);
	});

	it("cancels queued calls without entering the tool and still drains physical active work", async () => {
		const finish = gate();
		const controller = new AbortController();
		const trace: string[] = [];
		const { runner } = createRunner([
			tool(
				"exclusive",
				async () => {
					await finish.promise;
					return { content: [], details: {} };
				},
				true,
			),
			tool("queued", async () => {
				trace.push("executed");
				return { content: [], details: {} };
			}),
		]);
		const running = runner.execute("root", "exclusive", {});
		const queued = runner.execute("root", "queued", {}, { signal: controller.signal });
		let drained = false;
		try {
			await nextTurn();
			controller.abort();
			const drain = runner.drain("root").then(() => {
				drained = true;
			});
			await nextTurn();
			expect(await queued).toMatchObject({ isError: true });
			expect(trace).toEqual([]);
			expect(drained).toBe(false);
			finish.release();
			await Promise.all([running, drain]);
			expect(runner.takeRecord("root")?.calls?.calls.map((call) => call.status)).toEqual(["ok", "error"]);
		} finally {
			finish.release();
		}
	});

	it("releases the barrier without swallowing an unexpected pipeline rejection", async () => {
		const error = new Error("pipeline rejected");
		let called = false;
		const { runner } = createRunner([
			tool(
				"reject",
				async () => {
					throw error;
				},
				true,
			),
			tool("after", async () => {
				called = true;
				return { content: [], details: {} };
			}),
		]);
		const rejection = expect(runner.execute("root", "reject", {})).rejects.toBe(error);
		await Promise.all([rejection, runner.execute("root", "after", {})]);
		expect(called).toBe(true);
		await runner.drain("root");
	});
});

describe("NestedCallRecorder", () => {
	const call = (id: string, args: AgentToolCall["arguments"]): AgentToolCall => ({
		type: "toolCall",
		id,
		name: "t",
		arguments: args,
	});

	it("snapshots actual success and failure receipts independently of later mutation", () => {
		const recorder = new NestedCallRecorder();
		const result = { content: [{ type: "text" as const, text: "15" }], details: { receipt: { exitCode: 0 } } };
		recorder.finish(recorder.start(call("outer/1", {})), false, "", result);
		result.details.receipt.exitCode = 9;
		recorder.finish(recorder.start(call("outer/2", {})), true, "failed", result);
		const snapshot = recorder.snapshot();
		expect(snapshot?.calls[0].result).toEqual({
			content: [{ type: "text", text: "15" }],
			details: { receipt: { exitCode: 0 } },
		});
		expect(snapshot?.calls[1]).toMatchObject({ status: "error", result: { details: { receipt: { exitCode: 9 } } } });
		if (snapshot?.calls[0].result) snapshot.calls[0].result.details = {};
		expect(recorder.snapshot()?.calls[0].result?.details).toEqual({ receipt: { exitCode: 0 } });
		expect(JSON.parse(JSON.stringify(recorder.snapshot()))).toEqual(recorder.snapshot());
	});

	it.each([false, true])(
		"retains the structured result consumed by codemode within the same byte budget (isError=%s)",
		(isError) => {
			const recorder = new NestedCallRecorder();
			const result = {
				content: [{ type: "text" as const, text: "summary" }],
				details: { server: "fixture", tool: "inspect" },
				structuredContent: {
					content: [{ type: "text", text: "full result" }],
					structuredContent: { receiptId: "receipt:child", verified: true },
					isError,
				},
			};
			const expected = structuredClone(result);
			recorder.finish(recorder.start(call("outer/1", {})), isError, "", result);
			result.structuredContent.structuredContent.verified = false;
			const snapshot = recorder.snapshot();
			expect(snapshot?.complete).toBe(true);
			expect(snapshot?.calls[0].status).toBe(isError ? "error" : "ok");
			expect(snapshot?.calls[0].result).toEqual(expected);
			expect(snapshot?.calls[0].resultBytes).toBe(new TextEncoder().encode(JSON.stringify(expected)).length);

			recorder.finish(recorder.start(call("outer/2", {})), false, "", {
				content: [],
				details: {},
				structuredContent: "证".repeat(NESTED_CALL_LIMITS.maxResultBytesPerCall),
			});
			expect(recorder.snapshot()?.calls[1]).toMatchObject({ status: "ok", resultUnavailable: "size_limit" });
			expect(recorder.snapshot()?.calls[1].result).toBeUndefined();
			expect(recorder.snapshot()?.complete).toBe(false);
		},
	);

	it("bounds result bytes and retains the latest completed receipts", () => {
		const recorder = new NestedCallRecorder();
		const oversized = {
			content: [{ type: "text" as const, text: "证".repeat(NESTED_CALL_LIMITS.maxResultBytesPerCall) }],
			details: {},
		};
		recorder.finish(recorder.start(call("outer/1", {})), false, "", oversized);
		expect(recorder.snapshot()?.calls[0]).toMatchObject({ status: "ok", resultUnavailable: "size_limit" });
		expect(recorder.snapshot()?.calls[0].result).toBeUndefined();
		const result = { content: [], details: {}, structuredContent: "x".repeat(200_000) };
		for (let i = 2; i <= 15; i++) recorder.finish(recorder.start(call(`outer/${i}`, {})), false, "", result);
		const snapshot = recorder.snapshot();
		const retained = snapshot?.calls.filter((entry) => entry.result !== undefined) ?? [];
		expect(retained.length).toBeLessThan(14);
		expect(retained.reduce((total, entry) => total + (entry.resultBytes ?? 0), 0)).toBeLessThanOrEqual(
			NESTED_CALL_LIMITS.maxResultBytesTotal,
		);
		expect(retained.at(-1)?.id).toBe("outer/15");
		expect(snapshot?.complete).toBe(false);
	});

	it("keeps completed status when a receipt is not serializable", () => {
		const recorder = new NestedCallRecorder();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() =>
			recorder.finish(recorder.start(call("outer/1", {})), false, "", { content: [], details: circular }),
		).not.toThrow();
		expect(recorder.snapshot()?.calls[0]).toMatchObject({ status: "ok", resultUnavailable: "not_serializable" });
		expect(recorder.snapshot()?.complete).toBe(false);
	});

	it("omits oversized arguments and drops calls beyond the limit", () => {
		const recorder = new NestedCallRecorder();
		expect(recorder.snapshot()).toBeUndefined();
		const small = recorder.start(call("a", { x: 1 }));
		recorder.finish(small, false, "");
		expect(recorder.snapshot()).toEqual({
			calls: [{ id: "a", name: "t", arguments: { x: 1 }, status: "ok", durationMs: expect.any(Number) }],
			complete: true,
		});

		const big = recorder.start(call("b", { text: "x".repeat(NESTED_CALL_LIMITS.maxArgumentBytesPerCall) }));
		recorder.finish(big, true, "e".repeat(1000));
		const snapshot = recorder.snapshot();
		expect(snapshot?.complete).toBe(false);
		expect(snapshot?.calls[1]).toMatchObject({ id: "b", status: "error" });
		expect(snapshot?.calls[1].arguments).toBeUndefined();
		expect(snapshot?.calls[1].argumentsBytes).toBeGreaterThan(NESTED_CALL_LIMITS.maxArgumentBytesPerCall);
		expect(snapshot?.calls[1].error).toHaveLength(NESTED_CALL_LIMITS.maxErrorChars);

		for (let i = 0; i < NESTED_CALL_LIMITS.maxCalls; i++)
			recorder.finish(recorder.start(call(`c${i}`, {})), false, "");
		expect(recorder.snapshot()?.calls).toHaveLength(NESTED_CALL_LIMITS.maxCalls);
	});

	it("caps the total argument size and marks unfinished calls incomplete", () => {
		const recorder = new NestedCallRecorder();
		const chunk = { text: "x".repeat(7000) };
		const records = Array.from({ length: 6 }, (_, i) => recorder.start(call(`c${i}`, chunk)));
		const snapshot = recorder.snapshot();
		// 32 KiB fits four 7000-byte argument objects.
		expect(snapshot?.calls.filter((entry) => entry.arguments !== undefined)).toHaveLength(4);
		expect(snapshot?.calls.every((entry) => entry.status === "unfinished")).toBe(true);
		expect(snapshot?.complete).toBe(false);
		expect(records).toHaveLength(6);
	});
});
