#!/usr/bin/env node
import { createInterface } from "node:readline";
import { errorResponse, parseRuntimeRequest, successResponse } from "./protocol.ts";
import { RagImeRuntimeHost, runtimeHostOptionsFromEnvironment } from "./runtime-host.ts";

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
	const host = await RagImeRuntimeHost.create(runtimeHostOptionsFromEnvironment(output));
	let chain = Promise.resolve();
	const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
	reader.on("line", (line) => {
		chain = chain.then(async () => {
			let id = "";
			try {
				const value: unknown = JSON.parse(line);
				if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string")
					id = value.id;
				const request = parseRuntimeRequest(value);
				output(successResponse(request.id, await host.handle(request)));
			} catch (error) {
				output(errorResponse(id, error));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		reader.on("close", resolve);
		reader.on("error", reject);
	});
	await chain;
	await host.dispose();
}

void main().catch((error) => {
	process.stderr.write(`rag-ime-runtime-host: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
