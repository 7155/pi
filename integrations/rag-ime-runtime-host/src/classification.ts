import type { ClassifierContext, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";
import { RuntimeProtocolError } from "./protocol.ts";

export const MANAGED_CLASSIFIER = Object.freeze({ type: "classifier" as const, provider: "typesafe", id: "jev-latest" });
function record(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function classificationId(params: Record<string, unknown>): string {
 const id = params.requestId;
 if (typeof id !== "string" || !id.trim() || id.length > 200) {
  throw new RuntimeProtocolError("INVALID_PARAMS", "requestId must be a bounded non-empty string");
 }
 return id; // Opaque identity: never trim into another request.
}
export function classificationDispatch(params: Record<string, unknown>): string | undefined {
 const value = params.dispatchId;
 if (value === undefined) return undefined;
 if (typeof value !== "string" || !value.trim() || value.length > 200) throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid classification dispatch identity");
 return value;
}
export function trustedClassificationEndpoint(value: unknown): string | undefined {
 if (value === undefined) return undefined;
 if (typeof value !== "string" || value.length > 4096) throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid classification endpoint");
 try {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  return url.href;
 } catch { throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid classification endpoint"); }
}
export function classificationParams(params: Record<string, unknown>): {
 requestId: string; dispatchId?: string; context: ClassifierContext; timeoutMs: number; apiKey?: string; endpoint?: string;
} {
 const requestId = classificationId(params);
 if (!record(params.state) || !record(params.questions) || !Object.keys(params.questions).length) {
  throw new RuntimeProtocolError("INVALID_PARAMS", "Classification requires state and non-empty questions objects");
 }
 const questions: Record<string, ClassifierQuestion> = {};
 for (const [id, question] of Object.entries(params.questions)) {
  if (!id || !record(question) || typeof question.instructions !== "string" || !question.instructions.trim()) {
   throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid classification question");
  }
  if (question.type === "choice" && record(question.criteria) && Object.keys(question.criteria).length &&
   Object.entries(question.criteria).every(([key, text]) => key && typeof text === "string")) {
   questions[id] = {type: "choice", instructions: question.instructions, criteria: question.criteria as Record<string, string>};
  } else if (question.type === "score" && Array.isArray(question.criteria) && question.criteria.length &&
   question.criteria.every((text): text is string => typeof text === "string")) {
   questions[id] = {type: "score", instructions: question.instructions, criteria: question.criteria};
  } else throw new RuntimeProtocolError("INVALID_PARAMS", "Classification questions must use native Choice or Score criteria");
 }
 const timeoutMs = params.timeoutMs;
 if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
  throw new RuntimeProtocolError("INVALID_PARAMS", "timeoutMs must be an integer between 1 and 300000");
 }
 const apiKey = params.apiKey;
 if (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 16384)) {
  throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid private classification credential");
 }
 return {requestId, dispatchId: classificationDispatch(params), context: {state: params.state as ClassifierContext["state"], questions}, timeoutMs,
  apiKey: apiKey as string | undefined, endpoint: trustedClassificationEndpoint(params.endpoint)};
}
/** Keep native answers/usage; provider error bodies may contain private request data. */
export function publicClassificationResult(requestId: string, result: ClassifierResult, aborted: boolean, dispatchId?: string) {
 const stopReason = aborted ? "aborted" : result.stopReason;
 return {requestId, ...(dispatchId === undefined ? {} : {dispatchId}), provider: MANAGED_CLASSIFIER.provider, model: MANAGED_CLASSIFIER.id,
  stopReason, answers: result.answers, ...(result.usage ? {usage: result.usage} : {}),
  ...(stopReason === "stop" ? {} : {errorCode: stopReason === "aborted" ? "CLASSIFICATION_ABORTED" : "CLASSIFICATION_FAILED",
   errorMessage: stopReason === "aborted" ? "Classification was aborted" : "Native classification failed"})};
}
