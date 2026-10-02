import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { Api, Model } from "../src/types.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("registers the default Kimi K3 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("together", "moonshotai/Kimi-K3");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const gptOss = getModel("together", "openai/gpt-oss-120b");
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const minimax = getModel("together", "MiniMaxAI/MiniMax-M2.7");
		expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(minimax.compat?.thinkingFormat).toBeUndefined();
		expect(minimax.compat?.supportsReasoningEffort).toBe(false);
	});

	it("preserves legacy DeepSeek effort generation when the live catalog retires its ID", () => {
		// Hydration follows today's catalog; test the legacy override against fixed input.
		const root = mkdtempSync(join(tmpdir(), "pi-together-generation-"));
		try {
			const preload = join(root, "catalog.mjs");
			const output = join(root, "catalog");
			writeFileSync(
				preload,
				`globalThis.fetch = async (input) => {
				  const url = String(input);
				  if (url === "https://models.dev/api.json") return Response.json({ together: { models: {
				    "deepseek-ai/DeepSeek-V4-Pro": { name: "DeepSeek", tool_call: true, reasoning: true }
				  } } });
				  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000, output: 0 } } });
				  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });
				  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });
				  throw new Error(\`Unexpected fetch: \${url}\`);
				};`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preload).href,
					"scripts/generate-models.ts",
					"--json-only",
					"--json-output",
					output,
				],
				{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const models = JSON.parse(readFileSync(join(output, "providers/together.json"), "utf8")) as Record<
				string,
				Model<Api>
			>;
			const deepSeekV4 = models["deepseek-ai/DeepSeek-V4-Pro"];
			expect(deepSeekV4.thinkingLevelMap).toEqual({
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
			});
			expect(deepSeekV4.compat).toMatchObject({
				supportsReasoningEffort: true,
				thinkingFormat: "together",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
