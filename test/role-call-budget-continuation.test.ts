import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {contentHash} from '../src/world/canonical.js';
import {worldStorageRoot} from '../src/world/paths.js';
import {roleReviewBudget,inspectRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import {inspectParentCallContinuation,grantParentCallContinuation,openParentCallContinuation,readParentCallContinuation} from '../src/compiler/role-call-budget-continuation.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
import {inspectStoppedRoleSession,runWithRoleContextRecovery} from '../src/workflow/role-session-context.js';
import type {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import type {RoleWorkInvocation} from '../src/workflow/role-review-bounded.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-call-continuation-'));roots.push(root);
 const planHash=contentHash('window'),childPlanHash=contentHash('role-plan'),workId='continuation-window',childWorkId='role-source-fixture-19';
 const limits={maxModelCalls:2,maxRequestBytes:48000,maxTotalPayloadBytes:100};
 const parent=roleReviewBudget(root,planHash,workId,limits);
 for(let i=0;i<2;i++){parent.beginCall({});parent.admitPayload({text:'x'.repeat(200)});}
 expect(()=>parent.beginCall({})).toThrow('model-call limit');parent.close();
 const child=roleReviewBudget(root,childPlanHash,childWorkId,{...limits,maxModelCalls:6});child.beginCall({});child.admitPayload({});
 const trace=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:'source',operationId:'batch'});
 await trace.record('validation.completed',{phase:'role-review-work',workId:childWorkId,planHash:childPlanHash});
 await trace.record('validation.completed',{phase:'role-review-work-stopped',workId:childWorkId,budget:child.report()});
 await trace.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:'Error: Model request budget exhausted: model-call limit reached.',retryable:false});child.close();
 const input={planHash,workId,sourceId:'source',batchId:'batch',failedRunId:trace.manifest.id,expectedBudgetHash:inspectRoleReviewBudget(root,planHash,workId).hash,additionalCalls:2,auditRef:'user-authorized-resume',implementationRef:'tested-recovery'};
 const preview=await inspectParentCallContinuation(root,input);
 return {root,input,preview,childPlanHash,childWorkId};
}
it('preserves the exhausted original, all cumulative charges and the new bounded stop across restarts',async()=>{
 const f=await fixture(),original=inspectRoleReviewBudget(f.root,f.input.planHash,f.input.workId);
 await grantParentCallContinuation(f.root,f.input,f.preview.authorityHash);
 const next=openParentCallContinuation(f.root,f.input);expect(next.snapshot()).toEqual(original.state.usage);
 expect(next.limits.maxModelCalls).toBe(4);next.beginCall({});next.admitPayload({text:'large'});next.close();
 const again=openParentCallContinuation(f.root,f.input);expect(again.snapshot().modelCalls).toBe(3);again.beginCall({});
 expect(()=>again.beginCall({})).toThrow('model-call limit');again.close();
 expect(()=>openParentCallContinuation(f.root,f.input).beginCall({})).toThrow('retained hard stop');
 expect(inspectRoleReviewBudget(f.root,f.input.planHash,f.input.workId)).toEqual(original);
 await expect(grantParentCallContinuation(f.root,f.input,f.preview.authorityHash)).rejects.toMatchObject({code:'EEXIST'});
});
it('rejects stale previews, unrelated traces and implicit budget enlargement',async()=>{
 const f=await fixture();
 await expect(grantParentCallContinuation(f.root,f.input,contentHash('stale'))).rejects.toThrow('authority changed');
 await expect(inspectParentCallContinuation(f.root,{...f.input,sourceId:'other'})).rejects.toThrow('trace does not establish');
 await expect(inspectParentCallContinuation(f.root,{...f.input,additionalCalls:121})).rejects.toThrow('invalid bounded');
 await grantParentCallContinuation(f.root,f.input,f.preview.authorityHash);
 const record=JSON.parse(await fs.readFile(f.preview.file,'utf8'));record.authority.limits.maxModelCalls=1000;
 record.authorityHash=contentHash(record.authority);await fs.writeFile(f.preview.file,JSON.stringify(record));
 expect(()=>readParentCallContinuation(f.root,f.input)).toThrow('lineage changed');
});
it('fails closed on pending usage publication and regression',async()=>{
 const f=await fixture();await grantParentCallContinuation(f.root,f.input,f.preview.authorityHash);
 openParentCallContinuation(f.root,f.input).close();
 const file=f.preview.file+'.usage.json';await fs.writeFile(file+'.pending','pending');
 expect(()=>openParentCallContinuation(f.root,f.input)).toThrow('uncertain parent');await fs.unlink(file+'.pending');
 const record=JSON.parse(await fs.readFile(file,'utf8'));record.state.usage.modelCalls=0;record.hash=contentHash({authorityHash:record.authorityHash,state:record.state});await fs.writeFile(file,JSON.stringify(record));
 expect(()=>openParentCallContinuation(f.root,f.input)).toThrow('usage regressed');
});
it('resumes only the exact stopped task in the next original context round, once',async()=>{
 const f=await fixture();await grantParentCallContinuation(f.root,f.input,f.preview.authorityHash);
 let complete=false;
 const work:RoleWorkInvocation={workId:f.childWorkId,prompt:'Immutable original evidence',tools:[],complete:()=>complete};
 const taskHash=contentHash(work.prompt),dir=path.join(worldStorageRoot(f.root),'compiler','role-review-work','context-loops',f.childPlanHash,contentHash(work.workId),taskHash);
 const claim={planHash:f.childPlanHash,workId:work.workId,taskHash,ordinal:0};
 await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'0.json'),JSON.stringify({claim,hash:contentHash(claim)}));
 const store={root:f.root,planHash:f.childPlanHash,plan:{sourceId:'source',batchId:'batch'},journal:{assertModelRecoveryAllowed:()=>{},unresolved:()=>[]}} as unknown as RoleReviewWorkStore;
 const resume={planHash:f.input.planHash,workId:f.input.workId,authorityHash:f.preview.authorityHash};
 const run=vi.fn(async(w:RoleWorkInvocation)=>{expect(w.sessionOrdinal).toBe(1);expect(w.retainedBudgetRequired).toBe(true);expect(w.prompt).toContain('read_role_session_context');complete=true;});
 await expect(runWithRoleContextRecovery(store,{...work,prompt:'Changed task'},run,undefined,resume)).rejects.toThrow('differs');
 expect(run).not.toHaveBeenCalled();
 await runWithRoleContextRecovery(store,work,run,undefined,resume);expect(run).toHaveBeenCalledOnce();
 await expect(inspectStoppedRoleSession(store,resume)).rejects.toThrow('already consumed');
 expect(inspectRoleReviewBudget(f.root,f.childPlanHash,f.childWorkId).state.usage.modelCalls).toBe(1);
});
