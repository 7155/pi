import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, type Transport } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RETRY_POLICY, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeMethod } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

type RetrySettings = { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number;
	provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };

function record(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

function transientError() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
}

async function fixture(retry?: RetrySettings, transport?: Transport) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-host-durable-retry-")));
	const agentDir = join(directory, "agent");
	const settingsPath = join(agentDir, "settings.json");
	const writeSettings = async (value: RetrySettings) => {
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ retry: value, transport }));
	};
	if (retry) await writeSettings(retry);
	const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "test-auth.json"), modelsPath: null, allowModelNetwork: false });
	const faux = createFauxCore({ api: "faux:durable-retry", provider: "durable-retry", models: [{ id: "local" }] });
	const model = faux.getModel();
	const providerStream = vi.fn(faux.streamSimple);
	modelRuntime.registerProvider(model.provider, {
		name: "offline retry fixture", baseUrl: "http://localhost.invalid", api: model.api,
		apiKey: "test-only", streamSimple: providerStream,
		models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
			input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
	});
	const hosts: RagImeRuntimeHost[] = [];
	const createHost = async () => {
		const host = await RagImeRuntimeHost.create({ agentDir, sessionDir: join(directory, "sessions"),
			pluginsRoot: join(directory, "plugins"), pluginInbox: join(directory, "inbox"), maxSessions: 2,
			allowedWorkspaceRoots: [directory], modelRuntime, emitEvent: () => undefined });
		hosts.push(host);
		return host;
	};
	const host = await createHost();
	let request = 0;
	const sessionId = "agent:retry-settings";
	const invoke = async (method: RuntimeMethod, params: Record<string, unknown> = {}, target = host) =>
		record(await target.handle({ protocolVersion: "2", id: `retry:${++request}`, method, params: { sessionId, ...params } }));
	const open = async (target = host) => record((await invoke("session.open", { cwd: directory, runtimeEngine: "durable",
		durableStoreRef: join(directory, "sessions", "durable", sessionId), provider: model.provider, modelId: model.id,
		thinkingLevel: "off", codemodeMode: "off", toolManifest: [] }, target)).snapshot);
	const turn = async (clientMessageId = "input:one", message = "one bounded input", target = host) => {
		const ack = await invoke("session.prompt", { message, clientMessageId }, target);
		return invoke("session.await_settled", { turnId: ack.turnId, clientMessageId, timeoutMs: 10_000 }, target);
	};
	return { directory, settingsPath, writeSettings, host, createHost, faux, providerStream, invoke, open, turn,
		close: async () => { await Promise.all(hosts.map(item => item.dispose())); await rm(directory, { recursive: true, force: true }); } };
}

describe("Durable existing native retry settings", () => {
	it("forwards explicit stream settings to generation and compaction without calling the provider during open", async () => {
		const expected = { transport: "sse", timeoutMs: 4321, maxRetries: 0, maxRetryDelayMs: 1234 };
		const f = await fixture({ enabled: false, provider: { timeoutMs: 4321, maxRetries: 0, maxRetryDelayMs: 1234 } }, "sse");
		try {
			const before = await readFile(f.settingsPath, "utf8");
			f.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("summary")]);
			await f.open();
			expect(f.providerStream).not.toHaveBeenCalled();
			await f.turn("history:first", "old durable context ".repeat(5_000));
			await f.turn("history:second", "recent durable context ".repeat(5_000));
			const compact = await f.invoke("session.compact", { instructions: "retain facts" });
			expect(compact).toMatchObject({ outcome: { status: "completed" }, state: { isIdle: true } });
			expect(f.providerStream).toHaveBeenCalledTimes(3);
			for (const call of f.providerStream.mock.calls) expect(call[2]).toMatchObject(expected);
			expect(await readFile(f.settingsPath, "utf8")).toBe(before);
		} finally { await f.close(); }
	});

	it("uses existing trusted project overrides for stream settings", async () => {
		const f = await fixture({ enabled: false, provider: { timeoutMs: 4321, maxRetries: 2 } }, "auto");
		try {
			await mkdir(join(f.directory, ".pi"));
			await writeFile(join(f.directory, ".pi", "settings.json"), JSON.stringify({ transport: "sse", retry: { provider: { maxRetries: 0 } } }));
			f.faux.setResponses([fauxAssistantMessage("project settings applied")]);
			await f.open();
			expect(f.providerStream).not.toHaveBeenCalled();
			await f.turn();
			expect(f.providerStream.mock.calls[0][2]).toMatchObject({ transport: "sse", timeoutMs: 4321, maxRetries: 0 });
		} finally { await f.close(); }
	});

	it("honors explicit retry.enabled=false with one generation attempt and no settings writes", async () => {
		const f = await fixture({ enabled: false, maxRetries: 1, baseDelayMs: 1 });
		try {
			const before = await readFile(f.settingsPath, "utf8");
			f.faux.setResponses([transientError(), fauxAssistantMessage("must not retry")]);
			await f.open();
			const settled = await f.turn();
			expect(f.faux.state.callCount).toBe(1);
			expect(settled).toMatchObject({ receipt: { disposition: "failed" } });
			expect(await readFile(f.settingsPath, "utf8")).toBe(before);
		} finally { await f.close(); }
	});

	it("honors enabled maxRetries=1 as exactly two generation attempts", async () => {
		const f = await fixture({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
		try {
			f.faux.setResponses([transientError(), transientError(), fauxAssistantMessage("must not make a third attempt")]);
			await f.open();
			const settled = await f.turn();
			expect(f.faux.state.callCount).toBe(2);
			expect(settled).toMatchObject({ receipt: { disposition: "failed" } });
		} finally { await f.close(); }
	});

	it("applies the same explicit disable to native compaction retries", async () => {
		const f = await fixture({ enabled: false, maxRetries: 1, baseDelayMs: 1 });
		try {
			f.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), transientError(), fauxAssistantMessage("must not retry summary")]);
			await f.open();
			await f.turn("history:first", "old durable context ".repeat(5_000));
			await f.turn("history:second", "recent durable context ".repeat(5_000));
			const compact = await f.invoke("session.compact", { instructions: "retain facts" });
			expect(f.faux.state.callCount).toBe(3);
			expect(compact).toMatchObject({ outcome: { status: "failed" }, state: { isIdle: true } });
		} finally { await f.close(); }
	});

	it("keeps native default retry semantics when the settings file is absent", async () => {
		const f = await fixture();
		const open = vi.spyOn(Harness, "open");
		try {
			await f.open();
			expect(open).toHaveBeenCalledTimes(1);
			expect({ ...DEFAULT_RETRY_POLICY, ...open.mock.calls[0][1].settings?.retry }).toEqual(DEFAULT_RETRY_POLICY);
			expect(open.mock.calls[0][1].settings?.stream).toEqual({ transport: "auto", timeoutMs: undefined, maxRetries: undefined, maxRetryDelayMs: 60_000 });
			expect(f.faux.state.callCount).toBe(0);
			await expect(readFile(f.settingsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally { open.mockRestore(); await f.close(); }
	});

	it("rereads retry settings on passive reopen and applies them to the same Session's next input", async () => {
		const f = await fixture({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
		try {
			f.faux.setResponses([transientError(), transientError()]);
			const original = await f.open();
			await f.turn();
			expect(f.faux.state.callCount).toBe(2);
			await f.host.dispose();
			await f.writeSettings({ enabled: false, maxRetries: 1, baseDelayMs: 1 });
			const reopened = await f.createHost();
			expect(await f.open(reopened)).toMatchObject({ piSessionId: original.piSessionId, isIdle: true, paused: false });
			expect(f.faux.state.callCount).toBe(2);
			f.faux.setResponses([transientError(), fauxAssistantMessage("must not retry after reopen")]);
			const settled = await f.turn("input:two", "new bounded input", reopened);
			expect(f.faux.state.callCount).toBe(3);
			expect(settled).toMatchObject({ receipt: { disposition: "failed" } });
		} finally { await f.close(); }
	});
});
