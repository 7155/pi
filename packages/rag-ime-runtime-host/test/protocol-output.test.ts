import { describe, expect, it, vi } from "vitest";
import { SerializedJsonlOutput } from "../src/protocol-output.ts";

describe("SerializedJsonlOutput", () => {
	it("does not stringify queued records until the preceding write finishes", async () => {
		const records: string[] = [];
		let finishFirstWrite: (() => void) | undefined;
		const output = new SerializedJsonlOutput((record, callback) => {
			records.push(record);
			if (!finishFirstWrite) {
				finishFirstWrite = () => callback();
			} else {
				callback();
			}
			return false;
		});
		const queuedToJson = vi.fn(() => ({ id: "queued" }));

		output.emit({ id: "active" });
		await vi.waitFor(() => expect(records).toHaveLength(1));
		output.emit({ toJSON: queuedToJson });

		expect(queuedToJson).not.toHaveBeenCalled();
		finishFirstWrite?.();
		await output.settle();
		expect(queuedToJson).toHaveBeenCalledOnce();
		expect(records.map((record) => JSON.parse(record))).toEqual([{ id: "active" }, { id: "queued" }]);
	});

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
