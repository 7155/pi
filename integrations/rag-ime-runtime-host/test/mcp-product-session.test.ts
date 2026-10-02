import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";

describe("managed native MCP inspection", () => {
	it.each(["direct", "codemode", "deferred"] as const)("calls a real stdio MCP tool through the native %s pipeline", async (exposure) => {
		const root = await mkdtemp(join(tmpdir(), "paw-mcp-call-"));
		let session: PiProductSession | undefined;
		try {
			const agentDir = join(root, "agent"); await mkdir(agentDir);
			await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
				fixture: { command: process.execPath, args: [resolve("packages/mcp/test/fixtures/stdio-server.mjs")], exposure },
			} }));
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
			const faux = createFauxCore({ api: "faux:paw-mcp", provider: "paw-mcp-test", models: [{ id: "test" }] });
			const model = faux.getModel();
			faux.setResponses([
				...(exposure === "deferred" ? [fauxAssistantMessage(fauxToolCall("tool_search", {query:"fixture echo"}, {id:"mcp-search"}), {stopReason:"toolUse"})] : []),
				fauxAssistantMessage(fauxToolCall(exposure !== "codemode" ? "mcp__fixture__echo" : "codemode",
					exposure !== "codemode" ? { text: "mcp-value" } : { code: 'await searchTools("echo", {namespace:"mcp__fixture"}); text(await tools.mcp__fixture__echo({text:"mcp-value"}));' },
					{ id: "mcp-parent" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			modelRuntime.registerProvider("paw-mcp-test", { name: "test", baseUrl: "http://localhost.invalid", api: model.api,
				apiKey: "test-only", streamSimple: faux.streamSimple, models: [{ id: model.id, name: model.name, api: model.api,
					reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] });
			session = await PiProductSession.create({ externalSessionId: "mcp-call", cwd: root, agentDir,
				sessionDir: join(root, "sessions"), activePluginDir: join(root, "plugins"), skillPaths: [], piSkillPaths: [], codexSkillPaths: [],
				modelRuntime, provider: "paw-mcp-test", modelId: "test", toolManifest: [], nativeMcpExecutionAllowed: true, noContextFiles: true, emitEvent: () => undefined });
			await expect.poll(() => session?.nativeCapabilities().mcp, { timeout: 5_000 }).toMatchObject({
				servers: [{ name: "fixture", state: "connected", toolCount: 1 }],
			});
			expect(session.listTools().find(tool => tool.name === "mcp__fixture__echo")).toMatchObject({ exposure: exposure === "codemode" ? "deferred" : exposure, routable: true, namespace: { name: "mcp__fixture" } });
			expect(session.nativeCapabilities().tools).toMatchObject([{ name: "mcp__fixture__echo", exposure }]);
			if (exposure === "codemode") {
				session.setCodemodeMode("off");
				await session.invokeCommand("/mcp reconnect fixture");
				expect(session.listTools().find(tool => tool.name === "codemode")?.active).toBe(false);
				session.setCodemodeMode("on");
			}
			const turn = await session.prompt({ message: "call echo", clientMessageId: `mcp-${exposure}` });
			const settled = await session.awaitSettled(turn.turnId, { timeoutMs: 10_000 });
			expect(settled.receipt.pendingOperations).toBe(0);
			const messages = (session as unknown as { session: { messages: Array<{ role: string; isError?: boolean; content: unknown }> } }).session.messages;
			const results = messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(exposure === "deferred" ? 2 : 1);
			expect(results.every(result => result.isError === false)).toBe(true);
			expect(JSON.stringify(results.at(-1)?.content)).toContain("mcp-value");
			if (exposure === "codemode") {
				expect(results.at(-1)).toMatchObject({ nestedCalls: {
					complete: true,
					calls: [{ name: "mcp__fixture__echo", status: "ok", result: {
						structuredContent: { content: [{ type: "text", text: "mcp-value" }] },
					} }],
				} });
			}
			expect(session.resourceDiagnostics().extensions).toMatchObject({ errors: [] });
		} finally { await session?.dispose(); await rm(root, { recursive: true, force: true }); }
	});
	it("loads native MCP, exposes disabled and failed states without credentials, and never starts a model turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "paw-mcp-inspect-"));
		let session: PiProductSession | undefined;
		try {
			const agentDir = join(root, "agent");
			await mkdir(agentDir);
			await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
				parked: { command: "unused", enabled: false, env: { PRIVATE_TOKEN: "never-public" } },
				broken: { command: "paw-test-missing-mcp-server", exposure: "direct" },
			} }));
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
			session = await PiProductSession.create({ externalSessionId: "mcp-inspect", cwd: root, agentDir,
				sessionDir: join(root, "sessions"), activePluginDir: join(root, "plugins"),
				skillPaths: [], piSkillPaths: [], codexSkillPaths: [], modelRuntime, codemodeMode: "off",
				toolManifest: [], nativeMcpExecutionAllowed: true, noContextFiles: true, emitEvent: () => undefined });
			expect(session.listCommands().some(command => command.name === "mcp")).toBe(true);
			await expect.poll(() => session?.nativeCapabilities().mcp, { timeout: 5_000 }).toMatchObject({
				available: true, servers: [
					{ name: "parked", state: "disabled", exposure: "codemode", toolCount: 0 },
					{ name: "broken", state: "failed", exposure: "direct", toolCount: 0 },
				],
			});
			const snapshot = session.nativeCapabilities();
			expect(snapshot.codemodeMode).toBe("off");
			expect(JSON.stringify(snapshot)).not.toMatch(/never-public|PRIVATE_TOKEN|paw-test-missing-mcp-server|env|headers/u);
			expect(session.listTools().find(tool => tool.name === "codemode")?.active).toBe(false);
			expect(session.listTools().find(tool => tool.name === "tool_search")).toBeDefined();
			expect(session.openSnapshot().activeTurnId).toBeUndefined();
		} finally {
			await session?.dispose(); await rm(root, { recursive: true, force: true });
		}
	});
});
