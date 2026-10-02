import { fauxAssistantMessage, fauxToolCall, type ClassifierResult } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../../packages/coding-agent/src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "../../../packages/coding-agent/test/suite/harness.ts";
const ref = {type:"classifier" as const,provider:"typesafe",id:"jev-latest"};
const context = `{state:{task:"offline"},questions:{route:{type:"choice",instructions:"Choose",criteria:{stay:"Stay",handoff:"Delegate"}}}}`;
function result(): ClassifierResult {return {api:"typesafe-system-one",provider:"typesafe",model:"jev-latest",stopReason:"stop",answers:{route:{type:"choice",choice:"stay",probabilities:{stay:1,handoff:0},confidence:1}},timestamp:0,
usage:{input:2,output:1,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0.01,output:0,cacheRead:0,cacheWrite:0,total:0.01}}};}
async function run(h: Harness, code: string) {
 h.setResponses([fauxAssistantMessage([fauxToolCall("codemode",{code})],{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
 await h.session.prompt("offline code"); return getToolResult(h,"codemode");
}
function output(r: ReturnType<typeof getToolResult>) {return r.content.filter(b=>b.type==="text").map(b=>b.text).slice(1).join("\n");}
it("exposes only allowed classifier references and rejects forged/disallowed model refs",async()=>{
 const fetch = vi.fn<typeof globalThis.fetch>();
 const h = await createHarness({initialActiveToolNames:["codemode"],extensionFactories:[createCodemodeExtension({models:{allowed:[ref]},classifierOptions:{fetch,maxRetries:0}})]});
 try {
  const classify=vi.spyOn(h.session.modelRuntime,"classify").mockResolvedValue(result());
  const r=await run(h,`const modelsList=await models.getAvailableOfType("classifier");
   const listed=await models.getModelsOfType("classifier");
   const forbidden=await models.getModelOfType("classifier","openrouter","typesafe/jev-latest");
   let blocked;try{await models.classify({provider:"openrouter",id:"typesafe/jev-latest"},${context});}catch(e){blocked=e.message;}
   let imageCall;try{imageCall=typeof models.generateImages;}catch{imageCall="not exposed";}
   const answer=await models.classify({...listed[0],baseUrl:"https://untrusted.invalid",headers:{authorization:"forged"}},${context});
   return {listed:listed.map(m=>m.provider+"/"+m.id),available:modelsList.map(m=>m.id),images:await models.getModelsOfType("image"),imageCall,missing:forbidden===undefined,blocked,stop:answer.stopReason};`);
  expect(r.isError,output(r)).toBe(false);
  expect(JSON.parse(output(r))).toMatchObject({listed:["typesafe/jev-latest"],images:[],imageCall:"not exposed",missing:true,blocked:expect.stringContaining("not allowed"),stop:"stop"});
  expect(classify).toHaveBeenCalledTimes(1);
  expect(classify.mock.calls[0]?.[0].baseUrl).not.toBe("https://untrusted.invalid");
  expect(classify.mock.calls[0]?.[2]).toMatchObject({fetch,maxRetries:0,signal:expect.any(AbortSignal)});
  expect(r.usage).toMatchObject({totalTokens:3,cost:{total:0.01}});
  expect(r.details).toMatchObject({calls:[{name:"models.classify",status:"ok",args:"typesafe/jev-latest",cost:0.01}]});
  const description=h.session.agent.state.tools.find(t=>t.name==="codemode")?.description;
  expect(description).toContain("classifiers");expect(description).not.toContain("image generation");
 } finally {h.cleanup();vi.restoreAllMocks();}
});
it("rechecks policy after the native four-call limiter before a queued call dispatches",async()=>{
 const allowed=[ref];
 const h=await createHarness({initialActiveToolNames:["codemode"],extensionFactories:[createCodemodeExtension({models:{allowed}})]});
 const releases: (()=>void)[]=[];let active=0,maxActive=0;
 const classify=vi.spyOn(h.session.modelRuntime,"classify").mockImplementation(async()=>{
  active++;maxActive=Math.max(maxActive,active);if(releases.length<4) await new Promise<void>(resolve=>releases.push(resolve));active--;return result();
 });
 try {
  const pending=run(h,`return await Promise.allSettled(Array.from({length:5},()=>models.classify({provider:"typesafe",id:"jev-latest"},${context})));`);
  await vi.waitFor(()=>expect(classify).toHaveBeenCalledTimes(4));
  allowed.length=0; for(const release of releases)release();
  const r=await pending;expect(maxActive).toBe(4);expect(classify).toHaveBeenCalledTimes(4);
  expect(r.usage?.totalTokens).toBe(12);
  expect(r.details).toMatchObject({calls:[{status:"ok"},{status:"ok"},{status:"ok"},{status:"ok"},{status:"error"}]});
 }finally {for(const release of releases)release();h.cleanup();vi.restoreAllMocks();}
});
