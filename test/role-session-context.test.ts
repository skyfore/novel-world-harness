import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect,vi,afterEach} from 'vitest';
import type {AgentSessionEvent,ExtensionContext} from '@earendil-works/pi-coding-agent';
import {RoleSessionContext,runWithRoleContextRecovery} from '../src/workflow/role-session-context.js';
import type {RoleWorkInvocation} from '../src/workflow/role-review-bounded.js';
import {roleReviewBudget,inspectRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import type {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import {contentHash} from '../src/world/canonical.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const event=(value:unknown)=>value as AgentSessionEvent;
function fixtureWork(){
 const execute=vi.fn(async()=>({content:[{type:'text' as const,text:'committed'}],details:{}}));
 const work:RoleWorkInvocation={workId:'original-parent',prompt:'Original evidence 龙😀'.repeat(600),tools:[{name:'propose_original',label:'Original',description:'Original proposal',parameters:{type:'object'} as never,execute}],complete:()=>false,onContextInvalidated:vi.fn(),onContextRestored:vi.fn()};
 return {work,execute};
}
const invoke=(work:RoleWorkInvocation,name:string,input={})=>work.tools.find(t=>t.name===name)!.execute('call',input as never,undefined,undefined,{} as ExtensionContext);
async function restore(work:RoleWorkInvocation){let offset:number|undefined=0,text='';while(offset!==undefined){const result=await invoke(work,'read_role_session_context',{offset});const page=JSON.parse((result.content[0] as {text:string}).text);text+=page.text;offset=page.nextOffset;}return text;}
it('compaction invalidates evidence and blocks writes until exact original pages have been restored',async()=>{
 const f=fixtureWork(),context=new RoleSessionContext(f.work),w=context.invocation();
 w.onContextEvent!(event({type:'compaction_end',reason:'threshold',result:{summary:'not evidence'},aborted:false,willRetry:false}));
 expect(f.work.onContextInvalidated).toHaveBeenCalledOnce();
 await invoke(w,'propose_original');expect(f.execute).not.toHaveBeenCalled();
 expect(await restore(w)).toBe(f.work.prompt);expect(f.work.onContextRestored).toHaveBeenCalledOnce();
 await invoke(w,'propose_original');expect(f.execute).toHaveBeenCalledOnce();
 w.onContextEvent!(event({type:'compaction_end',reason:'threshold',result:{summary:'again'},aborted:false,willRetry:false}));
 await invoke(w,'propose_original');expect(f.execute).toHaveBeenCalledOnce();
 await expect(invoke(w,'read_role_session_context',{offset:999})).rejects.toThrow('copy nextOffset');
});
async function storeFixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-native-'));roots.push(root);const planHash=contentHash('plan'),limits={maxModelCalls:6,maxRequestBytes:48000,maxTotalPayloadBytes:1000000};const budget=roleReviewBudget(root,planHash,'original-parent',limits);budget.beginCall({});budget.close();return {root,planHash,limits,store:{root,planHash,journal:{assertModelRecoveryAllowed:()=>{},unresolved:()=>[]}} as unknown as RoleReviewWorkStore};}
const overflow=event({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'maximum context length exceeded',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}}});
it('falls back only after actual overflow, retains usage and persists a single recovery claim',async()=>{
 const f=await storeFixture(),{work}=fixtureWork();let calls=0;
 const run=async(w:RoleWorkInvocation)=>{calls++;if(calls===1){w.onContextEvent!(overflow);w.onContextEvent!(event({type:'compaction_end',reason:'overflow',aborted:false,willRetry:false,errorMessage:'cannot compact'}));throw Error('provider overflow');}expect(w.workId).toBe(work.workId);expect(w.prompt).not.toContain('龙');expect(w.retainedBudgetRequired).toBe(true);expect(await restore(w)).toBe(work.prompt);};
 const before=inspectRoleReviewBudget(f.root,f.planHash,work.workId);
 await runWithRoleContextRecovery(f.store,work,run);expect(calls).toBe(2);expect(inspectRoleReviewBudget(f.root,f.planHash,work.workId)).toEqual(before);
 await expect(runWithRoleContextRecovery(f.store,work,async w=>{w.onContextEvent!(overflow);throw Error('overflow');})).rejects.toThrow('already claimed');
});
it('never restarts proposal failures or unresolved obligations',async()=>{
 const f=await storeFixture(),{work}=fixtureWork(),run=vi.fn(async()=>{throw Error('invalid reference');});
 await expect(runWithRoleContextRecovery(f.store,work,run)).rejects.toThrow('invalid reference');expect(run).toHaveBeenCalledOnce();
 const g=await storeFixture();vi.spyOn(g.store.journal,'unresolved').mockReturnValue([{} as never]);
 await expect(runWithRoleContextRecovery(g.store,work,async w=>{w.onContextEvent!(overflow);throw Error('overflow');})).rejects.toThrow('unresolved proposal');
});
it('retains larger payload observations across budget reloads without clearing cumulative limits',async()=>{
 const f=await storeFixture(),b=roleReviewBudget(f.root,f.planHash,'original-parent',f.limits,true),payload={text:'x'.repeat(100000)};
 b.beginCall(payload);b.admitPayload(payload);const before=b.snapshot();b.close();
 const next=roleReviewBudget(f.root,f.planHash,'original-parent',f.limits,true);expect(next.snapshot()).toEqual(before);expect(next.report().requestBytesMode).toBe('observe');
 for(let i=before.modelCalls;i<f.limits.maxModelCalls;i++)next.beginCall({});expect(()=>next.beginCall({})).toThrow('model-call limit');next.close();
});

it('does not turn cancellation or a compaction provider outage into a new session',async()=>{
 const {work}=fixtureWork();
 for(const failure of ['abort','rate limit']){
  const f=await storeFixture();
  const run=vi.fn(async(w:RoleWorkInvocation)=>{w.onContextEvent!(overflow);w.onContextEvent!(event({type:'compaction_end',reason:'overflow',aborted:failure==='abort',willRetry:false,errorMessage:failure==='abort'?undefined:'429 rate limit'}));throw Error(failure);});
  await expect(runWithRoleContextRecovery(f.store,work,run)).rejects.toThrow(failure);expect(run).toHaveBeenCalledOnce();
 }
});

it('requires same-session refactor/read work before rebuilding and carries diagnostics into each bounded round',async()=>{
 const f=await storeFixture(),{work}=fixtureWork();
 work.tools.push({name:'preview_draft',label:'Preview',description:'Preview',parameters:{type:'object'} as never,execute:async()=>({content:[{type:'text',text:'{"valid":false,"diagnostic":"revise this draft"}'}],details:{}})});
 const rounds:number[]=[];
 await expect(runWithRoleContextRecovery(f.store,work,async w=>{
  rounds.push(w.sessionOrdinal!);
  if(w.sessionOrdinal){expect(w.prompt).toContain('preserve uncertainty');expect(await restore(w)).toBe(work.prompt);}
  const early=await invoke(w,'request_role_session_rebuild',{reason:'premature'});expect((early as {isError?:boolean}).isError).toBe(true);
  await invoke(w,'refactor_role_work',{diagnosis:'draft uncertain',revisionPlan:'preserve uncertainty',unresolvedQuestions:['Who acted?']});
  const stillEarly=await invoke(w,'request_role_session_rebuild',{reason:'premature'});expect((stillEarly as {isError?:boolean}).isError).toBe(true);
  await invoke(w,'preview_draft');
  await invoke(w,'request_role_session_rebuild',{reason:'reassess with original evidence'});
 })).rejects.toThrow('session limit reached');
 expect(rounds).toEqual([0,1,2]);
 await expect(runWithRoleContextRecovery(f.store,work,async()=>{throw Error('must not call');})).rejects.toThrow('already claimed');
});

it('observes cumulative bytes beyond the old cap but still blocks at the call count',async()=>{
 const f=await storeFixture(),limits={...f.limits,maxTotalPayloadBytes:100},workId='byte-observation';
 const b=roleReviewBudget(f.root,f.planHash,workId,limits);b.beginCall({text:'a'.repeat(60000)});b.admitPayload({text:'a'.repeat(60000)});b.close();
 const next=roleReviewBudget(f.root,f.planHash,workId,limits,true);expect(next.snapshot().totalPayloadBytes).toBeGreaterThan(100);expect(next.report().totalBytesMode).toBe('observe');
 for(let i=1;i<limits.maxModelCalls;i++)next.beginCall({});expect(()=>next.beginCall({})).toThrow('model-call limit');
});
