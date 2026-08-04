import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ASK_TOOL_NAME } from "./runtime-tool-names.ts";

export const ASK_SCHEMA_VERSION = "rag-ime.grouped-questions.v2" as const;

const MAX_PAYLOAD_BYTES = 12_000;
const MAX_QUESTION_ID_CHARS = 80;
const MAX_QUESTION_CHARS = 160;
const MAX_HEADER_CHARS = 80;
const MAX_OPTION_LABEL_CHARS = 240;
const MAX_OPTION_TEXT_CHARS = 500;
const MAX_CUSTOM_CHARS = 1_000;
const QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const OTHER_OPTION_PATTERN = /^(?:other|其他|其它|自定义)$/iu;

export interface AskQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: AskQuestionOption[];
	multi?: boolean;
	recommended?: number;
}

export interface AskWireRequest {
	schemaVersion: typeof ASK_SCHEMA_VERSION;
	questions: AskQuestion[];
}

export interface AskAnswer {
	selected: string[];
	custom?: string;
}

export interface AskAnswerWire {
	answers: Record<string, AskAnswer>;
}

export interface AskResult extends AskAnswerWire {
	answered: boolean;
	cancelled: boolean;
	summary: string;
}

export interface AskExtensionOptions {
	requestQuestions(
		toolCallId: string,
		request: AskWireRequest,
		signal: AbortSignal | undefined,
	): Promise<string | undefined>;
}

const ASK_OPTION_SCHEMA = {
	type: "object",
	properties: {
		label: { type: "string", minLength: 1, maxLength: MAX_OPTION_LABEL_CHARS },
		description: { type: "string", minLength: 1, maxLength: MAX_OPTION_TEXT_CHARS },
		preview: { type: "string", minLength: 1, maxLength: MAX_OPTION_TEXT_CHARS },
	},
	required: ["label"],
	additionalProperties: false,
};

export const ASK_PARAMETERS = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 4,
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						pattern: QUESTION_ID_PATTERN.source,
						minLength: 1,
						maxLength: MAX_QUESTION_ID_CHARS,
					},
					question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS },
					header: { type: "string", minLength: 1, maxLength: MAX_HEADER_CHARS },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 5,
						items: ASK_OPTION_SCHEMA,
					},
					multi: { type: "boolean" },
					recommended: { type: "integer", minimum: 0, maximum: 4 },
				},
				required: ["id", "question", "options"],
				additionalProperties: false,
			},
		},
	},
	required: ["questions"],
	additionalProperties: false,
} as ToolDefinition["parameters"];

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	const permitted = new Set(allowed);
	return Object.keys(record).every((key) => permitted.has(key));
}

function nonEmptyString(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) throw new Error(`${field} is missing or too long`);
	return normalized;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	return nonEmptyString(value, field, maximum);
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function normalizeOption(value: unknown, questionId: string, index: number): AskQuestionOption {
	const record = objectRecord(value);
	if (!record || !hasOnlyKeys(record, ["label", "description", "preview"])) {
		throw new Error(`Question ${questionId} option ${index} is invalid`);
	}
	const label = nonEmptyString(record.label, `Question ${questionId} option ${index} label`, MAX_OPTION_LABEL_CHARS);
	if (OTHER_OPTION_PATTERN.test(label)) {
		throw new Error(`Question ${questionId} must not add an Other option`);
	}
	const description = optionalString(
		record.description,
		`Question ${questionId} option ${index} description`,
		MAX_OPTION_TEXT_CHARS,
	);
	const preview = optionalString(
		record.preview,
		`Question ${questionId} option ${index} preview`,
		MAX_OPTION_TEXT_CHARS,
	);
	return {
		label,
		...(description !== undefined ? { description } : {}),
		...(preview !== undefined ? { preview } : {}),
	};
}

function normalizeQuestion(value: unknown, index: number, seenIds: Set<string>): AskQuestion {
	const record = objectRecord(value);
	if (!record || !hasOnlyKeys(record, ["id", "question", "header", "options", "multi", "recommended"])) {
		throw new Error(`Question ${index} is invalid`);
	}
	const id = nonEmptyString(record.id, `Question ${index} id`, MAX_QUESTION_ID_CHARS);
	if (!QUESTION_ID_PATTERN.test(id)) throw new Error(`Question ${index} id is invalid`);
	if (seenIds.has(id)) throw new Error(`Question ids must be unique: ${id}`);
	seenIds.add(id);
	const question = nonEmptyString(record.question, `Question ${id} text`, MAX_QUESTION_CHARS);
	const header = optionalString(record.header, `Question ${id} header`, MAX_HEADER_CHARS);
	if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 5) {
		throw new Error(`Question ${id} must contain two to five options`);
	}
	const options = record.options.map((option, optionIndex) => normalizeOption(option, id, optionIndex));
	const labels = options.map((option) => option.label);
	if (new Set(labels).size !== labels.length) throw new Error(`Question ${id} options must be unique`);
	if (record.multi !== undefined && typeof record.multi !== "boolean") {
		throw new Error(`Question ${id} multi must be a boolean`);
	}
	const multi = record.multi === true;
	let recommended: number | undefined;
	if (record.recommended !== undefined) {
		if (
			!Number.isInteger(record.recommended) ||
			(record.recommended as number) < 0 ||
			(record.recommended as number) >= options.length
		) {
			throw new Error(`Question ${id} recommended must identify an offered option`);
		}
		recommended = record.recommended as number;
	}
	return {
		id,
		question,
		...(header !== undefined ? { header } : {}),
		options,
		...(record.multi !== undefined ? { multi } : {}),
		...(recommended !== undefined ? { recommended } : {}),
	};
}

export function normalizeAskRequest(value: unknown): AskWireRequest {
	const record = objectRecord(value);
	if (!record || !hasOnlyKeys(record, ["questions"])) throw new Error("ask parameters must contain only questions");
	if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > 4) {
		throw new Error("ask must contain one to four questions");
	}
	const seenIds = new Set<string>();
	const questions = record.questions.map((question, index) => normalizeQuestion(question, index, seenIds));
	const request: AskWireRequest = { schemaVersion: ASK_SCHEMA_VERSION, questions };
	if (utf8Bytes(JSON.stringify(request)) > MAX_PAYLOAD_BYTES) throw new Error("ask question payload is too large");
	return request;
}

function normalizeSelected(value: unknown, question: AskQuestion): string[] {
	if (!Array.isArray(value)) throw new Error(`Question ${question.id} selected must be an array`);
	const selected = value.map((item, index) =>
		nonEmptyString(item, `Question ${question.id} selected ${index}`, MAX_OPTION_LABEL_CHARS),
	);
	if (new Set(selected).size !== selected.length)
		throw new Error(`Question ${question.id} selected options must be unique`);
	const offered = new Set(question.options.map((option) => option.label));
	if (selected.some((item) => !offered.has(item)))
		throw new Error(`Question ${question.id} selected option was not offered`);
	if (!question.multi && selected.length > 1)
		throw new Error(`Question ${question.id} allows only one selected option`);
	return selected;
}

function parseAnswerPayload(value: unknown, request: AskWireRequest): AskAnswerWire {
	const record = objectRecord(value);
	if (!record || !hasOnlyKeys(record, ["answers"])) throw new Error("ask answer payload must contain only answers");
	const proposed = objectRecord(record.answers);
	if (!proposed) throw new Error("ask answers must be an object");
	const expectedIds = request.questions.map((question) => question.id);
	const actualIds = Object.keys(proposed);
	if (actualIds.length !== expectedIds.length || actualIds.some((id) => !expectedIds.includes(id))) {
		throw new Error("ask answers must cover every offered question");
	}
	const answers: Record<string, AskAnswer> = {};
	for (const question of request.questions) {
		const rawAnswer = objectRecord(proposed[question.id]);
		if (!rawAnswer || !hasOnlyKeys(rawAnswer, ["selected", "custom"])) {
			throw new Error(`Question ${question.id} answer is invalid`);
		}
		const selected = normalizeSelected(rawAnswer.selected, question);
		let custom: string | undefined;
		if (rawAnswer.custom !== undefined)
			custom = nonEmptyString(rawAnswer.custom, `Question ${question.id} custom`, MAX_CUSTOM_CHARS);
		if (selected.length === 0 && custom === undefined) {
			throw new Error(`Question ${question.id} needs a selection or custom response`);
		}
		if (!question.multi && selected.length > 0 && custom !== undefined) {
			throw new Error(`Question ${question.id} cannot combine a selection and custom response`);
		}
		answers[question.id] = { selected, ...(custom !== undefined ? { custom } : {}) };
	}
	return { answers };
}

export function parseAskAnswers(value: string, request: AskWireRequest): AskAnswerWire {
	if (typeof value !== "string" || utf8Bytes(value) > MAX_PAYLOAD_BYTES)
		throw new Error("ask answer payload is missing or too large");
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		throw new Error("ask answer payload is not valid JSON");
	}
	return parseAnswerPayload(decoded, request);
}

function requestQuestionsWithAbort(
	options: AskExtensionOptions,
	toolCallId: string,
	request: AskWireRequest,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			if (signal?.aborted) {
				finish(undefined);
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		};
		const onAbort = () => finish(undefined);
		if (signal?.aborted) {
			finish(undefined);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		Promise.resolve()
			.then(() => (settled ? undefined : options.requestQuestions(toolCallId, request, signal)))
			.then(finish, fail);
	});
}

function cancelledResult(): AskResult {
	return {
		answered: false,
		cancelled: true,
		answers: {},
		summary: "用户结束了本次选择；不要代替用户猜测答案。",
	};
}

export function createAskExtension(options: AskExtensionOptions): InlineExtension {
	return {
		name: "rag-ime-ask",
		factory(pi) {
			pi.registerTool({
				name: ASK_TOOL_NAME,
				label: "Ask",
				description:
					"Ask the user one to four grouped questions when a material choice is missing. Do not add an Other option; the Control Center provides a custom response affordance.",
				promptSnippet: "Ask one to four related questions when a material user choice is missing",
				parameters: ASK_PARAMETERS,
				executionMode: "sequential",
				execute: async (toolCallId, args, signal) => {
					const request = normalizeAskRequest(args);
					if (signal?.aborted) {
						const result = cancelledResult();
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					}
					const response = await requestQuestionsWithAbort(options, toolCallId, request, signal);
					if (response === undefined || signal?.aborted) {
						const result = cancelledResult();
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					}
					const answer = parseAskAnswers(response, request);
					const result: AskResult = {
						answered: true,
						cancelled: false,
						answers: answer.answers,
						summary: "用户已完成本次选择。",
					};
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				},
			});
		},
	};
}
