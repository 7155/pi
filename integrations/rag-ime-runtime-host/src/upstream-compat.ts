import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
	interface AgentSession {
		/**
		 * Compatibility surface retained while the product adapter migrates from
		 * its 0.80 execution-only registry patch to upstream deferred tools.
		 */
		setRegisteredToolExecutionEnabled(enabled: boolean): void;
	}

	interface ModelRuntime {
		/** Re-read models.json and refresh the local model snapshot without network access. */
		reloadConfig(): Promise<void>;
	}
}

const sessionPrototype = AgentSession.prototype as AgentSession & {
	setRegisteredToolExecutionEnabled?: (enabled: boolean) => void;
};

if (typeof sessionPrototype.setRegisteredToolExecutionEnabled !== "function") {
	Object.defineProperty(sessionPrototype, "setRegisteredToolExecutionEnabled", {
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

const modelRuntimePrototype = ModelRuntime.prototype as ModelRuntime & {
	reloadConfig?: () => Promise<void>;
};

if (typeof modelRuntimePrototype.reloadConfig !== "function") {
	Object.defineProperty(modelRuntimePrototype, "reloadConfig", {
		configurable: true,
		writable: true,
		async value(this: ModelRuntime): Promise<void> {
			// Upstream 0.84 folded config reload into refresh(). Product requests
			// must not trigger catalog network traffic, so preserve the old host's
			// deterministic local-refresh behavior explicitly.
			await this.refresh({ allowNetwork: false });
		},
	});
}
