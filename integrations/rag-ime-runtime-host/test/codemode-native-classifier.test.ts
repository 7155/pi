import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RuntimeRequest } from "../src/protocol.ts";
import { RagImeRuntimeHost } from "../src/runtime-host.ts";
function request(method: RuntimeRequest["method"], params: Record<string, unknown> = {}): RuntimeRequest {
 return {protocolVersion:PROTOCOL_VERSION,id:method,method,params};
}
it.each(["success","failure","cancel"] as const)("runs native managed CodeMode classification (%s) through the bounded model owner",async(scenario)=>{
 const root=await mkdtemp(join(tmpdir(),"paw-native-classifier-"));
 let host:RagImeRuntimeHost|undefined;
 let active=0,maxActive=0;
 const endpoint="https://trusted.invalid/configured/complete";
 const calls:{url:string;body:Record<string,unknown>}[]=[];
 vi.stubEnv("TYPESAFE_API_KEY","offline-env-only-key");
 const fetch=vi.fn<typeof globalThis.fetch>(async(input,init)=>{
  calls.push({url:input.toString(),body:JSON.parse(String(init?.body))});
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-env-only-key");
  active++;maxActive=Math.max(active,maxActive);
  try {
   if(scenario==="cancel") await new Promise<void>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>setTimeout(()=>reject(new DOMException("Aborted","AbortError")),50),{once:true}));
   else await new Promise(resolve=>setTimeout(resolve,10));
   if(scenario==="failure") return new Response("offline-env-only-key private provider detail",{status:503});
   return Response.json({answers:{route:{type:"choice",choice:"stay",probabilities:{stay:1},confidence:1}},usage:{input_tokens:3,output_tokens:1}});
  }finally{active--;}
 });
 try {
  const runtime=await ModelRuntime.create({authPath:join(root,"auth.json"),modelsPath:null,allowModelNetwork:false});
  const faux=createFauxCore({api:"faux:managed-classifier",provider:"offline-chat",models:[{id:"test"}]});
  const model=faux.getModel();
  runtime.registerProvider("offline-chat",{name:"Offline",baseUrl:"https://offline.invalid",api:model.api,apiKey:"offline-only",
   streamSimple:faux.streamSimple,models:[{id:model.id,name:model.name,api:model.api,reasoning:model.reasoning,input:model.input,cost:model.cost,contextWindow:model.contextWindow,maxTokens:model.maxTokens}]});
  faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode",{code:`
   const listed=await models.getModelsOfType("classifier");
   const results=await Promise.all(Array.from({length:6},()=>models.classify({provider:"typesafe",id:"jev-latest",baseUrl:"https://forged.invalid"},
    {state:{task:"offline"},questions:{route:{type:"choice",instructions:"Choose",criteria:{stay:"Stay"}}}})));
   text({listed:listed.map(m=>m.provider+"/"+m.id),imageCount:(await models.getModelsOfType("image")).length,
    stops:results.map(r=>r.stopReason),errors:results.map(r=>r.errorMessage)});
  `},{id:"native-code-parent"}),{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
  host=await RagImeRuntimeHost.create({agentDir:join(root,"agent"),sessionDir:join(root,"sessions"),pluginsRoot:join(root,"plugins"),pluginInbox:join(root,"inbox"),maxSessions:2,
   modelRuntime:runtime,classificationFetch:fetch,classificationEndpoint:endpoint,emitEvent:()=>undefined});
  await host.handle(request("session.open",{sessionId:"native-code",cwd:root,provider:"offline-chat",modelId:"test",noContextFiles:true,codemodeMode:"on"}));
  const prompt=await host.handle(request("session.prompt",{sessionId:"native-code",message:"offline code",clientMessageId:"code-message"})) as {turnId:string};
  if(scenario==="cancel") {
   await vi.waitFor(()=>expect(calls).toHaveLength(4));
   await host.handle(request("session.abort",{sessionId:"native-code",expectedTurnId:prompt.turnId,expectedClientMessageId:"code-message"}));
  }
  const session=host.sessions.get("native-code")!;
  const settled=await session.awaitSettled(prompt.turnId,{timeoutMs:10000});
  expect(active).toBe(0);expect(maxActive).toBe(4);expect(settled.receipt.pendingOperations).toBe(0);
  expect(calls).toHaveLength(scenario==="cancel"?4:6);
  expect(calls.every(call=>call.url===endpoint && call.body.model==="jev-latest")).toBe(true);
  const messages=session.snapshot().messages as {role:string;toolCallId?:string;content?:{type:string;text?:string}[];usage?:{totalTokens:number};details?:unknown}[];
  const result=messages.find(m=>m.role==="toolResult" && m.toolCallId==="native-code-parent");
  expect(JSON.stringify(result)).not.toContain("offline-env-only-key");
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  if(scenario==="success") {
   expect(result?.usage?.totalTokens).toBe(24);
   expect(result?.details).toMatchObject({calls:Array.from({length:6},()=>({name:"models.classify",args:"typesafe/jev-latest",status:"ok"}))});
   expect(result?.content?.map(b=>b.text).join("\n")).toContain('"listed":["typesafe/jev-latest"]');
  }else if(scenario==="failure") expect(result?.details).toMatchObject({calls:Array.from({length:6},()=>({status:"error"}))});
  else expect(settled.receipt.disposition).toBe("aborted");
 }finally{await host?.dispose();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
