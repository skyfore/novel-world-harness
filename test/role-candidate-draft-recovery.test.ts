import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createEvidenceFixture} from './helpers/evidence.js';
import {ensureSourceStructure,baseStructuralUnits} from '../src/compiler/structure.js';
import {CanonicalModelStore} from '../src/world/canonical-model.js';
import {contentHash} from '../src/world/canonical.js';
import {loadCurrentRoleRoster} from '../src/compiler/role-roster-tools.js';
import {RoleRosterStore} from '../src/compiler/role-roster.js';
import {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import {roleReviewBudget,inspectRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import {inspectRoleCandidateDraftRecovery,recoverRoleCandidateDraft} from '../src/compiler/role-candidate-draft-recovery.js';
import {RequirementLedger} from '../src/compiler/requirement-ledger.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>fs.rm(r,{recursive:true,force:true})));});
async function fixture(options:{blocked?:boolean;gap?:boolean;changedText?:boolean;failure?:string;pending?:boolean;proposal?:boolean;epoch?:number;schemaOmission?:boolean}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwh-candidate-draft-'));roots.push(root);
 const text='Hero opens the door.\n';const f=await createEvidenceFixture(root,text);await ensureSourceStructure(root,f.source);
 await new CanonicalModelStore(root).putEntity({id:'hero',canonicalName:'Hero',kind:'character',aliases:[],evidence:f.evidence('Hero')});
 const {roster,structure}=await loadCurrentRoleRoster(root,f.source.id),candidateId=roster.candidates[0]!.id,batchId=`role-roster-${f.source.id}-draft`;
 const store=await RoleReviewWorkStore.open(root,{version:1,sourceId:f.source.id,sourceHash:roster.sourceSha256,subjectHash:roster.subjectHash,batchId,
  structureHash:contentHash(structure),spans:[{start:0,end:f.source.bytes}],legacyDraftHashes:[]});
 await store.submit('source',0,{summary:'Hero opens the door',findings:[],openQuestions:[]},()=>{});
 const unit=baseStructuralUnits(structure)[0]!,workId='candidate-'+candidateId;
 const original=Buffer.from(text).subarray(unit.anchor.startByte,unit.anchor.endByte).toString('utf8');
 const entry={candidateId,importance:'incidental',rationale:'A single opening action',basisUnitIds:[unit.id],
  developmentExpectation:{kind:'unknown',rationale:'This passage does not establish lasting change',basisUnitIds:[unit.id]}};
 const preview={subjectHash:roster.subjectHash,entries:[entry],partial:true,missingMajorCharacters:[]};
 const budget=roleReviewBudget(root,store.planHash,workId,{maxModelCalls:3,maxRequestBytes:48000,maxTotalPayloadBytes:100000},false,'progress');
 const recorder=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:f.source.id,operationId:batchId});
 await recorder.record('validation.completed',{phase:'role-review-work',planHash:store.planHash,workId});
 for(let i=0;i<3;i++){budget.beginCall({});await recorder.record('llm.request.started',{});}
 if(options.blocked)try{budget.beginCall({});}catch{}
 await recorder.record('validation.completed',{phase:'role-request-observation',planHash:store.planHash,workId,evidenceEpoch:options.epoch??0,sessionOrdinal:0});
 const call=async(name:string,args:unknown,result:unknown,failed=false)=>{
  const toolCallId='call-'+name;await recorder.record('tool.call.started',{toolName:name},recorder.rootContext,{toolCallId,blobRef:await recorder.putBlob(args)});
  if(!options.pending||name!=='preview_role_roster_review')await recorder.record(failed?'tool.call.failed':'tool.call.completed',{toolName:name},recorder.rootContext,{toolCallId,blobRef:await recorder.putBlob(result)});
 };
 const delivered=Array.from(original).slice(options.gap?1:0).join('');
 await call('read_role_work_evidence',{unitId:unit.id},{content:[{type:'text',text:JSON.stringify({units:[{unitId:unit.id,text:options.changedText?'wrong':delivered,startOffset:options.gap?1:0,endOffset:Array.from(original).length}]})}]});
 if(options.schemaOmission){
  const {missingMajorCharacters,...omitted}=preview;
  await call('preview_role_roster_review',omitted,{content:[{type:'text',text:'Validation failed for tool "preview_role_roster_review":\n  - missingMajorCharacters: must have required properties missingMajorCharacters\n\nReceived arguments:'+JSON.stringify(omitted)}]},true);
 }
 await call('preview_role_roster_review',preview,{content:[{type:'text',text:options.failure??'ROLE_REVIEW_WORK_HOST_REQUIRED: claim or atlas changed after audit. Stop; preserve history.'}]},true);
 if(options.proposal)await call('propose_role_roster_entry',{subjectHash:roster.subjectHash,entry},{content:[{type:'text',text:'failed proposal'}]},true);
 await recorder.record('validation.completed',{phase:'role-review-work-stopped',workId,budget:budget.report(),compactions:[]});
 await recorder.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:options.blocked?`Error: ${inspectRoleReviewBudget(root,store.planHash,workId).state.failure!.message}`:'Error: ROLE_REVIEW_WORK_HOST_REQUIRED: model ended without the assigned work receipt.',retryable:false});budget.close();
 const input={sourceId:f.source.id,batchId,candidateId,runId:recorder.manifest.id,auditRef:'fixture verified host preview defect'};
 const ledger=new RequirementLedger(root,f.source.id);await ledger.recordRoleEvidenceNeed(store.planHash,workId,{question:'Complete candidate',missing:'No candidate receipt',decisionImpact:'Blocks role review',searchedUnitIds:[],requestedUnitIds:[unit.id]});
 return {root,f,store,workId,entry,input,ledger};
}
it.each([false,true])('recovers only the retained draft without renewing even a blocked budget (%s)',async blocked=>{
 const f=await fixture({blocked}),before=inspectRoleReviewBudget(f.root,f.store.planHash,f.workId),sourceHash=contentHash(f.store.read('source',0));
 const preview=await inspectRoleCandidateDraftRecovery(f.root,f.input);expect(preview.input.entry).toEqual(f.entry);
 expect(f.store.stagedEntries()).toEqual([]);await expect(fs.stat(preview.file)).rejects.toMatchObject({code:'ENOENT'});
 const result=await recoverRoleCandidateDraft(f.root,{...f.input,expectedAuthorityHash:preview.authorityHash});
 expect(result).toMatchObject({modelCallsAdded:0,semanticSupport:'not-verified',certified:false});expect(f.store.stagedEntries()).toEqual([f.entry]);
 expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.workId)).toEqual(before);expect(contentHash(f.store.read('source',0))).toBe(sourceHash);
 expect(await new RoleRosterStore(f.root).read(f.f.source.id)).toBeNull();expect(f.store.auditComplete()).toBe(false);
 await f.ledger.assertRoleEvidenceNeedsResolved(f.store.planHash);
 await expect(recoverRoleCandidateDraft(f.root,{...f.input,expectedAuthorityHash:preview.authorityHash})).rejects.toThrow('proposal history');
});
it('retains the one completed schema correction before the independent host defect',async()=>{
 const f=await fixture({schemaOmission:true}),before=inspectRoleReviewBudget(f.root,f.store.planHash,f.workId);
 const preview=await inspectRoleCandidateDraftRecovery(f.root,f.input);
 await recoverRoleCandidateDraft(f.root,{...f.input,expectedAuthorityHash:preview.authorityHash});
 expect(f.store.stagedEntries()).toEqual([f.entry]);expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.workId)).toEqual(before);
});
it.each([
 [{gap:true},'complete original evidence'],[{changedText:true},'immutable source'],[{failure:'Different host failure'},'not solely'],
 [{pending:true},'ambiguous'],[{proposal:true},'another mutation'],[{epoch:1},'unchanged evidence context'],
] as const)('rejects unproved recovery: %j',async(options,message)=>{
 const f=await fixture(options);await expect(inspectRoleCandidateDraftRecovery(f.root,f.input)).rejects.toThrow(message);expect(f.store.stagedEntries()).toEqual([]);
});
it('rejects changed authority and keeps a consumed claim after uncertain publication',async()=>{
 const f=await fixture(),p=await inspectRoleCandidateDraftRecovery(f.root,f.input);
 await expect(recoverRoleCandidateDraft(f.root,{...f.input,auditRef:'changed review',expectedAuthorityHash:p.authorityHash})).rejects.toThrow('authority changed');
 await fs.mkdir(path.dirname(p.file),{recursive:true});await fs.writeFile(p.file,JSON.stringify({authority:p.authority,authorityHash:p.authorityHash}));
 await expect(inspectRoleCandidateDraftRecovery(f.root,f.input)).rejects.toThrow('already claimed');expect(f.store.stagedEntries()).toEqual([]);
});
