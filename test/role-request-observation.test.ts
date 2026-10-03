import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {describeRequest,type RequestObserver} from '../src/agent/request-observation.js';
import {ModelRequestBudget,installModelRequestBudget} from '../src/agent/model-request-budget.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
const model={id:'fixture',provider:'fixture',contextWindow:128000} as Parameters<Parameters<typeof installModelRequestBudget>[0]['streamFunction']>[0];
it('persists context composition and redacted snapshots before task and compaction transport',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-observations-'));
 try{
  const store=new TraceStore(root),recorder=await TraceRecorder.start(store,{kind:'prepare'}),sent:string[]=[];
  const observe:RequestObserver=async observation=>{const blobRef=await recorder.putBlob(observation.value);await recorder.record('validation.completed',{phase:'role-request-observation',measurement:describeRequest(observation)},recorder.rootContext,{blobRef});sent.push(observation.phase);};
  const target={streamFunction:vi.fn(async(_model,_context,options)=>{expect(sent.at(-1)).toBe('context');await options.onPayload({messages:[{role:'user',content:'中文'}],authorization:'Bearer very-secret-value'},model);expect(sent.at(-1)).toBe('provider-payload');return {result: async()=>({usage:{}})} as never;}),onPayload:undefined} as unknown as Parameters<typeof installModelRequestBudget>[0];
  const budget=new ModelRequestBudget({maxModelCalls:3,maxRequestBytes:10,maxTotalPayloadBytes:10},undefined,{requestBytesMode:'observe',totalBytesMode:'observe'});
  installModelRequestBudget(target,budget,observe);
  const context={systemPrompt:'Instructions',messages:[{role:'user',content:'中文'}, {role:'toolResult',toolName:'read_original',content:'original text'}],tools:[{name:'propose'}]};
  await target.streamFunction(model,context as never,{onPayload:target.onPayload});
  await target.streamFunction(model,{systemPrompt:'Summarize',messages:[]} as never);
  await recorder.finish('succeeded');
  const events=(await store.peekEvents(recorder.manifest.id)).filter(e=>e.data?.phase==='role-request-observation');expect(events).toHaveLength(4);
  const measurement=events[0]!.data!.measurement as ReturnType<typeof describeRequest>;
  expect(measurement.bytes).toBe(Buffer.byteLength(JSON.stringify(context)));expect(measurement.messages.map(m=>m.role)).toEqual(['user','toolResult']);expect(measurement.sections.map(s=>s.name)).toEqual(['systemPrompt','messages','tools']);expect(measurement.modelContextTokens).toBe(128000);expect(measurement.tokenEstimate).toBeNull();
  expect(JSON.stringify(await store.peekBlob(events[1]!.blobRef!))).not.toContain('very-secret-value');
  expect(budget.snapshot().modelCalls).toBe(2);expect(budget.snapshot().payloads).toBe(2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
it('fails closed before transport when required observation persistence fails',async()=>{
 const transport=vi.fn();
 const target={streamFunction:transport,onPayload:undefined} as unknown as Parameters<typeof installModelRequestBudget>[0];
 installModelRequestBudget(target,[],async()=>{throw Error('trace write failed');});
 await expect(target.streamFunction(model,{} as never)).rejects.toThrow('trace write failed');expect(transport).not.toHaveBeenCalled();
});
