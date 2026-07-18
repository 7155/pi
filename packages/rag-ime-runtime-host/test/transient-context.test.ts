import { describe, expect, it } from "vitest";
import {
	decodeRuntimePrompt,
	formatLocalTimestamp,
	injectRuntimeContext,
	injectTransientContext,
	TRANSIENT_CONTEXT_ENVELOPE_PREFIX,
} from "../src/transient-context.ts";

describe("transient context", () => {
	it("decodes the gateway envelope without changing the user message", () => {
		const encoded =
			TRANSIENT_CONTEXT_ENVELOPE_PREFIX +
			JSON.stringify({
				schemaVersion: "rag-ime.runtime-prompt.v1",
				message: "继续当前任务",
				sessionContext: "## 新 Session 个人记忆召回",
				transientContext: "## 召回结果\n- Book: 输入法架构",
			});

		expect(decodeRuntimePrompt(encoded)).toEqual({
			message: "继续当前任务",
			sessionContext: "## 新 Session 个人记忆召回",
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

	it("rejects malformed envelopes instead of storing them as user text", () => {
		expect(() => decodeRuntimePrompt(`${TRANSIENT_CONTEXT_ENVELOPE_PREFIX}{`)).toThrow("not valid JSON");
	});
});
