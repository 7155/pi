import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1_800;
const PARENT_OUTPUT_BYTES = 50 * 1024;
const DETAILS_OUTPUT_BYTES = 256 * 1024;
const STDERR_BYTES = 64 * 1024;
const COMMAND_RESULT_ENTRY_TYPE = "paw-pi-package-command-result";

type Responsibility = "research" | "review" | "execute";
type ChildStatus = "completed" | "failed" | "aborted" | "timeout";

interface DelegatedTask {
	task: string;
	responsibility?: Responsibility;
	cwd?: string;
	model?: string;
	thinking?: string;
	timeoutSeconds?: number;
}

interface ChildResult {
	task: string;
	responsibility: Responsibility;
	status: ChildStatus;
	exitCode: number | null;
	output: string;
	stderr: string;
	model?: string;
	stopReason?: string;
	elapsedMs: number;
	outputBytes: number;
	omittedBytes: number;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
	const merged = Buffer.from(current + chunk, "utf8");
	if (merged.byteLength <= maxBytes) return merged.toString("utf8");
	let start = merged.byteLength - maxBytes;
	while (start < merged.byteLength && (merged[start]! & 0xc0) === 0x80) start += 1;
	return merged.subarray(start).toString("utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; omittedBytes: number } {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength <= maxBytes) return { text: value, omittedBytes: 0 };
	let end = maxBytes;
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
	const text = encoded.subarray(0, end).toString("utf8");
	return { text, omittedBytes: encoded.byteLength - end };
}

interface PiInvocationOptions {
	currentScript?: string;
	execPath?: string;
	modulePath?: string;
	pathExists?: (path: string) => boolean;
}

function piInvocation(args: string[], options: PiInvocationOptions = {}): { command: string; args: string[] } {
	const currentScript = options.currentScript ?? process.argv[1];
	const execPath = options.execPath ?? process.execPath;
	const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
	const pathExists = options.pathExists ?? existsSync;
	// Installed Package extensions live at <runtime>/pi-packages/<id>/extension-*.js.
	// Resolve the sibling Pi CLI from that stable payload layout first because
	// some extension loaders replace process.argv[1] with their own bootstrap.
	// Relying only on argv therefore kept recursively invoking the Runtime Host
	// and reproduced `completed` + `(no output)` after the first fix was built.
	const packagedCli = resolve(dirname(modulePath), "../../runtime-host/pi-cli.mjs");
	if (pathExists(packagedCli)) {
		return { command: execPath, args: [packagedCli, ...args] };
	}
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && pathExists(currentScript)) {
		// The managed PAW payload's current script is the Runtime Host RPC CLI,
		// not Pi's coding-agent CLI. Passing --mode json/-p to that host exits 0
		// without producing a child answer, which previously surfaced as a false
		// `completed` + `(no output)` subagent result. The managed payload bundles
		// the real Pi CLI next to the host for this exact child-process boundary.
		if (basename(currentScript) === "cli.mjs" && basename(dirname(currentScript)) === "runtime-host") {
			const bundledCli = resolve(dirname(currentScript), "pi-cli.mjs");
			if (!pathExists(bundledCli)) {
				throw new Error(`Managed Runtime Host is missing bundled Pi CLI: ${bundledCli}`);
			}
			return { command: execPath, args: [bundledCli, ...args] };
		}
		return { command: execPath, args: [currentScript, ...args] };
	}
	const executable = basename(execPath).toLowerCase();
	return /^(?:node|bun)(?:\.exe)?$/u.test(executable)
		? { command: "pi", args }
		: { command: execPath, args };
}

function taskWithRuntimeDefaults(
	task: DelegatedTask,
	model: { provider: string; id: string } | undefined,
	thinking: string | undefined,
): DelegatedTask {
	return {
		...task,
		...(!task.model?.trim() && model ? { model: `${model.provider}/${model.id}` } : {}),
		...(!task.thinking?.trim() && thinking ? { thinking } : {}),
	};
}

function terminate(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
		else proc.kill("SIGTERM");
	} catch {
		proc.kill("SIGTERM");
	}
	setTimeout(() => {
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		try {
			if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
			else proc.kill("SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	}, 5_000).unref();
}

function operationalPrompt(task: DelegatedTask): string {
	const responsibility = task.responsibility ?? "research";
	const contract =
		responsibility === "execute"
			? "Complete only the authorized implementation and report changed files plus verification."
			: responsibility === "review"
				? "Read and review only. Do not change files. Return concrete findings with file and line evidence."
				: "Research only. Do not change files. Return compressed evidence that the parent can verify.";
	return `[DELEGATED WORK]\nResponsibility: ${responsibility}\n${contract}\n\nTask:\n${task.task.trim()}`;
}

function parseEvent(line: string): { output?: string; model?: string; stopReason?: string; error?: string } {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return {};
		const message = event.message as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return {};
		const output = message.content
			.flatMap((part) =>
				part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
					? [String((part as Record<string, unknown>).text ?? "")]
					: [],
			)
			.join("\n");
		return {
			...(output ? { output } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
			...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
		};
	} catch {
		return {};
	}
}

async function runChild(rootCwd: string, task: DelegatedTask, signal?: AbortSignal): Promise<ChildResult> {
	const startedAt = Date.now();
	const responsibility = task.responsibility ?? "research";
	const childCwd = resolve(rootCwd, task.cwd ?? ".");
	if (!isInside(resolve(rootCwd), childCwd)) {
		throw new Error(`Subagent cwd must stay inside the Session workspace: ${task.cwd}`);
	}
	const timeoutSeconds = Math.min(
		MAX_TIMEOUT_SECONDS,
		Math.max(5, Math.floor(task.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)),
	);
	const args = ["--mode", "json", "-p", "--no-session"];
	if (task.model?.trim()) args.push("--model", task.model.trim());
	if (task.thinking?.trim()) args.push("--thinking", task.thinking.trim());
	if (responsibility !== "execute") args.push("--tools", "read,grep,find,ls");
	args.push(operationalPrompt(task));
	const invocation = piInvocation(args);

	let output = "";
	let stderr = "";
	let stdoutBuffer = "";
	let detectedModel: string | undefined;
	let stopReason: string | undefined;
	let runtimeError: string | undefined;
	let status: ChildStatus = "completed";
	let abortKind: "aborted" | "timeout" | undefined;

	const exitCode = await new Promise<number | null>((settle) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			settle(code);
		};
		const abort = () => {
			abortKind = "aborted";
			terminate(proc);
		};
		const timeout = setTimeout(() => {
			abortKind = "timeout";
			terminate(proc);
		}, timeoutSeconds * 1_000);
		timeout.unref();

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuffer = appendBounded(stdoutBuffer, chunk.toString("utf8"), DETAILS_OUTPUT_BYTES * 2);
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseEvent(line);
				if (event.output !== undefined) output = appendBounded(output, event.output, DETAILS_OUTPUT_BYTES);
				if (event.model) detectedModel = event.model;
				if (event.stopReason) stopReason = event.stopReason;
				if (event.error) runtimeError = appendBounded(runtimeError ?? "", event.error, STDERR_BYTES);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString("utf8"), STDERR_BYTES);
		});
		proc.once("error", (error) => {
			stderr = appendBounded(stderr, error.message, STDERR_BYTES);
			finish(1);
		});
		proc.once("close", (code) => {
			if (stdoutBuffer.trim()) {
				const event = parseEvent(stdoutBuffer);
				if (event.output !== undefined) output = appendBounded(output, event.output, DETAILS_OUTPUT_BYTES);
				if (event.model) detectedModel = event.model;
				if (event.stopReason) stopReason = event.stopReason;
				if (event.error) runtimeError = appendBounded(runtimeError ?? "", event.error, STDERR_BYTES);
			}
			finish(code);
		});
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});

	if (abortKind) status = abortKind;
	else if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") status = "failed";
	const fullOutput = output || runtimeError?.trim() || stderr.trim() || "(no output)";
	const parent = truncateUtf8(fullOutput, PARENT_OUTPUT_BYTES);
	return {
		task: task.task,
		responsibility,
		status,
		exitCode,
		output: parent.text,
		stderr,
		...(detectedModel || task.model ? { model: detectedModel ?? task.model } : {}),
		...(stopReason ? { stopReason } : {}),
		elapsedMs: Date.now() - startedAt,
		outputBytes: Buffer.byteLength(fullOutput, "utf8"),
		omittedBytes: parent.omittedBytes,
	};
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await work(items[index], index);
			}
		}),
	);
	return results;
}

const ResponsibilitySchema = Type.Union([
	Type.Literal("research"),
	Type.Literal("review"),
	Type.Literal("execute"),
]);
const TaskSchema = Type.Object({
	task: Type.String({ minLength: 1, maxLength: 100_000 }),
	responsibility: Type.Optional(ResponsibilitySchema),
	cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
	model: Type.Optional(Type.String({ maxLength: 240 })),
	thinking: Type.Optional(Type.String({ maxLength: 32 })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: MAX_TIMEOUT_SECONDS })),
});

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerCommand("subagents", {
		description: "Show bounded subagent Package limits",
		handler: async (_args, ctx) => {
			const message = `subagent is available: max ${MAX_TASKS} tasks, ${MAX_CONCURRENCY} concurrent, ${DEFAULT_TIMEOUT_SECONDS}s default timeout.`;
			pi.appendEntry(COMMAND_RESULT_ENTRY_TYPE, {
				schemaVersion: "rag-ime.pi-package-command-result.v1",
				packageId: "@paw/pi-subagent",
				command: "subagents",
				message,
				details: {
					maxTasks: MAX_TASKS,
					maxConcurrency: MAX_CONCURRENCY,
					defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
				},
				timestamp: new Date().toISOString(),
			});
			if (ctx.hasUI) ctx.ui.notify(message, "info");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate one task or an array of independent tasks to isolated Pi child Sessions. Responsibilities are execution policies, not personas.",
		parameters: Type.Object({
			task: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
			responsibility: Type.Optional(ResponsibilitySchema),
			cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
			model: Type.Optional(Type.String({ maxLength: 240 })),
			thinking: Type.Optional(Type.String({ maxLength: 32 })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: MAX_TIMEOUT_SECONDS })),
			tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasSingle = Boolean(params.task?.trim());
			const hasParallel = Boolean(params.tasks?.length);
			if (Number(hasSingle) + Number(hasParallel) !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one of task or tasks." }],
					details: { results: [] },
					isError: true,
				};
			}
			const tasks: DelegatedTask[] = hasSingle
				? [
						{
							task: params.task!,
							...(params.responsibility ? { responsibility: params.responsibility } : {}),
							...(params.cwd ? { cwd: params.cwd } : {}),
							...(params.model ? { model: params.model } : {}),
							...(params.thinking ? { thinking: params.thinking } : {}),
							...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}),
						},
					]
				: params.tasks!;
			let completed = 0;
			const results = await mapLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
				const result = await runChild(
					ctx.cwd,
					taskWithRuntimeDefaults(task, ctx.model, ctx.thinkingLevel),
					signal,
				);
				completed += 1;
				onUpdate?.({
					content: [{ type: "text", text: `Subagents: ${completed}/${tasks.length} settled.` }],
					details: { completed, total: tasks.length, latest: index + 1 },
				});
				return result;
			});
			const successes = results.filter((result) => result.status === "completed").length;
			const text = results
				.map((result, index) => {
					const omitted = result.omittedBytes ? `\n[${result.omittedBytes} bytes omitted from parent result]` : "";
					return `### Task ${index + 1} · ${result.responsibility} · ${result.status}\n\n${result.output}${omitted}`;
				})
				.join("\n\n---\n\n");
			return {
				content: [{ type: "text", text: `${successes}/${results.length} subagents completed.\n\n${text}` }],
				details: { results },
				...(successes === results.length ? {} : { isError: true }),
			};
		},
	});
}

export { appendBounded, mapLimit, operationalPrompt, parseEvent, piInvocation, taskWithRuntimeDefaults, truncateUtf8 };
