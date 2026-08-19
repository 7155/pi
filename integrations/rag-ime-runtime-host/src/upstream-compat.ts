import { AgentSession } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
	interface AgentSession {
		/**
		 * Compatibility surface retained while the product adapter migrates from
		 * its 0.80 execution-only registry patch to upstream deferred tools.
		 */
		setRegisteredToolExecutionEnabled(enabled: boolean): void;
	}
}

const prototype = AgentSession.prototype as AgentSession & {
	setRegisteredToolExecutionEnabled?: (enabled: boolean) => void;
};

if (typeof prototype.setRegisteredToolExecutionEnabled !== "function") {
	Object.defineProperty(prototype, "setRegisteredToolExecutionEnabled", {
		configurable: true,
		writable: true,
		value(_enabled: boolean): void {
			// Pi 0.84 carries newly activated schemas through ToolResultMessage
			// addedToolNames. The product adapter now emits that field from
			// tool_load, so the old execution-only registry hook is intentionally
			// a no-op on the upstream runtime.
		},
	});
}
