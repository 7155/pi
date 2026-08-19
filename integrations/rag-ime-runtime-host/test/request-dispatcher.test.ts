import { describe, expect, it } from "vitest";
import type { RuntimeRequest } from "../src/protocol.ts";
import { RuntimeRequestDispatcher } from "../src/request-dispatcher.ts";

function request(id: string, method: RuntimeRequest["method"]): string {
	return JSON.stringify({ protocolVersion: "2", id, method, params: {} });
}

describe("runtime request dispatcher", () => {
	it("keeps abort and snapshot responsive while another command is pending", async () => {
		let releasePrompt: (() => void) | undefined;
		const promptPending = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const output: unknown[] = [];
		const dispatcher = new RuntimeRequestDispatcher(
			{
				async handle(value) {
					if (value.method === "session.prompt") await promptPending;
					return { method: value.method };
				},
			},
			(value) => output.push(value),
		);

		dispatcher.dispatch(request("prompt", "session.prompt"));
		dispatcher.dispatch(request("snapshot", "session.snapshot"));
		dispatcher.dispatch(request("abort", "session.abort"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(output).toMatchObject([
			{ id: "snapshot", ok: true, result: { method: "session.snapshot" } },
			{ id: "abort", ok: true, result: { method: "session.abort" } },
		]);

		releasePrompt?.();
		await dispatcher.settle();
		expect(output.at(-1)).toMatchObject({ id: "prompt", ok: true });
	});

	it("keeps malformed request failures isolated", async () => {
		const output: unknown[] = [];
		const dispatcher = new RuntimeRequestDispatcher(
			{
				async handle() {
					return {};
				},
			},
			(value) => output.push(value),
		);

		dispatcher.dispatch("{not-json");
		dispatcher.dispatch(request("health", "health"));
		await dispatcher.settle();

		expect(output).toHaveLength(2);
		expect(output).toContainEqual(expect.objectContaining({ ok: false }));
		expect(output).toContainEqual(expect.objectContaining({ id: "health", ok: true }));
	});

	it("reports the authoritative upstream Pi baseline in hello responses", async () => {
		const output: unknown[] = [];
		const dispatcher = new RuntimeRequestDispatcher(
			{
				async handle() {
					return {
						protocol: "rag-ime.pi-runtime",
						protocolVersion: "2",
						hostVersion: "1.0.0",
						piVersion: "0.80.7",
					};
				},
			},
			(value) => output.push(value),
		);

		dispatcher.dispatch(request("hello", "hello"));
		await dispatcher.settle();

		expect(output).toEqual([
			expect.objectContaining({
				id: "hello",
				ok: true,
				result: expect.objectContaining({ piVersion: "0.84.2" }),
			}),
		]);
	});
});
