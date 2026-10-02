import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { NestedCallRecorder } from "../src/core/nested-tool-calls.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("native nested tool receipt persistence", () => {
	it("reopens child results under the same durable turn and parent tool call", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-nested-receipt-"));
		try {
			const manager = SessionManager.create(directory, directory);
			manager.appendCustomEntry("rag-ime.pi-turn-binding", {
				schemaVersion: "rag-ime.pi-turn-binding.v1",
				turnId: "turn:a",
				clientMessageId: "dispatch:a",
			});
			manager.appendMessage({ role: "user", content: "Run the original calculation", timestamp: 1 });
			const recorder = new NestedCallRecorder();
			recorder.finish(
				recorder.start({ type: "toolCall", id: "outer/1", name: "bash", arguments: { command: "sum A" } }),
				false,
				"",
				{
					content: [{ type: "text", text: "15\n" }],
					details: { receipt: { exitCode: 0, output: "15\n" } },
					structuredContent: { receiptId: "receipt:calculation", total: 15 },
				},
			);
			const entryId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				content: [{ type: "text", text: "outer text is not the child receipt" }],
				isError: false,
				timestamp: 2,
				nestedCalls: recorder.snapshot(),
			});
			manager.flushPendingEntries();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Session did not persist");
			const reopened = SessionManager.open(sessionFile, directory, directory);
			const entry = reopened.getEntry(entryId);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Receipt missing");
			expect(reopened.getSessionId()).toBe(manager.getSessionId());
			expect(reopened.getBranch()[0]).toMatchObject({
				type: "custom",
				data: { turnId: "turn:a", clientMessageId: "dispatch:a" },
			});
			expect(entry.message.toolCallId).toBe("outer");
			expect(entry.message.nestedCalls?.calls[0]).toMatchObject({
				id: "outer/1",
				name: "bash",
				status: "ok",
				result: {
					content: [{ type: "text", text: "15\n" }],
					details: { receipt: { exitCode: 0, output: "15\n" } },
					structuredContent: { receiptId: "receipt:calculation", total: 15 },
				},
			});
			expect(serializeConversation([entry.message])).toBe("[Tool result]: outer text is not the child receipt");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
