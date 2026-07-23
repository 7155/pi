import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { isUpstreamProviderError, rotateProviderSessionAffinity } from "../provider-session-affinity.ts";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

export interface SummarizationRetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		const error = new Error("Compaction cancelled");
		error.name = "AbortError";
		throw error;
	}
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			const error = new Error("Compaction cancelled");
			error.name = "AbortError";
			reject(error);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function completeOnce(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) return completeSimple(model, context, options);
	const stream = await streamFn(model, context, options);
	return stream.result();
}

/** Keep compaction and branch summaries on the same bounded provider retry path. */
export async function completeSummarizationWithRetry(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retryOptions: SummarizationRetryOptions = {},
): Promise<AssistantMessage> {
	const maxRetries = Math.max(0, retryOptions.maxRetries ?? DEFAULT_MAX_RETRIES);
	const baseDelayMs = Math.max(0, retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
	const affinityBase = options.sessionId;
	let requestOptions = options;
	let response = await completeOnce(model, context, requestOptions, streamFn);

	for (let retry = 0; retry < maxRetries && isRetryableAssistantError(response); retry += 1) {
		const delayMs = Math.min(baseDelayMs * 2 ** retry, MAX_DELAY_MS);
		await waitForRetry(delayMs, options.signal);
		if (isUpstreamProviderError(response.errorMessage)) {
			requestOptions = {
				...requestOptions,
				sessionId: rotateProviderSessionAffinity(affinityBase, retry + 1),
			};
		}
		response = await completeOnce(model, context, requestOptions, streamFn);
	}
	return response;
}
