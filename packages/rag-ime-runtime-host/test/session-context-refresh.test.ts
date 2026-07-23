import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderContextJournal } from "../src/provider-context-journal.ts";
import { createSessionContextRefreshExtension } from "../src/session-context-refresh.ts";

describe("session context refresh", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("rebases every compaction epoch with exactly one bounded Room recovery snapshot", async () => {
		let sessionContext = "";
		let storedRoomRecoveryContext = "过期 Room 恢复包";
		const roomRecoveryFacts = [
			"原始需求：完成 Room 上下文回归",
			"当前任务：验证压缩恢复",
			"验收：需求与责任不能遗忘",
			"阻塞：等待测试环境",
			"continuation：交给 reviewer",
			"工具回执：load:room-state",
		];
		const roomRecoveryContext = roomRecoveryFacts.join("\n");
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
				json: async () => ({
					ok: true,
					result: {
						sessionContext: "## 第一次压缩后任务记忆",
						roomRecoveryContext,
						contextEpoch: 2,
						contextEpochReason: "compaction",
					},
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					result: {
						sessionContext: "## 第二次压缩后任务记忆",
						roomRecoveryContext,
						contextEpoch: 3,
						contextEpochReason: "compaction",
					},
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					result: {
						sessionContext: "## 第三次压缩后任务记忆",
						roomRecoveryContext,
						contextEpoch: 4,
						contextEpochReason: "compaction",
					},
				}),
			});
		vi.stubGlobal("fetch", fetchMock);
		const providerContextJournal = new ProviderContextJournal();

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
			getRoomContext: () => "## Room 当前任务",
			getRoomRecoveryContext: () => storedRoomRecoveryContext,
			setRoomRecoveryContext: (value) => {
				storedRoomRecoveryContext = value;
			},
			getRecentMessages: () => [
				{ role: "user", text: "完成检索测试" },
				{ role: "assistant", text: "已经完成初步实现" },
			],
			getRoomSkillRecovery: () => ({
				schemaVersion: "rag-ime.skill-load.v1",
				name: "implementation",
				catalogRevision: "c".repeat(64),
				contentRevision: "d".repeat(64),
				loadReason: "stage_required",
			}),
			getRoomToolRecovery: () => ({
				schemaVersion: "rag-ime.room-tool-recovery.v1",
				items: [{ name: "room_state", receiptId: "load:room-state" }],
			}),
			providerContextJournal,
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await handlers.get("before_agent_start")?.({ prompt: "完成检索测试" });
		expect(sessionContext).toBe("## 子任务记忆");
		const beforeCompact = (await handlers.get("session_before_compact")?.({
			preparation: {
				firstKeptEntryId: "entry:kept",
				tokensBefore: 42_000,
			},
		})) as { compaction?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number; details?: unknown } };
		expect(beforeCompact.compaction).toMatchObject({
			firstKeptEntryId: "entry:kept",
			tokensBefore: 42_000,
			details: {
				schemaVersion: "rag-ime.managed-room-compaction-pointer.v1",
				owner: "room_context",
			},
		});
		expect(beforeCompact.compaction?.summary).toContain("current managed Provider context");
		expect(beforeCompact.compaction?.summary).toContain("after Room release");
		for (const fact of roomRecoveryFacts) {
			expect(beforeCompact.compaction?.summary).not.toContain(fact);
		}
		const compactResult = (await handlers.get("session_compact")?.(
			{ compactionEntry: { id: "compaction:1", summary: "压缩摘要" } },
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
		expect(sessionContext).toBe("## 第一次压缩后任务记忆");
		expect(compactResult?.systemPrompt).toContain("## 第一次压缩后任务记忆");
		for (const fact of roomRecoveryFacts) {
			expect(compactResult?.systemPrompt?.split(fact)).toHaveLength(2);
		}
		expect(compactResult?.systemPrompt).not.toContain("## Room 当前任务");
		expect(compactResult?.systemPrompt).not.toContain("## 子任务记忆");
		expect(compactResult?.systemPrompt).not.toContain("过期 Room 恢复包");
		expect(storedRoomRecoveryContext).toBe(roomRecoveryContext);
		expect(compactResult?.systemPrompt?.match(/type="room_context"/g)).toHaveLength(1);
		expect(compactResult?.systemPrompt?.match(/type="session_memory"/g)).toHaveLength(1);
		let rebasedPrompt = compactResult?.systemPrompt ?? "";
		for (const [ordinal, expectedContext] of [
			[2, "## 第二次压缩后任务记忆"],
			[3, "## 第三次压缩后任务记忆"],
		] as const) {
			const next = (await handlers.get("session_compact")?.(
				{ compactionEntry: { id: `compaction:${ordinal}`, summary: `压缩摘要 ${ordinal}` } },
				{ getSystemPrompt: () => rebasedPrompt },
			)) as { systemPrompt?: string } | undefined;
			rebasedPrompt = next?.systemPrompt ?? "";
			expect(sessionContext).toBe(expectedContext);
			expect(rebasedPrompt).toContain(expectedContext);
			for (const fact of roomRecoveryFacts) {
				expect(rebasedPrompt.split(fact)).toHaveLength(2);
			}
			expect(rebasedPrompt.match(/type="room_context"/g)).toHaveLength(1);
			expect(rebasedPrompt.match(/type="session_memory"/g)).toHaveLength(1);
		}
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 4,
			epochReason: "compaction",
			entryCount: 2,
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8766/api/agent/tool/context-refresh");
		const sessionStartRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(sessionStartRequest.trigger).toBe("session_start");
		expect(sessionStartRequest).not.toHaveProperty("roomSkillRecovery");
		expect(sessionStartRequest).not.toHaveProperty("roomToolRecovery");
		const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(request.trigger).toBe("compaction");
		expect(request.compactionEntryId).toBe("compaction:1");
		expect(request.expectedContextEpoch).toBe(1);
		expect(request.summary).toBe("压缩摘要");
		expect(request.recentMessages).toHaveLength(2);
		expect(request.roomSkillRecovery).toEqual({
			schemaVersion: "rag-ime.skill-load.v1",
			name: "implementation",
			catalogRevision: "c".repeat(64),
			contentRevision: "d".repeat(64),
			loadReason: "stage_required",
		});
		expect(request.roomToolRecovery).toEqual({
			schemaVersion: "rag-ime.room-tool-recovery.v1",
			items: [{ name: "room_state", receiptId: "load:room-state" }],
		});
	});

	it("leaves ordinary Agent compaction on Pi's normal summarizer", async () => {
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:ordinary",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => "ordinary memory",
			setSessionContext: () => undefined,
			getRoomContext: () => "",
			getRoomRecoveryContext: () => "",
			setRoomRecoveryContext: () => undefined,
			getRecentMessages: () => [],
			getRoomSkillRecovery: () => undefined,
			getRoomToolRecovery: () => undefined,
			providerContextJournal: new ProviderContextJournal(),
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await expect(
			handlers.get("session_before_compact")?.({
				preparation: { firstKeptEntryId: "entry:ordinary", tokensBefore: 1_000 },
			}),
		).resolves.toBeUndefined();
	});

	it("uses the pre-compaction ordinary Agent messages and exact load revisions once", async () => {
		let recentMessages = [
			{ role: "user" as const, text: "ORIGINAL-REQUIREMENT: finish the project" },
			{ role: "assistant" as const, text: "Current implementation is complete" },
		];
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { sessionContext: "## 压缩恢复包" } }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:ordinary-recovery",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => "ordinary memory",
			setSessionContext: () => undefined,
			getRoomContext: () => "",
			getRoomRecoveryContext: () => "",
			setRoomRecoveryContext: () => undefined,
			getRecentMessages: () => recentMessages,
			getRoomSkillRecovery: () => undefined,
			getRoomToolRecovery: () => undefined,
			getAgentSkillRecovery: () => ({
				schemaVersion: "rag-ime.agent-skill-recovery.v1",
				items: [{ name: "notfor", contentRevision: "a".repeat(64) }],
			}),
			getAgentToolRecovery: () => ({
				schemaVersion: "rag-ime.agent-tool-recovery.v1",
				catalogRevision: "b".repeat(64),
				items: [{ name: "workspace_read", schemaRevision: "c".repeat(64) }],
			}),
			providerContextJournal: new ProviderContextJournal(),
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await handlers.get("session_before_compact")?.({
			preparation: { firstKeptEntryId: "entry:kept", tokensBefore: 1_000 },
		});
		recentMessages = [{ role: "assistant", text: "post-compaction-only" }];
		await handlers.get("session_compact")?.(
			{ compactionEntry: { id: "compaction:ordinary", summary: "summary" } },
			{ getSystemPrompt: () => "base prompt" },
		);

		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(request.recentMessages).toEqual([
			{ role: "user", text: "ORIGINAL-REQUIREMENT: finish the project" },
			{ role: "assistant", text: "Current implementation is complete" },
		]);
		expect(request.agentSkillRecovery.items[0].contentRevision).toBe("a".repeat(64));
		expect(request.agentToolRecovery.items[0].schemaRevision).toBe("c".repeat(64));
	});

	it("fails closed when governed Room skill recovery cannot reach the product", async () => {
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gateway offline")));
		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:room-child",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => "existing context",
			setSessionContext: () => undefined,
			getRoomContext: () => "room context",
			getRoomRecoveryContext: () => "room recovery context",
			setRoomRecoveryContext: () => undefined,
			getRecentMessages: () => [],
			getRoomSkillRecovery: () => ({ name: "implementation" }),
			getRoomToolRecovery: () => undefined,
			providerContextJournal: new ProviderContextJournal(),
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await expect(
			handlers.get("session_compact")?.(
				{ compactionEntry: { id: "compaction:closed", summary: "summary" } },
				{ getSystemPrompt: () => "base prompt" },
			),
		).rejects.toThrow("gateway offline");
	});

	it("treats an empty refreshed Session context as an authoritative clear", async () => {
		let sessionContext = "stale Session memory";
		let refreshCount = 0;
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: {
					sessionContext: "",
					roomRecoveryContext: "authoritative Room recovery",
					contextEpoch: 2,
					contextEpochReason: "compaction",
				},
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const providerContextJournal = new ProviderContextJournal();
		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:empty-session-recovery",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => sessionContext,
			setSessionContext: (value) => {
				sessionContext = value;
				refreshCount += 1;
			},
			getRoomContext: () => "active Room context",
			getRoomRecoveryContext: () => "stale Room recovery",
			setRoomRecoveryContext: () => undefined,
			getRecentMessages: () => [],
			getRoomSkillRecovery: () => ({ name: "room-independent-vision-review" }),
			getRoomToolRecovery: () => ({ items: [{ name: "room_state", receiptId: "load:state" }] }),
			providerContextJournal,
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		const compactResult = (await handlers.get("session_compact")?.(
			{ compactionEntry: { id: "compaction:empty-session", summary: "summary" } },
			{ getSystemPrompt: () => "base prompt" },
		)) as { systemPrompt?: string } | undefined;

		expect(refreshCount).toBe(1);
		expect(sessionContext).toBe("");
		expect(compactResult?.systemPrompt).toContain("authoritative Room recovery");
		expect(compactResult?.systemPrompt).not.toContain("stale Session memory");
		expect(compactResult?.systemPrompt).not.toContain('type="session_memory"');
		expect(providerContextJournal.snapshot()).toMatchObject({
			epoch: 2,
			epochReason: "compaction",
			entryCount: 1,
		});
	});

	it("rejects a managed Room compaction without a product-owned compaction epoch", async () => {
		const handlers = new Map<string, (event: any, context?: any) => Promise<unknown>>();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					result: {
						sessionContext: "恢复后的 Session 记忆",
						roomRecoveryContext: "恢复后的 Room 事实",
						contextEpoch: 2,
						contextEpochReason: "task_switch",
					},
				}),
			}),
		);
		const extension = createSessionContextRefreshExtension({
			bridge: {
				sessionId: "agent:managed-room",
				registry: {} as never,
				gatewayUrl: "http://127.0.0.1:8766/api/agent/tool/execute",
				gatewayToken: "test-token",
			},
			getSessionContext: () => "existing context",
			setSessionContext: () => undefined,
			getRoomContext: () => "room context",
			getRoomRecoveryContext: () => "room recovery context",
			setRoomRecoveryContext: () => undefined,
			getRecentMessages: () => [],
			getRoomSkillRecovery: () => undefined,
			getRoomToolRecovery: () => undefined,
			providerContextJournal: new ProviderContextJournal(),
		});
		extension({
			on: (event: string, handler: (value: any, context?: any) => Promise<unknown>) => handlers.set(event, handler),
		} as never);

		await expect(
			handlers.get("session_compact")?.(
				{ compactionEntry: { id: "compaction:wrong-reason", summary: "summary" } },
				{ getSystemPrompt: () => "base prompt" },
			),
		).rejects.toThrow("invalid contextEpochReason");
	});
});
