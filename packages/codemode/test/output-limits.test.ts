import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox, type CodemodeSandboxOptions } from "../src/index.ts";
import type { WorkerToHostMessage } from "../src/runtime/protocol.ts";

const sandboxes: CodemodeSandbox[] = [];

function createSandbox(options: CodemodeSandboxOptions = {}): CodemodeSandbox {
	const sandbox = new CodemodeSandbox({ timeoutMs: 5_000, memoryLimitBytes: 8 * 1024 * 1024, ...options });
	sandboxes.push(sandbox);
	return sandbox;
}

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("output limits", () => {
	it("accepts zero budgets without silently dropping attempted output", async () => {
		const sandbox = createSandbox({ maxOutputBytes: 0, maxOutputItems: 0 });
		expect(await sandbox.execute("await null;")).toMatchObject({ ok: true, output: [] });
		for (const code of ['text("");', "return 0;"]) {
			expect(await sandbox.execute(code)).toMatchObject({ ok: false, error: { kind: "limit" }, output: [] });
		}
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid limits: %s",
		(value) => {
			expect(() => new CodemodeSandbox({ maxOutputBytes: value })).toThrow(/maxOutputBytes/);
			expect(() => new CodemodeSandbox({ maxOutputItems: value })).toThrow(/maxOutputItems/);
		},
	);

	it("bounds repeated output independently of the VM heap and keeps the accepted prefix", async () => {
		const sandbox = createSandbox({ maxOutputBytes: 4096 });
		const result = await sandbox.execute('const part = "x".repeat(1024); for (let i = 0; i < 16; i++) text(part);');
		expect(result).toMatchObject({ ok: false, error: { kind: "limit", message: expect.stringContaining("4096") } });
		expect(result.output).toEqual(Array.from({ length: 4 }, () => ({ type: "text", text: "x".repeat(1024) })));
	});

	it("bounds empty output items even when byte usage is zero", async () => {
		const result = await createSandbox({ maxOutputItems: 8 }).execute(
			'for (let i = 0; i < 100; i++) console.log("");',
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit", message: expect.stringContaining("8") } });
		expect(result.output).toHaveLength(8);
	});

	it("rejects a single oversized value without losing earlier output", async () => {
		const result = await createSandbox({ maxOutputBytes: 1024 }).execute(
			'text("before"); text("x".repeat(128 * 1024));',
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [{ type: "text", text: "before" }] });
	});

	it("counts UTF-8 bytes, including surrogate pairs, exactly at the boundary", async () => {
		const sandbox = createSandbox({ maxOutputBytes: 10 });
		expect(await sandbox.execute('text("中😀abc");')).toMatchObject({
			ok: true,
			output: [{ type: "text", text: "中😀abc" }],
		});
		const result = await sandbox.execute('text("中😀abc"); text("é");');
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit" },
			output: [{ type: "text", text: "中😀abc" }],
		});
	});

	it("shares the byte budget across text, image data and MIME types", async () => {
		const result = await createSandbox({ maxOutputBytes: 22 }).execute(
			'text("x"); image("data:image/png;base64,iVBORw0KGgo="); image("data:image/png;base64,iVBORw0KGgo=");',
		);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit" },
			output: [
				{ type: "text", text: "x" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
	});

	it("counts serialized return values in the same output budget", async () => {
		const result = await createSandbox({ maxOutputBytes: 32 }).execute('text("prefix"); return "x".repeat(64);');
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [{ type: "text", text: "prefix" }] });
	});

	it.each([
		'throw new Error("x".repeat(128 * 1024));',
		'image("data:image/png;base64,iVBORw0KGgoA" + "QUJD".repeat(32 * 1024));',
		'return { value: "x".repeat(128 * 1024) };',
	])("bounds oversized non-text payloads: %s", async (code) => {
		const result = await createSandbox({ maxOutputBytes: 1024 }).execute(`text("prefix"); ${code}`);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ error: { kind: "limit" }, output: [{ type: "text", text: "prefix" }] });
	});

	it("does not let prototype changes bypass native accounting", async () => {
		const result = await createSandbox({ maxOutputBytes: 8 }).execute(`
			String.prototype.charCodeAt = () => 0;
			String.prototype.toString = () => "";
			text("中😀abc");
		`);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [] });
	});

	it("cannot catch an overrun and turn the run into success or more host calls", async () => {
		let called = false;
		const sandbox = createSandbox({
			maxOutputBytes: 8,
			tools: [
				{
					name: "late",
					execute: () => {
						called = true;
					},
				},
			],
		});
		const result = await sandbox.execute(
			'text("before"); try { text("too much"); } catch {} tools.late(); return "ok";',
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [{ type: "text", text: "before" }] });
		expect(called).toBe(false);
	});

	it("aborts tools already started when output exceeds its budget", async () => {
		let aborted = false;
		const sandbox = createSandbox({
			maxOutputItems: 2,
			tools: [
				{
					name: "slow",
					execute: (_args, { signal }) =>
						new Promise((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve(undefined);
								},
								{ once: true },
							);
						}),
				},
			],
		});
		const result = await sandbox.execute('tools.slow(); text("one"); text("two"); text("three");');
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit" },
			calls: [{ name: "slow", status: "cancelled" }],
		});
		expect(aborted).toBe(true);
	});
});

describe("host receive limits", () => {
	it.each([
		{ maxOutputBytes: 6, messages: [{ type: "output", item: { type: "text", text: "large" } }] },
		{ maxOutputItems: 1, messages: [{ type: "output", item: { type: "text", text: "" } }] },
		{ maxOutputBytes: 6, messages: [{ type: "done", ok: true, value: '"large"', writes: "[]" }] },
		{ maxOutputBytes: 6, messages: [{ type: "done", ok: false, error: '{"message":"large"}' }] },
	])("independently rejects over-budget producer messages: %j", async ({ messages, ...options }) => {
		const sandbox = createSandbox({ ...options, workerUrl: new URL("./fixtures/output-worker.ts", import.meta.url) });
		const script: WorkerToHostMessage[] = [
			{ type: "output", item: { type: "text", text: "before" } },
			...(messages as WorkerToHostMessage[]),
			{ type: "done", ok: true, value: undefined, writes: "[]" },
		];
		const result = await sandbox.execute(JSON.stringify(script));
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [{ type: "text", text: "before" }] });
	});
});
