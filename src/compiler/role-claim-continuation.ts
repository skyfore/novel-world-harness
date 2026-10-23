import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {TraceStore} from '../trace/store.js';
import {WorkspaceOperationLock} from '../util/workspace-lock.js';
import {ModelRequestBudget, type ModelRequestBudgetState} from '../runtime/model-request-budget.js';
import {inspectRoleReviewBudget} from './role-review-budget.js';
import {RoleReviewWorkStore, ROLE_CLAIM_AUDIT_TOOL, roleWorkStop} from './role-review-work.js';
import {mutableRoleReview} from './role-judgment-repair-service.js';
import {baseStructuralUnits} from './structure.js';
import {roleEntryEvidence} from './role-review-verification.js';
import {roleEvidencePacket} from './role-review-context.js';
import {readSourceMaterial} from '../storage/source-material-store.js';

const inputSchema=z.object({sourceId:z.string().min(1),batchId:z.string().min(1),candidateId:z.string().min(1),
  runId:z.string().min(1),authorizationRef:z.string().min(1),diagnosisRef:z.string().min(1),implementationRef:z.string().min(1),
  additionalCalls:z.number().int().min(1).max(12)}).strict();
export type RoleClaimContinuationInput=z.infer<typeof inputSchema>;
const absent=async(file:string)=>fs.access(file).then(()=>false,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return true;throw e;});
export const roleClaimContinuationFile=(root:string,planHash:string,workId:string)=>path.join(worldStorageRoot(root),
  'compiler','role-review-work','budgets',planHash,`${contentHash(workId)}.json.claim-continuation.json`);

/** A host revision of one settled, read-only first audit invocation. No changed
 * judgment, negative receipt, inherited stop or used retry is eligible. */
export async function inspectRoleClaimContinuation(root:string,raw:RoleClaimContinuationInput){
  const input=inputSchema.parse(raw),traces=new TraceStore(root);
  const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>p.batchId===input.batchId);
  if(!plan)throw roleWorkStop('claim continuation plan missing; discover with RoleReviewWorkStore.plans and copy batchId once; never guess');
  const store=new RoleReviewWorkStore(root,plan),current=await mutableRoleReview(store);
  const workId=store.claimWorkId(input.candidateId),entry=store.stagedEntries().find(e=>e.candidateId===input.candidateId);
  const inherited=store.inheritedAllowance(workId);
  if(!entry||workId!==store.originalClaimWorkId(input.candidateId)||store.journal.history(ROLE_CLAIM_AUDIT_TOOL,workId).length
    ||inherited?.attempts||inherited?.contextSessions||inherited?.contextHandoffs||inherited?.nativeContextFallback
    ||inherited?.budget?.state.blocked||inherited?.budget?.state.usage.modelCalls)throw roleWorkStop('claim continuation requires an original unaudited claim with no inherited consumption or proposal history');
  const file=roleClaimContinuationFile(root,store.planHash,workId);
  if(!await absent(file))throw roleWorkStop('claim continuation already claimed; inspect its result, never renew its allowance');
  const budget=inspectRoleReviewBudget(root,store.planHash,workId),run=await traces.peekRun(input.runId),events=await traces.peekEvents(input.runId);
  if(run.kind!=='prepare'||run.status!=='failed'||!run.endedAt||run.sourceId!==input.sourceId||run.operationId!==input.batchId
    ||run.error?.code!=='ROLE_REVIEW_WORK_FAILED'||run.counts.llmRequests!==budget.state.usage.modelCalls
    ||!budget.state.blocked||budget.state.failure?.code!=='no-progress'||run.error.message!==`Error: ${budget.state.failure.message}`
    ||(budget.state.progress?.lastProgressCall??0)!==0||(budget.state.progress?.milestones.length??0)!==0
    ||events.filter(e=>e.type==='llm.response.completed').length!==run.counts.llmRequests)throw roleWorkStop('claim continuation requires the exact settled read-only no-progress stop; do not retry other failures');
  // Pi may surface the local pre-transport budget refusal as a failed response.
  // It is not another provider attempt; every other response failure blocks.
  const failures=events.filter(e=>e.type==='llm.response.failed');
  if(failures.length>1||failures.some(e=>{
    const usage=e.data?.usage as {input?:number;output?:number;totalTokens?:number}|undefined;
    return e.data?.errorMessage!==budget.state.failure!.message||usage?.input!==0||usage.output!==0||usage.totalTokens!==0
      ||events.some(start=>start.type==='llm.request.started'&&start.callId===e.callId);
  }))throw roleWorkStop('claim has a provider response failure; diagnose it before continuation');
  const work=events.find(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work')?.data;
  const stop=events.findLast(e=>e.type==='validation.completed'&&e.data?.phase==='role-review-work-stopped')?.data;
  const observations=events.filter(e=>e.type==='validation.completed'&&e.data?.phase==='role-request-observation');
  const taskHash=observations[0]?.data?.logicalTaskHash;
  if(work?.planHash!==store.planHash||work.workId!==workId||typeof taskHash!=='string'||!/^[a-f0-9]{64}$/.test(taskHash)
    ||observations.some(e=>e.data?.logicalTaskHash!==taskHash||e.data?.sessionOrdinal!==0||e.data?.evidenceEpoch!==0||e.data?.planHash!==store.planHash||e.data?.workId!==workId)
    ||stop?.workId!==workId||!Array.isArray(stop.compactions)||stop.compactions.length
    ||contentHash((stop.budget as {usage?:unknown}|undefined)?.usage??null)!==contentHash(budget.state.usage))throw roleWorkStop('claim continuation requires one intact original context');
  const storage=worldStorageRoot(root),base=path.join(storage,'compiler','role-review-work'),key=contentHash(workId);
  const contextRoot=path.join(base,'context-loops',store.planHash,key),contextDir=path.join(contextRoot,taskHash);
  if(contentHash(await fs.readdir(contextRoot))!==contentHash([taskHash])
    ||contentHash(await fs.readdir(contextDir))!==contentHash(['0.json']))throw roleWorkStop('claim physical session allowance already used or ambiguous');
  const priorClaimFile=path.join(contextDir,'0.json'),priorClaim=JSON.parse(await fs.readFile(priorClaimFile,'utf8'));
  if(priorClaim.hash!==contentHash(priorClaim.claim)||priorClaim.claim.planHash!==store.planHash||priorClaim.claim.workId!==workId
    ||priorClaim.claim.taskHash!==taskHash||priorClaim.claim.ordinal!==0)throw roleWorkStop('original claim context changed');
  const attemptDir=path.join(base,'v1',contentHash(input.sourceId),'attempts',contentHash(input.batchId),key);
  if(contentHash(await fs.readdir(attemptDir))!==contentHash(['1.json']))throw roleWorkStop('claim continuation cannot grant another invocation attempt');
  const attemptFile=path.join(attemptDir,'1.json'),attempt=JSON.parse(await fs.readFile(attemptFile,'utf8'));
  if(attempt.planHash!==store.planHash||attempt.workId!==workId)throw roleWorkStop('claim invocation identity changed');
  const checkpointFile=path.join(base,'context',store.planHash,key+'.json');
  if(!await absent(checkpointFile+'.pending')||!await absent(path.join(base,'native-context-fallbacks',store.planHash,key+'.json')))throw roleWorkStop('uncertain or recovered claim context; do not continue');
  const checkpoint=JSON.parse(await fs.readFile(checkpointFile,'utf8'));
  if(checkpoint.hash!==contentHash(checkpoint.state)||checkpoint.state.packetHash!==taskHash||checkpoint.state.planHash!==store.planHash
    ||checkpoint.state.workId!==workId||checkpoint.state.handoffs.length||checkpoint.state.inheritedHandoffs)throw roleWorkStop('original claim checkpoint changed');
  const units=baseStructuralUnits(current.structure),unitIds=new Set(units.map(u=>u.id));
  const evidencePacket=roleEvidencePacket(await readSourceMaterial(root,current.source),units,roleEntryEvidence(entry));
  const claimRevision=contentHash(entry),atlasRevision=store.atlasRevision();
  const packetHash=contentHash({claimRevision,atlasRevision,evidencePacket});
  const promptEvent=events.find(e=>e.type==='context.assembled'&&e.data?.phase==='before-agent-start');
  const prompt=promptEvent?.blobRef?await traces.peekBlob(promptEvent.blobRef):undefined;
  if(typeof prompt!=='string'||contentHash(prompt)!==work.packetHash)throw roleWorkStop('original claim prompt is missing or changed');
  const lines=prompt.split('\n');
  const originalTask=lines.map((_,i)=>lines.slice(0,i+1).join('\n')).find(p=>contentHash(p)===taskHash);
  if(!originalTask)throw roleWorkStop('original claim task cannot be recovered exactly from its trace');
  const packet=JSON.parse(originalTask.split('\n').at(-1)!);
  if(packet.candidateId!==input.candidateId||packet.claimRevision!==claimRevision||packet.atlasRevision!==atlasRevision
    ||packet.packetHash!==packetHash||contentHash(packet.entry)!==claimRevision||contentHash(packet.evidencePacket)!==contentHash(evidencePacket)
    ||contentHash(packet.requiredEvidenceUnitIds)!==contentHash(roleEntryEvidence(entry)))throw roleWorkStop('claim or original evidence changed since the failed invocation');
  const pending=new Map<string,typeof events[number]>(),exactReadUnitIds=new Set<string>(),discoveredUnitIds=new Set<string>(),navigation:unknown[]=[];
  for(const event of events){
    const id=event.toolCallId??event.callId??event.spanId;
    if(event.type==='tool.call.started'){
      if(pending.has(id)||!['read_role_review_atlas','read_role_review_notes','read_role_work_evidence'].includes(String(event.data?.toolName)))throw roleWorkStop('claim continuation only permits successful reads; inspect drafts or mutations separately');
      pending.set(id,event);
    }else if(event.type==='tool.call.failed')throw roleWorkStop('claim has a tool failure; diagnose before continuation');
    else if(event.type==='tool.call.completed'){
      const start=pending.get(id);if(!start?.blobRef||!event.blobRef)throw roleWorkStop('claim tool publication is uncertain');pending.delete(id);
      const args=await traces.peekBlob(start.blobRef) as Record<string,unknown>;
      const result=await traces.peekBlob(event.blobRef) as {isError?:boolean;content?:Array<{type:string;text?:string}>};
      if(event.data?.isError===true||result.isError)throw roleWorkStop('claim read returned a tool error');
      if(start.data?.toolName==='read_role_work_evidence'&&typeof args.unitId==='string'){
        if(!unitIds.has(args.unitId))throw roleWorkStop('claim read names a foreign unit');exactReadUnitIds.add(args.unitId);
      }
      if(start.data?.toolName==='read_role_work_evidence'&&typeof args.query==='string'){
        const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw roleWorkStop('claim discovery result missing');
        for(const unit of (JSON.parse(text) as {units?:Array<{unitId?:string}>}).units??[]){
          if(!unit.unitId||!unitIds.has(unit.unitId))throw roleWorkStop('claim discovery returned a foreign unit');discoveredUnitIds.add(unit.unitId);
        }
      }
      if(start.data?.toolName==='read_role_review_atlas'&&args.page===undefined&&args.query===undefined){
        const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw roleWorkStop('claim atlas navigation missing');navigation.push(JSON.parse(text));
      }
    }
  }
  if(pending.size||!navigation.length||!(exactReadUnitIds.size+discoveredUnitIds.size))throw roleWorkStop('claim lacks settled source navigation for a focused continuation');
  const retainedFiles=await Promise.all([priorClaimFile,attemptFile,checkpointFile].map(async file=>({path:path.relative(storage,file),hash:contentHash(await fs.readFile(file,'utf8'))})));
  const authority={version:1 as const,policy:'host-reviewed-claim-evidence-replay/v1' as const,input,planHash:store.planHash,workId,taskHash,
    sourceHash:plan.sourceHash,entriesHash:store.entriesHash(),claimRevision,atlasRevision,packetHash,budget,
    traceHash:contentHash(events),runHash:contentHash(run),retainedFiles,exactReadUnitIds:[...exactReadUnitIds],discoveredUnitIds:[...discoveredUnitIds],
    navigationHash:contentHash(navigation),limits:{...budget.limits,maxModelCalls:budget.state.usage.modelCalls+input.additionalCalls}};
  return {authority,authorityHash:contentHash(authority),file,navigation};
}
export type RoleClaimContinuation=Awaited<ReturnType<typeof inspectRoleClaimContinuation>>;
const startRecoverySchema=z.object({expectedResultHash:z.string().regex(/^[a-f0-9]{64}$/),authorizationRef:z.string().min(1),implementationRef:z.string().min(1)}).strict();
export type RoleClaimStartRecoveryInput=z.infer<typeof startRecoverySchema>;

/** Recover dispatch, not model work: the same grant has not yet consumed its
 * second invocation/session or a single additional charge. No allowance grows. */
export async function inspectRoleClaimStartRecovery(root:string,input:RoleClaimContinuationInput,authorityHash:string,raw:RoleClaimStartRecoveryInput){
  const recovery=startRecoverySchema.parse(raw);
  const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>p.batchId===input.batchId);
  if(!plan)throw roleWorkStop('claim start recovery plan missing; copy batchId from RoleReviewWorkStore.plans once');
  const store=new RoleReviewWorkStore(root,plan);await mutableRoleReview(store);
  const record=readRoleClaimContinuation(root,store.planHash,store.claimWorkId(input.candidateId));
  if(!record||record.authorityHash!==authorityHash||contentHash(record.authority.input)!==contentHash(input))throw roleWorkStop('claim start recovery authority differs; inspect the original grant, never rename it');
  const a=record.authority,file=record.file+'.start-recovery.json';
  if(!await absent(file))throw roleWorkStop('claim start recovery already consumed; never dispatch it again');
  await assertRoleClaimContinuationHistory(store,authorityHash);
  const result=JSON.parse(await fs.readFile(record.file+'.result.json','utf8'));
  if(contentHash(result)!==recovery.expectedResultHash||result.status!=='failed'||result.authorityHash!==authorityHash
    ||contentHash(record.usage)!==contentHash({usage:a.budget.state.usage,blocked:false})
    ||contentHash(result.usage?.state)!==contentHash(record.usage)||store.journal.history(ROLE_CLAIM_AUDIT_TOOL,a.workId).length
    ||store.entriesHash()!==a.entriesHash||store.atlasRevision()!==a.atlasRevision)throw roleWorkStop('claim start recovery requires an unchanged pre-dispatch failure with zero additional charges');
  const base=path.join(worldStorageRoot(root),'compiler','role-review-work'),key=contentHash(a.workId);
  const attempts=path.join(base,'v1',contentHash(input.sourceId),'attempts',contentHash(input.batchId),key);
  const contexts=path.join(base,'context-loops',store.planHash,key);
  if(contentHash(await fs.readdir(attempts))!==contentHash(['1.json'])||contentHash(await fs.readdir(contexts))!==contentHash([a.taskHash])
    ||contentHash(await fs.readdir(path.join(contexts,a.taskHash)))!==contentHash(['0.json'])
    ||(await fs.readdir(path.join(base,'context',store.planHash))).some(n=>n.startsWith(key+'.json.continuation-')))throw roleWorkStop('continued invocation or session may already have started; preserve it and do not redispatch');
  const authority={version:1 as const,policy:'same-claim-grant-before-dispatch/v1' as const,continuationAuthorityHash:authorityHash,
    recovery,planHash:store.planHash,workId:a.workId,usageHash:contentHash(record.usage)};
  return {authority,authorityHash:contentHash(authority),file,continuation:record};
}
export async function claimRoleClaimStartRecovery(root:string,input:RoleClaimContinuationInput,authorityHash:string,recovery:RoleClaimStartRecoveryInput,expectedHash:string){
  if((await WorkspaceOperationLock.inspect(root)).owner?.pid!==process.pid)throw roleWorkStop('claim start recovery needs the owning host compiler lock');
  const preview=await inspectRoleClaimStartRecovery(root,input,authorityHash,recovery);
  if(preview.authorityHash!==expectedHash)throw roleWorkStop('claim start recovery changed; inspect and copy authorityHash once');
  await fs.writeFile(preview.file,JSON.stringify({authority:preview.authority,authorityHash:preview.authorityHash}),{flag:'wx',mode:0o600});
  const record=preview.continuation;
  const save=(state:ModelRequestBudgetState)=>{
    const value={authorityHash,state},file=record.file+'.usage.json';
    syncFs.writeFileSync(file+'.pending',JSON.stringify({...value,hash:contentHash(value)}),{flag:'wx',mode:0o600});syncFs.renameSync(file+'.pending',file);
  };
  return {...record,budget:new ModelRequestBudget(record.authority.limits,{initial:record.usage,save},{modelCallsMode:'enforce',requestBytesMode:'observe',totalBytesMode:'observe'})};
}

/** Read-only lineage validation, also used when capturing budgets for later
 * revisions. The old stop stays blocked; extra charges cannot disappear. */
export function readRoleClaimContinuation(root:string,planHash:string,workId:string){
  const file=roleClaimContinuationFile(root,planHash,workId);
  if(!syncFs.existsSync(file))return;
  if(syncFs.existsSync(file+'.usage.json.pending'))throw roleWorkStop('uncertain claim continuation charge; do not retry');
  const record=JSON.parse(syncFs.readFileSync(file,'utf8')) as RoleClaimContinuation,a=record.authority;
  if(record.authorityHash!==contentHash(a)||a.policy!=='host-reviewed-claim-evidence-replay/v1'||a.version!==1
    ||a.planHash!==planHash||a.workId!==workId||record.file!==file||a.navigationHash!==contentHash(record.navigation)
    ||a.limits.maxModelCalls!==a.budget.state.usage.modelCalls+a.input.additionalCalls
    ||a.input.additionalCalls<1||a.input.additionalCalls>12)throw roleWorkStop('claim continuation authority integrity changed');
  if(!syncFs.existsSync(file+'.usage.json'))throw roleWorkStop('claim continuation charge publication is unfinished; inspect the original grant, never restart');
  const usage=JSON.parse(syncFs.readFileSync(file+'.usage.json','utf8')) as {authorityHash:string;state:ModelRequestBudgetState;hash:string};
  if(usage.authorityHash!==record.authorityHash||usage.hash!==contentHash({authorityHash:usage.authorityHash,state:usage.state})
    ||Object.entries(a.budget.state.usage).some(([k,v])=>!Number.isInteger(usage.state.usage[k as keyof typeof a.budget.state.usage])||usage.state.usage[k as keyof typeof a.budget.state.usage]<v)
    ||usage.state.usage.modelCalls>a.limits.maxModelCalls)throw roleWorkStop('claim continuation usage changed or regressed');
  return {...record,usage:usage.state};
}

/** The caller holds the compiler lock through one physical session. Claiming
 * grants neither another proposal correction nor a third invocation. */
export async function claimRoleClaimContinuation(root:string,input:RoleClaimContinuationInput,expectedHash:string){
  if((await WorkspaceOperationLock.inspect(root)).owner?.pid!==process.pid)throw roleWorkStop('claim continuation needs the owning host compiler lock');
  const preview=await inspectRoleClaimContinuation(root,input);
  if(preview.authorityHash!==expectedHash)throw roleWorkStop('claim continuation authority changed; inspect the new preview and copy authorityHash once');
  await fs.writeFile(preview.file,JSON.stringify(preview),{flag:'wx',mode:0o600});
  const usageFile=preview.file+'.usage.json';
  const initial:ModelRequestBudgetState={usage:preview.authority.budget.state.usage,blocked:false};
  const save=(state:ModelRequestBudgetState)=>{
    const record={authorityHash:expectedHash,state};
    syncFs.writeFileSync(usageFile+'.pending',JSON.stringify({...record,hash:contentHash(record)}),{flag:'wx',mode:0o600});
    syncFs.renameSync(usageFile+'.pending',usageFile);
  };
  if(!await absent(usageFile)||!await absent(usageFile+'.pending'))throw roleWorkStop('claim continuation usage already exists; never restart');
  save(initial);
  const budget=new ModelRequestBudget(preview.authority.limits,{initial,save},{modelCallsMode:'enforce',requestBytesMode:'observe',totalBytesMode:'observe'});
  return {...preview,budget};
}

export async function assertRoleClaimContinuationHistory(store:RoleReviewWorkStore,activeAuthorityHash?:string){
  const dir=path.dirname(roleClaimContinuationFile(store.root,store.planHash,'unused'));
  const names=await fs.readdir(dir).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of names.filter(n=>n.endsWith('.json.claim-continuation.json'))){
    const saved=JSON.parse(await fs.readFile(path.join(dir,name),'utf8')) as RoleClaimContinuation;
    const record=readRoleClaimContinuation(store.root,store.planHash,saved.authority.workId)!;
    const a=record.authority;
    if(a.input.sourceId!==store.plan.sourceId||a.input.batchId!==store.plan.batchId||a.sourceHash!==store.plan.sourceHash
      ||inspectRoleReviewBudget(store.root,store.planHash,a.workId).hash!==a.budget.hash)throw roleWorkStop('claim continuation predecessor budget or scope changed');
    for(const file of a.retainedFiles){
      if(path.isAbsolute(file.path)||file.path.split(/[\\/]/).includes('..')
        ||contentHash(await fs.readFile(path.join(worldStorageRoot(store.root),file.path),'utf8'))!==file.hash)throw roleWorkStop('claim continuation predecessor history changed');
    }
    const traces=new TraceStore(store.root);
    if(contentHash(await traces.peekRun(a.input.runId))!==a.runHash||contentHash(await traces.peekEvents(a.input.runId))!==a.traceHash)throw roleWorkStop('claim continuation failure trace changed');
    if(record.authorityHash===activeAuthorityHash)continue;
    if(await absent(record.file+'.result.json'))throw roleWorkStop('claim continuation result is unfinished; inspect the original grant and trace, never restart');
    let result=JSON.parse(await fs.readFile(record.file+'.result.json','utf8'));
    if(!await absent(record.file+'.start-recovery.json')){
      const recovery=JSON.parse(await fs.readFile(record.file+'.start-recovery.json','utf8'));
      if(recovery.authorityHash!==contentHash(recovery.authority)||recovery.authority.continuationAuthorityHash!==record.authorityHash
        ||recovery.authority.policy!=='same-claim-grant-before-dispatch/v1'||recovery.authority.planHash!==store.planHash
        ||recovery.authority.workId!==a.workId||recovery.authority.recovery.expectedResultHash!==contentHash(result)
        ||result.status!=='failed'||recovery.authority.usageHash!==contentHash(result.usage.state))throw roleWorkStop('claim pre-dispatch recovery history changed');
      if(await absent(record.file+'.start-recovery.result.json'))throw roleWorkStop('claim start recovery result is unfinished; do not redispatch');
      result=JSON.parse(await fs.readFile(record.file+'.start-recovery.result.json','utf8'));
      if(result.startRecoveryHash!==recovery.authorityHash)throw roleWorkStop('claim start recovery result identity changed');
    }
    const receipt=store.journal.history(ROLE_CLAIM_AUDIT_TOOL,a.workId).at(-1);
    if(result.status!=='succeeded'||result.authorityHash!==record.authorityHash||result.receiptHash!==contentHash(receipt??null)
      ||receipt?.status!=='succeeded'||contentHash(result.usage.state)!==contentHash(record.usage))throw roleWorkStop('claim continuation is unfinished or changed; inspect its original result, do not retry');
  }
}
