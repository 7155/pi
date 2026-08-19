import { TextDecoder } from "node:util";

export const DEFAULT_MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;

export type StrictJsonlFramingErrorCode = "INVALID_UTF8" | "RECORD_TOO_LARGE" | "TRUNCATED_RECORD";

export class StrictJsonlFramingError extends Error {
	readonly code: StrictJsonlFramingErrorCode;

	constructor(code: StrictJsonlFramingErrorCode, message: string) {
		super(message);
		this.name = "StrictJsonlFramingError";
		this.code = code;
	}
}

export interface StrictJsonlReaderOptions {
	/** Maximum bytes in one record, excluding the LF delimiter. */
	maxRecordBytes?: number;
}

function normalizeMaximum(value: number | undefined): number {
	const maximum = value ?? DEFAULT_MAX_JSONL_RECORD_BYTES;
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new RangeError("maxRecordBytes must be a positive safe integer");
	}
	return maximum;
}

function chunkBytes(chunk: Uint8Array | string): Buffer {
	if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
	return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function decodeRecord(record: Buffer): string {
	const bytes = record.length > 0 && record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new StrictJsonlFramingError("INVALID_UTF8", "JSONL record is not valid UTF-8");
	}
}

/**
 * Read strict JSONL records from a byte stream.
 *
 * Only the LF byte (0x0A) delimits records. A single CR immediately before LF
 * is removed so CRLF senders remain compatible. Unicode line/paragraph
 * separators stay inside the JSON string, unlike Node's readline interface.
 * EOF with an unterminated record is rejected instead of dispatching a partial
 * request.
 */
export async function* readStrictJsonl(
	input: AsyncIterable<Uint8Array | string>,
	options: StrictJsonlReaderOptions = {},
): AsyncGenerator<string> {
	const maximum = normalizeMaximum(options.maxRecordBytes);
	let pending = Buffer.alloc(0);

	for await (const chunk of input) {
		const incoming = chunkBytes(chunk);
		if (incoming.length === 0) continue;
		pending = pending.length === 0 ? Buffer.from(incoming) : Buffer.concat([pending, incoming]);

		let newlineIndex = pending.indexOf(0x0a);
		while (newlineIndex >= 0) {
			if (newlineIndex > maximum) {
				throw new StrictJsonlFramingError(
					"RECORD_TOO_LARGE",
					`JSONL record exceeds ${maximum} bytes`,
				);
			}
			yield decodeRecord(pending.subarray(0, newlineIndex));
			pending = pending.subarray(newlineIndex + 1);
			newlineIndex = pending.indexOf(0x0a);
		}

		if (pending.length > maximum) {
			throw new StrictJsonlFramingError("RECORD_TOO_LARGE", `JSONL record exceeds ${maximum} bytes`);
		}
	}

	if (pending.length > 0) {
		throw new StrictJsonlFramingError("TRUNCATED_RECORD", "JSONL stream ended before the final LF delimiter");
	}
}
