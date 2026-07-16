import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeHostOptionsFromEnvironment } from "../src/runtime-host.ts";

describe("runtime host managed skills", () => {
	it("discovers the bundled plugin creator skill", async () => {
		const options = runtimeHostOptionsFromEnvironment(() => undefined);
		const skillPath = options.skillPaths?.find((value) => value.endsWith(join("skills", "rag-ime-plugin-creator")));

		expect(skillPath).toBeTruthy();
		await expect(readFile(join(skillPath!, "SKILL.md"), "utf8")).resolves.toContain("name: rag-ime-plugin-creator");
	});
});
