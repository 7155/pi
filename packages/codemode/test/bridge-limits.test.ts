import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { loadQuickJSWasm } from "../src/index.ts";
import {
	MAX_BRIDGE_BYTES,
	MAX_BRIDGE_MESSAGE_BYTES,
	MAX_BRIDGE_MESSAGES,
	MessageBudget,
	type OutputLimits,
} from "../src/runtime/limits.ts";
import { isWorkerToHostMessage, type WorkerData, type WorkerToHostMessage } from "../src/runtime/protocol.ts";

async function collectWorkerMessages(code: string, outputLimits: OutputLimits): Promise<WorkerToHostMessage[]> {
	const workerData: WorkerData = {
		code,
		outputLimits,
		tools: [{ name: "late", jsName: "late", description: "Must never be called" }],
		globals: [],
		wasm: await loadQuickJSWasm(),
		memoryLimitBytes: 8 * 1024 * 1024,
		store: {},
		interrupt: new SharedArrayBuffer(4),
	};
	const worker = new Worker(new URL("../src/runtime/worker.ts", import.meta.url), { workerData });
	const messages: WorkerToHostMessage[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Worker did not report its limit")), 3_000);
			worker.on("error", reject);
			worker.on("message", (message: unknown) => {
				if (!isWorkerToHostMessage(message)) return;
				messages.push(message);
				if (message.type === "limit") resolve();
				else if (message.type === "done" || message.type === "crash")
					reject(new Error("Worker failed to enforce its budget"));
			});
		});
	} finally {
		clearTimeout(timer);
		await worker.terminate();
	}
	return messages;
}

describe("producer bridge limits", () => {
	it("posts only the accepted UTF-8 prefix and one limit control message", async () => {
		const messages = await collectWorkerMessages(
			'for (let i = 0; i < 100; i++) { try { text("中😀abc"); } catch {} } tools.late();',
			{ maxOutputBytes: 20, maxOutputItems: 100 },
		);
		expect(messages).toHaveLength(3);
		expect(messages.slice(0, 2)).toEqual(
			Array.from({ length: 2 }, () => ({ type: "output", item: { type: "text", text: "中😀abc" } })),
		);
		expect(messages[2]).toMatchObject({ type: "limit", message: expect.stringContaining("20 UTF-8 bytes") });
	});

	it("limits queued empty messages even when the configured item limit is higher", async () => {
		const messages = await collectWorkerMessages(`for (let i = 0; i < ${MAX_BRIDGE_MESSAGES + 20}; i++) text("");`, {
			maxOutputBytes: 0,
			maxOutputItems: MAX_BRIDGE_MESSAGES + 20,
		});
		expect(messages).toHaveLength(MAX_BRIDGE_MESSAGES + 1);
		expect(messages.at(-1)).toMatchObject({
			type: "limit",
			message: expect.stringContaining(`${MAX_BRIDGE_MESSAGES} messages`),
		});
	});
});

describe("shared bridge accounting", () => {
	it("checks a single huge message using lengths without allocating its payload", () => {
		const budget = new MessageBudget({ maxOutputBytes: Number.MAX_SAFE_INTEGER, maxOutputItems: 10 });
		expect(budget.check(MAX_BRIDGE_MESSAGE_BYTES, 0, 0)).toBeUndefined();
		expect(budget.check(MAX_BRIDGE_MESSAGE_BYTES + 1, 0, 0)).toContain("bytes per message");
	});

	it("caps aggregate call payload bytes using one reusable 256 KiB fixture", () => {
		const budget = new MessageBudget({ maxOutputBytes: 0, maxOutputItems: 0 });
		const size = 256 * 1024;
		const args = "x".repeat(size - 1);
		for (let index = 0; index < MAX_BRIDGE_BYTES / size; index++) {
			expect(budget.accept({ type: "call", id: index, target: "tool", name: "t", args })).toBeUndefined();
		}
		expect(budget.accept({ type: "call", id: 300, target: "tool", name: "t", args: undefined })).toContain(
			"payload bytes per execution",
		);
	});
});
