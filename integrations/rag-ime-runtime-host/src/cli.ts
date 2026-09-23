#!/usr/bin/env node
import "./upstream-compat.ts";
import { createDeterministicTestModelRuntime } from "./deterministic-test-adapter.ts";
import { readStrictJsonl } from "./jsonl-framing.ts";
import { SerializedJsonlOutput } from "./protocol-output.ts";
import { RuntimeRequestDispatcher } from "./request-dispatcher.ts";
import { RagImeRuntimeHost, runtimeHostOptionsFromEnvironment } from "./runtime-host.ts";

const protocolOutput = new SerializedJsonlOutput(
	process.stdout.write.bind(process.stdout) as (record: string, callback: (error?: Error | null) => void) => boolean,
);

function output(value: unknown): void {
	protocolOutput.emit(value);
}

async function main(): Promise<void> {
	const options = runtimeHostOptionsFromEnvironment(output);
	if (process.env.RAG_IME_PI_DETERMINISTIC_ADAPTER === "room-v2") {
		options.modelRuntime = await createDeterministicTestModelRuntime();
	}
	const host = await RagImeRuntimeHost.create(options);
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
	await protocolOutput.settle();
}

void main().catch((error) => {
	process.stderr.write(`rag-ime-runtime-host: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
