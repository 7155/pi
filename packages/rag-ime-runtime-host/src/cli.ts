#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createDeterministicTestModelRuntime } from "./deterministic-test-adapter.ts";
import { RuntimeRequestDispatcher } from "./request-dispatcher.ts";
import { RagImeRuntimeHost, runtimeHostOptionsFromEnvironment } from "./runtime-host.ts";

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
	const options = runtimeHostOptionsFromEnvironment(output);
	if (process.env.RAG_IME_PI_DETERMINISTIC_ADAPTER === "room-v2") {
		options.modelRuntime = await createDeterministicTestModelRuntime();
	}
	const host = await RagImeRuntimeHost.create(options);
	const dispatcher = new RuntimeRequestDispatcher(host, output);
	const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
	reader.on("line", (line) => {
		dispatcher.dispatch(line);
	});
	await new Promise<void>((resolve, reject) => {
		reader.on("close", resolve);
		reader.on("error", reject);
	});
	await dispatcher.settle();
	await host.dispose();
}

void main().catch((error) => {
	process.stderr.write(`rag-ime-runtime-host: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
