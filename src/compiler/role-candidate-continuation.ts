import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {TraceStore} from '../trace/store.js';
import {WorkspaceOperationLock} from '../util/workspace-lock.js';
import {ModelRequestBudget,type ModelRequestBudgetState} from '../runtime/model-request-budget.js';
import {inspectRoleReviewBudget} from './role-review-budget.js';
import {RoleReviewWorkStore,roleWorkStop} from './role-review-work.js';
import {loadCurrentRoleRoster} from './role-roster-tools.js';
import {CompilerFinishReceipts} from './finish-receipts.js';
import {RequirementLedger} from './requirement-ledger.js';
import {baseStructuralUnits} from './structure.js';

const inputSchema=z.object({sourceId:z.string().min(1),batchId:z.string().min(1),candidateId:z.string().min(1),
 runId:z.string().min(1),auditRef:z.string().min(1),implementationRef:z.string().min(1),
 diagnosis:z.enum(['read-only-no-progress','host-aborted-read-only']),additionalCalls:z.number().int().min(1).max(12)}).strict();
export type RoleCandidateContinuationInput=z.infer<typeof inputSchema>;
const absent=async(file:string)=>{try{await fs.access(file);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}};

/** Explicit host revision after inspecting a settled, entirely read-only work.
 * The old stop is immutable. One second physical session gets a finite total
 * allowance with cumulative usage, original IDs, and no proposal retry grant. */
export async function inspectRoleCandidateContinuation(root:string,raw:RoleCandidateContinuationInput){
 const input=inputSchema.parse(raw),traces=new TraceStore(root);
 const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>p.batchId===input.batchId);
 if(!plan)throw roleWorkStop('candidate continuation plan missing; discover with RoleReviewWorkStore.plans and copy batchId');
 const store=new RoleReviewWorkStore(root,plan),current=await loadCurrentRoleRoster(root,input.sourceId);
 store.assertScope(current.roster,contentHash(current.structure),current.structure.sourceBytes);
 store.journal.assertModelRecoveryAllowed();
 const workId='candidate-'+input.candidateId;
 if(!store.sourceComplete()||!current.roster.candidates.some(c=>c.id===input.candidateId)||store.journal.unresolved().length
  ||store.journal.history('propose_role_roster_entry','role-entry-'+input.candidateId).length
  ||await new CompilerFinishReceipts(root,input.sourceId,input.batchId).read())throw roleWorkStop('candidate continuation requires an unfinished original candidate without proposal history');
 const base=path.join(worldStorageRoot(root),'compiler','role-review-work'),key=contentHash(workId);
 const file=path.join(base,'candidate-continuations',store.planHash,key+'.json');
 if(!await absent(file))throw roleWorkStop('candidate continuation already claimed; inspect its result, never renew its allowance');
 const budget=inspectRoleReviewBudget(root,store.planHash,workId),run=await traces.peekRun(input.runId),events=await traces.peekEvents(input.runId);
 if(run.kind!=='prepare'||run.status!=='failed'||!run.endedAt||run.sourceId!==input.sourceId||run.operationId!==input.batchId
  ||run.error?.code!=='ROLE_REVIEW_WORK_FAILED'||run.counts.llmRequests!==budget.state.usage.modelCalls
  ||(budget.state.progress?.lastProgressCall??0)!==0||(budget.state.progress?.milestones.length??0)!==0)throw roleWorkStop('original settled candidate usage or failure changed');
 if(input.diagnosis==='read-only-no-progress' ? !budget.state.blocked||budget.state.failure?.code!=='no-progress'||run.error.message!==`Error: ${budget.state.failure.message}`
  : budget.state.blocked||Boolean(budget.state.failure)||run.error.message!=='AbortError: Request was aborted')throw roleWorkStop('host diagnosis does not match the exact retained stop');
 const work=events.find(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work')?.data;
 const stop=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped')?.data;
 const observations=events.filter(e=>e.type==='validation.completed'&&e.data?.phase==='role-request-observation');
 const taskHash=observations[0]?.data?.logicalTaskHash;
 if(work?.planHash!==store.planHash||work.workId!==workId||typeof taskHash!=='string'||!observations.length
  ||observations.some(e=>e.data?.logicalTaskHash!==taskHash||e.data?.sessionOrdinal!==0||e.data?.evidenceEpoch!==0||e.data?.planHash!==store.planHash||e.data?.workId!==workId)
  ||stop?.workId!==workId||!Array.isArray(stop.compactions)||stop.compactions.length
  ||contentHash((stop.budget as {usage?:unknown}|undefined)?.usage??null)!==contentHash(budget.state.usage))throw roleWorkStop('candidate continuation requires one intact original context');
 const contextRoot=path.join(base,'context-loops',store.planHash,key);
 if(contentHash(await fs.readdir(contextRoot))!==contentHash([taskHash]))throw roleWorkStop('ambiguous original candidate task');
 const contextDir=path.join(contextRoot,taskHash);
 if(contentHash(await fs.readdir(contextDir))!==contentHash(['0.json']))throw roleWorkStop('candidate physical session allowance already used');
 const priorClaim=JSON.parse(await fs.readFile(path.join(contextDir,'0.json'),'utf8'));
 if(priorClaim.hash!==contentHash(priorClaim.claim)||priorClaim.claim.planHash!==store.planHash||priorClaim.claim.workId!==workId||priorClaim.claim.taskHash!==taskHash||priorClaim.claim.ordinal!==0)throw roleWorkStop('original candidate context claim changed');
 const attemptDir=path.join(base,'v1',contentHash(input.sourceId),'attempts',contentHash(input.batchId),key);
 if(contentHash(await fs.readdir(attemptDir))!==contentHash(['1.json']))throw roleWorkStop('candidate continuation cannot grant another invocation attempt');
 const attempt=JSON.parse(await fs.readFile(path.join(attemptDir,'1.json'),'utf8'));
 if(attempt.planHash!==store.planHash||attempt.workId!==workId)throw roleWorkStop('candidate invocation identity changed');
 const checkpointFile=path.join(base,'context',store.planHash,key+'.json');
 if(!await absent(checkpointFile+'.pending'))throw roleWorkStop('uncertain candidate context publication; do not continue');
 const checkpoint=JSON.parse(await fs.readFile(checkpointFile,'utf8'));
 if(checkpoint.hash!==contentHash(checkpoint.state)||checkpoint.state.packetHash!==taskHash||checkpoint.state.planHash!==store.planHash||checkpoint.state.workId!==workId||checkpoint.state.handoffs.length)throw roleWorkStop('original candidate checkpoint changed');
 const pending=new Map<string,typeof events[number]>(),evidenceUnitIds=new Set<string>(),discoveredUnitIds=new Set<string>(),navigation:unknown[]=[];
 const unitIds=new Set(baseStructuralUnits(current.structure).map(u=>u.id));
 for(const event of events){
  const id=event.toolCallId??event.callId??event.spanId;
  if(event.type==='tool.call.started'){
   if(pending.has(id)||!['read_role_review_atlas','read_role_review_notes','read_role_work_evidence'].includes(String(event.data?.toolName)))throw roleWorkStop('candidate continuation only permits diagnosed read-only work; inspect drafts or mutations separately');
   pending.set(id,event);
  }else if(event.type==='tool.call.failed')throw roleWorkStop('candidate has a tool failure; diagnose it before any continuation');
  else if(event.type==='tool.call.completed'){
   const start=pending.get(id);if(!start?.blobRef||!event.blobRef)throw roleWorkStop('candidate tool publication is uncertain');pending.delete(id);
   const args=await traces.peekBlob(start.blobRef) as Record<string,unknown>;
   const result=await traces.peekBlob(event.blobRef) as {isError?:boolean;content?:Array<{type:string;text?:string}>};
   if(result.isError)throw roleWorkStop('candidate read returned a tool error');
   if(start.data?.toolName==='read_role_work_evidence'&&typeof args.unitId==='string'){
    if(!unitIds.has(args.unitId))throw roleWorkStop('original candidate read names a foreign unit');evidenceUnitIds.add(args.unitId);
   }
   if(start.data?.toolName==='read_role_work_evidence'&&typeof args.query==='string'){
    const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw roleWorkStop('original evidence discovery missing');
    const body=JSON.parse(text) as {units?:Array<{unitId?:string}>};
    for(const unit of body.units??[]){if(!unit.unitId||!unitIds.has(unit.unitId))throw roleWorkStop('original search returned a foreign unit');discoveredUnitIds.add(unit.unitId);}
   }
   if(start.data?.toolName==='read_role_review_atlas'&&args.page===undefined&&args.query===undefined){
    const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw roleWorkStop('original atlas directory result missing');navigation.push(JSON.parse(text));
   }
  }
 }
 if(pending.size||!(evidenceUnitIds.size+discoveredUnitIds.size)||!navigation.length)throw roleWorkStop('candidate lacks settled source navigation for a focused continuation');
 const history=await new RequirementLedger(root,input.sourceId).history();
 const need=history.find(r=>r.payload.kind==='role-review-evidence-need'&&r.payload.planHash===store.planHash&&r.payload.workId===workId);
 if(!need||history.some(r=>r.payload.kind==='role-review-evidence-resolution'&&r.payload.needRef===contentHash(need.payload)))throw roleWorkStop('original candidate evidence need is missing or already resolved');
 const authority={version:1,policy:'host-reviewed-candidate-evidence-replay/v1',input,planHash:store.planHash,workId,taskHash,
  atlasRevision:store.atlasRevision(),sourceHash:plan.sourceHash,budget,traceHash:contentHash(events),runHash:contentHash(run),
  priorClaimHash:priorClaim.hash,checkpointHash:checkpoint.hash,attemptHash:contentHash(attempt),needRef:contentHash(need.payload),
  evidenceUnitIds:[...evidenceUnitIds],discoveredUnitIds:[...discoveredUnitIds],navigationHash:contentHash(navigation),contextDir,
  limits:{...budget.limits,maxModelCalls:budget.state.usage.modelCalls+input.additionalCalls}};
 return {authority,authorityHash:contentHash(authority),file,navigation};
}

/** The caller holds the compiler lock through the single continuation. */
export async function claimRoleCandidateContinuation(root:string,input:RoleCandidateContinuationInput,expectedHash:string){
 if((await WorkspaceOperationLock.inspect(root)).owner?.pid!==process.pid)throw roleWorkStop('candidate continuation needs the owning host compiler lock');
 const preview=await inspectRoleCandidateContinuation(root,input);
 if(preview.authorityHash!==expectedHash)throw roleWorkStop('candidate continuation authority changed; inspect before claiming');
 await fs.mkdir(path.dirname(preview.file),{recursive:true});
 await fs.writeFile(preview.file,JSON.stringify(preview),{flag:'wx',mode:0o600});
 const claim={planHash:preview.authority.planHash,workId:preview.authority.workId,taskHash:preview.authority.taskHash,ordinal:1,
  budgetHash:preview.authority.budget.hash,recoveryInfo:{authorityHash:expectedHash,policy:preview.authority.policy},at:new Date().toISOString()};
 await fs.writeFile(path.join(preview.authority.contextDir,'1.json'),JSON.stringify({claim,hash:contentHash(claim)}),{flag:'wx',mode:0o600});
 const usageFile=preview.file+'.usage.json';
 const initial:ModelRequestBudgetState={usage:preview.authority.budget.state.usage,blocked:false};
 const save=(state:ModelRequestBudgetState)=>{
  const record={authorityHash:expectedHash,state};
  syncFs.writeFileSync(usageFile+'.pending',JSON.stringify({...record,hash:contentHash(record)}),{flag:'wx',mode:0o600});
  syncFs.renameSync(usageFile+'.pending',usageFile);
 };
 if(!await absent(usageFile)||!await absent(usageFile+'.pending'))throw roleWorkStop('candidate continuation usage already exists; never restart');
 save(initial);
 const budget=new ModelRequestBudget(preview.authority.limits,{initial,save},{modelCallsMode:'enforce',requestBytesMode:'observe',totalBytesMode:'observe'});
 return {...preview,budget};
}
