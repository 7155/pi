import { parentPort, workerData } from "node:worker_threads";
import type { WorkerData, WorkerToHostMessage } from "../../src/runtime/protocol.ts";

// Deliberately bypass the production worker's budget to exercise the host's independent guard.
const data = workerData as WorkerData;
for (const message of JSON.parse(data.code) as WorkerToHostMessage[]) parentPort?.postMessage(message);
