import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionContextRefreshExtension } from "../src/session-context-refresh.ts";

describe("session context refresh", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("bootstraps an empty child Session and refreshes it before a compaction retry", async () => {
		let sessionContext = "";
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { sessionContext: "## 子任务记忆" } }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { sessionContext: "## 压缩后任务记忆" } }),
			});
		vi.stubGlobal("fetch", fetchMock);

		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:child",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => sessionContext,
			setSessionContext: (value) => {
				sessionContext = value;
			},
			getRecentMessages: () => [
				{ role: "user", text: "完成检索测试" },
				{ role: "assistant", text: "已经完成初步实现" },
			],
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await handlers.get("before_agent_start")?.({ prompt: "完成检索测试" });
		expect(sessionContext).toBe("## 子任务记忆");
		const compactResult = (await handlers.get("session_compact")?.(
			{ compactionEntry: { summary: "压缩摘要" } },
			{
				getSystemPrompt: () =>
					[
						"基础提示词",
						'<rag-ime-context type="session_memory" current_time="2026-07-19T08:00:00+08:00">',
						"## 子任务记忆",
						"</rag-ime-context>",
					].join("\n"),
			},
		)) as { systemPrompt?: string } | undefined;
		expect(sessionContext).toBe("## 压缩后任务记忆");
		expect(compactResult?.systemPrompt).toContain("## 压缩后任务记忆");
		expect(compactResult?.systemPrompt).not.toContain("## 子任务记忆");
		expect(compactResult?.systemPrompt?.match(/type="session_memory"/g)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8766/api/agent/tool/context-refresh");
		const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(request.trigger).toBe("compaction");
		expect(request.summary).toBe("压缩摘要");
		expect(request.recentMessages).toHaveLength(2);
	});
});
