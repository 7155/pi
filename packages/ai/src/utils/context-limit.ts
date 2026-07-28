import type { Api, Context, Model } from "../types.ts";
import { type ContextUsageEstimate, estimateContextTokens } from "./estimate.ts";

/**
 * Refuse an over-window request before auth resolution or network dispatch.
 *
 * Output-token clamping cannot make an already oversized input valid. Returning
 * the normal overflow wording lets higher-level runtimes compact and retry
 * without paying for a Provider request that was guaranteed to fail.
 */
export function assertContextFitsModel(model: Model<Api>, context: Context): ContextUsageEstimate {
	const estimate = estimateContextTokens(context);
	if (model.contextWindow > 0 && estimate.tokens >= model.contextWindow) {
		throw new Error(
			`Estimated input of ${estimate.tokens} tokens exceeds the context window ` +
				`of ${model.contextWindow} tokens for ${model.provider}/${model.id}`,
		);
	}
	return estimate;
}
