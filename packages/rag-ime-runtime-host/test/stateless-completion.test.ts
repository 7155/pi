import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, type RuntimeRequest } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

const model: Model<"openai-responses"> = {
	id: "vision-fast",
	name: "Vision Fast",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	thinkingLevelMap: { xhigh: null, max: null },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 258_000,
	maxTokens: 8_192,
};

function assistant(stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text: "one-shot result" }] : [],
		api: "openai-responses",
		provider: "test",
		model: model.id,
		usage: {
			input: 10,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 14,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function completedStream({
	message = assistant(),
	reasoning = "",
	textChunks = ["one-shot result"],
}: {
	message?: AssistantMessage;
	reasoning?: string;
	textChunks?: string[];
} = {}): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (reasoning) {
		stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: reasoning, partial: message });
		stream.push({ type: "thinking_end", contentIndex: 0, content: reasoning, partial: message });
	}
	stream.push({ type: "text_start", contentIndex: reasoning ? 1 : 0, partial: message });
	for (const delta of textChunks) {
		stream.push({ type: "text_delta", contentIndex: reasoning ? 1 : 0, delta, partial: message });
	}
	stream.push({
		type: "text_end",
		contentIndex: reasoning ? 1 : 0,
		content: textChunks.join(""),
		partial: message,
	});
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function request(id: string, method: RuntimeRequest["method"], params: Record<string, unknown>): RuntimeRequest {
	return { protocolVersion: PROTOCOL_VERSION, id, method, params };
}

async function fixture(): Promise<{
	host: RagImeRuntimeHost;
	modelRuntime: ModelRuntime;
	root: string;
	events: RuntimeEventEnvelope[];
}> {
	const root = await mkdtemp(join(tmpdir(), "rag-ime-stateless-"));
	const events: RuntimeEventEnvelope[] = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	vi.spyOn(modelRuntime, "reloadConfig").mockResolvedValue(undefined);
	vi.spyOn(modelRuntime, "getAvailable").mockResolvedValue([model]);
	vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([model]);
	const host = await RagImeRuntimeHost.create({
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
		pluginsRoot: join(root, "plugins"),
		pluginInbox: join(root, "plugin-inbox"),
		maxSessions: 2,
		modelRuntime,
		emitEvent: (event) => events.push(event),
	});
	return { host, modelRuntime, root, events };
}

afterEach(() => vi.restoreAllMocks());

describe("stateless completion", () => {
	it("sends one semantic user message without a system prompt, tools, session, images, or cache retention", async () => {
		const { host, modelRuntime, root, events } = await fixture();
		let capturedContext: Context | undefined;
		let capturedOptions: ModelsSimpleStreamOptions | undefined;
		vi.spyOn(modelRuntime, "streamSimple").mockImplementation((_model, context, options) => {
			capturedContext = context;
			capturedOptions = options;
			return completedStream({
				reasoning: "private provider reasoning that must never cross the host boundary",
				textChunks: ["one-", "shot result"],
			});
		});

		try {
			const result = (await host.handle(
				request("call-1", "completion.once", {
					requestId: "surface-1",
					provider: "test",
					modelId: model.id,
					thinkingLevel: "low",
					message: "complete from the semantic context packet",
					timeoutMs: 15_000,
				}),
			)) as Record<string, unknown>;

			expect(result).toMatchObject({
				text: "one-shot result",
				provider: "test",
				modelId: model.id,
				thinkingLevel: "low",
			});
			expect(host.sessions.size).toBe(0);
			expect(capturedContext?.messages).toHaveLength(1);
			expect(capturedContext?.messages[0]).toMatchObject({ role: "user" });
			expect(Object.hasOwn(capturedContext ?? {}, "systemPrompt")).toBe(false);
			expect(Object.hasOwn(capturedContext ?? {}, "tools")).toBe(false);
			expect(capturedOptions).toMatchObject({
				reasoning: "low",
				cacheRetention: "none",
				maxRetries: 0,
				timeoutMs: 15_000,
			});
			expect(Object.hasOwn(capturedOptions ?? {}, "sessionId")).toBe(false);
			expect(events.map((event) => event.payload.type)).toEqual([
				"completion_reasoning_progress",
				"completion_reasoning_progress",
				"completion_text_delta",
				"completion_text_delta",
			]);
			expect(events.map((event) => event.payload.phase).filter(Boolean)).toEqual(["started", "completed"]);
			expect(events.map((event) => event.payload.delta).filter(Boolean)).toEqual(["one-", "shot result"]);
			expect(JSON.stringify(events)).not.toContain("private provider reasoning");
			expect(result.reasoningChars).toBeGreaterThan(0);
			expect(result.firstTokenMs).toBeGreaterThan(0);
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects images on the semantic-only stateless surface", async () => {
		const { host, root } = await fixture();
		try {
			await expect(
				host.handle(
					request("call-image", "completion.once", {
						requestId: "surface-image",
						provider: "test",
						modelId: model.id,
						thinkingLevel: "off",
						message: "semantic only",
						images: [{ mimeType: "image/png", data: "cG5n" }],
					}),
				),
			).rejects.toThrow("does not accept images");
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("omits off, forwards supported thinking, and rejects invalid levels", async () => {
		const { host, modelRuntime, root } = await fixture();
		const complete = vi.spyOn(modelRuntime, "streamSimple").mockImplementation(() => completedStream());

		try {
			await host.handle(
				request("call-off", "completion.once", {
					requestId: "surface-off",
					provider: "test",
					modelId: model.id,
					thinkingLevel: "off",
					message: "answer once",
				}),
			);
			expect(complete.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
			await host.handle(
				request("call-high", "completion.once", {
					requestId: "surface-high",
					provider: "test",
					modelId: model.id,
					thinkingLevel: "high",
					message: "answer once",
				}),
			);
			expect(complete.mock.calls[1]?.[2]?.reasoning).toBe("high");
			await expect(
				host.handle(
					request("call-invalid", "completion.once", {
						requestId: "surface-invalid",
						provider: "test",
						modelId: model.id,
						thinkingLevel: "turbo",
						message: "answer once",
					}),
				),
			).rejects.toThrow("Unsupported thinkingLevel: turbo");
			await expect(
				host.handle(
					request("call-max", "completion.once", {
						requestId: "surface-max",
						provider: "test",
						modelId: model.id,
						thinkingLevel: "max",
						message: "answer once",
					}),
				),
			).rejects.toThrow(`does not support max thinking`);
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cancels an in-flight one-shot request by request id", async () => {
		const { host, modelRuntime, root } = await fixture();
		vi.spyOn(modelRuntime, "streamSimple").mockImplementation((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => {
					const aborted = assistant("aborted", "cancelled");
					stream.push({ type: "error", reason: "aborted", error: aborted });
				},
				{ once: true },
			);
			return stream;
		});

		try {
			const pending = host.handle(
				request("call-pending", "completion.once", {
					requestId: "surface-pending",
					provider: "test",
					modelId: model.id,
					thinkingLevel: "off",
					message: "wait",
				}),
			);
			await vi.waitFor(() => expect(modelRuntime.streamSimple).toHaveBeenCalledOnce());
			await expect(
				host.handle(request("cancel", "completion.cancel", { requestId: "surface-pending" })),
			).resolves.toMatchObject({ cancelled: true });
			await expect(pending).rejects.toThrow("cancelled");
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
