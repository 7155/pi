import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseRuntimeRequest, RuntimeProtocolError } from "../src/protocol.ts";

describe("runtime protocol", () => {
	it("accepts versioned plugin and session methods", () => {
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-1",
				method: "plugins.create",
				params: {},
			}),
		).toMatchObject({ id: "request-1", method: "plugins.create" });
	});

	it("rejects unknown or unversioned requests", () => {
		expect(() => parseRuntimeRequest({ id: "request-1", method: "hello" })).toThrow(RuntimeProtocolError);
		expect(() =>
			parseRuntimeRequest({ protocolVersion: PROTOCOL_VERSION, id: "request-1", method: "session.destroy" }),
		).toThrow("Unknown runtime method");
	});
});
