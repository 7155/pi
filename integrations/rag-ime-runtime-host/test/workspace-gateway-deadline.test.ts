import { afterEach, expect, it, vi } from "vitest";
import { BackendToolRegistry, createBackendToolDefinition } from "../src/tool-bridge.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([45, 120])("does not cut off a %s second shell at 30 seconds, but still bounds transport", async (seconds) => {
	vi.useFakeTimers();
	let signal: AbortSignal | null | undefined;
	vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => {
		signal = init.signal;
		return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
	}));
	const tool = createBackendToolDefinition({ sessionId: "deadline-test", registry: new BackendToolRegistry(), gatewayUrl: "http://localhost/tool/execute" }, { name: "workspace_shell", description: "Run a bounded shell", parameters: { type: "object" } });
	const outcome = tool.execute("call-test", { timeoutSeconds: seconds } as never, undefined, undefined, {} as never).catch((error: Error) => error);
	await vi.advanceTimersByTimeAsync(31_000);
	expect(signal?.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(seconds * 1_000);
	expect(signal?.aborted).toBe(true);
	expect(await outcome).toBeInstanceOf(Error);
});

it("still propagates cancellation during a long shell", async () => {
	const caller = new AbortController();
	vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }))));
	const tool = createBackendToolDefinition({ sessionId: "cancel-test", registry: new BackendToolRegistry(), gatewayUrl: "http://localhost/tool/execute" }, { name: "workspace_shell", description: "Run a bounded shell", parameters: { type: "object" } });
	const outcome = tool.execute("call-test", { timeoutSeconds: 120 } as never, caller.signal, undefined, {} as never);
	await Promise.resolve();
	caller.abort(new Error("User cancelled"));
	await expect(outcome).rejects.toThrow("User cancelled");
});
