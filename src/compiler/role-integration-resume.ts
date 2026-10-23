import fs from 'node:fs/promises';
import path from 'node:path';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {roleWorkStop,roleSourceWorkSchema,type RoleReviewWorkStore} from './role-review-work.js';
import {CompilerProposalObligations} from './proposal-obligations.js';
import {loadCurrentRoleRoster} from './role-roster-tools.js';
import {readSourceMaterial} from '../storage/source-material-store.js';
import {baseStructuralUnits} from './structure.js';
import {reassembleRoleContext} from './role-review-context.js';
import {roleSourceParts} from './role-source-parts.js';
import {inspectRoleReviewBudget,remainingRoleProgressCalls} from './role-review-budget.js';
import {TraceStore} from '../trace/store.js';
export type IntegrationResume={workId:string;failedRunId:string;auditRef:string;expectedAuthorityHash?:string};
/** One host-reviewed continuation for a completed partition whose integration
 * was rejected BEFORE transport by the retired byte watermark. No model failure
 * or proposal correction is pardoned; all original invocations remain spent. */
export async function inspectIntegrationResume(store:RoleReviewWorkStore,input:IntegrationResume){
 const {root,plan}=store,{workId}=input,page=plan.spans.findIndex((_,i)=>store.workId('source',i)===workId);
 if(!input.auditRef.trim()||page<0||store.read('source',page)||store.journal.unresolved().length||store.journal.history('propose_role_source_review',workId).length)throw roleWorkStop('integration resume requires an unsubmitted parent without unresolved proposals');
 const dir=path.join(worldStorageRoot(root),'compiler','role-review-work'),marker=path.join(dir,'integration-policy-resumes',store.planHash,contentHash(workId)+'.json');
 try{await fs.access(marker);throw roleWorkStop('integration policy resume already claimed; do not retry');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const cp=path.join(dir,'context',store.planHash,contentHash(workId)+'.json');
 try{await fs.access(cp+'.pending');throw roleWorkStop('uncertain context publication');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const context=JSON.parse(await fs.readFile(cp,'utf8'));
 if(context.hash!==contentHash(context.state)||context.state.workId!==workId||context.state.planHash!==store.planHash)throw roleWorkStop('original context changed');
 const current=await loadCurrentRoleRoster(root,plan.sourceId),bytes=await readSourceMaterial(root,current.source);store.assertScope(current.roster,contentHash(current.structure),bytes.length);
 const units=baseStructuralUnits(current.structure).sort((a,b)=>a.anchor.startByte-b.anchor.startByte),evidence=reassembleRoleContext(bytes,units,[plan.spans[page]!],context.state.accesses,{page,spans:plan.spans},Number.MAX_SAFE_INTEGER),parts=roleSourceParts(bytes,units,evidence.packet.ranges);
 const bundleHash=contentHash({planHash:store.planHash,workId,packets:parts.map(p=>p.packetHash)});
 const records=parts.map(p=>{
  const a=store.journal.history('propose_role_source_part',`${workId}:part:${p.index}`).at(-1),v=a?.input as {planHash:string;bundleHash:string;packetHash:string;payload:unknown}|undefined;
  if(a?.status!=='succeeded'||!v||v.planHash!==store.planHash||v.bundleHash!==bundleHash||v.packetHash!==p.packetHash||CompilerProposalObligations.identity(a.tool,a.input).inputHash!==a.inputHash)throw roleWorkStop('missing or stale part receipt');
  const ids=new Set(p.packet.fragments.map(f=>f.unitId));if(roleSourceWorkSchema.parse(v.payload).findings.some(f=>f.unitIds.some(id=>!ids.has(id))))throw roleWorkStop('invalid part citations');return a;
 });
 const attemptsDir=path.join(dir,'v1',contentHash(plan.sourceId),'attempts',contentHash(plan.batchId),contentHash(workId));
 const attempts=await Promise.all([1,2].map(async i=>JSON.parse(await fs.readFile(path.join(attemptsDir,`${i}.json`),'utf8'))));
 if(attempts.some(a=>a.planHash!==store.planHash||a.workId!==workId))throw roleWorkStop('invocation scope changed');
 const budget=inspectRoleReviewBudget(root,store.planHash,workId);
 if(budget.state.blocked||remainingRoleProgressCalls(budget)===0)throw roleWorkStop('retained integration budget exhausted');
 const traces=new TraceStore(root),run=await traces.peekRun(input.failedRunId),events=await traces.peekEvents(input.failedRunId),stop=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped');
 const failure=events.findLast(e=>e.type==='run.failed')?.data?.error as {message?:string}|undefined,b=stop?.data?.budget as {usage?:unknown;limits?:unknown;blocked?:boolean}|undefined;
 if(run.status!=='failed'||run.sourceId!==plan.sourceId||run.operationId!==plan.batchId||events.some(e=>e.type==='tool.call.started'||e.type==='llm.request.started')
  ||!failure?.message?.includes('ROLE_CONTEXT_REPACK_REQUIRED')||stop?.data?.workId!==workId||stop.data.repack!==true||b?.blocked!==false
  ||contentHash(b.usage)!==contentHash(budget.state.usage)||contentHash(b.limits)!==contentHash(budget.limits)
  ||!events.some(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work'&&e.data?.workId===workId&&e.data?.planHash===store.planHash))throw roleWorkStop('trace does not prove unchanged pre-transport integration stop');
 const authority={planHash:store.planHash,workId,bundleHash,contextHash:context.hash,partsHash:contentHash(records),attemptsHash:contentHash(attempts),budgetHash:budget.hash,traceHash:contentHash(events),auditRef:input.auditRef,policy:'pi-native-compaction-v1'};
 return {authority,authorityHash:contentHash(authority),marker,remainingCalls:remainingRoleProgressCalls(budget),parts:parts.length};
}
export async function claimIntegrationResume(store:RoleReviewWorkStore,input:IntegrationResume,bundleHash:string){
 const p=await inspectIntegrationResume(store,input);
 if(p.authorityHash!==input.expectedAuthorityHash||p.authority.bundleHash!==bundleHash)throw roleWorkStop('integration resume authority changed; inspect a fresh host preview');
 await fs.mkdir(path.dirname(p.marker),{recursive:true});await fs.writeFile(p.marker,JSON.stringify({authority:p.authority,authorityHash:p.authorityHash,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
}
