import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from '../world/canonical.js';
import { worldStorageRoot } from '../world/paths.js';
import { RoleReviewWorkStore, roleSourceWorkSchema, roleWorkStop } from './role-review-work.js';
import { CompilerProposalObligations } from './proposal-obligations.js';
import { loadCurrentRoleRoster } from './role-roster-tools.js';
import { readSourceMaterial } from '../storage/source-material-store.js';
import { baseStructuralUnits } from './structure.js';
import { reassembleRoleContext } from './role-review-context.js';
import { roleSourceParts } from './role-source-parts.js';
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from './role-review-budget.js';
import { TraceStore } from '../trace/store.js';
export type PartCitationCorrection = {workId:string; proposalId:string; failedInputHash:string; failedRunId:string; auditRef:string; expectedAuthorityHash?:string};
const TOOL='propose_role_source_part';
/** Host-only, read-only inspection of one unused citation correction. No new
 * invocation, handoff or budget is granted. The original interrupted partition
 * may continue once, with all historical failures retained. */
export async function inspectPartCitationCorrection(store:RoleReviewWorkStore,input:PartCitationCorrection) {
  const {root,plan}=store,{workId,proposalId}=input;
  const page=plan.spans.findIndex((_,i)=>store.workId('source',i)===workId);
  if(!input.auditRef.trim()||page<0||store.read('source',page)||store.journal.history('propose_role_source_review',workId).length)throw roleWorkStop('citation correction requires an unfinished original partition parent and audit reference');
  const history=store.journal.history(TOOL,proposalId),last=history.at(-1),unresolved=store.journal.unresolved();
  if(unresolved.length!==1||unresolved[0]!.tool!==TOOL||unresolved[0]!.proposalId!==proposalId||last?.status!=='failed'||last.inputHash!==input.failedInputHash
    ||history.filter(a=>a.status==='failed').length!==1||history.some(a=>a.hostReview||!['running','failed'].includes(a.status)||CompilerProposalObligations.identity(a.tool,a.input).inputHash!==a.inputHash)
    ||!last.diagnostic.includes('Copy findings[].unitIds from this part packet fragments[].unitId'))throw roleWorkStop('requires the sole original citation failure with one unused correction');
  store.journal.assertModelRecoveryAllowed();
  const dir=path.join(worldStorageRoot(root),'compiler','role-review-work');
  const marker=path.join(dir,'part-citation-corrections',store.planHash,`${contentHash(workId)}.json`);
  try{await fs.access(marker);throw roleWorkStop('part citation correction already claimed; do not retry');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const cp=path.join(dir,'context',store.planHash,`${contentHash(workId)}.json`);
  try{await fs.access(`${cp}.pending`);throw roleWorkStop('uncertain context publication; do not retry');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const context=JSON.parse(await fs.readFile(cp,'utf8'));
  if(context.hash!==contentHash(context.state)||context.state.planHash!==store.planHash||context.state.workId!==workId)throw roleWorkStop('original context integrity changed');
  const attemptsDir=path.join(dir,'v1',contentHash(plan.sourceId),'attempts',contentHash(plan.batchId),contentHash(workId));
  const attempts=await Promise.all([1,2].map(async i=>JSON.parse(await fs.readFile(path.join(attemptsDir,`${i}.json`),'utf8'))));
  if(attempts.some(a=>a.planHash!==store.planHash||a.workId!==workId))throw roleWorkStop('original invocation scope changed');
  const current=await loadCurrentRoleRoster(root,plan.sourceId),bytes=await readSourceMaterial(root,current.source);
  store.assertScope(current.roster,contentHash(current.structure),bytes.length);
  const units=baseStructuralUnits(current.structure).sort((a,b)=>a.anchor.startByte-b.anchor.startByte);
  const evidence=reassembleRoleContext(bytes,units,[plan.spans[page]!],context.state.accesses,{page,spans:plan.spans},Number.MAX_SAFE_INTEGER);
  const parts=roleSourceParts(bytes,units,evidence.packet.ranges),part=parts.find(p=>proposalId===`${workId}:part:${p.index}`);
  const bundleHash=contentHash({planHash:store.planHash,workId,packets:parts.map(p=>p.packetHash)});
  const envelope=last.input as {planHash:string;bundleHash:string;packetHash:string;payload:unknown};
  if(!part||envelope.planHash!==store.planHash||envelope.bundleHash!==bundleHash||envelope.packetHash!==part.packetHash)throw roleWorkStop('original part scope changed');
  const failed=roleSourceWorkSchema.parse(envelope.payload),allowed=new Set(part.packet.fragments.map(f=>f.unitId));
  if(!failed.findings.some(f=>f.unitIds.some(id=>!allowed.has(id))))throw roleWorkStop('no original citation defect remains');
  const receipts=parts.map(p=>store.journal.history(TOOL,`${workId}:part:${p.index}`).at(-1));
  for(const p of parts){
    if(p.index===part.index)continue;
    const a=receipts[p.index],old=a?.input as typeof envelope|undefined;
    if(p.index>part.index){if(a)throw roleWorkStop('later part already attempted');continue;}
    if(a?.status!=='succeeded'||!old||old.planHash!==store.planHash||old.bundleHash!==bundleHash||old.packetHash!==p.packetHash||CompilerProposalObligations.identity(TOOL,a.input).inputHash!==a.inputHash)throw roleWorkStop('missing or stale earlier part');
    const ids=new Set(p.packet.fragments.map(f=>f.unitId));
    if(roleSourceWorkSchema.parse(old.payload).findings.some(f=>f.unitIds.some(id=>!ids.has(id))))throw roleWorkStop('invalid earlier part citations');
  }
  const budget=inspectRoleReviewBudget(root,store.planHash,workId),remainingCalls=remainingRoleProgressCalls(budget);
  if(budget.state.blocked||remainingCalls<parts.length-part.index+1)throw roleWorkStop('insufficient retained parent budget for remaining parts and integration');
  const traces=new TraceStore(root),run=await traces.peekRun(input.failedRunId),events=await traces.peekEvents(input.failedRunId);
  const stopped=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped');
  const failure=events.findLast(e=>e.type==='run.failed')?.data?.error as {message?:string}|undefined;
  const toolFailure=events.findLast(e=>e.type==='tool.call.failed'&&e.data?.toolName===TOOL);
  const started=events.find(e=>e.type==='tool.call.started'&&e.toolCallId===toolFailure?.toolCallId&&e.data?.toolName===TOOL);
  const stoppedBudget=stopped?.data?.budget as {usage?:unknown;limits?:unknown;blocked?:boolean}|undefined;
  if(run.status!=='failed'||run.sourceId!==plan.sourceId||run.operationId!==plan.batchId||!failure?.message?.includes('ROLE_CONTEXT_REPACK_REQUIRED')
    ||stopped?.data?.workId!==workId||stopped.data.repack!==true
    ||!events.some(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work'&&e.data?.workId===workId&&e.data?.planHash===store.planHash)
    ||!started?.blobRef||contentHash(await traces.peekBlob(started.blobRef))!==contentHash(failed)
    ||stoppedBudget?.blocked!==false||contentHash(stoppedBudget.usage)!==contentHash(budget.state.usage)||contentHash(stoppedBudget.limits)!==contentHash(budget.limits))throw roleWorkStop('trace does not prove original citation context stop with unchanged usage');
  const authority={planHash:store.planHash,workId,proposalId,failedInputHash:input.failedInputHash,historyHash:contentHash(history),receiptsHash:contentHash(receipts),bundleHash,contextHash:context.hash,attemptsHash:contentHash(attempts),budgetHash:budget.hash,traceHash:contentHash(events),auditRef:input.auditRef};
  return {authority,authorityHash:contentHash(authority),marker,failed,partIndex:part.index,remainingCalls};
}
export async function claimPartCitationCorrection(store:RoleReviewWorkStore,input:PartCitationCorrection,bundleHash:string){
  const preview=await inspectPartCitationCorrection(store,input);
  if(preview.authorityHash!==input.expectedAuthorityHash||preview.authority.bundleHash!==bundleHash)throw roleWorkStop('citation correction authority changed; inspect a fresh host preview');
  await fs.mkdir(path.dirname(preview.marker),{recursive:true});
  await fs.writeFile(preview.marker,JSON.stringify({authority:preview.authority,authorityHash:preview.authorityHash,claimedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  return preview;
}
