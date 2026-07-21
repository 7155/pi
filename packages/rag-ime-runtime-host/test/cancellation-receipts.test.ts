import { describe, expect, it } from "vitest";
import { pendingRoomCancellationSurfaces, roomCancellationSurfaces } from "../src/cancellation-receipts.ts";

describe("Room cancellation receipts", () => {
	it("keeps pending and failed runtime operations visible instead of claiming termination", () => {
		const surfaces = roomCancellationSurfaces("session:1", ["room-continuation"], {
			schemaVersion: "rag-ime.pi-session-abort-receipt.v1",
			sessionId: "session:1",
			turnId: "turn:1",
			cancelledDecisionIds: [],
			cancelledUIRequestIds: [],
			lifecycle: {
				schemaVersion: "pi.agent-abort-receipt.v1",
				scopeId: "scope:1",
				generation: 2,
				reason: "user_abort",
				cancelledContinuationIds: ["agent-continuation"],
				cancelledOperationIds: ["provider"],
				failedOperationIds: ["tool:1"],
				operations: [
					{ operationId: "provider", kind: "provider", registeredAt: 1 },
					{ operationId: "tool:1", kind: "tool", registeredAt: 2 },
					{ operationId: "auto-compaction", kind: "auto_compaction", registeredAt: 3 },
				],
				pendingOperations: [{ operationId: "auto-compaction", kind: "auto_compaction", registeredAt: 3 }],
				drained: false,
				idle: false,
			},
		});

		expect(surfaces.provider.state).toBe("terminated");
		expect(surfaces.tool.state).toBe("unknown");
		expect(surfaces.compaction.state).toBe("requested");
		expect(surfaces.session.state).toBe("requested");
		expect(surfaces.continuation.targetIds).toEqual(["session:1", "room-continuation", "agent-continuation"]);
		expect(pendingRoomCancellationSurfaces(surfaces)).toEqual(["tool", "compaction", "session"]);
	});
});
