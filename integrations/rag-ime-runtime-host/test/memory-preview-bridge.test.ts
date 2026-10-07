import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolArtifactBuffer } from "../src/tool-artifact-buffer.ts";
import { BackendToolRegistry, executeGatewayTool } from "../src/tool-bridge.ts";

// Produced by PAW's real isolated SQLite/Gateway memory preview owner. These
// are synthetic fixture identities, not an installed Session or user data.
const preview = JSON.parse(readFileSync(new URL("./fixtures/memory-governance-preview.json", import.meta.url), "utf8")) as Record<string, unknown>;
const sessionId = String(preview.sessionId);
const manifest = { name: "memory", description: "Governed memory", parameters: { type: "object" } };
const operations = ["remember_preview", "correct_preview", "forget_preview"] as const;

function respond(result: Record<string, unknown>) {
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function execute(result: Record<string, unknown>, options: { name?: string; op?: string; wait?: (kind: "approval" | "review", id: string, details: Record<string, unknown>, signal?: AbortSignal) => Promise<boolean> } = {}) {
	const fetchMock = respond(result);
	const promise = executeGatewayTool({ sessionId, registry: new BackendToolRegistry(), gatewayUrl: "http://gateway.invalid/tool/execute", waitForDecision: options.wait }, { ...manifest, name: options.name ?? "memory" }, "fixture-call", { op: options.op ?? "remember_preview" }, undefined, new ToolArtifactBuffer());
	return { promise, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("typed governed memory previews", () => {
	it.each(operations)("returns %s unchanged without invoking native review or applying", async (operation) => {
		const result: Record<string, unknown> = { ...preview, operation, applyOperation: operation.replace("_preview", "_apply") };
		const wait = vi.fn(async () => true);
		const { promise, fetchMock } = execute(result, { op: operation, wait });
		const returned = await promise;
		expect(JSON.parse(returned.content[0].text)).toEqual(result);
		expect(returned.details).toMatchObject(result);
		expect(result.mutationApplied).toBe(false);
		expect(wait).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not require a decision port for a read-only preview", async () => {
		const { promise } = execute(preview);
		expect((await promise).details).toMatchObject({ proposalId: preview.proposalId, reviewRequired: true, mutationApplied: false });
	});

	it.each([
		{ schemaVersion: "other-preview.v1" },
		{ operation: "correct_preview" },
		{ applyOperation: "forget_apply" },
		{ sessionId: "foreign-session" },
		{ previewId: "foreign-proposal" },
		{ proposalId: "" },
		{ mutationApplied: true },
		{ writes: { proposalStored: true, memoryAtoms: true, memoryBooks: false, retrievalVectors: false } },
		{ audit: { ...(preview.audit as Record<string, unknown>), payloadSha256: "invalid" } },
		{ audit: { ...(preview.audit as Record<string, unknown>), sessionId: "foreign-session" } },
	])("keeps invalid or mismatched proposals on the existing review guard: %j", async (change) => {
		const wait = vi.fn(async () => true);
		await expect(execute({ ...preview, ...change }, { wait }).promise).rejects.toThrow("Product review bridge is unavailable");
		expect(wait).not.toHaveBeenCalled();
	});

	it("does not accept the schema on another tool, apply operation, or wrapper", async () => {
		await expect(execute(preview, { name: "agent_role_book" }).promise).rejects.toThrow("Product review bridge is unavailable");
		await expect(execute(preview, { op: "remember_apply" }).promise).rejects.toThrow("Product review bridge is unavailable");
		await expect(execute({ reviewRequired: true, result: preview }).promise).rejects.toThrow("Product review bridge is unavailable");
	});

	it("still waits for whole-memory review with a valid run, and rejects missing run/port", async () => {
		const wait = vi.fn(async () => false);
		const run = { reviewRequired: true, run: { runId: "curation-run" } };
		const returned = await execute(run, { op: "curation_prepare", wait }).promise;
		expect(wait).toHaveBeenCalledWith("review", "curation-run", run, undefined);
		expect(returned.details).toMatchObject({ reviewState: "deferred", runId: "curation-run" });
		await expect(execute({ reviewRequired: true }, { op: "curation_prepare", wait }).promise).rejects.toThrow("Product review bridge is unavailable");
		await expect(execute(run, { op: "curation_prepare" }).promise).rejects.toThrow("Product review bridge is unavailable");
	});

	it("still requires native approval on apply and never interprets a preview as approval", async () => {
		const approval = { approvalRequired: true, approvalId: "approval-fixture", approval: { approvalId: "approval-fixture", state: "pending", payloadSha256: "a".repeat(64) } };
		await expect(execute(approval, { op: "remember_apply" }).promise).rejects.toThrow("Product approval bridge is unavailable");
		const wait = vi.fn(async () => false);
		const fetchMock = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: approval })))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, approval: { ...approval.approval, state: "rejected" } })));
		vi.stubGlobal("fetch", fetchMock);
		const returned = await executeGatewayTool({ sessionId, registry: new BackendToolRegistry(), gatewayUrl: "http://gateway.invalid/tool/execute", waitForDecision: wait }, manifest, "apply-call", { op: "remember_apply", proposalId: preview.proposalId }, undefined, new ToolArtifactBuffer());
		expect(wait).toHaveBeenCalledWith("approval", "approval-fixture", approval, undefined);
		expect(returned.details).toMatchObject({ approvalState: "rejected" });
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["http://gateway.invalid/tool/execute", "http://gateway.invalid/tool/approval-result"]);
	});
});
