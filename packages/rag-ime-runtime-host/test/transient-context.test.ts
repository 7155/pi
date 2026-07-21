import { describe, expect, it } from "vitest";
import { createProviderContextJournalExtension, ProviderContextJournal } from "../src/provider-context-journal.ts";
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
		const first = journal.project("基础角色提示词", {
			roomContext: "Room 冻结任务",
			sessionContext: "第一轮相关记忆",
			transientContext: "",
		});
		const second = journal.project(first, {
			roomContext: "Room 冻结任务",
			sessionContext: "第二轮相关记忆",
			transientContext: "本轮工具证据",
		});

		expect(second.startsWith(first)).toBe(true);
		expect(second).toContain("第一轮相关记忆");
		expect(second).toContain("第二轮相关记忆");
		expect(second.match(/Room 冻结任务/g)).toHaveLength(1);
		expect(second).toContain("本轮工具证据");
		expect(second).not.toContain("contentHash");
		expect(second).not.toContain("相关度");
		expect(journal.snapshot().entryCount).toBe(4);
	});

	it("deduplicates identical memory without adding volatile provider metadata", () => {
		const journal = new ProviderContextJournal();
		const first = journal.project("基础角色提示词", { sessionContext: "同一份记忆", transientContext: "" });
		const second = journal.project(first, { sessionContext: "同一份记忆", transientContext: "" });

		expect(second).toBe(first);
		expect(second).not.toContain("observed_at");
		expect(second).not.toContain("current_time");
		expect(journal.snapshot().entryCount).toBe(1);
	});

	it("projects Room-only context through the before-agent-start hook", async () => {
		const handlers = new Map<string, (event: { systemPrompt: string }) => unknown>();
		const extension = createProviderContextJournalExtension(new ProviderContextJournal(), () => ({
			roomContext: "Room 当前责任与验收",
			sessionContext: "",
			transientContext: "",
		}));
		extension({
			on: (event: string, handler: (value: { systemPrompt: string }) => unknown) => handlers.set(event, handler),
		} as never);

		const result = (await handlers.get("before_agent_start")?.({ systemPrompt: "基础角色提示词" })) as
			| { systemPrompt?: string }
			| undefined;

		expect(result?.systemPrompt).toContain('type="room_context"');
		expect(result?.systemPrompt).toContain("Room 当前责任与验收");
	});

	it("starts a recorded new epoch only after compaction", () => {
		const journal = new ProviderContextJournal();
		const before = journal.project("基础角色提示词", {
			roomContext: "Room 冻结任务",
			sessionContext: "压缩前记忆",
			transientContext: "旧工具证据",
		});
		const after = journal.beginEpoch("compaction", before, {
			roomContext: "Room 冻结任务",
			sessionContext: "压缩后任务记忆",
			transientContext: "",
		});

		expect(after).not.toContain("压缩前记忆");
		expect(after).not.toContain("旧工具证据");
		expect(after).toContain("压缩后任务记忆");
		expect(after).toContain("Room 冻结任务");
		expect(journal.snapshot()).toMatchObject({
			epoch: 2,
			epochReason: "compaction",
			entryCount: 2,
		});
	});

	it("accepts only the exact next product-owned epoch", () => {
		const journal = new ProviderContextJournal(4, "task_switch");
		const next = journal.beginEpoch(
			"compaction",
			"基础角色提示词",
			{
				roomContext: "压缩恢复包",
				sessionContext: "压缩后记忆",
				transientContext: "",
			},
			5,
		);

		expect(next).toContain("压缩恢复包");
		expect(journal.snapshot().epoch).toBe(5);
		expect(() =>
			journal.beginEpoch(
				"compaction",
				next,
				{ roomContext: "重复恢复包", sessionContext: "重复记忆", transientContext: "" },
				5,
			),
		).toThrow("stale or non-monotonic");
		expect(() =>
			journal.beginEpoch(
				"compaction",
				next,
				{ roomContext: "跳号恢复包", sessionContext: "跳号记忆", transientContext: "" },
				7,
			),
		).toThrow("stale or non-monotonic");
		expect(journal.snapshot().epoch).toBe(5);
	});
});
