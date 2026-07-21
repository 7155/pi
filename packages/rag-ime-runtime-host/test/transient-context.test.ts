import { describe, expect, it } from "vitest";
import { ProviderContextJournal } from "../src/provider-context-journal.ts";
import {
	decodeRuntimePrompt,
	formatLocalTimestamp,
	TRANSIENT_CONTEXT_ENVELOPE_PREFIX,
} from "../src/transient-context.ts";

describe("runtime context envelope", () => {
	it("decodes provider-only context without changing the user message", () => {
		const encoded =
			TRANSIENT_CONTEXT_ENVELOPE_PREFIX +
			JSON.stringify({
				schemaVersion: "rag-ime.runtime-prompt.v1",
				message: "继续当前任务",
				sessionContext: "## Session 记忆",
				transientContext: "## 本轮证据",
			});

		expect(decodeRuntimePrompt(encoded)).toEqual({
			message: "继续当前任务",
			sessionContext: "## Session 记忆",
			transientContext: "## 本轮证据",
		});
	});

	it("rejects malformed envelopes instead of storing them as user text", () => {
		expect(() => decodeRuntimePrompt(`${TRANSIENT_CONTEXT_ENVELOPE_PREFIX}{`)).toThrow("not valid JSON");
	});

	it("formats a bounded local observation timestamp", () => {
		const value = formatLocalTimestamp(new Date("2026-07-18T15:30:45.000Z"));
		expect(value).toMatch(/^2026-07-(18|19)T\d{2}:30:45[+-]\d{2}:\d{2}$/);
	});
});

describe("provider context journal", () => {
	it("keeps the previous provider prompt as an exact prefix in one epoch", () => {
		const journal = new ProviderContextJournal();
		const first = journal.project(
			"基础角色提示词",
			{ sessionContext: "第一轮相关记忆", transientContext: "" },
			new Date("2026-07-18T15:30:45.000Z"),
		);
		const second = journal.project(
			first,
			{ sessionContext: "第二轮相关记忆", transientContext: "本轮工具证据" },
			new Date("2026-07-18T15:31:46.000Z"),
		);

		expect(second.startsWith(first)).toBe(true);
		expect(second).toContain("第一轮相关记忆");
		expect(second).toContain("第二轮相关记忆");
		expect(second).toContain("本轮工具证据");
		expect(second).not.toContain("contentHash");
		expect(second).not.toContain("相关度");
		expect(journal.snapshot().entryCount).toBe(3);
	});

	it("deduplicates identical memory and does not rewrite its timestamp", () => {
		const journal = new ProviderContextJournal();
		const first = journal.project(
			"基础角色提示词",
			{ sessionContext: "同一份记忆", transientContext: "" },
			new Date("2026-07-18T15:30:45.000Z"),
		);
		const second = journal.project(
			first,
			{ sessionContext: "同一份记忆", transientContext: "" },
			new Date("2026-07-18T15:31:46.000Z"),
		);

		expect(second).toBe(first);
		expect(second).toContain(":30:45");
		expect(second).not.toContain(":31:46");
		expect(journal.snapshot().entryCount).toBe(1);
	});

	it("starts a recorded new epoch only after compaction", () => {
		const journal = new ProviderContextJournal();
		const before = journal.project(
			"基础角色提示词",
			{ sessionContext: "压缩前记忆", transientContext: "旧工具证据" },
			new Date("2026-07-18T15:30:45.000Z"),
		);
		const after = journal.beginEpoch(
			"compaction",
			before,
			{ sessionContext: "压缩后任务记忆", transientContext: "" },
			new Date("2026-07-18T15:31:46.000Z"),
		);

		expect(after).not.toContain("压缩前记忆");
		expect(after).not.toContain("旧工具证据");
		expect(after).toContain("压缩后任务记忆");
		expect(journal.snapshot()).toMatchObject({
			epoch: 2,
			epochReason: "compaction",
			entryCount: 1,
		});
	});
});
