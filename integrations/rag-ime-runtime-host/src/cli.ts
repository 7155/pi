#!/usr/bin/env node
import "./upstream-compat.ts";
import { readStrictJsonl } from "./jsonl-framing.ts";
import { RuntimeRequestDispatcher } from "./request-dispatcher.ts";
import { RagImeRuntimeHost, runtimeHostOptionsFromEnvironment } from "./runtime-host.ts";

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
	const host = await RagImeRuntimeHost.create(runtimeHostOptionsFromEnvironment(output));
	const dispatcher = new RuntimeRequestDispatcher(host, output);
	try {
		for await (const line of readStrictJsonl(process.stdin)) {
			dispatcher.dispatch(line);
		}
		await dispatcher.settle();
	} catch (error) {
		// A framing failure invalidates the whole byte stream. Abort Runtime work
		// first, then wait for request handlers to settle before surfacing it.
		await host.dispose();
		await dispatcher.settle();
		throw error;
	}
	await host.dispose();
}

void main().catch((error) => {
	process.stderr.write(`rag-ime-runtime-host: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
