import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {ToolDefinition,ExtensionContext} from '@earendil-works/pi-coding-agent';
import {ModelRequestBudget,type ModelRequestBudgetState} from '../src/runtime/model-request-budget.js';
import {roleReviewBudget,inspectRoleReviewBudget,remainingRoleProgressCalls} from '../src/compiler/role-review-budget.js';
import {roleProgressTools} from '../src/workflow/role-validated-progress.js';
import type {RoleWorkInvocation} from '../src/workflow/role-review-bounded.js';
import {contentHash} from '../src/world/canonical.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const limits={maxModelCalls:3,maxRequestBytes:10000,maxTotalPayloadBytes:100000};
const tool=(name:string,value:unknown,isError=false):ToolDefinition=>({name,label:name,description:name,parameters:{type:'object'} as never,execute:async()=>({content:[{type:'text',text:JSON.stringify(value)}],details:{},isError})});
async function invoke(work:RoleWorkInvocation,budget:ModelRequestBudget,name:string,value:unknown,options={recovery:false,isError:false}) {
 const [wrapped]=roleProgressTools({...work,tools:[tool(name,value,options.isError)]},budget,()=>options.recovery);
 return wrapped!.execute('call',{} as never,undefined,undefined,{} as ExtensionContext);
}
const work=(prompt='Original immutable part'):RoleWorkInvocation=>({workId:'same-parent',prompt,logicalTaskHash:contentHash(prompt),tools:[],complete:()=>false});
it('never reopens a blocked budget through a retained draft or credits a model-supplied preflight',async()=>{
 const b=new ModelRequestBudget(limits,undefined,{modelCallsMode:'progress'}),w=work();
 b.beginCall({});
 await invoke(w,b,'read_role_work_evidence',{hostDraftPreview:{valid:true}});
 await invoke({...w,revalidateDraft:()=>({valid:false,inputHash:contentHash('draft')})},b,'read_role_work_evidence',{});
 expect(b.report().progress?.milestones).toEqual([]);
 b.beginCall({});b.beginCall({});expect(()=>b.beginCall({})).toThrow('no new validated progress');
 await expect(invoke({...w,revalidateDraft:()=>({valid:true,inputHash:contentHash('draft')})},b,'read_role_work_evidence',{})).rejects.toThrow('no new validated progress');
 expect(b.report().progress?.milestones).toEqual([]);
});
it('keeps productive validated parts running beyond the old total while preserving a rolling stall boundary',async()=>{
 const budget=new ModelRequestBudget(limits,undefined,{modelCallsMode:'progress'});
 for(let part=0;part<20;part++){
  const w=work('Original immutable part '+part);
  for(let i=0;i<3;i++)budget.beginCall({});
  await invoke({...w,complete:()=>true},budget,'propose_role_source_part',{workCompleted:true});
 }
 expect(budget.snapshot().modelCalls).toBe(60);expect(budget.report().progress?.callsWithoutProgress).toBe(0);
 for(let i=0;i<3;i++)budget.beginCall({});
 expect(()=>budget.beginCall({})).toThrow('no new validated progress');
 expect(()=>budget.recordValidatedProgress('late-result')).toThrow('no new validated progress');
});
it('never credits repeated drafts, renamed preview tools, model assertions, failed proposals or ordinary reads',async()=>{
 const b=new ModelRequestBudget(limits,undefined,{modelCallsMode:'progress'}),w=work();
 b.beginCall({});await invoke(w,b,'preview_role_source_review',{valid:true,draft:'first'});
 b.beginCall({});
 await invoke(w,b,'preview_role_source_review',{valid:true,draft:'reworded'});
 await invoke(w,b,'preview_role_other',{valid:true});
 await invoke(w,b,'read_role_work_evidence',{valid:true,progress:true});
 await invoke(w,b,'refactor_role_work',{valid:true,progress:true});
 await invoke({...w,complete:()=>true},b,'propose_role_source_review',{valid:true},{recovery:false,isError:true});
 await invoke(w,b,'propose_role_source_review',{workCompleted:true});
 b.beginCall({});b.beginCall({});
 expect(b.report().progress?.milestones).toEqual([`draft:${w.logicalTaskHash}`]);
 expect(()=>b.beginCall({})).toThrow('no new validated progress');
});
it('credits only complete original-task restoration after real recovery, once per immutable task',async()=>{
 const b=new ModelRequestBudget(limits,undefined,{modelCallsMode:'progress'}),w=work();b.beginCall({});
 await invoke(w,b,'read_role_session_context',{complete:true,taskHash:w.logicalTaskHash});
 await invoke(w,b,'read_role_session_context',{complete:false,taskHash:w.logicalTaskHash},{recovery:true,isError:false});
 await invoke(w,b,'read_role_session_context',{complete:true,taskHash:contentHash('other')},{recovery:true,isError:false});
 expect(b.report().progress?.milestones).toEqual([]);
 await invoke(w,b,'read_role_session_context',{complete:true,taskHash:w.logicalTaskHash},{recovery:true,isError:false});b.beginCall({});
 await invoke(w,b,'read_role_session_context',{complete:true,taskHash:w.logicalTaskHash},{recovery:true,isError:false});
 expect(b.report().progress?.callsWithoutProgress).toBe(1);
});
it('credits a structurally valid roster draft once despite stale downstream audits, without reopening stopped work',async()=>{
 const b=new ModelRequestBudget(limits,undefined,{modelCallsMode:'progress'}),w=work();
 const draft={structuralValid:true,complete:false,requiresHostReview:false,unresolvedObligations:[],unreadSourcePages:[],
  auditStatus:{staleSourceAudits:130,staleClaimAudits:26},semanticSupport:'not-verified'};
 b.beginCall({});
 for(const invalid of [{...draft,structuralValid:false},{...draft,requiresHostReview:true},
  {...draft,unresolvedObligations:[{status:'failed'}]},{...draft,unreadSourcePages:[1]}]) {
  await invoke(w,b,'preview_role_roster_review',invalid);
 }
 await invoke(w,b,'preview_role_roster_review',draft,{recovery:false,isError:true});
 expect(b.report().progress?.milestones).toEqual([]);
 await invoke(w,b,'preview_role_roster_review',draft);
 expect(b.report().progress?.milestones).toEqual([`draft:${w.logicalTaskHash}`]);
 for(let i=0;i<3;i++){b.beginCall({});await invoke(w,b,'preview_role_roster_review',draft);}
 expect(b.report().progress?.callsWithoutProgress).toBe(3);
 expect(()=>b.beginCall({})).toThrow('no new validated progress');
 await expect(invoke(w,b,'preview_role_roster_review',draft)).rejects.toThrow('no new validated progress');
});
it('persists verified milestones and stalled calls across fresh sessions without resetting cumulative usage',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-stall-'));roots.push(root);const plan=contentHash('plan');
 const first=roleReviewBudget(root,plan,'work',limits,false,'progress');
 first.beginCall({});first.beginCall({});first.recordValidatedProgress('accepted-part-0');first.beginCall({});first.close();
 const second=roleReviewBudget(root,plan,'work',limits,true,'progress');second.beginCall({});
 expect(second.recordValidatedProgress('accepted-part-0')).toBe(false);second.beginCall({});
 const stored=inspectRoleReviewBudget(root,plan,'work');expect(stored.state.usage.modelCalls).toBe(5);expect(remainingRoleProgressCalls(stored)).toBe(0);
 expect(()=>second.beginCall({})).toThrow('no new validated progress');second.close();
 const third=roleReviewBudget(root,plan,'work',limits,true,'progress');
 expect(()=>third.beginCall({})).toThrow('retained hard stop');
 expect(third.snapshot().modelCalls).toBe(5);
});
it('does not erase legacy blocked states and fails closed when progress publication fails',()=>{
 const initial:ModelRequestBudgetState={usage:{modelCalls:3,payloads:0,totalPayloadBytes:0,largestRequestBytes:2},blocked:true,failure:{code:'call-limit',message:'legacy stop'}};
 const b=new ModelRequestBudget(limits,{initial,save:()=>{}},{modelCallsMode:'progress'});
 expect(()=>b.beginCall({})).toThrow('retained hard stop');
 const broken=new ModelRequestBudget(limits,{save:()=>{throw Error('disk failure');}},{modelCallsMode:'progress'});
 expect(()=>broken.recordValidatedProgress('accepted')).toThrow('usage publication failed');expect(broken.isBlocked()).toBe(true);
 expect(()=>new ModelRequestBudget(limits,{initial:{...initial,blocked:false,progress:{lastProgressCall:4,milestones:[]}},save:()=>{}},{modelCallsMode:'progress'})).toThrow('Invalid persisted progress');
});
it('allows an explicitly observational aggregate to cross its historical total and reports that policy',()=>{
 const budget=new ModelRequestBudget(limits,undefined,{modelCallsMode:'observe'});
 for(let i=0;i<20;i++)budget.beginCall({});
 expect(budget.snapshot().modelCalls).toBe(20);expect(budget.report().modelCallsMode).toBe('observe');budget.close();
 expect(()=>budget.beginCall({})).toThrow('already ended');
});
