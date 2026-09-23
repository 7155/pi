import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ThresholdCompactionContinuationController {
	readonly extension: InlineExtension;
	beginExternalPrompt(): void;
}

export interface ThresholdCompactionContinuationOptions {
	text: string;
	limit?: number;
}

/**
 * Queue one product continuation after Pi completes threshold compaction.
 *
 * Pi 0.84 deliberately owns compaction settlement and no longer exposes the
 * older AgentSession.setThresholdCompactionContinuation() hook. The product
 * continuation therefore lives at the supported extension boundary: the
 * session_compact event queues a hidden follow-up, and AgentSession's native
 * auto-compaction loop observes that queued message before deciding whether to
 * continue.
 */
export function createThresholdCompactionContinuationController(
	options: ThresholdCompactionContinuationOptions,
): ThresholdCompactionContinuationController {
	const text = options.text.trim();
	const limit = options.limit ?? 1;
	if (!text) throw new Error("threshold compaction continuation text must not be empty");
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new Error("threshold compaction continuation limit must be a non-negative safe integer");
	}

	let issued = limit;
	return {
		beginExternalPrompt(): void {
			issued = 0;
		},
		extension: {
			name: "rag-ime-threshold-compaction-continuation",
			hidden: true,
			factory: (pi) => {
				pi.on("session_compact", (event, ctx) => {
					if (event.reason !== "threshold" || event.willRetry || issued >= limit || ctx.hasPendingMessages()) {
						return;
					}
					issued += 1;
					pi.sendMessage(
						{
							customType: "threshold-compaction-continuation",
							content: text,
							display: false,
							details: {
								reason: event.reason,
								continuationNumber: issued,
								continuationLimit: limit,
							},
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				});
			},
		},
	};
}
