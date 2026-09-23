import type { ContextProvider } from "../src/context-provider.ts";
import { describe, expect, it } from "vitest";
import { ProductContextProvider } from "../src/product-context-provider.ts";

describe("ProductContextProvider", () => {
	it("maps PAW Room, Memory, and turn inputs into one receipted Pi assembly", async () => {
		const provider = new ProductContextProvider({
			sessionId: "session-1",
			getRunId: () => "turn-1",
			getRoomContext: () => "RoomTask 和 WorkDocument",
			getSessionContext: () => "长期偏好",
			getTurnContext: () => "本轮 Knowledge 检索",
			isRoomBound: () => true,
			now: () => 100,
		});
		const assembled = await provider.assemble({ stage: "turn_start", queryText: "继续实现" });
		expect(assembled.context.roomContext).toContain("RoomTask 和 WorkDocument");
		expect(assembled.context.sessionContext).toContain("长期偏好");
		expect(assembled.context.transientContext).toContain("本轮 Knowledge 检索");
		expect(assembled.receipt.contributions.map((item) => item.providerId)).toEqual([
			"paw.room",
			"paw.session-memory",
			"paw.turn",
		]);
	});

	it("uses recovery as the required Room fallback without injecting it twice", async () => {
		const provider = new ProductContextProvider({
			sessionId: "session-1",
			getRunId: () => "turn-1",
			getRoomContext: () => "",
			getRoomRecoveryContext: () => "恢复后的 RoomTask",
			getSessionContext: () => "",
			getTurnContext: () => "",
			isRoomBound: () => true,
			now: () => 100,
		});
		const assembled = await provider.assemble({ stage: "continuation_resume" });
		expect(assembled.context.roomContext).toContain("恢复后的 RoomTask");
		expect(assembled.context.transientContext).not.toContain("恢复后的 RoomTask");
		expect(assembled.receipt.contributions.map((item) => item.providerId)).toEqual(["paw.room"]);
		expect(assembled.receipt.contributions[0]?.provenance[0]?.sourceId).toBe("paw.room-recovery");
	});

	it("passes query, budget, scope, and cancellation to product-owned providers", async () => {
		let observedQuery = "";
		const knowledge: ContextProvider = {
			descriptor: {
				id: "paw.knowledge",
				version: "1",
				stages: ["turn_start"],
				placement: "turn_context",
				priority: 150,
				minTokens: 0,
				maxTokens: 500,
				failureMode: "optional",
				cacheSegment: "turn",
			},
			read: (request) => {
				observedQuery = request.queryText ?? "";
				expect(request.scopeTags).toMatchObject({ product: "personal-agent-workbench", roomBound: "true" });
				expect(request.allocatedTokens).toBeGreaterThan(0);
				return {
					revision: "knowledge-r3",
					content: "检索结果",
					estimatedTokens: 2,
					fetchedAtMs: 100,
					provenance: [{ sourceId: "knowledge-book:3", sourceRevision: "3" }],
				};
			},
		};
		const provider = new ProductContextProvider({
			sessionId: "session-1",
			getRunId: () => "turn-1",
			getRoomContext: () => "Room",
			getSessionContext: () => "",
			getTurnContext: () => "",
			isRoomBound: () => true,
			additionalProviders: [knowledge],
			now: () => 100,
		});
		const assembled = await provider.assemble({ stage: "turn_start", queryText: "如何继续" });
		expect(observedQuery).toBe("如何继续");
		expect(assembled.context.transientContext).toContain("检索结果");
	});
});
