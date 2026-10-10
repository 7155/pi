import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

function quoteEditorArgument(value: string): string {
	// Preserve the existing Windows shell contract; these argv regressions target POSIX.
	return process.platform === "win32" ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: `${quoteEditorArgument(process.execPath)} ${quoteEditorArgument(editorFixturePath)} ${quoteEditorArgument(capturePath)}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it.skipIf(process.platform === "win32")(
		"preserves quoted script paths, literal argv and the appended prompt path",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi editor argv "));
			const scriptPath = join(directory, `editor 'single' "double".mjs`);
			const capturePath = join(directory, "captured argv.json");
			const unintendedFile = join(directory, "must not exist");
			const args = [
				"",
				"+17:9",
				"--wait",
				`single' and double"`,
				"C:\\Users\\editor",
				`$(touch '${unintendedFile}')`,
				"`echo nope`",
				";",
				"|",
				"*.md",
				"$HOME",
			];
			try {
				writeFileSync(
					scriptPath,
					`import { readFileSync, writeFileSync } from "node:fs";
const [capturePath, ...args] = process.argv.slice(2);
const promptPath = args.at(-1);
writeFileSync(capturePath, JSON.stringify({ args, content: readFileSync(promptPath, "utf-8") }));
writeFileSync(promptPath, "edited\\n");
`,
				);
				const result = await editInExternalEditor({
					command: [process.execPath, scriptPath, capturePath, ...args].map(quoteEditorArgument).join(" "),
					content: "original",
				});
				const captured = JSON.parse(readFileSync(capturePath, "utf-8")) as { args: string[]; content: string };
				expect(captured.args.slice(0, -1)).toEqual(args);
				expect(captured.content).toBe("original");
				expect(captured.args.at(-1)).toMatch(/prompt\.md$/);
				expect(existsSync(captured.args.at(-1)!)).toBe(false);
				expect(existsSync(unintendedFile)).toBe(false);
				expect(result).toEqual({ status: "complete", content: "edited" });
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps single-quoted arguments literal without expanding shell syntax",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi editor single "));
			const capturePath = join(directory, "capture.json");
			try {
				const result = await editInExternalEditor({
					command: `'${process.execPath}' '${editorFixturePath}' '${capturePath}'`,
					content: "original",
				});
				expect(result).toEqual({ status: "complete", content: "edited" });
				expect(JSON.parse(readFileSync(capturePath, "utf-8")).content).toBe("original");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("fails closed for an empty or unterminated editor command", async () => {
		for (const command of ["", "   ", '"unterminated', "'unterminated", '"" --wait']) {
			expect(await editInExternalEditor({ command, content: "original" })).toEqual({ status: "failed" });
		}
	});

	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});
});
