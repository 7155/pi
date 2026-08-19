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
		value(this: AgentSession, enabled: boolean): void {
			// Pi 0.84 carries newly activated schemas through ToolResultMessage
			// addedToolNames. Preserve the old introspection field for product
			// diagnostics, but do not patch the upstream agent loop or Provider
			// context. Actual disclosure is owned by active tools + addedToolNames.
			const agent = (this as unknown as { agent?: Record<string, unknown> }).agent;
			if (!agent) return;
			agent.resolveToolForExecution = enabled
				? (name: string) => this.getAllTools().find((tool) => tool.name === name)
				: undefined;
		},
	});
}
