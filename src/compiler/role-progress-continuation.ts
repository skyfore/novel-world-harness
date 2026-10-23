import fs from "node:fs";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
import { readParentCallUsage } from "./role-call-budget-continuation.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/), counter = z.number().int().nonnegative();
const usageSchema = z.object({modelCalls:counter,payloads:counter,totalPayloadBytes:counter,largestRequestBytes:counter}).strict();
const stateSchema = z.object({usage:usageSchema,blocked:z.boolean(),failure:z.object({code:z.string(),message:z.string()}).strict().optional()}).strict();
const limitsSchema = z.object({maxModelCalls:counter.positive(),maxRequestBytes:counter.positive(),maxTotalPayloadBytes:counter.positive()}).strict();
const authoritySchema = z.object({
  version:z.literal(1),planHash:sha,workId:z.literal("continuation-window"),priorAuthorityHash:sha,priorUsageHash:sha,
  sourceId:z.string().min(1),batchId:z.string().min(1),childPlanHash:sha,childWorkId:z.string().min(1),childBudgetHash:sha,
  failedRunId:z.string().min(1),traceHash:sha,auditRef:z.string().min(1),implementationRef:z.string().min(1),
  policy:z.literal("validated-role-progress/v1"),limits:limitsSchema,initial:stateSchema,
  receipts:z.array(z.object({page:counter,hash:sha}).strict()).min(1),
}).strict();
export type RoleProgressContinuationInput = {
  planHash:string;workId:string;expectedUsageHash:string;failedRunId:string;auditRef:string;implementationRef:string;
};

/** Read-only migration preview. A fixed aggregate stop is not a stalled work.
 * Keep both former windows immutable and bind the replacement to this source. */
export async function inspectRoleProgressContinuation(root:string,input:RoleProgressContinuationInput) {
  const prior=readParentCallUsage(root,input),a=prior.authority;
  if(prior.hash!==input.expectedUsageHash||!prior.state.blocked||prior.state.failure?.code!=="call-limit"
    ||prior.state.usage.modelCalls!==a.limits.maxModelCalls)throw roleWorkStop("aggregate stop changed; copy the exact retained usage hash");
  const traces=new TraceStore(root),run=await traces.peekRun(input.failedRunId),events=await traces.peekEvents(input.failedRunId);
  const work=events.findLast(e=>e.type==="validation.completed"&&e.data?.phase==="role-review-work")?.data;
  const stop=events.findLast(e=>e.type==="validation.completed"&&e.data?.phase==="role-review-work-stopped")?.data;
  const reported=stop?.budget as {usage?:unknown;limits?:unknown;blocked?:boolean}|undefined;
  if(run.status!=="failed"||run.sourceId!==a.sourceId||run.operationId!==a.batchId
    ||!run.error?.message.includes("model-call limit reached")||!work?.planHash||!work.workId
    ||stop?.workId!==work.workId||reported?.blocked!==false)throw roleWorkStop("trace does not establish this aggregate call stop");
  const child=inspectRoleReviewBudget(root,String(work.planHash),String(work.workId));
  if(child.state.blocked||remainingRoleProgressCalls(child)===0||contentHash(child.state.usage)!==contentHash(reported.usage)
    ||contentHash(child.limits)!==contentHash(reported.limits))throw roleWorkStop("stopped child changed or has no progress window");
  const plan=(await RoleReviewWorkStore.plans(root,a.sourceId)).find(p=>p.batchId===a.batchId);
  if(!plan)throw roleWorkStop("original role plan missing");
  const store=new RoleReviewWorkStore(root,plan),current=await loadCurrentRoleRoster(root,a.sourceId);
  store.assertScope(current.roster,contentHash(current.structure),current.structure.sourceBytes);
  store.journal.assertModelRecoveryAllowed();
  if(store.planHash!==work.planHash||store.journal.unresolved().length)throw roleWorkStop("role scope changed or proposals remain unresolved");
  const page=plan.spans.findIndex((_,i)=>store.workId("source",i)===work.workId);
  if(page<0||store.read("source",page))throw roleWorkStop("stopped source work is foreign or already settled");
  const receipts=plan.spans.flatMap((_,page)=>{const note=store.read("source",page);return note?[{page,hash:contentHash(note)}]:[];});
  const authority=authoritySchema.parse({version:1,planHash:input.planHash,workId:input.workId,priorAuthorityHash:prior.authorityHash,priorUsageHash:prior.hash,
    sourceId:a.sourceId,batchId:a.batchId,childPlanHash:store.planHash,childWorkId:work.workId,childBudgetHash:child.hash,
    failedRunId:input.failedRunId,traceHash:contentHash(events),auditRef:input.auditRef,implementationRef:input.implementationRef,
    policy:"validated-role-progress/v1",limits:a.limits,initial:{usage:prior.state.usage,blocked:false},receipts});
  return {authority,authorityHash:contentHash(authority),file:`${prior.file}.progress-policy.json`};
}

/** Explicit host policy change under the compiler lock, never a model tool. */
export async function grantRoleProgressContinuation(root:string,input:RoleProgressContinuationInput,expectedAuthorityHash:string) {
  const preview=await inspectRoleProgressContinuation(root,input);
  if(preview.authorityHash!==expectedAuthorityHash)throw roleWorkStop("progress policy preview changed; inspect before applying");
  fs.writeFileSync(preview.file,JSON.stringify({authority:preview.authority,authorityHash:preview.authorityHash}),{flag:"wx",mode:0o600});
  return preview;
}

export function readRoleProgressContinuation(root:string,input:{planHash:string;workId:string}) {
  const prior=readParentCallUsage(root,input),file=`${prior.file}.progress-policy.json`;
  const record=JSON.parse(fs.readFileSync(file,"utf8")),authority=authoritySchema.parse(record.authority);
  if(record.authorityHash!==contentHash(authority)||authority.planHash!==input.planHash||authority.workId!==input.workId
    ||authority.priorAuthorityHash!==prior.authorityHash||authority.priorUsageHash!==prior.hash
    ||authority.sourceId!==prior.authority.sourceId||authority.batchId!==prior.authority.batchId
    ||!prior.state.blocked||prior.state.failure?.code!=="call-limit"||authority.initial.blocked
    ||contentHash(authority.initial.usage)!==contentHash(prior.state.usage)||contentHash(authority.limits)!==contentHash(prior.authority.limits)) {
    throw roleWorkStop("progress policy lineage changed; preserve all records, do not retry");
  }
  return {authority,authorityHash:record.authorityHash as string,file};
}

/** Aggregate counters remain cumulative telemetry. The finite original work
 * plan, validated receipts, local stall windows and failure gates control work. */
export function openRoleProgressContinuation(root:string,input:{planHash:string;workId:string}) {
  const {authority:a,authorityHash,file}=readRoleProgressContinuation(root,input),usageFile=`${file}.usage.json`,pending=`${usageFile}.pending`;
  if(fs.existsSync(pending))throw roleWorkStop("uncertain aggregate progress charge; preserve pending publication");
  let initial=stateSchema.parse(a.initial);
  if(fs.existsSync(usageFile)) {
    const record=JSON.parse(fs.readFileSync(usageFile,"utf8")),state=stateSchema.parse(record.state);
    if(record.authorityHash!==authorityHash||record.hash!==contentHash({authorityHash,state})
      ||(Object.keys(initial.usage) as Array<keyof typeof initial.usage>).some(k=>state.usage[k]<initial.usage[k]))throw roleWorkStop("aggregate progress usage regressed");
    initial=state;
  }
  const save=(state:z.infer<typeof stateSchema>)=>{
    const value={authorityHash,state};fs.writeFileSync(pending,JSON.stringify({...value,hash:contentHash(value)}),{flag:"wx",mode:0o600});fs.renameSync(pending,usageFile);
  };
  if(!fs.existsSync(usageFile))save(initial);
  return new ModelRequestBudget(a.limits,{initial,save},{modelCallsMode:"observe",requestBytesMode:"observe",totalBytesMode:"observe"});
}
