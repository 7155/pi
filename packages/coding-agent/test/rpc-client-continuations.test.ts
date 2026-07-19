import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: Record<string, unknown>) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient structured continuations", () => {
	it("exposes queue listing and every selective cancellation selector", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async (command: Record<string, unknown>) => ({
			type: "response",
			command: command.type,
			success: true,
			data: command.type === "list_continuations" ? [] : { cancelledIds: ["queued"] },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		expect(await client.listContinuations()).toEqual([]);
		expect(await client.cancelContinuation({ continuationId: "queued" }, "user_stop")).toEqual({
			cancelledIds: ["queued"],
		});
		await client.cancelContinuation({ correlationId: "root" });
		await client.cancelContinuation({ generation: 3 });

		expect(send).toHaveBeenNthCalledWith(1, { type: "list_continuations" });
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "cancel_continuation",
			continuationId: "queued",
			reason: "user_stop",
		});
		expect(send).toHaveBeenNthCalledWith(3, {
			type: "cancel_continuation",
			correlationId: "root",
			reason: undefined,
		});
		expect(send).toHaveBeenNthCalledWith(4, {
			type: "cancel_continuation",
			generation: 3,
			reason: undefined,
		});
	});
});
