import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { prepareNativePiFork } from "../src/pi-session.ts";

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("native Pi conversation fork", () => {
	it("creates a distinct transcript at the selected user anchor without mutating the source", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "first question", timestamp: 1 });
			source.appendMessage(assistant("first answer", 2));
			const secondUserId = source.appendMessage({ role: "user", content: "branch this", timestamp: 3 });
			const sourceLeaf = source.appendMessage(assistant("abandoned answer", 4));
			const sourceFile = source.getSessionFile();

			const prepared = prepareNativePiFork(source, secondUserId);

			expect(prepared.selectedText).toBe("branch this");
			expect(prepared.sessionFile).not.toBe(sourceFile);
			expect(prepared.branchAnchor).not.toBe(secondUserId);
			expect(prepared.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(source.getLeafId()).toBe(sourceLeaf);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a non-user anchor instead of copying the conversation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-host-fork-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "question", timestamp: 1 });
			const assistantId = source.appendMessage(assistant("answer", 2));

			expect(() => prepareNativePiFork(source, assistantId)).toThrow("Fork entry must identify a user message");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
