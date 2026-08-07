import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseRuntimeRequest } from "../src/protocol.ts";

describe("Pi Runtime SDK v2 protocol compatibility", () => {
	it("accepts the additive session.await_settled method on protocol v2", () => {
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-1",
				method: "session.await_settled",
				params: { sessionId: "session-1", turnId: "turn-1", timeoutMs: 600_000 },
			}),
		).toMatchObject({
			method: "session.await_settled",
			params: { sessionId: "session-1", turnId: "turn-1", timeoutMs: 600_000 },
		});
	});

	it("does not change the wire protocol version for an additive capability", () => {
		expect(PROTOCOL_VERSION).toBe("2");
	});
});
