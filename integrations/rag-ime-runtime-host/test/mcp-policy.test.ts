import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionToolContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";

const MUTATING_SERVER = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.argv[2], "started\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (!("id" in message)) continue;
  let result = {};
  if (message.method === "initialize") result = {
    protocolVersion: "2025-06-18", capabilities: { tools: {} },
    serverInfo: { name: "mutating-fixture", version: "1" },
  };
  if (message.method === "tools/list") result = { tools: [{
    name: "mutate", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
  }] };
  if (message.method === "tools/call") {
    appendFileSync(process.argv[3], "effect\\n");
    result = { content: [{ type: "text", text: "effect recorded" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`;

describe("managed native MCP authority", () => {
	it.each(["direct", "deferred", "codemode"] as const)(
		"enforces deny, grant, revoke and reload for %s tools before effects",
		async (exposure) => {
			const root = await mkdtemp(join(tmpdir(), "paw-mcp-policy-"));
			const agentDir = join(root, "agent");
			const started = join(root, "started");
			const effects = join(root, "effects");
			let session: PiProductSession | undefined;
			try {
				await mkdir(agentDir);
				const server = join(root, "server.mjs");
				await writeFile(server, MUTATING_SERVER);
				await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
					fixture: { command: process.execPath, args: [server, started, effects], exposure },
				} }));
				const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
				const faux = createFauxCore({ api: "faux:mcp-policy", provider: "mcp-policy-test", models: [{ id: "test" }] });
				const model = faux.getModel();
				modelRuntime.registerProvider("mcp-policy-test", {
					name: "test", baseUrl: "http://localhost.invalid", api: model.api, apiKey: "test-only",
					streamSimple: faux.streamSimple, models: [{ ...model }],
				});
				session = await PiProductSession.create({
					externalSessionId: "mcp-policy", cwd: root, agentDir, sessionDir: join(root, "sessions"),
					activePluginDir: join(root, "plugins"), skillPaths: [], piSkillPaths: [], codexSkillPaths: [],
					modelRuntime, provider: "mcp-policy-test", modelId: "test", toolManifest: [],
					// Missing policy must also deny. PAW sends an explicit value.
					noContextFiles: true, emitEvent: () => undefined,
				});
				const attempt = async () => {
					faux.setResponses([
						...(exposure === "deferred" ? [fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture mutate" }), { stopReason: "toolUse" })] : []),
						fauxAssistantMessage(fauxToolCall(
							exposure === "codemode" ? "codemode" : "mcp__fixture__mutate",
							exposure === "codemode" ? { code: 'await searchTools("mutate", {namespace:"mcp__fixture"}); text(await tools.mcp__fixture__mutate({}));' } : {},
						), { stopReason: "toolUse" }), fauxAssistantMessage("done"),
					]);
					const turn = await session!.prompt({ message: "attempt mutation" });
					await session!.awaitSettled(turn.turnId, { timeoutMs: 10_000 });
				};
				await attempt();
				expect(existsSync(started)).toBe(false);
				expect(existsSync(effects)).toBe(false);
				expect(session.nativeCapabilities()).toMatchObject({ mcp: { available: false, policyAllowed: false }, tools: [] });

				await session.syncTools([], true);
				await expect.poll(() => session!.nativeCapabilities().mcp).toMatchObject({ servers: [{ state: "connected" }] });
				await attempt();
				expect(await readFile(effects, "utf8")).toBe("effect\n");
				const owner = (session as unknown as { session: AgentSession }).session;
				const stale = owner.getToolDefinition("mcp__fixture__mutate");
				expect(stale).toBeDefined();
				if (exposure === "direct") {
					const reload = vi.spyOn(owner, "reload").mockRejectedValueOnce(new Error("fixture reload failed"));
					await expect(session.syncTools([], false)).rejects.toThrow("fixture reload failed");
					reload.mockRestore();
				}

				await session.syncTools([], false);
				expect(() => stale!.execute("stale", {}, undefined, undefined, {} as ExtensionToolContext)).toThrow("denied");
				await session.reloadPlugins();
				expect(session.forkRuntimeProfile().nativeMcpExecutionAllowed).toBe(false);
				expect(session.nativeCapabilities()).toMatchObject({ mcp: { available: false }, tools: [] });
				await attempt();
				expect(await readFile(effects, "utf8")).toBe("effect\n");
				expect(await readFile(started, "utf8")).toBe("started\n");

				await session.syncTools([], true);
				await expect.poll(() => session!.nativeCapabilities().mcp).toMatchObject({ servers: [{ state: "connected" }] });
				await attempt();
				expect(await readFile(effects, "utf8")).toBe("effect\neffect\n");
			} finally {
				await session?.dispose();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
