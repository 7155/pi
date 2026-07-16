import { describe, expect, it, vi } from "vitest";
import {
	BackendToolRegistry,
	backendToolCatalogRevision,
	backendToolSchemaRevision,
	createBackendToolDefinition,
	diffBackendToolCatalog,
} from "../src/tool-bridge.ts";

function tool(options: {
	name: string;
	description?: string;
	profile?: string;
	risk?: string;
	parameters?: Record<string, unknown>;
}) {
	return {
		name: options.name,
		description: options.description ?? `Run ${options.name}`,
		parameters:
			options.parameters ??
			({
				type: "object",
				properties: {
					query: { type: "string" },
				},
			} as Record<string, unknown>),
		profile: options.profile,
		risk: options.risk,
	};
}

describe("BackendToolRegistry", () => {
	it("canonicalizes manifest and schema ordering for a stable cache prefix", () => {
		const registry = new BackendToolRegistry();
		const first = registry.sync([
			tool({
				name: "zeta.run",
				parameters: {
					properties: { z: { type: "string" }, a: { type: "integer" } },
					type: "object",
				},
			}),
			tool({ name: "alpha.query" }),
		]);
		const firstRevision = registry.revision();
		const firstSchemaRevision = backendToolSchemaRevision(first);

		const second = registry.sync([
			tool({ name: "alpha.query" }),
			tool({
				name: "zeta.run",
				parameters: {
					type: "object",
					properties: { a: { type: "integer" }, z: { type: "string" } },
				},
			}),
		]);

		expect(second.map((item) => item.name)).toEqual(["alpha.query", "zeta.run"]);
		expect(registry.revision()).toBe(firstRevision);
		expect(backendToolSchemaRevision(second)).toBe(firstSchemaRevision);
	});

	it("separates metadata-only permission changes from schema changes", () => {
		const before = [tool({ name: "memory.query", profile: "standard", risk: "read" })];
		const metadataOnly = [tool({ name: "memory.query", profile: "strict", risk: "approval" })];
		const schemaChange = [
			tool({
				name: "memory.query",
				profile: "strict",
				risk: "approval",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			}),
		];

		const metadataDiff = diffBackendToolCatalog(before, metadataOnly);
		expect(metadataDiff.changed).toEqual(["memory.query"]);
		expect(metadataDiff.metadataChanged).toEqual(["memory.query"]);
		expect(metadataDiff.schemaChanged).toEqual([]);
		expect(metadataDiff.previousSchemaRevision).toBe(metadataDiff.schemaRevision);
		expect(metadataDiff.previousRevision).not.toBe(metadataDiff.revision);

		const schemaDiff = diffBackendToolCatalog(metadataOnly, schemaChange);
		expect(schemaDiff.schemaChanged).toEqual(["memory.query"]);
		expect(schemaDiff.previousSchemaRevision).not.toBe(schemaDiff.schemaRevision);
	});

	it("reports additions and removals and reserves runtime discovery names", () => {
		const before = [tool({ name: "memory.query" })];
		const after = [tool({ name: "planning.update" })];

		expect(diffBackendToolCatalog(before, after)).toMatchObject({
			added: ["planning.update"],
			removed: ["memory.query"],
		});
		expect(backendToolCatalogRevision(before)).not.toBe(backendToolCatalogRevision(after));

		const registry = new BackendToolRegistry();
		registry.sync(before);
		expect(registry.active()).toEqual([]);
		expect(registry.activate("memory.query").name).toBe("memory.query");
		expect(registry.active().map((item) => item.name)).toEqual(["memory.query"]);
		registry.sync(after);
		expect(registry.active()).toEqual([]);

		for (const name of ["skill_load", "tool_load"]) {
			expect(() => registry.sync([tool({ name })])).toThrow("Tool name is reserved by the runtime host");
		}
	});

	it("keeps the native approval bridge on a dynamically loaded tool", async () => {
		const waitForDecision = vi.fn(async () => true);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							approvalRequired: true,
							approval: { approvalId: "approval-1", state: "pending" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						approval: {
							approvalId: "approval-1",
							state: "applied",
							receipt: { summary: "设置已应用" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const definition = createBackendToolDefinition(
				{
					sessionId: "session-1",
					registry: new BackendToolRegistry(),
					gatewayUrl: "http://127.0.0.1:8768/api/agent/tool/execute",
					waitForDecision,
				},
				tool({ name: "settings.apply" }),
			);

			const result = await definition.execute(
				"call-1",
				{ query: "apply" } as never,
				undefined,
				undefined,
				{} as never,
			);

			expect(waitForDecision).toHaveBeenCalledWith(
				"approval",
				"approval-1",
				expect.objectContaining({ approvalRequired: true }),
				undefined,
			);
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
				"http://127.0.0.1:8768/api/agent/tool/execute",
				"http://127.0.0.1:8768/api/agent/tool/approval-result",
			]);
			expect(result.details).toMatchObject({
				approvalState: "applied",
				approval: { receipt: { summary: "设置已应用" } },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
