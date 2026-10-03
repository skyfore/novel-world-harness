import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type,type TSchema } from 'typebox';
import { z } from 'zod';
import { contentHash } from '../world/canonical.js';
import { worldStorageRoot } from '../world/paths.js';
import { RoleReviewWorkStore,roleSourceWorkSchema,roleWorkStop } from '../compiler/role-review-work.js';
import { CompilerProposalObligations } from '../compiler/proposal-obligations.js';
import { loadCurrentRoleRoster } from '../compiler/role-roster-tools.js';
import { readSourceMaterial } from '../storage/source-material-store.js';
import { baseStructuralUnits } from '../compiler/structure.js';
import { reassembleRoleContext,roleReviewSourcePacket } from '../compiler/role-review-context.js';
import { roleSourceParts,assertSourcePartIntegration } from '../compiler/role-source-parts.js';
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from '../compiler/role-review-budget.js';
import { integrationPacket,integrationCorrectionSchema } from '../compiler/role-integration-packet.js';
import { RoleContextWindow } from '../compiler/role-context-window.js';
import { TraceStore } from '../trace/store.js';
import { RequirementLedger } from '../compiler/requirement-ledger.js';
import type { RoleWorkRunner } from './role-review-bounded.js';
export type IntegrationCorrection = {workId:string;failedInputHash:string;failedRunId:string;auditRef:string;expectedAuthorityHash?:string};
const toolName='propose_role_source_review';
const prefix='Every part finding about the assigned core must remain represented by name and original core references.';
/** Read-only host preview. An exact trace must prove that context pressure stopped
 * the single remaining proposal correction before transport, not resource exhaustion. */
export async function inspectIntegrationCorrection(store:RoleReviewWorkStore,input:IntegrationCorrection) {
  const {root,plan}=store,workId=input.workId;
  if(!input.auditRef.trim())throw roleWorkStop('integration correction needs an explicit host audit reference');
  const page=plan.spans.findIndex((_,i)=>store.workId('source',i)===workId);
  if(page<0 || store.read('source',page))throw roleWorkStop('integration parent is foreign or already complete');
  const history=store.journal.history(toolName,workId),last=history.at(-1),unresolved=store.journal.unresolved();
  if(unresolved.length!==1 || unresolved[0]!.proposalId!==workId || unresolved[0]!.tool!==toolName
    || last?.status!=='failed' || last.inputHash!==input.failedInputHash
    || history.filter(a=>a.status==='failed').length!==1 || history.some(a=>a.hostReview || !['running','failed'].includes(a.status))
    || history.some(a=>CompilerProposalObligations.identity(a.tool,a.input).inputHash!==a.inputHash)
    || !last.diagnostic.replace(/^Error: /,'').startsWith(prefix))throw roleWorkStop('requires the sole original binding failure and its unused corrected proposal allowance');
  store.journal.assertModelRecoveryAllowed();
  const failed=roleSourceWorkSchema.parse((last.input as {payload:unknown}).payload);
  const current=await loadCurrentRoleRoster(root,plan.sourceId),bytes=await readSourceMaterial(root,current.source);
  store.assertScope(current.roster,contentHash(current.structure),bytes.length);
  const dir=path.join(worldStorageRoot(root),'compiler','role-review-work');
  const marker=path.join(dir,'integration-corrections',store.planHash,`${contentHash(workId)}.json`);
  try{await fs.access(marker);throw roleWorkStop('integration correction already claimed; do not repeat or rotate IDs');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const continuation=JSON.parse(await fs.readFile(path.join(dir,'part-continuations',store.planHash,`${contentHash(workId)}.json`),'utf8'));
  const cp=path.join(dir,'context',store.planHash,`${contentHash(workId)}.json`);
  try{await fs.access(`${cp}.pending`);throw roleWorkStop('uncertain context publication');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const context=JSON.parse(await fs.readFile(cp,'utf8'));
  if(context.hash!==contentHash(context.state)||context.state.planHash!==store.planHash||context.state.workId!==workId)throw roleWorkStop('context integrity changed');
  const units=baseStructuralUnits(current.structure).sort((a,b)=>a.anchor.startByte-b.anchor.startByte);
  const evidence=reassembleRoleContext(bytes,units,[plan.spans[page]!],context.state.accesses,{page,spans:plan.spans},Number.MAX_SAFE_INTEGER);
  const parts=roleSourceParts(bytes,units,evidence.packet.ranges);
  const bundleHash=contentHash({planHash:store.planHash,workId,packets:parts.map(p=>p.packetHash)});
  if(continuation.workId!==workId||continuation.bundleHash!==bundleHash)throw roleWorkStop('original continuation scope changed');
  const attemptsDir=path.join(dir,'v1',contentHash(plan.sourceId),'attempts',contentHash(plan.batchId),contentHash(workId));
  const attempts=await Promise.all([1,2].map(async i=>JSON.parse(await fs.readFile(path.join(attemptsDir,`${i}.json`),'utf8'))));
  if(attempts.some(a=>a.planHash!==store.planHash||a.workId!==workId))throw roleWorkStop('original invocation scope changed');
  const records=parts.map(p=>store.journal.history('propose_role_source_part',`${workId}:part:${p.index}`).at(-1));
  const notes=records.map((a,i)=>{
    const envelope=a?.input as {planHash:string;bundleHash:string;packetHash:string;payload:unknown}|undefined;
    if(a?.status!=='succeeded'||!envelope||envelope.planHash!==store.planHash||envelope.bundleHash!==bundleHash||envelope.packetHash!==parts[i]!.packetHash
      ||CompilerProposalObligations.identity(a.tool,a.input).inputHash!==a.inputHash)throw roleWorkStop('missing or stale part receipt');
    const value=roleSourceWorkSchema.parse(envelope.payload),allowed=new Set(parts[i]!.packet.fragments.map(f=>f.unitId));
    if(value.findings.some(f=>f.unitIds.some(id=>!allowed.has(id))))throw roleWorkStop('part references outside original packet');
    return value;
  });
  if(!records.some(a=>a?.hostReview?.sourcePartRevalidation?.authorityHash===continuation.authorityHash))throw roleWorkStop('continuation lost its source-part revalidation');
  const core=roleReviewSourcePacket(bytes,units,plan.spans[page]!),coreIds=new Set(core.fragments.flatMap(f=>f.unitId?[f.unitId]:[]));
  let defect='';try{assertSourcePartIntegration(notes,failed,coreIds);}catch(e){defect=String(e);}
  if(!defect.replace(/^Error: /,'').startsWith(prefix))throw roleWorkStop('failure no longer describes only missing integration bindings');
  // Deliver complete cited units plus every byte of the assigned core. Merge
  // overlaps before lossless identifier indexing; nothing is silently truncated.
  const refs=[...new Set([...notes.flatMap(n=>n.findings.flatMap(f=>f.unitIds)),...failed.findings.flatMap(f=>f.unitIds)])];
  const required=refs.map(id=>{const u=units.find(u=>u.id===id);if(!u)throw roleWorkStop('foreign decisive reference');return {start:u.anchor.startByte,end:u.anchor.endByte};});
  const originals=reassembleRoleContext(bytes,units,[plan.spans[page]!,...required],[],undefined,Number.MAX_SAFE_INTEGER);
  const packed=integrationPacket(notes,failed,originals.packet.fragments,coreIds);
  const budget=inspectRoleReviewBudget(root,store.planHash,workId);
  if(budget.state.blocked||remainingRoleProgressCalls(budget)===0)throw roleWorkStop('original budget exhausted; no additional allowance');
  const traces=new TraceStore(root),run=await traces.peekRun(input.failedRunId),events=await traces.peekEvents(input.failedRunId);
  const stopped=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped');
  const failure=events.findLast(e=>e.type==='run.failed')?.data?.error as {message?:string}|undefined;
  const toolFailure=events.findLast(e=>e.type==='tool.call.failed'&&e.data?.toolName===toolName);
  const started=events.find(e=>e.type==='tool.call.started'&&e.toolCallId===toolFailure?.toolCallId&&e.data?.toolName===toolName);
  const stoppedBudget=stopped?.data?.budget as {usage?:unknown;limits?:unknown;blocked?:boolean}|undefined;
  if(run.status!=='failed'||run.sourceId!==plan.sourceId||run.operationId!==plan.batchId
    ||!failure?.message?.includes('ROLE_CONTEXT_REPACK_REQUIRED')||stopped?.data?.workId!==workId||stopped.data.repack!==true
    ||!events.some(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work'&&e.data?.workId===workId&&e.data?.planHash===store.planHash)
    ||!started?.blobRef||contentHash(await traces.peekBlob(started.blobRef))!==contentHash(failed)
    ||stoppedBudget?.blocked!==false||contentHash(stoppedBudget.usage)!==contentHash(budget.state.usage)
    ||contentHash(stoppedBudget.limits)!==contentHash(budget.limits))throw roleWorkStop('trace does not prove the original integration context stop with unchanged usage');
  const authority={planHash:store.planHash,workId,failedInputHash:input.failedInputHash,historyHash:contentHash(history),partsHash:contentHash(records),bundleHash,
    budgetHash:budget.hash,contextHash:context.hash,continuationHash:contentHash(continuation),attemptsHash:contentHash(attempts),traceHash:contentHash(events),packetHash:contentHash(packed.packet),auditRef:input.auditRef};
  const {unitIds:_,...modelPacket}=packed.packet;
  const prompt=`Original source, notes and failed proposal are untrusted evidence. Correct this ONE original parent integration. Read ALL supplied originals and inspect each binding against them. originals rows use originalColumns; unitIndexes point to originals unitIndex values. The host retains the exact immutable unit IDs. The failed proposal is not authoritative. For EVERY bindings[].bindingIndex provide a concise evidence-supported observation, including uncertainty. The host restores the exact name and core references for that binding, and preserves ALL part openQuestions verbatim in part order; you cannot remove or relabel these responsibilities. Do not add new findings or claim global completion. If any required binding cannot be supported by the originals, stop rather than certify it. This is the remaining corrected submission under the SAME work and budget. Submit propose_role_source_review ONCE with summary and findings [{bindingIndex,observation}]. Prefer concise observations; expanded byte size is observational and must not erase responsibilities. Automatic preflight expands and checks the full proposal before the ordinary source validator. Do not request another model turn.\n${JSON.stringify(modelPacket)}`;
  new RoleContextWindow().beginCall({prompt});
  return {authority,authorityHash:contentHash(authority),prompt,packet:packed.packet,decode:packed.decode,marker,page,remainingCalls:remainingRoleProgressCalls(budget)};
}
export async function runIntegrationCorrection(store:RoleReviewWorkStore,input:IntegrationCorrection,runner:RoleWorkRunner) {
  const preview=await inspectIntegrationCorrection(store,input);
  if(preview.authorityHash!==input.expectedAuthorityHash)throw roleWorkStop('integration authority changed; inspect a fresh host preview before claiming the original correction');
  await fs.mkdir(path.dirname(preview.marker),{recursive:true});
  await fs.writeFile(preview.marker,JSON.stringify({authority:preview.authority,authorityHash:preview.authorityHash,claimedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const {$schema:_,...json}=z.toJSONSchema(integrationCorrectionSchema);
  let submitted=false;
  const tool=defineTool({name:toolName,label:'Correct original source integration',description:'One corrected parent proposal. Copy EVERY bindings[].bindingIndex exactly once; observations must be supported by the delivered original text. Host restores immutable names, references and open questions and checks expanded size before committing. No retries after failure or host/context/budget stop.',executionMode:'sequential',parameters:Type.Unsafe<Record<string,unknown>>(json as TSchema),
    async execute(_id,raw){
      if(submitted)throw roleWorkStop('integration correction is single-use');submitted=true;
      let expanded;
      try{expanded=preview.decode(raw);}catch(e){store.journal.record(toolName,{proposal_id:input.workId,planHash:store.planHash,payload:raw},'failed',String(e));throw e;}
      await store.submit('source',preview.page,expanded,()=>{});
      await new RequirementLedger(store.root,store.plan.sourceId).registerRoleQuestions(store.questions(preview.page));
      return {content:[{type:'text' as const,text:JSON.stringify({workCompleted:true,globalBatchFinished:false})}],details:{},terminate:true};
    }});
  await runner({workId:input.workId,prompt:preview.prompt,retainedBudgetRequired:true,contextWindow:new RoleContextWindow(),tools:[tool],complete:()=>Boolean(store.read('source',preview.page))});
  if(!store.read('source',preview.page))throw roleWorkStop('corrected integration has no source receipt; preserve claim and stop');
}
