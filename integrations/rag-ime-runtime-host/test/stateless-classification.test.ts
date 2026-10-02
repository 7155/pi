import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RuntimeEventEnvelope, type RuntimeRequest } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";

afterEach(() => vi.restoreAllMocks());
const questions = {
 route: {type: "choice", instructions: "Choose the next owner", criteria: {stay: "Stay", handoff: "Delegate"}},
 quality: {type: "score", instructions: "Score the evidence", criteria: ["Specific", "Verified"]},
};
const answers = {
 route: {type: "choice", choice: "handoff", probabilities: {stay: 0.1, handoff: 0.9}, confidence: 0.9},
 quality: {type: "score", score: 0.8, confidence: 0.7},
};
function request(method: string, params: Record<string, unknown> = {}): RuntimeRequest {
 return {protocolVersion: PROTOCOL_VERSION, id: method, method, params} as RuntimeRequest;
}
function once(requestId = "classification:1", extra: Record<string, unknown> = {}) {
 return request("classification.once", {requestId, state: {task: "Offline fixture"}, questions,
 timeoutMs: 1000, apiKey: "offline-private-key", ...extra});
}
async function fixture(fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({answers, usage: {input_tokens: 5, output_tokens: 2}}))) {
 const root = await mkdtemp(join(tmpdir(), "rag-ime-classification-"));
 const runtime = await ModelRuntime.create({authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false});
 const events: RuntimeEventEnvelope[] = [];
 const host = await RagImeRuntimeHost.create({agentDir: join(root, "agent"), sessionDir: join(root, "sessions"),
 pluginsRoot: join(root, "plugins"), pluginInbox: join(root, "inbox"), maxSessions: 2,
 modelRuntime: runtime, classificationFetch: fetch, emitEvent: event => events.push(event)});
 return {host, runtime, fetch, events, close: async () => {await host.dispose(); await rm(root, {recursive: true, force: true});}};
}
it("advertises classification without opening an Agent Session", async () => {
 const f = await fixture();
 try {expect(await f.host.handle(request("hello"))).toMatchObject({protocolVersion: "2", capabilities: {statelessClassification: true}});
 expect(f.host.sessions.size).toBe(0);} finally {await f.close();}
});
it("uses the native Choice/Score transport, fresh private auth and trusted complete endpoint, preserving usage", async () => {
 const f = await fixture();
 try {
  const result = await f.host.handle(once("one", {endpoint: "https://classifier.invalid/custom/complete"}));
  expect(result).toMatchObject({requestId: "one", provider: "typesafe", model: "jev-latest", stopReason: "stop", answers,
  usage: {input: 5, output: 2, totalTokens: 7}});
  expect(f.fetch.mock.calls[0]?.[0].toString()).toBe("https://classifier.invalid/custom/complete");
  const init = f.fetch.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-private-key");
  expect(JSON.parse(String(init?.body))).toEqual({model: "jev-latest", state: {task: "Offline fixture"}, questions});
  await f.host.handle(once("two", {apiKey: "next-offline-key"}));
  expect(new Headers(f.fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer next-offline-key");
  expect(JSON.stringify(result)).not.toContain("offline-private-key");
  expect(f.host.sessions.size).toBe(0);
  expect(f.events.map(e=>e.payload)).toEqual([{type:"classification_settled",requestId:"one",stopReason:"stop"},{type:"classification_settled",requestId:"two",stopReason:"stop"}]);
  expect(f.events.every(e=>e.event === "runtime.notice")).toBe(true);
 } finally {await f.close();}
});
it("rejects invalid input before native dispatch", async () => {
 const f = await fixture();
 try {
  for (const extra of [{state: []}, {questions: {}}, {questions: {q:{type:"bool",instructions:"x",criteria:{true:"yes",false:"no"}}}},
    {timeoutMs: 0}, {endpoint:"file:///tmp/classify"}, {endpoint:"https://user:password@example.invalid/"}]) {
   await expect(f.host.handle(once("invalid",extra))).rejects.toMatchObject({code:"INVALID_PARAMS"});
  }
  expect(f.fetch).not.toHaveBeenCalled();
 } finally {await f.close();}
});
it("keeps native failure and malformed answers distinct from success, with safe text and no retry", async () => {
 const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("offline-private-key upstream detail",{status:503}))
  .mockResolvedValueOnce(Response.json({answers:{},usage:{input_tokens:9,output_tokens:1}}));
 const f = await fixture(fetch);
 try {
  expect(await f.host.handle(once("http-failed"))).toMatchObject({stopReason:"error",errorCode:"CLASSIFICATION_FAILED"});
  const malformed = await f.host.handle(once("malformed"));
  expect(malformed).toMatchObject({stopReason:"error",usage:{totalTokens:10}});
  expect(JSON.stringify(malformed)).not.toContain("upstream detail");
  expect(fetch).toHaveBeenCalledTimes(2);
 } finally {await f.close();}
});
it("signals only the exact classification, rejects active duplicates and reports real drain", async () => {
 let release!: () => void;
 const fetch = vi.fn<typeof globalThis.fetch>((_input,init)=>new Promise((resolve)=>{
  release=()=>resolve(Response.json({answers,usage:{input_tokens:5,output_tokens:2}}));
  expect(init?.signal).toBeDefined();
 }));
 const f = await fixture(fetch);
 try {
  const pending=f.host.handle(once("exact"));
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
  await expect(f.host.handle(once("exact"))).rejects.toMatchObject({code:"CLASSIFICATION_ALREADY_ACTIVE"});
  expect(await f.host.handle(request("classification.abort",{requestId:"other"}))).toEqual({requestId:"other",aborted:false,active:false,drained:false});
  expect(await f.host.handle(request("completion.cancel",{requestId:"exact"}))).toMatchObject({cancelled:false});
  const abort=f.host.handle(request("classification.abort",{requestId:"exact"}));
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(f.events).toHaveLength(0);
  release();
  expect(await pending).toMatchObject({stopReason:"aborted",usage:{totalTokens:7}});
  expect(await abort).toEqual({requestId:"exact",aborted:true,active:true,drained:true});
  expect(f.events.map(e=>e.payload)).toEqual([{type:"classification_settled",requestId:"exact",stopReason:"aborted"}]);
 } finally {release?.();await f.close();}
});
it("fences a reused request with dispatch identity and emits the original drained identity", async()=>{
 const releases:(()=>void)[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(()=>new Promise(resolve=>releases.push(()=>resolve(Response.json({answers})))));
 const f=await fixture(fetch);
 try {
  const old=f.host.handle(once("reuse",{dispatchId:"old"}));await vi.waitFor(()=>expect(releases).toHaveLength(1));releases[0]?.();
  expect(await old).toMatchObject({requestId:"reuse",dispatchId:"old",stopReason:"stop"});
  const fresh=f.host.handle(once("reuse",{dispatchId:"fresh"}));await vi.waitFor(()=>expect(releases).toHaveLength(2));
  await expect(f.host.handle(request("classification.abort",{requestId:"reuse",dispatchId:"old"}))).rejects.toMatchObject({code:"CLASSIFICATION_TARGET_MISMATCH"});
  expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  const abort=await f.host.handle(request("classification.abort",{requestId:"reuse",dispatchId:"fresh"}));
  expect(abort).toEqual({requestId:"reuse",dispatchId:"fresh",aborted:true,active:true,drained:false});
  expect(f.events).toHaveLength(1);
  releases[1]?.();expect(await fresh).toMatchObject({dispatchId:"fresh",stopReason:"aborted"});
  expect(f.events.map(e=>e.payload)).toEqual([
   {type:"classification_settled",requestId:"reuse",dispatchId:"old",stopReason:"stop"},
   {type:"classification_settled",requestId:"reuse",dispatchId:"fresh",stopReason:"aborted"},
  ]);
 }finally{for(const release of releases)release();await f.close();}
});
it("keeps another active classification running and an unconfigured classifier from HTTP dispatch",async()=>{
 const releases:(()=>void)[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(()=>new Promise(resolve=>releases.push(()=>resolve(Response.json({answers})))));
 const f=await fixture(fetch);
 try {
  const a=f.host.handle(once("a"));const b=f.host.handle(once("b"));await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
  const abort=f.host.handle(request("classification.abort",{requestId:"a"}));
  expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  releases[0]?.();releases[1]?.();expect(await a).toMatchObject({stopReason:"aborted"});expect(await b).toMatchObject({stopReason:"stop"});await abort;
  // Explicit empty env keeps this fixture isolated from the developer's configured providers.
  vi.spyOn(f.runtime,"getAuth").mockResolvedValue(undefined);
  expect(await f.host.handle(once("no-key",{apiKey:undefined}))).toMatchObject({stopReason:"error"});
  expect(fetch).toHaveBeenCalledTimes(2);
 }finally{for(const release of releases)release();await f.close();}
});
it("passes the native timeout and stops rather than retries a deadline failure",async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>((_input,init)=>new Promise((_resolve,reject)=>{
  init?.signal?.addEventListener("abort",()=>reject(new DOMException("Deadline","AbortError")),{once:true});
 }));
 const f=await fixture(fetch);
 try{expect(await f.host.handle(once("deadline",{timeoutMs:10}))).toMatchObject({stopReason:"error"});expect(fetch).toHaveBeenCalledTimes(1);
 expect(f.events[0]?.payload).toMatchObject({type:"classification_settled",requestId:"deadline",stopReason:"error"});}
 finally{await f.close();}
});
