import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RuntimeRequest } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

const model: Model<"openai-responses"> = {
	id: "vision-fast",
	name: "Vision Fast",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	thinkingLevelMap: { medium: null, high: null, xhigh: null, max: null },
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

function request(id: string, method: RuntimeRequest["method"], params: Record<string, unknown>): RuntimeRequest {
	return { protocolVersion: PROTOCOL_VERSION, id, method, params };
}

async function fixture(): Promise<{
	host: RagImeRuntimeHost;
	modelRuntime: ModelRuntime;
	root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "rag-ime-stateless-"));
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
		emitEvent: () => undefined,
	});
	return { host, modelRuntime, root };
}

afterEach(() => vi.restoreAllMocks());

describe("stateless completion", () => {
	it("sends one semantic user message without a system prompt, tools, session, images, or cache retention", async () => {
		const { host, modelRuntime, root } = await fixture();
		let capturedContext: Context | undefined;
		let capturedOptions: ModelsSimpleStreamOptions | undefined;
		vi.spyOn(modelRuntime, "completeSimple").mockImplementation(async (_model, context, options) => {
			capturedContext = context;
			capturedOptions = options;
			return assistant();
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

	it("omits reasoning for off and rejects unsupported high thinking", async () => {
		const { host, modelRuntime, root } = await fixture();
		const complete = vi.spyOn(modelRuntime, "completeSimple").mockResolvedValue(assistant());

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
			await expect(
				host.handle(
					request("call-high", "completion.once", {
						requestId: "surface-high",
						provider: "test",
						modelId: model.id,
						thinkingLevel: "high",
						message: "answer once",
					}),
				),
			).rejects.toThrow("only supports off or low");
		} finally {
			await host.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cancels an in-flight one-shot request by request id", async () => {
		const { host, modelRuntime, root } = await fixture();
		vi.spyOn(modelRuntime, "completeSimple").mockImplementation(
			async (_model, _context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(assistant("aborted", "cancelled")), {
						once: true,
					});
				}),
		);

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
			await vi.waitFor(() => expect(modelRuntime.completeSimple).toHaveBeenCalledOnce());
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
