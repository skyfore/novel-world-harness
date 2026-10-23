import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {withWorkspaceOperationLock} from '../util/workspace-lock.js';
import {TraceStore} from '../trace/store.js';
import {readSourceMaterial} from '../storage/source-material-store.js';
import {baseStructuralUnits} from './structure.js';
import {createRoleRosterTools,loadCurrentRoleRoster,roleRosterEntryInputSchema} from './role-roster-tools.js';
import {createCompilerProposalToolset} from './proposal-tools.js';
import {CompilerProposalObligations} from './proposal-obligations.js';
import {CompilerFinishReceipts} from './finish-receipts.js';
import {RoleReviewWorkStore,roleWorkStop} from './role-review-work.js';
import {inspectRoleReviewBudget} from './role-review-budget.js';
import {roleEntryEvidence} from './role-review-verification.js';
import {RequirementLedger} from './requirement-ledger.js';

const inputSchema=z.object({sourceId:z.string().min(1),batchId:z.string().min(1),candidateId:z.string().min(1),
 runId:z.string().min(1),auditRef:z.string().min(1),expectedAuthorityHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export type RoleCandidateDraftRecovery=z.infer<typeof inputSchema>;
type ToolResult={content?:Array<{type:string;text?:string}>;isError?:boolean};
function jsonResult(raw:unknown):Record<string,unknown>{
 const result=raw as ToolResult,block=result.content?.find(c=>c.type==='text');
 if(result.isError||!block?.text)throw roleWorkStop('candidate recovery requires an intact successful tool result');
 return JSON.parse(block.text) as Record<string,unknown>;
}

/** Recover the exact last model draft blocked solely by the retired preview
 * audit-order bug. No model call, budget renewal, semantic certification or
 * proposal correction allowance is granted. The original trace is evidence
 * of a proposal and source delivery, never an instruction to the host. */
export async function inspectRoleCandidateDraftRecovery(root:string,raw:RoleCandidateDraftRecovery){
 const input=inputSchema.parse(raw),traces=new TraceStore(root);
 const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>p.batchId===input.batchId);
 if(!plan)throw roleWorkStop('original candidate plan missing; discover it with RoleReviewWorkStore.plans and copy batchId');
 const store=new RoleReviewWorkStore(root,plan),current=await loadCurrentRoleRoster(root,input.sourceId);
 const bytes=await readSourceMaterial(root,current.source),units=baseStructuralUnits(current.structure);
 store.assertScope(current.roster,contentHash(current.structure),bytes.length);
 const workId='candidate-'+input.candidateId;
 if(!current.roster.candidates.some(c=>c.id===input.candidateId)||!store.sourceComplete())throw roleWorkStop('candidate identity or source coverage is incomplete');
 store.journal.assertModelRecoveryAllowed();
 if(store.journal.unresolved().length||await new CompilerFinishReceipts(root,input.sourceId,input.batchId).read())throw roleWorkStop('candidate recovery requires an unfinished batch without unresolved proposals');
 const proposal={subjectHash:current.roster.subjectHash,...(current.roster.reviewRevisionId?{reviewRevisionId:current.roster.reviewRevisionId}:{}),entry:{candidateId:input.candidateId}};
 const identity=CompilerProposalObligations.identity('propose_role_roster_entry',proposal);
 if(store.journal.history('propose_role_roster_entry',identity.proposalId).length)throw roleWorkStop('candidate already has a proposal history; this recovery cannot retry or replace it');
 const file=path.join(worldStorageRoot(root),'compiler','role-review-work','candidate-draft-recoveries',store.planHash,contentHash(workId)+'.json');
 try{await fs.access(file);throw roleWorkStop('candidate draft recovery already claimed; inspect its original publication, never repeat it');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const run=await traces.peekRun(input.runId),events=await traces.peekEvents(input.runId),budget=inspectRoleReviewBudget(root,store.planHash,workId);
 const work=events.find(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work')?.data;
 if(run.kind!=='prepare'||run.status!=='failed'||!run.endedAt||run.sourceId!==input.sourceId||run.operationId!==input.batchId
  ||run.error?.code!=='ROLE_REVIEW_WORK_FAILED'||!(/model ended without the assigned work receipt/.test(run.error.message)
    ||(budget.state.failure?.code==='no-progress'&&run.error.message===`Error: ${budget.state.failure.message}`))
  ||work?.workId!==workId||work.planHash!==store.planHash||run.counts.llmRequests!==budget.state.usage.modelCalls
  ||(budget.state.failure&&budget.state.failure.code!=='no-progress'))throw roleWorkStop('trace and retained candidate usage do not establish this original settled work');
 const observations=events.filter(e=>e.type==='validation.completed'&&e.data?.phase==='role-request-observation');
 if(!observations.length||observations.some(e=>e.data?.evidenceEpoch!==0||e.data?.sessionOrdinal!==0
  ||e.data?.workId!==workId||e.data?.planHash!==store.planHash))throw roleWorkStop('candidate draft recovery requires one unchanged evidence context');
 const stop=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped')?.data;
 if(!stop||stop.workId!==workId||!Array.isArray(stop.compactions)||stop.compactions.length
  ||contentHash((stop.budget as {usage?:unknown}|undefined)?.usage??null)!==contentHash(budget.state.usage))throw roleWorkStop('candidate stop or context evidence changed');
 const previews=events.filter(e=>e.type==='tool.call.started'&&e.data?.toolName==='preview_role_roster_review');
 if(!previews.length)throw roleWorkStop('no retained candidate draft; do not fabricate a replacement');
 const last=previews.at(-1)!;
 const pending=new Map<string,typeof last>();
 const delivery=new Map<string,Array<{start:number;end:number}>>();
 if(!last.blobRef)throw roleWorkStop('retained draft input missing');
 const previewInput=await traces.peekBlob(last.blobRef) as Record<string,unknown>;
 let failedPreviews=0,schemaCorrections=0;
 for(const event of events){
  const key=event.toolCallId??event.callId??event.spanId;
  if(event.type==='tool.call.started'){
   if(pending.has(key))throw roleWorkStop('ambiguous original tool call identity');
   if(!['read_role_review_atlas','read_role_review_notes','read_role_work_evidence','preview_role_roster_review'].includes(String(event.data?.toolName)))throw roleWorkStop('original work includes another mutation or recovery; inspect it separately');
   pending.set(key,event);
  }else if(event.type==='tool.call.completed'||event.type==='tool.call.failed'){
   const started=pending.get(key);if(!started||!started.blobRef||!event.blobRef)throw roleWorkStop('original tool receipt is incomplete');
   pending.delete(key);
   const args=await traces.peekBlob(started.blobRef) as Record<string,unknown>,result=await traces.peekBlob(event.blobRef);
   if(event.type==='tool.call.failed'){
    const text=(result as ToolResult).content?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n')??'';
    const correctedRequiredEmptyField=started===previews[0]&&previews.length===2&&started!==last&&schemaCorrections===0
      &&!Object.hasOwn(args,'missingMajorCharacters')&&contentHash({...args,missingMajorCharacters:[]})===contentHash(previewInput)
      &&text.startsWith('Validation failed for tool "preview_role_roster_review":\n  - missingMajorCharacters: must have required properties missingMajorCharacters\n\nReceived arguments:');
    if(started.data?.toolName!=='preview_role_roster_review'||(!text.startsWith('ROLE_REVIEW_WORK_HOST_REQUIRED: claim or atlas changed after audit.')&&!correctedRequiredEmptyField))throw roleWorkStop('original tool failure is not solely the retired preview audit gate');
    if(correctedRequiredEmptyField)schemaCorrections++;
    failedPreviews++;
   }else if(started.data?.toolName==='preview_role_roster_review')throw roleWorkStop('successful preview is not eligible for failed-preview recovery');
   else if(started.data?.toolName==='read_role_work_evidence'&&typeof args.unitId==='string'&&event.seq<last.seq){
    const unit=units.find(u=>u.id===args.unitId);if(!unit)throw roleWorkStop('original exact read contains a foreign unit');
    const resultJson=jsonResult(result),items=resultJson.units as Array<Record<string,unknown>>;
    if(!Array.isArray(items)||items.length!==1||items[0]?.unitId!==unit.id)throw roleWorkStop('original evidence result identity changed');
    const item=items[0]!;
    if(item.alreadyDeliveredInCurrentContext===true)continue;
    const chars=Array.from(bytes.subarray(unit.anchor.startByte,unit.anchor.endByte).toString('utf8'));
    const from=item.startOffset,to=item.endOffset;
    if(typeof from!=='number'||typeof to!=='number'||!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>chars.length
     ||item.text!==chars.slice(from,to).join(''))throw roleWorkStop('trace evidence differs from immutable source bytes');
    delivery.set(unit.id,[...(delivery.get(unit.id)??[]),{start:from,end:to}]);
   }
  }
 }
 if(pending.size||failedPreviews!==previews.length||previewInput?.partial!==true||!Array.isArray(previewInput.entries)||previewInput.entries.length!==1
  ||!Array.isArray(previewInput.missingMajorCharacters)||previewInput.missingMajorCharacters.length)throw roleWorkStop('candidate draft or tool completion scope is ambiguous');
 const entryInput=roleRosterEntryInputSchema.parse({...proposal,subjectHash:previewInput.subjectHash,entry:previewInput.entries[0]});
 if(entryInput.entry.candidateId!==input.candidateId)throw roleWorkStop('retained draft belongs to another candidate');
 const evidence=roleEntryEvidence(entryInput.entry).map(unitId=>{
  const unit=units.find(u=>u.id===unitId);if(!unit)throw roleWorkStop('draft cites a foreign original unit');
  const text=bytes.subarray(unit.anchor.startByte,unit.anchor.endByte).toString('utf8');let cursor=0;
  for(const span of [...(delivery.get(unitId)??[])].sort((a,b)=>a.start-b.start)){if(span.start>cursor)break;cursor=Math.max(cursor,span.end);}
  if(cursor<Array.from(text).length)throw roleWorkStop('draft lacks complete original evidence delivery before preview; preserve it for a supported continuation');
  return {unitId,textHash:contentHash(text),text};
 });
 const previewTool=createRoleRosterTools(root,()=>({sourceId:input.sourceId,batchId:input.batchId,finished:false})).tools.find(t=>t.name==='preview_role_roster_review')!;
 const result=jsonResult(await previewTool.execute('host-candidate-draft-preflight',previewInput as never,undefined,undefined,{} as never));
 if(result.structuralValid!==true||result.complete!==false||result.requiresHostReview!==false)throw roleWorkStop('retained candidate draft fails current preflight');
 const freshness=store.reviewFreshness();
 const authority={version:1,policy:'exact-retained-candidate-preview/v1',sourceId:input.sourceId,batchId:input.batchId,workId,
  planHash:store.planHash,sourceHash:plan.sourceHash,atlasRevision:freshness.atlasRevision,entriesHash:freshness.entriesHash,
  runHash:contentHash(run),traceHash:contentHash(events),budgetHash:budget.hash,inputHash:contentHash(entryInput),
  evidenceHash:contentHash(evidence),auditRef:input.auditRef,
  retainedAudits:[...freshness.sourceAudits,...freshness.claimAudits].map(a=>({workId:a.workId,hash:a.receiptHash}))};
 return {authority,authorityHash:contentHash(authority),file,input:entryInput,evidence,semanticSupport:'not-verified' as const};
}

export async function recoverRoleCandidateDraft(root:string,raw:RoleCandidateDraftRecovery){
 const input=inputSchema.parse(raw);
 if(!input.expectedAuthorityHash)throw roleWorkStop('copy authorityHash from inspectRoleCandidateDraftRecovery before applying once');
 return withWorkspaceOperationLock(root,'compiler',async()=>{
  const preview=await inspectRoleCandidateDraftRecovery(root,input);
  if(preview.authorityHash!==input.expectedAuthorityHash)throw roleWorkStop('candidate recovery authority changed; inspect fresh evidence before applying');
  await fs.mkdir(path.dirname(preview.file),{recursive:true});
  await fs.writeFile(preview.file,JSON.stringify({authority:preview.authority,authorityHash:preview.authorityHash,claimedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const tools=createCompilerProposalToolset(root);await tools.beginBatch([],input.batchId,input.sourceId);
  const tool=tools.tools.find(t=>t.name==='propose_role_roster_entry')!;
  await tool.execute('host-reviewed-retained-candidate-draft',preview.input as never,undefined,undefined,{} as never);
  const journal=new CompilerProposalObligations(root,input.sourceId,input.batchId),id=CompilerProposalObligations.identity(tool.name,preview.input);
  const receipt=journal.history(tool.name,id.proposalId).at(-1);
  if(receipt?.status!=='succeeded'||receipt.inputHash!==id.inputHash)throw roleWorkStop('candidate receipt publication is incomplete; inspect the claimed recovery, never repeat it');
  await new RequirementLedger(root,input.sourceId).resolveRoleEvidenceNeed(preview.authority.planHash,preview.authority.workId,contentHash([receipt.inputHash]));
  const result={authorityHash:preview.authorityHash,receiptHash:contentHash(receipt),candidateId:input.candidateId,modelCallsAdded:0,semanticSupport:'not-verified',certified:false};
  await fs.writeFile(preview.file+'.result.json',JSON.stringify(result),{flag:'wx',mode:0o600});
  return result;
 });
}
