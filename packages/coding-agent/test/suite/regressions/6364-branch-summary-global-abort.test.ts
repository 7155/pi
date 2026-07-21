import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("branch summary global abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("routes session.abort through the branch-summary cancel registry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let started = () => {};
		const streamStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.session.agent.streamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			started();
			options?.signal?.addEventListener("abort", () => {
				stream.push({
					type: "error",
					reason: "aborted",
					error: fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" }),
				});
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("keep"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));
		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await streamStarted;
		const abort = harness.session.abort();

		const [result] = await Promise.all([navigation, abort]);
		expect(result).toMatchObject({ cancelled: true, aborted: true });
		expect(harness.session.getRuntimeLifecycleSnapshot().lastSettledReceipt).toMatchObject({
			aborted: true,
			pendingOperations: 0,
			operationCounts: { branch_summary: 1 },
		});
	});
});
