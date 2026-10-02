import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackendToolBridgeOptions,
	BackendToolRegistry,
	createBackendToolDefinition,
	createProjectedBackendToolDefinition,
	requestProductGateway,
} from "../src/tool-bridge.ts";

function bridgeOptions(): BackendToolBridgeOptions {
	return {
		sessionId: "session-concurrency",
		registry: new BackendToolRegistry(),
		gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
	};
}

function definition(options: BackendToolBridgeOptions, name = "workspace_shell") {
	return createBackendToolDefinition(options, { name, description: `Run ${name}`, parameters: { type: "object" } });
}

function success(): Response {
	return new Response(JSON.stringify({ ok: true, result: { summary: "done" } }));
}

function holdGatewayRequests() {
	const requests: Array<{
		toolCallId: string;
		finish(response?: Response): void;
		fail(error: Error): void;
	}> = [];
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
		const { toolCallId } = JSON.parse(String(init?.body)) as { toolCallId: string };
		const signal = init?.signal;
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => reject(signal?.reason);
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			requests.push({
				toolCallId,
				finish(response = success()) {
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				},
				fail(error) {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return { requests, fetchMock };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("session gateway concurrency", () => {
	it.each([
		{ name: "workspace_read", args: {} },
		{ name: "workspace_shell", args: { command: "true", timeoutSeconds: 120 } },
		{ name: "browser", args: { op: "run" } },
		{ name: "browser", args: { op: "run", timeoutMs: 110_000 } },
		{ name: "room_partner", args: { op: "delegate" } },
		{ name: "room_partner", args: { op: "delegate_batch" } },
	])("keeps $name requests at eight with per-call timeout options ($args)", async ({ name, args }) => {
		let active = 0;
		let maximum = 0;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			return success();
		});
		vi.stubGlobal("fetch", fetchMock);
		const tool = definition(bridgeOptions(), name);
		const pending = Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				tool.execute(`call-${index}`, args as never, undefined, undefined, {} as never),
			),
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toHaveLength(20);
		expect(fetchMock).toHaveBeenCalledTimes(20);
		expect(maximum).toBe(8);
		expect(active).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shares admission across product, projected native, and direct gateway option copies", async () => {
		const options = bridgeOptions();
		options.registry.sync([{ name: "workspace_shell", description: "Run shell", parameters: { type: "object" } }]);
		const native = createProjectedBackendToolDefinition(
			{ ...options },
			{
				definition: { name: "bash", label: "bash", description: "Run shell", parameters: { type: "object" } as never },
				targetToolName: "workspace_shell",
				mapArguments: () => ({ command: "true", timeoutSeconds: 120 }),
			},
		);
		const product = definition({ ...options }, "browser");
		const { requests, fetchMock } = holdGatewayRequests();
		const pending = Promise.all(
			Array.from({ length: 24 }, (_, index) => {
				const callId = `call-${index}`;
				if (index % 3 === 0) return native.execute(callId, {}, undefined, undefined, {} as never);
				if (index % 3 === 1) {
					return product.execute(callId, { op: "run" } as never, undefined, undefined, {} as never);
				}
				return requestProductGateway({ ...options }, "load", { toolCallId: callId }, undefined);
			}),
		);
		for (let batch = 0; batch < 3; batch += 1) {
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock).toHaveBeenCalledTimes((batch + 1) * 8);
			for (const request of requests.slice(batch * 8)) request.finish();
		}
		expect(await pending).toHaveLength(24);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives independent session registries independent capacity, including a reopened session id", async () => {
		const { requests, fetchMock } = holdGatewayRequests();
		const tools = [definition(bridgeOptions()), definition(bridgeOptions())];
		const pending = Promise.all(
			tools.flatMap((tool, session) =>
				Array.from({ length: 8 }, (_, index) =>
					tool.execute(`${session}-${index}`, {}, undefined, undefined, {} as never),
				),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(16);
		for (const request of requests) request.finish();
		expect(await pending).toHaveLength(16);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("removes canceled waiters without dispatching them or losing capacity", async () => {
		const options = bridgeOptions();
		const shell = definition(options);
		const { requests, fetchMock } = holdGatewayRequests();
		const active = Array.from({ length: 8 }, (_, index) =>
			shell.execute(`active-${index}`, {}, undefined, undefined, {} as never),
		);
		const caller = new AbortController();
		const cancelled = definition({ ...options }, "browser")
			.execute("cancelled", { op: "run" } as never, caller.signal, undefined, {} as never)
			.catch((error: unknown) => error);
		const next = shell.execute("next", {}, undefined, undefined, {} as never);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(8);
		caller.abort(new Error("cancel queued request"));
		expect(await cancelled).toEqual(new Error("cancel queued request"));
		requests[0].finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(requests.map((request) => request.toolCallId)).toEqual([
			...Array.from({ length: 8 }, (_, index) => `active-${index}`),
			"next",
		]);
		for (const request of requests.slice(1)) request.finish();
		await Promise.all([...active, next]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["caller abort", "fetch error", "invalid JSON", "gateway error"])(
		"releases active capacity after %s",
		async (failure) => {
			const shell = definition(bridgeOptions());
			const caller = new AbortController();
			const { requests, fetchMock } = holdGatewayRequests();
			const pending = Promise.allSettled(
				Array.from({ length: 9 }, (_, index) =>
					shell.execute(`call-${index}`, {}, index === 0 ? caller.signal : undefined, undefined, {} as never),
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock).toHaveBeenCalledTimes(8);
			if (failure === "caller abort") caller.abort(new Error("cancel active request"));
			else if (failure === "fetch error") requests[0].fail(new Error("gateway unavailable"));
			else if (failure === "invalid JSON") requests[0].finish(new Response("invalid JSON"));
			else requests[0].finish(new Response(JSON.stringify({ ok: false, error: "gateway refused request" })));
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock).toHaveBeenCalledTimes(9);
			for (const request of requests.slice(1)) request.finish();
			const results = await pending;
			expect(results[0].status).toBe("rejected");
			expect(results.slice(1).every((result) => result.status === "fulfilled")).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("keeps each deadline independent while queued and reuses capacity after a timeout", async () => {
		const options = bridgeOptions();
		const room = definition(options, "room_partner");
		const { requests, fetchMock } = holdGatewayRequests();
		const active = Array.from({ length: 8 }, (_, index) =>
			room.execute(`active-${index}`, { op: "delegate" } as never, undefined, undefined, {} as never),
		);
		const queued = definition({ ...options, gatewayTimeoutMs: 10 }, "browser")
			.execute("queued-timeout", { op: "run" } as never, undefined, undefined, {} as never)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(10);
		expect(await queued).toEqual(new Error("Tool gateway request timed out after 10ms"));
		expect(fetchMock).toHaveBeenCalledTimes(8);
		for (const request of requests) request.finish();
		await Promise.all(active);

		const timeout = definition({ ...options, gatewayTimeoutMs: 10 })
			.execute("active-timeout", {}, undefined, undefined, {} as never)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(10);
		expect(await timeout).toEqual(new Error("Tool gateway request timed out after 10ms"));
		const recovery = Array.from({ length: 8 }, (_, index) =>
			room.execute(`recovery-${index}`, { op: "delegate" } as never, undefined, undefined, {} as never),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests.slice(-8).map((request) => request.toolCallId)).toEqual(
			Array.from({ length: 8 }, (_, index) => `recovery-${index}`),
		);
		for (const request of requests.slice(-8)) request.finish();
		await Promise.all(recovery);
		expect(vi.getTimerCount()).toBe(0);
	});
});
