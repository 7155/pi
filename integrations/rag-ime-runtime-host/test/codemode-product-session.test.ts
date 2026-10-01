import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiProductSession } from "../src/pi-session.ts";
import type { RuntimeEventEnvelope } from "../src/protocol.ts";

describe("managed native codemode", () => {
	it.each(["on", "only", "off"] as const)("keeps %s effective in snapshots and forks", async (codemodeMode) => {
		const root = await mkdtemp(join(tmpdir(), "paw-codemode-mode-"));
		let session: PiProductSession | undefined;
		try {
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
			session = await PiProductSession.create({
				externalSessionId: "mode-test", cwd: root, agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"), activePluginDir: join(root, "plugins"),
				skillPaths: [], piSkillPaths: [], codexSkillPaths: [], modelRuntime, codemodeMode,
				toolManifest: [], noContextFiles: true, emitEvent: () => undefined,
			});
			expect(session.openSnapshot()).toMatchObject({ codemodeMode });
			expect(session.forkRuntimeProfile()).toMatchObject({ codemodeMode });
			const active = (session as unknown as { session: { getActiveToolNames(): string[] } }).session.getActiveToolNames();
			expect(active.includes("codemode")).toBe(codemodeMode !== "off");
            for (const mode of ["off", "only", "on"] as const) {
                expect(session.setCodemodeMode(mode)).toEqual({codemodeMode: mode});
                expect(session.openSnapshot()).toMatchObject({codemodeMode: mode});
                expect((session as unknown as {session:{getActiveToolNames():string[]}}).session.getActiveToolNames().includes("codemode")).toBe(mode !== "off");
            }
		} finally {
			await session?.dispose(); await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
        { mode: "on", values: [2, 3], code: "const r = await Promise.all([tools.product_probe({value: 2}), tools.product_probe({value: 3})]); text(r.map(x => JSON.parse(x).value).reduce((a,b) => a+b, 0));", failed: false, requests: 2 },
        { mode: "only", values: [2, 3], code: "const r = await Promise.all([tools.product_probe({value: 2}), tools.product_probe({value: 3})]); text(r.map(x => JSON.parse(x).value).reduce((a,b) => a+b, 0));", failed: false, requests: 2 },
        { mode: "on", values: [-1], code: "await tools.product_probe({value: -1}); text('must not run');", failed: true, requests: 1 },
        { mode: "only", values: ["invalid"], code: "await tools.product_probe({value: 'invalid'}); text('must not run');", failed: true, requests: 0 },
    { mode: "on", values: [999], code: "await tools.product_probe({value:999}); text('must not run');", failed: true, requests: 1, cancel: true },
    ] as const)("keeps $mode nested calls and failure=$failed exact through the original Gateway", async (scenario) => {
        const codemodeMode = scenario.mode;
		const root = await mkdtemp(join(tmpdir(), "paw-codemode-gateway-"));
		const sessionDir = join(root, "sessions");
		await mkdir(sessionDir, { recursive: true });
		let session: PiProductSession | undefined;
		const events: RuntimeEventEnvelope[] = [];
		const requests: Record<string, unknown>[] = [];
		let concurrent = 0, maxConcurrent = 0;
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.tool !== "product_probe") return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
			requests.push(body); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
			if ((body.args as {value:number}).value === 999) {
                await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => { concurrent--; reject(new DOMException("Aborted", "AbortError")); }, {once: true}));
            }
            await new Promise(resolve => setTimeout(resolve, 20)); concurrent--;
			return new Response(JSON.stringify((body.args as {value:number}).value === -1 ? {ok:false,error:"probe failed"} : { ok: true, result: { value: (body.args as { value: number }).value } }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
			const faux = createFauxCore({ api: "faux:paw-codemode", provider: "paw-codemode-test", models: [{ id: "test" }] });
			const model = faux.getModel();
			const declared: string[][] = [];
			faux.setResponses([
				context => {
					declared.push(getCurrentTools(context.messages).map(tool => tool.name));
					return fauxAssistantMessage(fauxToolCall("codemode", { code: scenario.code }, { id: "ptc-parent" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);
			modelRuntime.registerProvider("paw-codemode-test", { name: "test", baseUrl: "http://localhost.invalid", api: model.api,
				apiKey: "test-only", streamSimple: faux.streamSimple,
				models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input,
					cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
			});
			session = await PiProductSession.create({
				externalSessionId: "ptc-managed-test", cwd: root, agentDir: join(root, "agent"), sessionDir,
				activePluginDir: join(root, "plugins"), skillPaths: [], piSkillPaths: [], codexSkillPaths: [],
				modelRuntime, provider: "paw-codemode-test", modelId: "test", codemodeMode,
				toolGatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
				toolManifest: [{ name: "product_probe", description: "Probe the governed Gateway.", alwaysAvailable: true,
					parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }],
				noContextFiles: true, emitEvent: event => events.push(event),
			});
			const turn = await session.prompt({ message: "run the code", clientMessageId: "ptc-test-request" });
			if ("cancel" in scenario) {
                await vi.waitFor(() => expect(requests).toHaveLength(1));
                expect(()=>session!.setCodemodeMode("off")).toThrow("Session must be idle");
                await session.abortExact({turnId: turn.turnId, clientMessageId: "ptc-test-request", cancelId: "cancel-ptc"});
            }
            const settlement = await session.awaitSettled(turn.turnId, { timeoutMs: 10_000 });
            if ("cancel" in scenario) expect(settlement.receipt.aborted).toBe(true);
			expect(settlement.receipt.pendingOperations).toBe(0);
			expect(requests).toHaveLength(scenario.requests);
			expect(maxConcurrent).toBe(scenario.requests);
			expect(requests.map(request => request.toolCallId)).toEqual(scenario.values.slice(0, scenario.requests).map((_, index) => `ptc-parent/${index+1}`));
			expect(requests.every(request => request.sessionId === "ptc-managed-test" && request.tool === "product_probe")).toBe(true);
			expect(declared[0]).toContain("codemode");
			expect(declared[0].includes("product_probe")).toBe(codemodeMode === "on");
			const nested = events.filter(event => event.payload.parentToolCallId === "ptc-parent");
			expect(nested.filter(event => event.payload.type === "tool_execution_start")).toHaveLength(scenario.values.length);
			expect(nested.filter(event => event.payload.type === "tool_execution_end")).toHaveLength(scenario.values.length);
			const snapshot = session.snapshot();
			const file = String(snapshot.sessionFile);
			const restored = SessionManager.open(file, sessionDir, root).buildSessionContext().messages;
			const result = restored.find(message => message.role === "toolResult" && message.toolCallId === "ptc-parent");
            expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: scenario.failed,
                nestedCalls: { complete: true, calls: scenario.values.map((value, index) => ({id: `ptc-parent/${index+1}`,name:"product_probe",arguments:{value},status:scenario.failed ? "error" : "ok"})) } });
            if (result?.role === "toolResult") {
                const output = result.content.filter(block => block.type === "text").map(block=>block.text).join("\n");
                expect(output).not.toContain("must not run");
                if (!scenario.failed) expect(output).toContain("5");
                else if (!("cancel" in scenario)) expect(output).toContain("Script failed");
            }
		} finally {
			await session?.dispose(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
		}
	});
});
