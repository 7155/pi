import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		// Windows retains its existing shell/cmd command contract. POSIX launches a
		// literal argv: quotes only group arguments, never execute shell syntax.
		const commandArgs: string[] = [];
		if (process.platform === "win32") {
			commandArgs.push(...options.command.split(" "));
		} else {
			let current = "";
			let quote: string | undefined;
			let started = false;
			for (let index = 0; index < options.command.length; index++) {
				const char = options.command[index];
				if (char === "\\" && quote !== "'") {
					const next = options.command[index + 1];
					if (next === undefined) return { status: "failed" };
					if (next === "\\" || next === '"' || (!quote && (next === "'" || /\s/.test(next)))) {
						current += next;
						index++;
					} else {
						current += char;
					}
					started = true;
				} else if (quote) {
					if (char === quote) quote = undefined;
					else current += char;
				} else if (char === '"' || char === "'") {
					quote = char;
					started = true;
				} else if (/\s/.test(char)) {
					if (started) commandArgs.push(current);
					current = "";
					started = false;
				} else {
					current += char;
					started = true;
				}
			}
			if (quote) return { status: "failed" };
			if (started) commandArgs.push(current);
		}
		const [editor, ...editorArgs] = commandArgs;
		if (!editor) return { status: "failed" };
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
