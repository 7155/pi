import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { openaiChatGPTProvider, prepareChatGPTPayload } from "../src/providers/openai-chatgpt.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const credential: OAuthCredential = {
	type: "oauth",
	protocol: "siwc-v1",
	issuer: "https://auth.openai.com",
	clientId: "oaiapp_test",
	subject: "sub",
	access: "access-fixture",
	refresh: "refresh-fixture",
	idToken: "id-fixture",
	expires: Date.now() + 3_600_000,
	scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
	sessionState: "active",
};

const catalog = {
	models: [
		{ slug: "fixture-second", display_name: "Second in name, first in catalog", visibility: "list" },
		{ slug: "hidden", display_name: "Hidden", visibility: "hide" },
		{ slug: "gpt-6.1-sol", display_name: "Sol", visibility: "list" },
	],
};
const response = (value: unknown) =>
	new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

async function models() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-chatgpt", async () => credential);
	const store = new InMemoryModelsStore();
	const models = createModels({ credentials, modelsStore: store });
	const provider = openaiChatGPTProvider();
	models.setProvider(provider);
	return { credentials, store, models, provider };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ChatGPT account-entitled public Responses provider", () => {
	it("uses only authenticated models, preserving server names and order", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url, init) => {
				expect(url).toBe("https://api.openai.com/v1/models");
				expect(init?.headers).toEqual({ Authorization: "Bearer access-fixture" });
				return response(catalog);
			}),
		);
		const { models: runtime } = await models();
		expect(runtime.getModels()).toEqual([]);
		expect((await runtime.refresh()).errors.size).toBe(0);
		expect(runtime.getModels().map((model) => [model.id, model.name])).toEqual([
			["fixture-second", "Second in name, first in catalog"],
			["gpt-6.1-sol", "Sol"],
		]);
		expect(runtime.getModels().every((model) => model.baseUrl === "https://api.openai.com/v1")).toBe(true);
	});
	it("never restores a previous account's cached catalog after switching", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(catalog)),
		);
		const { models: runtime, credentials } = await models();
		await runtime.refresh();
		await credentials.modify("openai-chatgpt", async () => ({ ...credential, clientId: "other_client" }));
		expect(await runtime.getAvailable()).toEqual([]);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModels()).toEqual([]);
	});
	it("does not use legacy Codex credentials or unauthorised identity-only tokens", async () => {
		const stub = vi.fn(async () => response(catalog));
		vi.stubGlobal("fetch", stub);
		const { models: runtime, credentials } = await models();
		await credentials.modify("openai-chatgpt", async () => ({ ...credential, protocol: "legacy" }));
		await runtime.refresh();
		expect(stub).not.toHaveBeenCalled();
		expect(runtime.getModels()).toEqual([]);
		await credentials.modify("openai-chatgpt", async () => ({ ...credential, scopes: ["openid"] }));
		await runtime.refresh();
		expect(stub).not.toHaveBeenCalled();
	});
	it("strips unsupported fields after payload hooks and groups local tools", () => {
		const payload = prepareChatGPTPayload({
			model: "fixture",
			stream: false,
			store: true,
			input: [{ type: "message", role: "system", content: "instructions" }],
			max_output_tokens: 100,
			temperature: 0.9,
			prompt_cache_retention: "24h",
			previous_response_id: "other",
			tools: [{ type: "function", name: "local" }],
		});
		expect(payload).toEqual({
			model: "fixture",
			stream: true,
			store: false,
			input: [{ type: "message", role: "developer", content: "instructions" }],
			tools: [
				{
					type: "namespace",
					name: "functions",
					description: "Local application tools",
					tools: [{ type: "function", name: "local" }],
				},
			],
		});
		expect(() => prepareChatGPTPayload({ input: [], tools: [{ type: "tool_search" }] })).toThrow("does not support");
	});
	it.each(["response.completed", "response.incomplete", "response.failed", "interrupted"])(
		"handles %s without mistaking failure for success",
		async (terminal) => {
			let sent: Record<string, unknown> = {};
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url, init) => {
					const address = url instanceof Request ? url.url : String(url);
					if (address.endsWith("/models")) return response(catalog);
					expect(address).toBe("https://api.openai.com/v1/responses");
					sent = JSON.parse(String(init?.body));
					const event = {
						type: terminal,
						response: {
							id: "r",
							status: terminal.split(".")[1],
							output: [],
							incomplete_details: { reason: "max_output_tokens" },
							error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached" },
						},
					};
					return new Response(
						terminal === "interrupted"
							? "data: [DONE]\n\n"
							: `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
						{ status: 200, headers: { "Content-Type": "text/event-stream" } },
					);
				}),
			);
			const { models: runtime, provider } = await models();
			await runtime.refresh();
			const model = runtime.getModels()[0] as Model<"openai-responses">;
			const stream = provider.stream(
				{ ...model, baseUrl: "https://must-not-receive-token.invalid" },
				normalizeContext({
					messages: [{ role: "user", content: "fixture", timestamp: 1 }],
				}),
				{
					apiKey: "access-fixture",
					maxTokens: 99,
					onPayload: (body) => ({ ...(body as object), store: true, temperature: 1 }),
				},
			);
			const result = await stream.result();
			expect(sent.stream).toBe(true);
			expect(sent.store).toBe(false);
			expect(sent).not.toHaveProperty("max_output_tokens");
			expect(sent).not.toHaveProperty("temperature");
			expect(result.stopReason).toBe(terminal === "response.completed" ? "stop" : "error");
			if (terminal === "response.failed")
				expect(result.errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
			if (terminal === "response.failed") {
				expect(isRetryableAssistantError({ ...result, errorMessage: `HTTP 429 ${result.errorMessage}` })).toBe(
					false,
				);
				expect(
					isRetryableAssistantError({ ...result, errorMessage: "subscription_sharing_usage_unavailable" }),
				).toBe(true);
			}
		},
	);
});
