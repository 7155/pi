import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	AGENT_NATIVE_WORKSPACE_TOOL_NAMES,
	BASH_TOOL_NAME,
	EDIT_TOOL_NAME,
	FIND_TOOL_NAME,
	GREP_TOOL_NAME,
	LS_TOOL_NAME,
	READ_TOOL_NAME,
	WRITE_TOOL_NAME,
} from "./runtime-tool-names.ts";
import { ToolArtifactBuffer } from "./tool-artifact-buffer.ts";
import {
	type BackendToolBridgeOptions,
	type BackendToolManifest,
	createProjectedBackendToolDefinition,
	requestGovernedNativeTargetLoads,
} from "./tool-bridge.ts";
import { isToolResultHandle } from "./tool-result-store.ts";

interface RuntimeProjectionTarget {
	manifest: BackendToolManifest;
	operation: string;
}

const PROJECTED_TOOL_LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
	[READ_TOOL_NAME]: "读取文件",
	[EDIT_TOOL_NAME]: "编辑文件",
	[WRITE_TOOL_NAME]: "写入文件",
	[BASH_TOOL_NAME]: "运行命令",
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function inputRecord(value: unknown): Record<string, unknown> {
	return record(value);
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
	const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.max(1, Math.min(maximum, number));
}

function projectionTarget(
	registry: BackendToolBridgeOptions["registry"],
	runtimeName: string,
): RuntimeProjectionTarget | undefined {
	for (const manifest of registry.list()) {
		const projection = manifest.runtimeProjections?.find((item) => item.name === runtimeName);
		if (projection) return { manifest, operation: projection.operation };
	}
	return undefined;
}

/**
 * The governed workspace mutation targets add a snapshot revision to Pi's
 * native edit/write shape. Derive that exact model schema from the active
 * target manifest so the Agent and gateway cannot drift independently.
 */
function projectionParameters(target: RuntimeProjectionTarget): ToolDefinition["parameters"] {
	const schema = target.manifest.parameters;
	const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
	const branch = branches.find((value) => {
		const properties = record(record(value).properties);
		return record(properties.op).const === target.operation;
	});
	if (!branch) {
		throw new Error(
			`Native workspace projection ${target.manifest.name}.${target.operation} has no parameter branch`,
		);
	}
	const branchRecord = structuredClone(record(branch));
	const properties = {
		...structuredClone(record(schema.properties)),
		...structuredClone(record(branchRecord.properties)),
	};
	delete properties.op;
	const required = [
		...(Array.isArray(schema.required) ? schema.required : []),
		...(Array.isArray(branchRecord.required) ? branchRecord.required : []),
	].filter(
		(value, index, values): value is string =>
			typeof value === "string" && value !== "op" && value in properties && values.indexOf(value) === index,
	);
	delete branchRecord.oneOf;
	return {
		...branchRecord,
		type: "object",
		additionalProperties: branchRecord.additionalProperties ?? schema.additionalProperties ?? false,
		properties,
		...(required.length > 0 ? { required } : {}),
	} as ToolDefinition["parameters"];
}

function nativeWorkspaceTargets(options: BackendToolBridgeOptions): string[] {
	const nativeNames = new Set<string>(AGENT_NATIVE_WORKSPACE_TOOL_NAMES);
	return options.registry
		.list()
		.filter(
			(tool) =>
				tool.modelVisible === false &&
				tool.runtimeProjections?.some((projection) => nativeNames.has(projection.name)),
		)
		.map((tool) => tool.name);
}

/** Bind resident native coding tools to their hidden governed Room targets. */
export async function bootstrapNativeWorkspaceToolTargets(options: BackendToolBridgeOptions): Promise<string[]> {
	if (!options.roomCapability || !options.gatewayUrl) return [];
	const targetNames = nativeWorkspaceTargets(options);
	const manifestHash = String(options.roomCapability.manifestHash ?? "").slice(0, 16) || "room";
	const loaded: Array<{ name: string; receiptId: string }> = [];
	for (let index = 0; index < targetNames.length; index += 4) {
		const batch = targetNames.slice(index, index + 4).map((name) => ({
			name,
			receiptId: `load:native:${options.sessionId}:${manifestHash}:${name}`,
		}));
		const receipts = await requestGovernedNativeTargetLoads(options, batch);
		for (const [offset, item] of receipts.entries()) {
			const receiptId = typeof item?.receiptId === "string" ? item.receiptId : "";
			if (!receiptId) {
				throw new Error(`Native coding target load failed: ${batch[offset].name}`);
			}
			loaded.push({ name: batch[offset].name, receiptId });
		}
	}
	for (const item of loaded) {
		options.registry.recordLoadReceipt(item.name, item.receiptId);
	}
	return loaded.map((item) => item.name);
}

function resultReceipt(details: Record<string, unknown>): Record<string, unknown> {
	const receipt = record(details.receipt);
	if (Object.keys(receipt).length > 0) return receipt;
	const approvalReceipt = record(record(details.approval).receipt);
	return Object.keys(approvalReceipt).length > 0 ? approvalReceipt : details;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatReadResult(details: Record<string, unknown>): string {
	const content = text(details.content);
	const revision = text(details.resourceRevision);
	const start = number(details.startLine);
	const end = number(details.endLine);
	const next = number(details.nextLineOffset);
	const revisionNote = revision ? `[resourceRevision: ${revision}]\n` : "";
	const note =
		next !== undefined ? `\n\n[Showing lines ${start ?? "?"}-${end ?? "?"}. Continue with offset=${next}.]` : "";
	return `${revisionNote}${content}${note}` || text(details.summary);
}

function formatGrepResult(details: Record<string, unknown>): string {
	const matches = Array.isArray(details.matches) ? details.matches : [];
	if (matches.length === 0) return text(details.summary) || "No matches found";
	const lines: string[] = [];
	for (const value of matches) {
		const match = record(value);
		const path = text(match.relativePath) || text(match.path);
		const lineNumber = number(match.lineNumber);
		for (const before of Array.isArray(match.contextBefore) ? match.contextBefore : []) {
			lines.push(`${path}-${text(before)}`);
		}
		lines.push(`${path}${lineNumber !== undefined ? `:${lineNumber}` : ""}:${text(match.preview)}`);
		for (const after of Array.isArray(match.contextAfter) ? match.contextAfter : []) {
			lines.push(`${path}-${text(after)}`);
		}
	}
	if (details.truncated === true) {
		lines.push(`[Results truncated at ${matches.length} matches. Narrow the pattern or path to continue.]`);
	}
	return lines.join("\n");
}

function formatFindResult(details: Record<string, unknown>): string {
	const matches = Array.isArray(details.matches) ? details.matches : [];
	if (matches.length === 0) return text(details.summary) || "No files found";
	const paths = matches.map((value) => {
		const match = record(value);
		return text(match.relativePath) || text(match.path);
	});
	if (details.truncated === true) {
		paths.push(`[Results truncated at ${matches.length} files. Narrow the pattern or path to continue.]`);
	}
	return paths.join("\n");
}

function formatLsResult(details: Record<string, unknown>): string {
	const items = Array.isArray(details.items) ? details.items : [];
	if (items.length === 0) return text(details.summary) || "Directory is empty";
	const entries = items.map((value) => {
		const item = record(value);
		const label = text(item.name) || text(item.relativePath) || text(item.path);
		return item.kind === "directory" || item.kind === "workspace" ? `${label}/` : label;
	});
	if (details.truncated === true) entries.push("[Directory listing truncated. Use a narrower path.]");
	return entries.join("\n");
}

function formatBashResult(details: Record<string, unknown>): string {
	const receipt = resultReceipt(details);
	const combinedOutput = text(receipt.output);
	const stdout = text(receipt.stdout);
	const stderr = text(receipt.stderr);
	const exitCode = number(receipt.exitCode);
	const chunks = combinedOutput ? [combinedOutput] : [stdout, stderr].filter((value) => value.length > 0);
	chunks.push(`[exit code: ${exitCode ?? "unknown"}]`);
	return chunks.join(!combinedOutput && stdout && stderr ? "\n[stderr]\n" : "\n");
}

function formatMutationResult(details: Record<string, unknown>): string {
	const receipt = resultReceipt(details);
	const summary = text(receipt.summary) || text(details.summary) || "Workspace mutation finished";
	const path = text(receipt.path);
	const postimage = text(receipt.postimageSha256);
	const error = text(receipt.error);
	const registration = record(receipt.workDocumentRegistration);
	const document = record(registration.document);
	const canonicalPath = text(document.path);
	const documentId = text(document.documentId);
	const authorityKey = text(document.authorityKey);
	const authorityRevision = number(document.authorityRevision);
	const documentRevision = number(document.documentRevision);
	return [
		summary,
		error ? `error=${error}` : "",
		path ? `path=${path}` : "",
		postimage ? `postimageSha256=${postimage}` : "",
		documentId ? `workDocument.documentId=${documentId}` : "",
		authorityKey ? `workDocument.authorityKey=${authorityKey}` : "",
		authorityRevision !== undefined ? `workDocument.authorityRevision=${authorityRevision}` : "",
		documentRevision !== undefined ? `workDocument.documentRevision=${documentRevision}` : "",
		canonicalPath ? `workDocument.canonicalPath=${canonicalPath}` : "",
		canonicalPath
			? "后续对此 WorkDocument 的 read/write 必须使用 workDocument.canonicalPath，不再使用首次请求路径。"
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

function projected(
	options: BackendToolBridgeOptions,
	definition: ToolDefinition<any, any, any>,
	target: RuntimeProjectionTarget,
	mapArguments: (input: Record<string, unknown>) => Record<string, unknown>,
	projectModelResult: (result: Record<string, unknown>) => unknown,
	artifacts: ToolArtifactBuffer,
): ToolDefinition<any, any, any> {
	const lifecycleLabel = PROJECTED_TOOL_LIFECYCLE_LABELS[definition.name];
	return createProjectedBackendToolDefinition(
		options,
		{
			definition,
			targetToolName: target.manifest.name,
			mapArguments: (args) => ({
				op: target.operation,
				...mapArguments(inputRecord(args)),
			}),
			projectModelResult,
			...(lifecycleLabel ? { lifecycle: { label: lifecycleLabel, heartbeatMs: 2_000 } } : {}),
		},
		artifacts,
	);
}

function withEvidenceRead(
	options: BackendToolBridgeOptions,
	definition: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
	if (!options.resultStore) return definition;
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		execute: async (toolCallId, params, signal, onUpdate, context) => {
			const input = inputRecord(params);
			const path = text(input.path);
			if (!isToolResultHandle(path)) {
				return execute(toolCallId, params, signal, onUpdate, context);
			}
			if (signal?.aborted) throw new Error("Operation aborted");
			const evidence = options.resultStore?.read(path, boundedLimit(input.offset, 1, Number.MAX_SAFE_INTEGER));
			if (!evidence) throw new Error(`Tool-result evidence store is unavailable: ${path}`);
			const latestObservation = evidence.observations.at(-1);
			const lines = [
				`[Tool evidence ${evidence.available ? "available" : "reclaimed"}]`,
				`handle=${evidence.handle}`,
				`sha256=${evidence.sha256}`,
				`originalBytes=${evidence.byteSize}`,
				latestObservation?.toolName ? `tool=${latestObservation.toolName}` : "",
				latestObservation ? `status=${latestObservation.status}` : "",
				latestObservation?.requestSummary ? `request=${JSON.stringify(latestObservation.requestSummary)}` : "",
				latestObservation?.resultSummary ? `resultSummary=${JSON.stringify(latestObservation.resultSummary)}` : "",
				latestObservation?.resultFacts ? `resultFacts=${JSON.stringify(latestObservation.resultFacts)}` : "",
				evidence.segmentCount > 0
					? `segment=${evidence.segment}/${evidence.segmentCount} (offset selects 48KiB evidence segments)`
					: "",
				"",
				evidence.content,
				evidence.nextSegment
					? `\n[Continue with read(path="${evidence.handle}", offset=${evidence.nextSegment}, limit=1).]`
					: "",
			].filter((line) => line !== "");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					evidenceHandle: evidence.handle,
					evidenceSha256: evidence.sha256,
					evidenceBytes: evidence.byteSize,
					evidenceAvailable: evidence.available,
					segment: evidence.segment,
					segmentCount: evidence.segmentCount,
					...(latestObservation?.toolName ? { evidenceToolName: latestObservation.toolName } : {}),
					...(latestObservation ? { evidenceStatus: latestObservation.status } : {}),
					...(latestObservation?.requestSummary ? { evidenceRequest: latestObservation.requestSummary } : {}),
					...(latestObservation?.resultSummary ? { evidenceSummary: latestObservation.resultSummary } : {}),
					...(latestObservation?.resultFacts ? { evidenceFacts: latestObservation.resultFacts } : {}),
					...(evidence.nextSegment ? { nextSegment: evidence.nextSegment } : {}),
				},
			};
		},
	};
}

export function createNativeWorkspaceToolsExtension(
	options: BackendToolBridgeOptions & { cwd: string },
): Extract<InlineExtension, { name: string }> {
	const artifacts = new ToolArtifactBuffer();
	const definitions: ToolDefinition<any, any, any>[] = [];
	const read = projectionTarget(options.registry, READ_TOOL_NAME);
	if (read) {
		definitions.push(
			withEvidenceRead(
				options,
				projected(
					options,
					createReadToolDefinition(options.cwd),
					read,
					(input) => ({
						path: input.path,
						// Pi's native read contract is line-based and 1-indexed.
						// Normalize malformed model input at the adapter boundary,
						// then preserve Pi's own 2,000-line truncation ceiling.
						lineOffset: boundedLimit(input.offset, 1, Number.MAX_SAFE_INTEGER),
						lineLimit: boundedLimit(input.limit, 2_000, 2_000),
					}),
					formatReadResult,
					artifacts,
				),
			),
		);
	}
	const grep = projectionTarget(options.registry, GREP_TOOL_NAME);
	if (grep) {
		definitions.push(
			projected(
				options,
				createGrepToolDefinition(options.cwd),
				grep,
				(input) => ({
					query: input.pattern,
					path: input.path,
					mode: "content",
					caseSensitive: input.ignoreCase !== true,
					patternKind: input.literal === true ? "literal" : "regex",
					glob: input.glob,
					context: input.context,
					limit: boundedLimit(input.limit, 100, 100),
				}),
				formatGrepResult,
				artifacts,
			),
		);
	}
	const find = projectionTarget(options.registry, FIND_TOOL_NAME);
	if (find) {
		definitions.push(
			projected(
				options,
				createFindToolDefinition(options.cwd),
				find,
				(input) => ({
					query: input.pattern,
					path: input.path,
					mode: "name",
					caseSensitive: true,
					patternKind: "glob",
					limit: boundedLimit(input.limit, 100, 100),
				}),
				formatFindResult,
				artifacts,
			),
		);
	}
	const ls = projectionTarget(options.registry, LS_TOOL_NAME);
	if (ls) {
		definitions.push(
			projected(
				options,
				createLsToolDefinition(options.cwd),
				ls,
				(input) => ({
					path: input.path ?? ".",
					depth: 1,
					limit: boundedLimit(input.limit, 300, 300),
				}),
				formatLsResult,
				artifacts,
			),
		);
	}
	const edit = projectionTarget(options.registry, EDIT_TOOL_NAME);
	if (edit) {
		definitions.push(
			projected(
				options,
				{
					...createEditToolDefinition(options.cwd),
					parameters: projectionParameters(edit),
				} as unknown as ToolDefinition<any, any, any>,
				edit,
				(input) => ({
					path: input.path,
					resourceRevision: input.resourceRevision,
					edits: input.edits,
				}),
				formatMutationResult,
				artifacts,
			),
		);
	}
	const write = projectionTarget(options.registry, WRITE_TOOL_NAME);
	if (write) {
		definitions.push(
			projected(
				options,
				{
					...createWriteToolDefinition(options.cwd),
					parameters: projectionParameters(write),
				} as unknown as ToolDefinition<any, any, any>,
				write,
				(input) => ({
					path: input.path,
					resourceRevision: input.resourceRevision,
					content: input.content,
					workDocument: input.workDocument,
				}),
				formatMutationResult,
				artifacts,
			),
		);
	}
	const bash = projectionTarget(options.registry, BASH_TOOL_NAME);
	if (bash) {
		definitions.push(
			projected(
				options,
				createBashToolDefinition(options.cwd),
				bash,
				(input) => ({
					command: input.command,
					cwd: options.cwd,
					timeoutSeconds: typeof input.timeout === "number" ? Math.max(1, Math.min(120, input.timeout)) : 30,
					allowNetwork: false,
				}),
				formatBashResult,
				artifacts,
			),
		);
	}
	return {
		name: "rag-ime-native-workspace-tools",
		factory(pi) {
			for (const definition of definitions) pi.registerTool(definition);
		},
	};
}
