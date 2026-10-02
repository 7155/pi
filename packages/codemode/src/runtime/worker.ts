/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * or embedded-module string specifier as `workerUrl`.
 */
import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { MessageBudget } from "./limits.ts";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

function crash(error: unknown): void {
	const message =
		error instanceof Error
			? `${error.name.slice(0, 128)}: ${error.message.slice(0, 4096)}`
			: String(error).slice(0, 4096);
	post({ type: "crash", message });
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	const budget = new MessageBudget(data.outputLimits);
	let stopped = false;
	const stop = (message: string) => {
		if (stopped) return;
		stopped = true;
		// Fail closed even when a script catches exceptions or keeps emitting synchronously.
		Atomics.store(interrupt, 0, 1);
		post({ type: "limit", message });
	};
	const send = (message: Exclude<WorkerToHostMessage, { type: "limit" }>) => {
		if (stopped) return;
		const limit = budget.accept(message);
		if (limit) stop(limit);
		else post(message);
	};
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
		wasi: discardOutput,
	});

	// Called from the prelude with primitives only.
	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		if (stopped) return vm.undefined;
		const type = kind.toString();
		const outputItems = type === "output" || (type === "done" && a.toBoolean() && !b.isUndefined) ? 1 : 0;
		let messageBytes = 0;
		let outputBytes = 0;
		const initialLimit = budget.check(0, 0, outputItems);
		if (initialLimit) {
			stop(initialLimit);
			return vm.undefined;
		}
		const read = (value: JSValueHandle, output = false): string => {
			if (stopped) return "";
			if (!value.isString) throw new Error("Invalid non-string bridge payload");
			// A string's UTF-16 length is a lower bound on its UTF-8 byte count. Reject huge
			// values before toString() copies them into the worker's JS heap. Exact accounting
			// follows; even a multibyte candidate is bounded to at most 3x the remaining bytes.
			const lengthLimit = budget.check(
				messageBytes + value.length,
				outputBytes + (output ? value.length : 0),
				outputItems,
			);
			if (lengthLimit) {
				stop(lengthLimit);
				return "";
			}
			const text = value.toString();
			const bytes = Buffer.byteLength(text);
			messageBytes += bytes;
			if (output) outputBytes += bytes;
			const limit = budget.check(messageBytes, outputBytes, outputItems);
			if (limit) stop(limit);
			return text;
		};
		switch (type) {
			case "call":
			case "global":
				send({
					type: "call",
					id: a.toNumber(),
					target: type === "call" ? "tool" : "global",
					name: read(b),
					args: c === undefined || c.isUndefined ? undefined : read(c),
				});
				break;
			case "output":
				send({
					type: "output",
					item:
						a.toString() === "image"
							? { type: "image", data: read(b, true), mimeType: read(c, true) }
							: { type: "text", text: read(b, true) },
				});
				break;
			case "done":
				if (a.toBoolean()) {
					send({
						type: "done",
						ok: true,
						value: b === undefined || b.isUndefined ? undefined : read(b, true),
						writes: read(c),
					});
				} else {
					send({ type: "done", ok: false, error: read(b, true) });
				}
				break;
		}
		return vm.undefined;
	});

	// The VM lives until the host terminates the worker, so these handles are never disposed.
	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.tools)),
				vm.newString(JSON.stringify(data.globals)),
				vm.newString(JSON.stringify(data.store)),
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");
	const stalled = api.getProp("stalled");
	/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
	const drain = () => {
		if (stopped) return;
		vm.executePendingJobs();
		if (stopped) return;
		vm.callFunction(stalled, api).dispose();
	};

	parentPort?.on("message", (message: unknown) => {
		if (stopped || !isHostToWorkerMessage(message)) return;
		try {
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				);
			});
			drain();
		} catch (error) {
			if (!stopped) crash(error);
		}
	});

	// The prefix shares the first line with the script so reported line numbers
	// match the script as written.
	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		send({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	try {
		vm.callFunction(run, api, fn).dispose();
		drain();
	} catch (error) {
		// A limit's interrupt can surface while unwinding the current VM call. Its single
		// limit message was already posted; do not queue a second crash behind it.
		if (!stopped) throw error;
	} finally {
		fn.dispose();
	}
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
