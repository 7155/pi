import { describe, expect, it } from "vitest";
import {
	appendBounded,
	mapLimit,
	operationalPrompt,
	parseEvent,
	piInvocation,
	taskWithRuntimeDefaults,
	truncateUtf8,
} from "../pi-packages/subagent/index.ts";

describe("Subagent Pi Package bounds", () => {
	it("keeps UTF-8 output valid while reporting omitted bytes", () => {
		const tail = appendBounded("前缀-", "🙂🙂结果", 12);
		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(12);
		expect(tail).not.toContain("�");

		const truncated = truncateUtf8("结论🙂证据🙂完成", 13);
		expect(Buffer.byteLength(truncated.text, "utf8")).toBeLessThanOrEqual(13);
		expect(truncated.text).not.toContain("�");
		expect(truncated.omittedBytes).toBeGreaterThan(0);
	});

	it("preserves result order while enforcing concurrency", async () => {
		let active = 0;
		let peak = 0;
		const results = await mapLimit([30, 5, 15, 1], 2, async (delay, index) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, delay));
			active -= 1;
			return index;
		});
		expect(results).toEqual([0, 1, 2, 3]);
		expect(peak).toBe(2);
	});

	it("treats responsibilities as execution contracts rather than personas", () => {
		const prompt = operationalPrompt({ task: "Inspect the plugin lifecycle", responsibility: "review" });
		expect(prompt).toContain("Responsibility: review");
		expect(prompt).toContain("Do not change files");
		expect(prompt).not.toMatch(/persona|澄·远/iu);
	});

	it("launches the bundled Pi CLI instead of recursively invoking the managed Runtime Host", () => {
		const currentScript = "/managed/runtime-host/cli.mjs";
		const expectedCli = "/managed/runtime-host/pi-cli.mjs";
		const invocation = piInvocation(["--mode", "json", "-p", "task"], {
			currentScript,
			execPath: "/managed/bin/node",
			pathExists: (path) => path === currentScript || path === expectedCli,
		});

		expect(invocation).toEqual({
			command: "/managed/bin/node",
			args: [expectedCli, "--mode", "json", "-p", "task"],
		});
	});

	it("locates the bundled Pi CLI from the installed Package when argv points at a loader", () => {
		const currentScript = "/managed/runtime-host/extension-loader.mjs";
		const modulePath = "/managed/pi-packages/subagent/extension-0.js";
		const expectedCli = "/managed/runtime-host/pi-cli.mjs";
		const invocation = piInvocation(["--mode", "json", "-p", "task"], {
			currentScript,
			execPath: "/managed/bin/node",
			modulePath,
			pathExists: (path) => path === currentScript || path === expectedCli,
		});

		expect(invocation).toEqual({
			command: "/managed/bin/node",
			args: [expectedCli, "--mode", "json", "-p", "task"],
		});
	});

	it("fails closed when a managed Runtime Host has no bundled Pi CLI", () => {
		const currentScript = "/managed/runtime-host/cli.mjs";
		expect(() =>
			piInvocation(["--mode", "json"], {
				currentScript,
				execPath: "/managed/bin/node",
				pathExists: (path) => path === currentScript,
			}),
		).toThrow(/missing bundled Pi CLI/u);
	});

	it("keeps a child Provider failure visible instead of reporting no output", () => {
		expect(
			parseEvent(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "gpt-test",
						stopReason: "error",
						errorMessage: "Provider unavailable",
					},
				}),
			),
		).toEqual({ model: "gpt-test", stopReason: "error", error: "Provider unavailable" });
	});

	it("inherits the parent model and thinking level unless the task overrides them", () => {
		expect(
			taskWithRuntimeDefaults(
				{ task: "inspect" },
				{ provider: "openai-codex", id: "gpt-5.4" },
				"high",
			),
		).toMatchObject({ model: "openai-codex/gpt-5.4", thinking: "high" });
		expect(
			taskWithRuntimeDefaults(
				{ task: "inspect", model: "provider/custom", thinking: "minimal" },
				{ provider: "openai-codex", id: "gpt-5.4" },
				"high",
			),
		).toMatchObject({ model: "provider/custom", thinking: "minimal" });
	});
});
