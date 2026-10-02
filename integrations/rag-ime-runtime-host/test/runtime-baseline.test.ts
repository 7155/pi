import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PI_RUNTIME_BASELINE } from "../src/runtime-baseline.ts";

it("keeps the advertised baseline and exact SDK dependency pins aligned", () => {
	const sdk = JSON.parse(
		readFileSync(new URL("../../../packages/coding-agent/package.json", import.meta.url), "utf8"),
	) as { version: string };
	const adapter = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	expect(PI_RUNTIME_BASELINE).toBe(sdk.version);
	expect(adapter.version).toBe(sdk.version);
	expect(adapter.dependencies["@earendil-works/pi-coding-agent"]).toBe(sdk.version);
	expect(adapter.dependencies["@earendil-works/pi-ai"]).toBe(sdk.version);
});
