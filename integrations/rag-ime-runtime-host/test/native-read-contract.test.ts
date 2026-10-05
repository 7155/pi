import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";
import type { BackendToolManifest } from "../src/tool-bridge.ts";

describe("governed read model contract", () => {
	it.each([
		{ mode: "on", deferred: false, paged: false },
		{ mode: "only", deferred: false, paged: false },
		{ mode: "only", deferred: true, paged: false },
		{ mode: "only", deferred: false, paged: true },
	] as const)("exposes the real $mode declaration with deferred=$deferred and paged=$paged", async (scenario) => {
		const root = await mkdtemp(join(tmpdir(), "paw-read-contract-"));
		const sessionDir = join(root, "sessions");
		await mkdir(sessionDir, { recursive: true });
		let session: PiProductSession | undefined;
		const requests: Array<Record<string, unknown>> = [];
		const body = scenario.paged ? '{"value":' : JSON.stringify({ value: 11, label: "[resourceRevision: file-data]" }) + "\n";
		const receipt = {
			content: body, resourceRevision: "fixture-revision", startLine: 1, endLine: 1,
			contentBytes: Buffer.byteLength(body), size: scenario.paged ? 100 : Buffer.byteLength(body),
			lineLayout: "physical_lines", nextLineOffset: scenario.paged ? 2 : null, truncated: scenario.paged,
		};
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			// Session refresh and lifecycle delivery are control requests, not read calls.
			if (request.schemaVersion === "rag-ime.agent-session-context-refresh-request.v1"
				|| request.schemaVersion === "rag-ime.agent-lifecycle-event.v1") {
				return new Response(JSON.stringify({ ok: true, result: {} }), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			expect(request.schemaVersion).toBe("rag-ime.agent-tool-call.v1");
			expect(request.tool).toBe("workspace_files");
			requests.push(request);
			return new Response(JSON.stringify({ ok: true, result: receipt }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false,
			});
			const faux = createFauxCore({
				api: "faux:paw-read-contract", provider: "paw-read-contract-test", models: [{ id: "test" }],
			});
			const model = faux.getModel();
			const declarations: Array<{ name: string; description: string }> = [];
			faux.setResponses([
				context => {
					declarations.push(...getCurrentTools(context.messages).map(tool => ({
						name: tool.name, description: tool.description,
					})));
					return fauxAssistantMessage(fauxToolCall("codemode", {
						code: 'text(await describeTool("read")); text(await tools.read({path:"example.json"}));',
					}, { id: "read-contract-parent" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);
			modelRuntime.registerProvider("paw-read-contract-test", {
				name: "test", baseUrl: "http://localhost.invalid", api: model.api, apiKey: "test-only",
				streamSimple: faux.streamSimple,
				models: [{
					id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
					input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
				}],
			});
			const fileManifest: BackendToolManifest = {
				name: "workspace_files", description: "Governed file fixture", modelVisible: false,
				runtimeProjections: [{ name: "read", operation: "read" }],
				parameters: {
					type: "object",
					oneOf: [{
						type: "object", properties: {
							op: { const: "read" }, path: { type: "string" },
							lineOffset: { type: "integer" }, lineLimit: { type: "integer" },
						}, required: ["op", "path"],
					}],
				},
			};
			// Fill the real inline catalog, while leaving read callable through describeTool.
			const cheapTools: BackendToolManifest[] = scenario.deferred
				? Array.from({ length: 96 }, (_, index) => ({
						name: `probe_${index}`, description: "Probe.", alwaysAvailable: true,
						parameters: { type: "object", properties: {} },
					}))
				: [];
			session = await PiProductSession.create({
				externalSessionId: "read-contract-test", cwd: root, agentDir: join(root, "agent"), sessionDir,
				activePluginDir: join(root, "plugins"), skillPaths: [], piSkillPaths: [], codexSkillPaths: [],
				modelRuntime, provider: "paw-read-contract-test", modelId: "test", codemodeMode: scenario.mode,
				toolGatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
				toolManifest: [fileManifest, ...cheapTools], noContextFiles: true, emitEvent: () => undefined,
			});
			const turn = await session.prompt({ message: "Inspect the read contract", clientMessageId: "contract-request" });
			await session.awaitSettled(turn.turnId, { timeoutMs: 15_000 });
			const codemode = declarations.find(tool => tool.name === "codemode");
			expect(codemode).toBeDefined();
			if (scenario.mode === "on") {
				expect(declarations.find(tool => tool.name === "read")?.description).toContain("[readPage:");
			} else {
				expect(declarations.some(tool => tool.name === "read")).toBe(false);
				if (scenario.deferred) expect(codemode?.description).not.toContain("[readPage:");
				else expect(codemode?.description).toContain("[readPage:");
			}
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				tool: "workspace_files", sessionId: "read-contract-test",
				args: { op: "read", path: "example.json", lineOffset: 1, lineLimit: 2_000 },
			});
			const messages = SessionManager.open(String(session.snapshot().sessionFile), sessionDir, root)
				.buildSessionContext().messages;
			const result = messages.find(message => message.role === "toolResult" && message.toolCallId === "read-contract-parent");
			expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: false });
			if (result?.role !== "toolResult") throw new Error("Missing actual codemode receipt");
			const output = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			// Assert the actual discovery declaration and the actual governed read output, not source text.
			expect(output).toContain("not a content/details object");
			expect(output).toContain("store writes from a failed script are discarded");
			expect(output).toContain("[resourceRevision: fixture-revision]");
			expect(output).toContain(`"truncated":${scenario.paged}`);
			expect(output).toContain(body);
			if (scenario.paged) expect(output).toContain("[Showing lines 1-1. Continue with offset=2.]");
			else expect(output).toContain('"nextLineOffset":null');
		} finally {
			await session?.dispose();
			vi.unstubAllGlobals();
			await rm(root, { recursive: true, force: true });
		}
	});
});
