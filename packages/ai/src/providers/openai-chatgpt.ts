import { lazyStream } from "../api/lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import type { Credential } from "../auth/types.ts";
import type { Provider } from "../models.ts";
import type { Model, ProviderRequestOptions } from "../types.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

const RESOURCE = "https://api.openai.com/v1";
const FORBIDDEN_FIELDS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"previous_response_id",
];

function accountKey(credential: Credential | undefined): string | undefined {
	if (
		credential?.type !== "oauth" ||
		credential.protocol !== "siwc-v1" ||
		credential.sessionState !== "active" ||
		!credential.access ||
		typeof credential.clientId !== "string" ||
		typeof credential.subject !== "string" ||
		!Array.isArray(credential.scopes) ||
		!credential.scopes.includes("chatgpt.tokens.use.direct") ||
		!credential.scopes.includes("resource.invoke")
	)
		return undefined;
	return JSON.stringify([credential.clientId, credential.subject]);
}

/** Final public-route guard, after application payload hooks have run. */
export function prepareChatGPTPayload(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid ChatGPT Responses payload");
	const payload = { ...value } as Record<string, unknown>;
	for (const field of FORBIDDEN_FIELDS) delete payload[field];
	payload.store = false;
	payload.stream = true;
	if (!Array.isArray(payload.input)) throw new Error("ChatGPT Responses input must be an array");
	payload.input = payload.input.map((item: unknown) => {
		if (!item || typeof item !== "object") return item;
		const entry = item as Record<string, unknown>;
		if (["tool_search_call", "tool_search_output"].includes(String(entry.type)))
			throw new Error("ChatGPT plan does not support tool_search");
		return entry.role === "system" ? { ...entry, role: "developer" } : item;
	});
	if (Array.isArray(payload.tools)) {
		const functions: unknown[] = [];
		const tools: unknown[] = [];
		for (const tool of payload.tools) {
			if (!tool || typeof tool !== "object") throw new Error("Invalid ChatGPT tool");
			const type = String((tool as Record<string, unknown>).type);
			if (["function", "custom"].includes(type)) functions.push(tool);
			else if (["namespace", "web_search", "web_search_preview"].includes(type)) tools.push(tool);
			else throw new Error(`ChatGPT plan does not support tool type: ${type}`);
		}
		if (functions.length)
			tools.push({ type: "namespace", name: "functions", description: "Local application tools", tools: functions });
		payload.tools = tools;
	}
	return payload;
}

function requestOptions<T extends ProviderRequestOptions>(options: T | undefined): T & ProviderRequestOptions {
	return {
		...options,
		// Never silently retry plan limits or change billing paths.
		maxRetries: 0,
		onPayload: async (payload, model) =>
			prepareChatGPTPayload((await options?.onPayload?.(payload, model)) ?? payload),
	} as T & ProviderRequestOptions;
}

/** Account-entitled dynamic models; the OpenAI API-key catalog is metadata only. */
export function openaiChatGPTProvider(): Provider<"openai-responses"> {
	let models: Model<"openai-responses">[] = [];
	let catalogAccount: string | undefined;
	const api = openAIResponsesApi();
	const canonical = (model: Model<"openai-responses">): Model<"openai-responses"> => ({
		...model,
		provider: "openai-chatgpt",
		baseUrl: RESOURCE,
		api: "openai-responses",
		compat: {
			...model.compat,
			supportsMaxOutputTokens: false,
			supportsLongCacheRetention: false,
			supportsAdditionalTools: true,
			supportsToolSearch: false,
		},
	});
	return {
		id: "openai-chatgpt",
		name: "ChatGPT plan (Sign in with ChatGPT)",
		baseUrl: RESOURCE,
		auth: {
			oauth: lazyOAuth({
				name: "ChatGPT plan",
				isSubscription: true,
				loginLabel: "Continue with ChatGPT",
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		getModels: () => models,
		filterModels: (available, credential) =>
			accountKey(credential) === catalogAccount && catalogAccount ? available : [],
		async refreshModels(context) {
			const key = accountKey(context.credential);
			if (!key) {
				await context.publish({
					persist: null,
					update: () => {
						models = [];
						catalogAccount = undefined;
					},
				});
				return;
			}
			if (!context.allowNetwork) {
				const restored =
					context.stored?.etag === key
						? context.stored.models
								.filter((model) => model.provider === "openai-chatgpt")
								.map((model) => canonical(model as Model<"openai-responses">))
						: [];
				await context.publish({
					update: () => {
						models = restored;
						catalogAccount = key;
					},
				});
				return;
			}
			const token = context.credential?.type === "oauth" ? context.credential.access : "";
			const response = await fetch(`${RESOURCE}/models`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
				redirect: "error",
			});
			if (!response.ok)
				throw new Error(
					`ChatGPT model catalog failed (HTTP ${response.status}); reconnect or check ChatGPT usage settings`,
				);
			const value = (await response.json()) as { models?: unknown };
			if (!Array.isArray(value.models)) throw new Error("Invalid ChatGPT model catalog");
			const refreshed: Model<"openai-responses">[] = [];
			for (const item of value.models) {
				if (!item || typeof item !== "object") continue;
				const entry = item as Record<string, unknown>;
				if (entry.visibility !== "list") continue;
				if (
					typeof entry.slug !== "string" ||
					!entry.slug ||
					typeof entry.display_name !== "string" ||
					!entry.display_name
				)
					throw new Error("Invalid ChatGPT model catalog entry");
				const metadata = Object.values(OPENAI_MODELS).find((model) => model.id === entry.slug);
				refreshed.push(
					canonical({
						...(metadata ?? { reasoning: false, input: ["text"], contextWindow: 16_384, maxTokens: 4_096 }),
						id: entry.slug,
						name: entry.display_name,
						provider: "openai-chatgpt",
						api: "openai-responses",
						baseUrl: RESOURCE,
						// Subscription usage is not an API dollar charge; the UI links to actual plan usage.
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					}),
				);
			}
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now(), etag: key },
				update: () => {
					models = refreshed;
					catalogAccount = key;
				},
			});
		},
		stream: (model, context, options) =>
			lazyStream(model, async () => {
				if (!models.some((item) => item.id === model.id))
					throw new Error("Refresh the selected ChatGPT account's model catalog first");
				return api.stream(canonical(model), context, requestOptions(options));
			}),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => {
				if (!models.some((item) => item.id === model.id))
					throw new Error("Refresh the selected ChatGPT account's model catalog first");
				return api.streamSimple(canonical(model), context, requestOptions(options));
			}),
	};
}
