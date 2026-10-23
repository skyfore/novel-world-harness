import fs from 'node:fs/promises';
import path from 'node:path';
import {RoleReviewWorkStore,roleSourceWorkSchema,roleWorkStop} from './role-review-work.js';
import {loadCurrentRoleRoster} from './role-roster-tools.js';
import {readSourceMaterial} from '../storage/source-material-store.js';
import {baseStructuralUnits} from './structure.js';
import {reassembleRoleContext,roleReviewSourcePacket} from './role-review-context.js';
import {roleSourceParts,assertSourcePartIntegration} from './role-source-parts.js';
import {integrationPacket} from './role-integration-packet.js';
import {CompilerProposalObligations} from './proposal-obligations.js';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {RequirementLedger} from './requirement-ledger.js';
import {roleQuestions} from './role-review-verification.js';
import {inspectRoleReviewBudget} from './role-review-budget.js';
import {withWorkspaceOperationLock} from '../util/workspace-lock.js';
type Input={sourceId:string;batchId:string;workId:string;failedInputHash:string;auditRef:string;expectedAuthorityHash?:string};
export async function reviewIntegrationSize(root:string,input:Input,apply=false):Promise<{authority:Record<string,string>;authorityHash:string;expandedBytes:number;applied:boolean}>{
 if(apply)return withWorkspaceOperationLock(root,'compiler',async()=>{
  const data=await inspect(root,input);
  if(data.result.authorityHash!==input.expectedAuthorityHash)throw roleWorkStop('integration size-review authority changed; inspect fresh preview');
  const {store,page,expanded,notes,coreIds}=data,ledger=new RequirementLedger(root,input.sourceId);
  await ledger.registerRoleQuestions(roleQuestions(store.planHash,page,expanded));
  const envelope={proposal_id:input.workId,planHash:store.planHash,payload:expanded};
  await store.journal.withHostSourceIntegrationRevalidation(envelope,data.result.authority.historyHash!,data.result.authorityHash,input.auditRef,()=>store.submit('source',page,expanded,value=>assertSourcePartIntegration(notes,roleSourceWorkSchema.parse(value),coreIds)));
  return {...data.result,applied:true};
 });
 return (await inspect(root,input)).result;
}
async function inspect(root:string,input:Input){
 const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>p.batchId===input.batchId);if(!plan)throw roleWorkStop('original plan missing');
 const store=new RoleReviewWorkStore(root,plan),page=plan.spans.findIndex((_,i)=>store.workId('source',i)===input.workId),history=store.journal.history('propose_role_source_review',input.workId),last=history.at(-1),unresolved=store.journal.unresolved();
 if(!input.auditRef.trim()||page<0||store.read('source',page)||unresolved.length!==1||unresolved[0]!.proposalId!==input.workId||last?.status!=='failed'||last.inputHash!==input.failedInputHash||history.some(a=>a.hostReview||!['running','failed'].includes(a.status)||CompilerProposalObligations.identity(a.tool,a.input).inputHash!==a.inputHash))throw roleWorkStop('requires exact sole unreviewed integration size failure');
 for(const h of history.filter(a=>a.status==='failed')){
  let e;try{e=JSON.parse(h.diagnostic);}catch{throw roleWorkStop('not solely retired size validation');}
  if(!Array.isArray(e)||e.length!==1||e[0].code!=='custom'||JSON.stringify(e[0].path)!=='[]'||e[0].message!=='Source work notes must fit 8000 UTF-8 bytes; keep precise evidence refs and open questions, not copied source passages')throw roleWorkStop('not solely retired size validation');
 }
 const current=await loadCurrentRoleRoster(root,input.sourceId),bytes=await readSourceMaterial(root,current.source);store.assertScope(current.roster,contentHash(current.structure),bytes.length);
 const cp=path.join(worldStorageRoot(root),'compiler','role-review-work','context',store.planHash,contentHash(input.workId)+'.json');
 try{await fs.access(cp+'.pending');throw roleWorkStop('uncertain context publication');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const context=JSON.parse(await fs.readFile(cp,'utf8'));if(context.hash!==contentHash(context.state)||context.state.planHash!==store.planHash||context.state.workId!==input.workId)throw roleWorkStop('context integrity changed');
 const units=baseStructuralUnits(current.structure).sort((a,b)=>a.anchor.startByte-b.anchor.startByte),evidence=reassembleRoleContext(bytes,units,[plan.spans[page]!],context.state.accesses,{page,spans:plan.spans},Number.MAX_SAFE_INTEGER),parts=roleSourceParts(bytes,units,evidence.packet.ranges);
 const bundleHash=contentHash({planHash:store.planHash,workId:input.workId,packets:parts.map(p=>p.packetHash)});
 const records=parts.map(p=>store.journal.history('propose_role_source_part',`${input.workId}:part:${p.index}`).at(-1));
 const notes=records.map((r,i)=>{const v=r?.input as {planHash:string;bundleHash:string;packetHash:string;payload:unknown}|undefined;
  if(r?.status!=='succeeded'||!v||v.planHash!==store.planHash||v.bundleHash!==bundleHash||v.packetHash!==parts[i]!.packetHash||CompilerProposalObligations.identity(r.tool,r.input).inputHash!==r.inputHash)throw roleWorkStop('missing or stale part receipt');
  const note=roleSourceWorkSchema.parse(v.payload),allowed=new Set(parts[i]!.packet.fragments.map(f=>f.unitId));if(note.findings.some(f=>f.unitIds.some(id=>!allowed.has(id))))throw roleWorkStop('invalid original part citations');return note;
 });
 const core=roleReviewSourcePacket(bytes,units,plan.spans[page]!),coreIds=new Set(core.fragments.flatMap(f=>f.unitId?[f.unitId]:[]));
 const packet=integrationPacket(notes,{summary:'No prior expanded submission',findings:[],openQuestions:[]},evidence.packet.fragments,coreIds);
 for(const h of history){const v=h.input as {planHash:string;payload:unknown};if(v.planHash!==store.planHash)throw roleWorkStop('failed plan changed');const expanded=packet.decode(v.payload);if(Buffer.byteLength(JSON.stringify(expanded))<=8000)throw roleWorkStop('failure was not the retired size gate');}
 const expanded=packet.decode((last.input as {payload:unknown}).payload),budget=inspectRoleReviewBudget(root,store.planHash,input.workId);
 const authority={planHash:store.planHash,workId:input.workId,historyHash:contentHash(history),partsHash:contentHash(records),contextHash:context.hash,budgetHash:budget.hash,expandedHash:contentHash(expanded),auditRef:input.auditRef,policy:'observational-note-size-v1'};
 return {store,page,expanded,notes,coreIds,result:{authority,authorityHash:contentHash(authority),expandedBytes:Buffer.byteLength(JSON.stringify(expanded)),applied:false}};
}
