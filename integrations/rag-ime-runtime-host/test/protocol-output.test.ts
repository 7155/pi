import { describe, expect, it } from "vitest";
import { SerializedJsonlOutput } from "../src/protocol-output.ts";

describe("SerializedJsonlOutput", () => {
	it("keeps concurrent large Runtime events and responses as complete ordered JSONL records", async () => {
		const records: string[] = [];
		let activeWrites = 0;
		let maximumActiveWrites = 0;
		const output = new SerializedJsonlOutput((record, callback) => {
			activeWrites += 1;
			maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
			setTimeout(
				() => {
					records.push(record);
					activeWrites -= 1;
					callback();
				},
				record.includes('"event"') ? 5 : 0,
			);
			return undefined;
		});

		const largePayload = "runtime-evidence ".repeat(7_000);
		output.emit({ event: "agent.event", payload: { text: largePayload } });
		output.emit({ id: "request:1", ok: true, result: { status: "accepted" } });
		output.emit({ event: "agent.event", payload: { type: "agent_settled" } });
		await output.settle();

		expect(maximumActiveWrites).toBe(1);
		expect(records).toHaveLength(3);
		expect(records.every((record) => record.endsWith("\n"))).toBe(true);
		expect(records.map((record) => JSON.parse(record))).toEqual([
			{ event: "agent.event", payload: { text: largePayload } },
			{ id: "request:1", ok: true, result: { status: "accepted" } },
			{ event: "agent.event", payload: { type: "agent_settled" } },
		]);
	});
});
