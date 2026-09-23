import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const telemetrySrcIndex = fileURLToPath(new URL("../../packages/telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../../packages/ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../../packages/ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../../packages/ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../../packages/ai/src/providers", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("../../packages/coding-agent/src/index.ts", import.meta.url));
const protocolSrcIndex = fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url));
const clientSrcIndex = fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../../packages/tui/src/index.ts", import.meta.url));

export default defineConfig({
	root: repoRoot,
	test: {
		include: ["integrations/rag-ime-runtime-host/test/**/*.test.ts"],
		setupFiles: ["integrations/rag-ime-runtime-host/test/setup-upstream-compat.ts"],
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: protocolSrcIndex },
			{ find: /^@earendil-works\/pi-client$/, replacement: clientSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
