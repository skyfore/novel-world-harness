import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {createEvidenceFixture} from './helpers/evidence.js';
import {CanonicalModelStore} from '../src/world/canonical-model.js';
import {contentHash} from '../src/world/canonical.js';
import {worldStorageRoot} from '../src/world/paths.js';
import {ensureSourceStructure,baseStructuralUnits} from '../src/compiler/structure.js';
import {loadCurrentRoleRoster} from '../src/compiler/role-roster-tools.js';
import {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import {RequirementLedger} from '../src/compiler/requirement-ledger.js';
import {RoleContextCheckpoint} from '../src/compiler/role-context-window.js';
import {roleReviewBudget,inspectRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import {inspectRoleCandidateContinuation,claimRoleCandidateContinuation} from '../src/compiler/role-candidate-continuation.js';
import {withWorkspaceOperationLock} from '../src/util/workspace-lock.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
import {PiAgentSession} from '../src/agent/pi-session.js';
import {runBoundedRoleReview} from '../src/workflow/role-review-bounded.js';
import {continueRoleCandidate} from '../src/workflow/role-candidate-continuation.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(options:{toolFailure?:boolean;pending?:boolean;mutation?:boolean;otherFailure?:boolean;searchOnly?:boolean;interrupted?:boolean;secondContext?:boolean;productionTask?:boolean}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwh-candidate-continuation-'));roots.push(root);
 const f=await createEvidenceFixture(root,'Hero opens the door.\n');await ensureSourceStructure(root,f.source);
 await new CanonicalModelStore(root).putEntity({id:'hero',canonicalName:'Hero',kind:'character',aliases:[],evidence:f.evidence('Hero')});
 const {roster,structure}=await loadCurrentRoleRoster(root,f.source.id),candidateId=roster.candidates[0]!.id,batchId=`role-roster-${f.source.id}-continuation`;
 const store=await RoleReviewWorkStore.open(root,{version:1,sourceId:f.source.id,sourceHash:roster.sourceSha256,subjectHash:roster.subjectHash,batchId,
  structureHash:contentHash(structure),spans:[{start:0,end:f.source.bytes}],legacyDraftHashes:[]});
 await store.submit('source',0,{summary:'Hero opens a door',findings:[],openQuestions:[]},()=>{});
 const workId='candidate-'+candidateId,unit=baseStructuralUnits(structure)[0]!;
 const workflowOptions={root,sourceId:f.source.id,compilerBatchId:batchId,configPath:path.join(root,'absent.yaml')};
 let taskHash=contentHash('original prompt');
 if(options.productionTask){
  const stopped=new Error('fixture: retain original candidate task');
  await expect(runBoundedRoleReview({...workflowOptions,candidateWorkScope:{planHash:store.planHash,atlasRevision:store.atlasRevision(),candidateIds:[candidateId]}},async work=>{
   taskHash=contentHash(work.prompt);throw stopped;
  })).rejects.toBe(stopped);
 }else await store.beginAttempt(workId);
 const checkpoint=await RoleContextCheckpoint.open(root,store.planHash,workId,taskHash);
 const contextDir=path.join(worldStorageRoot(root),'compiler','role-review-work','context-loops',store.planHash,contentHash(workId),taskHash);
 await fs.mkdir(contextDir,{recursive:true});const claim={planHash:store.planHash,workId,taskHash,ordinal:0};
 await fs.writeFile(path.join(contextDir,'0.json'),JSON.stringify({claim,hash:contentHash(claim)}));
 if(options.secondContext)await fs.writeFile(path.join(contextDir,'1.json'),'{}');
 const budget=roleReviewBudget(root,store.planHash,workId,{maxModelCalls:3,maxRequestBytes:48000,maxTotalPayloadBytes:100000},false,'progress');
 const recorder=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:f.source.id,operationId:batchId});
 await recorder.record('validation.completed',{phase:'role-review-work',planHash:store.planHash,workId});
 for(let i=0;i<3;i++){budget.beginCall({});await recorder.record('llm.request.started',{});}
 if(!options.interrupted)try{budget.beginCall({});}catch{}
 await recorder.record('validation.completed',{phase:'role-request-observation',planHash:store.planHash,workId,logicalTaskHash:taskHash,sessionOrdinal:0,evidenceEpoch:0});
 const call=async(name:string,args:unknown,body:unknown,last=false)=>{
  const id='call-'+name,result={content:[{type:'text',text:JSON.stringify(body)}]};
  await recorder.record('tool.call.started',{toolName:name},recorder.rootContext,{toolCallId:id,blobRef:await recorder.putBlob(args)});
  if(last&&options.pending)return;
  await recorder.record(last&&options.toolFailure?'tool.call.failed':'tool.call.completed',{toolName:name},recorder.rootContext,{toolCallId:id,blobRef:await recorder.putBlob(result)});
  await checkpoint.record(name,args,result);
 };
 await call('read_role_review_atlas',{}, {pages:[{page:0,summary:'Hero opens a door'}]});
 await call(options.mutation?'propose_role_roster_entry':'read_role_work_evidence',options.searchOnly?{query:'Hero'}:{unitId:unit.id},{units:[{unitId:unit.id,excerpt:'Hero'}]},true);
 await recorder.record('validation.completed',{phase:'role-review-work-stopped',workId,compactions:[],budget:budget.report()});
 await recorder.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:options.otherFailure?'Error: quota':options.interrupted?'AbortError: Request was aborted':`Error: ${inspectRoleReviewBudget(root,store.planHash,workId).state.failure!.message}`,retryable:false});budget.close();
 await new RequirementLedger(root,f.source.id).recordRoleEvidenceNeed(store.planHash,workId,{question:'Judge Hero',missing:'Candidate judgment',decisionImpact:'Blocks role review',searchedUnitIds:[],requestedUnitIds:[unit.id]});
 return {root,store,workId,roster,unit,workflowOptions,input:{sourceId:f.source.id,batchId,candidateId,runId:recorder.manifest.id,auditRef:'Reviewed same-source read-only stop',implementationRef:'fixture',
  diagnosis:options.interrupted?'host-aborted-read-only' as const:'read-only-no-progress' as const,additionalCalls:2}};
}
it.each([false,true])('charges the finite host revision cumulatively, leaving original history intact (interrupted=%s)',async interrupted=>{
 const f=await fixture({interrupted}),before=inspectRoleReviewBudget(f.root,f.store.planHash,f.workId);
 const preview=await inspectRoleCandidateContinuation(f.root,f.input);await expect(fs.stat(preview.file)).rejects.toMatchObject({code:'ENOENT'});
 await withWorkspaceOperationLock(f.root,'compiler',async()=>{
  const grant=await claimRoleCandidateContinuation(f.root,f.input,preview.authorityHash);
  expect(grant.budget.snapshot().modelCalls).toBe(3);grant.budget.beginCall({});grant.budget.beginCall({});
  expect(()=>grant.budget.beginCall({})).toThrow('model-call limit');grant.budget.close();
  expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.workId)).toEqual(before);
  await expect(claimRoleCandidateContinuation(f.root,f.input,preview.authorityHash)).rejects.toThrow('already claimed');
 });
 expect(f.store.stagedEntries()).toEqual([]);expect(f.store.sourceComplete()).toBe(true);
});
it('keeps searched-only references as navigation, without claiming evidence delivery',async()=>{
 const f=await fixture({searchOnly:true}),preview=await inspectRoleCandidateContinuation(f.root,f.input);
 expect(preview.authority.evidenceUnitIds).toEqual([]);expect(preview.authority.discoveredUnitIds).toHaveLength(1);
});
it.each([
 [{toolFailure:true},'tool failure'],[{pending:true},'settled source navigation'],[{mutation:true},'read-only work'],
 [{otherFailure:true},'exact retained stop'],[{secondContext:true},'session allowance'],
] as const)('refuses an unsupported continuation: %j',async(options,message)=>{
 const f=await fixture(options);await expect(inspectRoleCandidateContinuation(f.root,f.input)).rejects.toThrow(message);
});
it('requires lock ownership and an unchanged authority',async()=>{
 const f=await fixture(),p=await inspectRoleCandidateContinuation(f.root,f.input);
 await expect(claimRoleCandidateContinuation(f.root,f.input,p.authorityHash)).rejects.toThrow('compiler lock');
 await withWorkspaceOperationLock(f.root,'compiler',async()=>{
  await expect(claimRoleCandidateContinuation(f.root,{...f.input,additionalCalls:3},p.authorityHash)).rejects.toThrow('authority changed');
 });
});

it.each(['success','unread','exhausted'] as const)('runs the candidate continuation with real proposal and budget gates: %s',async mode=>{
 const f=await fixture({productionTask:true}),preview=await inspectRoleCandidateContinuation(f.root,f.input);
 const originalBudget=inspectRoleReviewBudget(f.root,f.store.planHash,f.workId);
 const entry={candidateId:f.input.candidateId,importance:'incidental',rationale:'Only one opening action is established',basisUnitIds:[f.unit.id],
  developmentExpectation:{kind:'unknown',rationale:'No lasting change is established',basisUnitIds:[f.unit.id]}};
 const create=vi.spyOn(PiAgentSession,'create').mockImplementation(async options=>{
  const budget=Array.isArray(options.requestBudget)?options.requestBudget[0]!:options.requestBudget!;
  return {promptWithReport:async()=>{
   expect(budget.snapshot().modelCalls).toBe(3);budget.beginCall({});
   const tools=options.additionalTools!;
   expect(tools.some(t=>['request_role_session_rebuild','request_role_work_evidence'].includes(t.name))).toBe(false);
   const call=(name:string,input:unknown)=>tools.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{} as ExtensionContext);
   if(mode==='exhausted'){budget.beginCall({});budget.beginCall({});}
   if(mode==='success')await call('read_role_work_evidence',{unitId:f.unit.id});
   await call('preview_role_roster_review',{subjectHash:f.roster.subjectHash,partial:true,entries:[entry],missingMajorCharacters:[]});
   await call('propose_role_roster_entry',{subjectHash:f.roster.subjectHash,entry});
  },dispose:async()=>{},abort:async()=>{}} as unknown as PiAgentSession;
 });
 const run=continueRoleCandidate(f.workflowOptions,f.input,preview.authorityHash);
 if(mode==='success'){
  await expect(run).resolves.toMatchObject({status:'succeeded'});
  expect(f.store.stagedEntries()).toEqual([entry]);
  await new RequirementLedger(f.root,f.input.sourceId).assertRoleEvidenceNeedsResolved(f.store.planHash);
 }else{
  await expect(run).rejects.toThrow(mode==='exhausted'?'model-call limit':'evidence');
  expect(f.store.stagedEntries()).toEqual([]);
 }
 expect(create).toHaveBeenCalledOnce();expect(f.store.claimAudits()).toEqual([]);
 expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.workId)).toEqual(originalBudget);
 const result=JSON.parse(await fs.readFile(preview.file+'.result.json','utf8'));
 expect(result.status).toBe(mode==='success'?'succeeded':'failed');
 expect(result.usage.usage.modelCalls).toBe(mode==='exhausted'?5:4);
 await expect(continueRoleCandidate(f.workflowOptions,f.input,preview.authorityHash)).rejects.toThrow(/already claimed|unfinished original candidate|host review/);
 expect(create).toHaveBeenCalledOnce();
});
