import { describe, expect, it } from "vitest";
import { readStrictJsonl, type StrictJsonlReaderOptions } from "../src/jsonl-framing.ts";

async function* chunks(values: Array<Uint8Array | string>): AsyncGenerator<Uint8Array | string> {
	for (const value of values) yield value;
}

async function collect(values: Array<Uint8Array | string>, options?: StrictJsonlReaderOptions): Promise<string[]> {
	const result: string[] = [];
	for await (const line of readStrictJsonl(chunks(values), options)) result.push(line);
	return result;
}

describe("strict JSONL framing", () => {
	it("uses only LF as the delimiter and preserves Unicode separators", async () => {
		const value = JSON.stringify({ message: `before\u2028middle\u2029after` });
		await expect(collect([`${value}\n`])).resolves.toEqual([value]);
		expect(JSON.parse(value)).toEqual({ message: `before\u2028middle\u2029after` });
	});

	it("reassembles fragmented UTF-8 records", async () => {
		const encoded = Buffer.from(`${JSON.stringify({ message: "继续当前任务" })}\n`, "utf8");
		await expect(
			collect([encoded.subarray(0, 7), encoded.subarray(7, 13), encoded.subarray(13)]),
		).resolves.toEqual([JSON.stringify({ message: "继续当前任务" })]);
	});

	it("accepts CRLF and multiple records in one chunk", async () => {
		await expect(collect(["{\"id\":1}\r\n{\"id\":2}\n"])).resolves.toEqual(["{\"id\":1}", "{\"id\":2}"]);
	});

	it("rejects an oversized record before dispatch", async () => {
		await expect(collect(["12345\n"], { maxRecordBytes: 4 })).rejects.toMatchObject({
			code: "RECORD_TOO_LARGE",
		});
	});

	it("rejects an unterminated final record", async () => {
		await expect(collect(["{\"id\":\"partial\"}"])).rejects.toMatchObject({
			code: "TRUNCATED_RECORD",
		});
	});

	it("rejects invalid UTF-8 without corrupting it into replacement characters", async () => {
		await expect(collect([Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a])])).rejects.toMatchObject({
			code: "INVALID_UTF8",
		});
	});
});
