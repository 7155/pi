import { createHash } from "node:crypto";

const BLOCK_FENCE = /```rag_ime_blocks[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_BLOCKS = 16;
const MAX_SUMMARY_CHARS = 240;

const KNOWN_TYPES = new Set([
	"text",
	"code",
	"reasoning_summary",
	"progress",
	"tool_call",
	"tool_result",
	"citation",
	"image",
	"audio",
	"file",
	"sticker",
	"task_plan",
	"diff",
	"approval",
	"error",
	"card",
	"checklist",
	"table",
	"artifact",
	"reference",
	"status",
]);

const FORBIDDEN_KEYS = new Set(["html", "script", "style", "srcdoc", "javascript", "css"]);

export interface ContextCleanerReceipt {
	schemaVersion: "pi.context-cleaner-receipt.v1";
	beforeBytes: number;
	afterBytes: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	cleanedBlockCount: number;
	preservedInvalidFenceCount: number;
}

export interface CleanedContextText {
	text: string;
	receipt: ContextCleanerReceipt;
}

interface CanonicalBlock {
	id: string;
	type: string;
	summary: string;
	digest: string;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function compact(value: unknown, limit = MAX_SUMMARY_CHARS): string {
	return String(value ?? "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}

function safeData(value: unknown, depth = 0): boolean {
	if (depth > 8) return false;
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return typeof value !== "string" || byteLength(value) <= MAX_BLOCK_BYTES;
	}
	if (Array.isArray(value)) return value.length <= 256 && value.every((item) => safeData(item, depth + 1));
	if (!value || typeof value !== "object") return false;
	for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
		const key = rawKey.toLowerCase();
		if (FORBIDDEN_KEYS.has(key) || key.startsWith("on")) return false;
		if ((key === "url" || key.endsWith("url")) && typeof item === "string") {
			if (!/^(https:\/\/|\/api\/agent\/media\/|media:|artifact:)/i.test(item)) return false;
		}
		if (!safeData(item, depth + 1)) return false;
	}
	return true;
}

function summaryFor(type: string, data: Record<string, unknown>): string {
	const title = compact(data.title || data.label || data.name || data.fileName || data.path, 120);
	switch (type) {
		case "card":
			return title ? `卡片：${title}` : "卡片";
		case "checklist": {
			const items = Array.isArray(data.items) ? data.items : [];
			const done = items.filter((item) => item && typeof item === "object" && Boolean((item as Record<string, unknown>).checked)).length;
			return `清单${title ? `：${title}` : ""}，${done}/${items.length} 完成`;
		}
		case "table": {
			const rows = Array.isArray(data.rows) ? data.rows.length : 0;
			const columns = Array.isArray(data.columns) ? data.columns.length : 0;
			return `表格${title ? `：${title}` : ""}，${rows} 行 ${columns} 列`;
		}
		case "diff":
			return `代码变更：${compact(data.filePath || data.path || "未知文件", 140)}`;
		case "image":
			return `图片：${compact(data.alt || data.caption || title || "已生成图片", 160)}`;
		case "file":
		case "artifact":
			return `产物：${title || compact(data.ref || "已生成产物", 160)}`;
		case "citation":
		case "reference":
			return `引用：${title || compact(data.ref || data.source || "已记录引用", 160)}`;
		case "status":
		case "progress":
			return `状态：${title || compact(data.state || data.summary || "已更新", 160)}`;
		case "code":
			return `代码：${title || compact(data.language || "代码片段", 160)}`;
		case "unknown":
			return `暂不支持的内容：${compact(data.originalType || "unknown", 80)}`;
		default:
			return compact(data.summary || data.text || data.message || title || `已生成 ${type} 内容`);
	}
}

function normalizeBlock(value: unknown): CanonicalBlock | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const id = compact(raw.id, 160);
	const originalType = compact(raw.type, 80);
	if (!id || !originalType || originalType === "html_widget") return undefined;
	const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
		? (raw.data as Record<string, unknown>)
		: {};
	if (!safeData(data) || byteLength(canonicalJson(raw)) > MAX_BLOCK_BYTES) return undefined;
	const type = KNOWN_TYPES.has(originalType) ? originalType : "unknown";
	const summaryData = type === "unknown" ? { originalType } : data;
	const summary = summaryFor(type, summaryData);
	if (!summary) return undefined;
	const digest = createHash("sha256").update(canonicalJson(raw)).digest("hex");
	return { id, type, summary, digest };
}

function parseEnvelope(json: string): CanonicalBlock[] | undefined {
	if (byteLength(json) > MAX_ENVELOPE_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const envelope = value as Record<string, unknown>;
	if (envelope.schemaVersion !== "rag-ime.agent-blocks.v1" || !Array.isArray(envelope.blocks)) return undefined;
	if (envelope.blocks.length === 0 || envelope.blocks.length > MAX_BLOCKS) return undefined;
	const blocks = envelope.blocks.map(normalizeBlock);
	return blocks.every(Boolean) ? (blocks as CanonicalBlock[]) : undefined;
}

function renderReference(block: CanonicalBlock): string {
	return `[内容块 ref=block:${block.id}:${block.digest.slice(0, 16)} type=${block.type}：${block.summary}]`;
}

export function cleanAgentBlockText(input: string): CleanedContextText {
	let cleanedBlockCount = 0;
	let preservedInvalidFenceCount = 0;
	const text = input.replace(BLOCK_FENCE, (match, json: string) => {
		const blocks = parseEnvelope(json);
		if (!blocks) {
			preservedInvalidFenceCount += 1;
			return match;
		}
		cleanedBlockCount += blocks.length;
		return blocks.map(renderReference).join("\n");
	});
	const beforeBytes = byteLength(input);
	const afterBytes = byteLength(text);
	return {
		text,
		receipt: {
			schemaVersion: "pi.context-cleaner-receipt.v1",
			beforeBytes,
			afterBytes,
			estimatedTokensBefore: Math.ceil(beforeBytes / 4),
			estimatedTokensAfter: Math.ceil(afterBytes / 4),
			cleanedBlockCount,
			preservedInvalidFenceCount,
		},
	};
}
