import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	handleLine(line: string): void;
};

function emitSettlementFailure(client: RpcClient, error: string): void {
	(client as unknown as RpcClientPrivate).handleLine(
		JSON.stringify({
			type: "agent_settle_failed",
			error,
		}),
	);
}

describe("RpcClient settlement failure", () => {
	it("rejects waitForIdle immediately instead of timing out", async () => {
		const client = new RpcClient();
		const waiting = client.waitForIdle(10_000);

		emitSettlementFailure(client, "Room Kernel unavailable");

		await expect(waiting).rejects.toThrow("Agent settlement failed: Room Kernel unavailable");
	});

	it("rejects event collection immediately instead of claiming a final", async () => {
		const client = new RpcClient();
		const collecting = client.collectEvents(10_000);

		emitSettlementFailure(client, "Room commit missing");

		await expect(collecting).rejects.toThrow("Agent settlement failed: Room commit missing");
	});
});
