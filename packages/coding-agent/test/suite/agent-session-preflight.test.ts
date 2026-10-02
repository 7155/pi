import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("AgentSession prompt admission lifecycle", () => {
	it("counts preflight as non-idle and fences cancelled hooks and their late nested prompts", async () => {
		const entered = deferred();
		const release = deferred();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event, ctx) => {
						if (event.prompt !== "old") return;
						signal = ctx.signal;
						entered.resolve();
						await release.promise;
						pi.sendUserMessage("late old continuation");
					});
				},
			],
		});
		let prompt: Promise<void> | undefined;
		let cancellation: Promise<void> | undefined;
		let calls = 0;
		harness.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("new reply");
			},
		]);
		try {
			prompt = harness.session.prompt("old");
			const result = prompt.catch((error) => error);
			await entered.promise;
			expect(harness.session.isIdle).toBe(false);
			let cancelled = false;
			cancellation = harness.session.abort().then(() => {
				cancelled = true;
			});
			await Promise.resolve();
			expect(cancelled).toBe(false);
			expect(signal?.aborted).toBe(true);
			release.resolve();
			expect(await result).toMatchObject({ name: "AbortError" });
			await cancellation;
			expect(harness.session.isIdle).toBe(true);
			expect(calls).toBe(0);
			await harness.session.prompt("new");
			expect(calls).toBe(1);
			expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		} finally {
			release.resolve();
			await prompt?.catch(() => undefined);
			await cancellation;
			harness.cleanup();
		}
	});
});
