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
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-2",
				method: "session.fork.candidates",
				params: { sessionId: "source" },
			}),
		).toMatchObject({ id: "request-2", method: "session.fork.candidates" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-3",
				method: "session.fork",
				params: { sessionId: "source", targetSessionId: "target", entryId: "entry" },
			}),
		).toMatchObject({ id: "request-3", method: "session.fork" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-4",
				method: "session.commands",
				params: { sessionId: "source" },
			}),
		).toMatchObject({ id: "request-4", method: "session.commands" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-5",
				method: "session.debug.context",
				params: { sessionId: "source", turnId: "turn-1" },
			}),
		).toMatchObject({ id: "request-5", method: "session.debug.context" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-6",
				method: "session.rewind",
				params: { sessionId: "source", entryId: "message-1" },
			}),
		).toMatchObject({ id: "request-6", method: "session.rewind" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-7",
				method: "session.steer",
				params: { sessionId: "source", message: "change direction" },
			}),
		).toMatchObject({ id: "request-7", method: "session.steer" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-8",
				method: "session.follow_up",
				params: { sessionId: "source", message: "continue afterwards" },
			}),
		).toMatchObject({ id: "request-8", method: "session.follow_up" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-9",
				method: "completion.once",
				params: { requestId: "surface-1" },
			}),
		).toMatchObject({ id: "request-9", method: "completion.once" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-10",
				method: "completion.cancel",
				params: { requestId: "surface-1" },
			}),
		).toMatchObject({ id: "request-10", method: "completion.cancel" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-11",
				method: "ui.resolve",
				params: { sessionId: "source", requestId: "ui-1", response: { confirmed: true } },
			}),
		).toMatchObject({ id: "request-11", method: "ui.resolve" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-12",
				method: "room.dispatch",
				params: { sessionId: "target" },
			}),
		).toMatchObject({ id: "request-12", method: "room.dispatch" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-13",
				method: "room.cancel",
				params: { sessionId: "target" },
			}),
		).toMatchObject({ id: "request-13", method: "room.cancel" });
		expect(
			parseRuntimeRequest({
				protocolVersion: PROTOCOL_VERSION,
				id: "request-14",
				method: "session.control_state",
				params: { sessionId: "source" },
			}),
		).toMatchObject({ id: "request-14", method: "session.control_state" });
	});

	it("rejects unknown or unversioned requests", () => {
		expect(() => parseRuntimeRequest({ id: "request-1", method: "hello" })).toThrow(RuntimeProtocolError);
		expect(() =>
			parseRuntimeRequest({ protocolVersion: PROTOCOL_VERSION, id: "request-1", method: "session.destroy" }),
		).toThrow("Unknown runtime method");
	});
});
