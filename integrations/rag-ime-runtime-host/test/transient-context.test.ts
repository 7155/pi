import { describe, expect, it } from "vitest";
import {
	decodeRuntimePrompt,
	formatLocalTimestamp,
	injectRuntimeContext,
	injectTransientContext,
	replaceRuntimeSessionContext,
	TRANSIENT_CONTEXT_ENVELOPE_PREFIX,
} from "../src/transient-context.ts";

describe("transient context", () => {
	it("decodes the gateway envelope without changing the user message", () => {
		const encoded =
			TRANSIENT_CONTEXT_ENVELOPE_PREFIX +
			JSON.stringify({
				schemaVersion: "rag-ime.runtime-prompt.v1",
				message: "继续当前任务",
				sessionContext: "## Session 记忆",
				transientContext: "## 召回结果\n- Book: 输入法架构",
			});

		expect(decodeRuntimePrompt(encoded)).toEqual({
			message: "继续当前任务",
			sessionContext: "## Session 记忆",
			transientContext: "## 召回结果\n- Book: 输入法架构",
		});
	});

	it("injects readable context into the high-priority system prompt", () => {
		const now = new Date("2026-07-18T15:30:45.000Z");
		const prompt = injectTransientContext("基础角色提示词", "## Session 记忆\n### 主题书\n#### 输入法架构");

		expect(prompt).toContain("基础角色提示词");
		expect(prompt).not.toContain(TRANSIENT_CONTEXT_ENVELOPE_PREFIX.trim());
		expect(prompt).toContain('type="turn_context"');
		expect(prompt).toContain("#### 输入法架构");
		expect(prompt).not.toContain('"message"');
		expect(formatLocalTimestamp(now)).toMatch(/^2026-07-(18|19)T\d{2}:30:45[+-]\d{2}:\d{2}$/);
	});

	it("keeps only context type, current time, and body in the model-visible prompt", () => {
		const now = new Date("2026-07-18T15:30:45.000Z");
		const prompt = injectRuntimeContext(
			"基础角色提示词",
			{
				sessionContext: "## Session 记忆",
				transientContext: "## 本回合工具结果",
			},
			now,
		);

		expect(prompt).not.toContain("RAG_IME_TRANSIENT_CONTEXT_V1");
		expect(prompt).toContain('type="session_memory"');
		expect(prompt).toContain('type="turn_context"');
		expect(prompt.match(/current_time=/g)).toHaveLength(2);
		expect(prompt).toContain(formatLocalTimestamp(now));
		expect(prompt).toContain("## Session 记忆");
		expect(prompt).toContain("## 本回合工具结果");
		expect(prompt).not.toContain("不是用户消息正文");
		expect(prompt).not.toContain("权限、审批或安全边界");
	});

	it("writes a fresh current time on every provider injection", () => {
		const contexts = { sessionContext: "记忆正文", transientContext: "" };
		const first = injectRuntimeContext("基础角色提示词", contexts, new Date("2026-07-18T15:30:45.000Z"));
		const second = injectRuntimeContext("基础角色提示词", contexts, new Date("2026-07-18T15:31:46.000Z"));

		expect(first).not.toEqual(second);
		expect(first).toContain(":30:45");
		expect(second).toContain(":31:46");
	});

	it("replaces managed blocks on the next turn instead of duplicating compacted context", () => {
		const compacted = injectRuntimeContext(
			"基础角色提示词",
			{
				sessionContext: "压缩后的旧注入",
				transientContext: "上一轮工具证据",
			},
			new Date("2026-07-18T15:30:45.000Z"),
		);
		const nextTurn = injectRuntimeContext(
			compacted,
			{
				sessionContext: "压缩后的当前记忆",
				transientContext: "本轮工具证据",
			},
			new Date("2026-07-18T15:31:46.000Z"),
		);

		expect(nextTurn).not.toContain("压缩后的旧注入");
		expect(nextTurn).not.toContain("上一轮工具证据");
		expect(nextTurn.match(/type="session_memory"/g)).toHaveLength(1);
		expect(nextTurn.match(/type="turn_context"/g)).toHaveLength(1);
		expect(nextTurn).toContain("压缩后的当前记忆");
		expect(nextTurn).toContain("本轮工具证据");
		expect(nextTurn).toContain(":31:46");
	});

	it("atomically replaces Session memory after compaction without duplicating turn context", () => {
		const before = injectRuntimeContext(
			"基础角色提示词",
			{
				sessionContext: "旧 Session 记忆",
				transientContext: "本轮工具证据",
			},
			new Date("2026-07-18T15:30:45.000Z"),
		);
		const after = replaceRuntimeSessionContext(before, "压缩后 Session 记忆", new Date("2026-07-18T15:31:46.000Z"));

		expect(after).not.toContain("旧 Session 记忆");
		expect(after).toContain("压缩后 Session 记忆");
		expect(after).toContain("本轮工具证据");
		expect(after.match(/type="session_memory"/g)).toHaveLength(1);
		expect(after.match(/type="turn_context"/g)).toHaveLength(1);
		expect(after).toContain(":31:46");
	});

	it("repairs duplicate legacy Session blocks while replacing compaction context", () => {
		const duplicate = [
			"基础角色提示词",
			'<rag-ime-context type="session_memory" current_time="2026-07-18T15:30:45+08:00">',
			"旧记忆一",
			"</rag-ime-context>",
			'<rag-ime-context type="turn_context" current_time="2026-07-18T15:30:45+08:00">',
			"当前回合证据",
			"</rag-ime-context>",
			'<rag-ime-context type="session_memory" current_time="2026-07-18T15:30:45+08:00">',
			"旧记忆二",
			"</rag-ime-context>",
		].join("\n");

		const repaired = replaceRuntimeSessionContext(duplicate, "唯一的新记忆", new Date("2026-07-18T15:31:46.000Z"));

		expect(repaired).not.toContain("旧记忆一");
		expect(repaired).not.toContain("旧记忆二");
		expect(repaired.match(/type="session_memory"/g)).toHaveLength(1);
		expect(repaired.match(/type="turn_context"/g)).toHaveLength(1);
		expect(repaired).toContain("唯一的新记忆");
		expect(repaired).toContain("当前回合证据");
	});

	it("rejects malformed envelopes instead of storing them as user text", () => {
		expect(() => decodeRuntimePrompt(`${TRANSIENT_CONTEXT_ENVELOPE_PREFIX}{`)).toThrow("not valid JSON");
	});
});
