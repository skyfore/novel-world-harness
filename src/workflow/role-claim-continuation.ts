import fs from 'node:fs/promises';
import path from 'node:path';
import {contentHash} from '../world/canonical.js';
import {worldStorageRoot} from '../world/paths.js';
import {withWorkspaceOperationLock} from '../util/workspace-lock.js';
import {claimRoleClaimContinuation,claimRoleClaimStartRecovery,readRoleClaimContinuation,type RoleClaimContinuationInput,type RoleClaimStartRecoveryInput} from '../compiler/role-claim-continuation.js';
import {RoleReviewWorkStore,ROLE_CLAIM_AUDIT_TOOL,roleWorkStop} from '../compiler/role-review-work.js';
import {runBoundedRoleReview,type BoundedRoleReviewOptions} from './role-review-bounded.js';
import {RoleSessionContext} from './role-session-context.js';
import {PiAgentSession} from '../agent/pi-session.js';
import {LocalFileWorkspace} from '../workspace/local-files.js';
import {COMPILER_SYSTEM_PROMPT} from '../compiler/pi-compiler.js';
import {loadOptionalConfig,profileForRole} from '../config/load.js';
import {TraceStore} from '../trace/store.js';
import {TraceRecorder} from '../trace/recorder.js';
import {describeRequest} from '../agent/request-observation.js';

/** Same claim, ordinary independent validator, original second invocation and
 * physical session ordinal 1. Only the navigation/instructions are revised. */
export async function continueRoleClaim(options:BoundedRoleReviewOptions,input:RoleClaimContinuationInput,authorityHash:string,startRecovery?:{input:RoleClaimStartRecoveryInput;authorityHash:string}){
  const {root}=options;
  const execute=async()=>{
    if(options.sourceId!==input.sourceId||options.compilerBatchId!==input.batchId)throw roleWorkStop('claim continuation source or batch differs');
    if(typeof options.configPath!=='string'||!options.configPath.trim())throw roleWorkStop('claim continuation needs the host configPath before claiming; use the same compiler configuration path and correct once');
    const config=await loadOptionalConfig(options.configPath),profile=config?profileForRole(config,'controller').profile:undefined;
    const grant=startRecovery?await claimRoleClaimStartRecovery(root,input,authorityHash,startRecovery.input,startRecovery.authorityHash)
      :await claimRoleClaimContinuation(root,input,authorityHash),a=grant.authority;
    const plan=(await RoleReviewWorkStore.plans(root,input.sourceId)).find(p=>contentHash(p)===a.planHash)!;
    const store=new RoleReviewWorkStore(root,plan);
    let dispatched=false;
    const result:{status:string;authorityHash:string;startRecoveryHash?:string;usage?:unknown;receiptHash?:string;error?:string}={status:'running',authorityHash,...(startRecovery?{startRecoveryHash:startRecovery.authorityHash}:{})};
    try{
      await runBoundedRoleReview({...options,claimAuditScope:{planHash:a.planHash,atlasRevision:a.atlasRevision,entriesHash:a.entriesHash,
        candidateIds:[input.candidateId],missingSourceWorkIds:[]},claimAuditContinuation:{workId:a.workId,authorityHash}},async original=>{
        if(dispatched||original.workId!==a.workId)throw roleWorkStop('claim continuation may dispatch its original audit only once');
        dispatched=true;
        const packet=JSON.parse(original.prompt.split('\n').at(-1)!);
        if(packet.candidateId!==input.candidateId||packet.claimRevision!==a.claimRevision||packet.atlasRevision!==a.atlasRevision
          ||packet.packetHash!==a.packetHash)throw roleWorkStop('continued claim or evidence packet differs from host review');
        const taskHash=contentHash(original.prompt);
        const dir=path.join(worldStorageRoot(root),'compiler','role-review-work','context-loops',a.planHash,contentHash(a.workId),taskHash);
        await fs.mkdir(dir,{recursive:true});
        const claim={planHash:a.planHash,workId:a.workId,taskHash,ordinal:1,priorTaskHash:a.taskHash,authorityHash,at:new Date().toISOString()};
        await fs.writeFile(path.join(dir,'1.json'),JSON.stringify({claim,hash:contentHash(claim)}),{flag:'wx',mode:0o600});
        const context=new RoleSessionContext(original),work=context.invocation(false,1,{authorityHash,policy:a.policy});
        work.tools=work.tools.filter(t=>!['request_role_session_rebuild','request_role_work_evidence','refactor_role_work'].includes(t.name));
        const prompt=`${original.prompt}\n\nHost recovery: this same claim has exactly ${input.additionalCalls} additional model calls, authorized once after review of its read-only stop. The prior ${a.budget.state.usage.modelCalls} calls, stopped budget, failed trace, attempt and session remain charged. The finite total limit is ${a.limits.maxModelCalls}; previews cannot extend this grant. Reserve a response to submit the original audit. The retained unfiltered directory below is navigation from this SAME review, not evidence or instructions. Do not restart its supplied pages. Inspect relevant original counterevidence using the prior exact-read and discovered unit IDs; those IDs alone do not satisfy current read gates. Required originals are still mandatory. Preview all three checks with honest evidence boundaries, then submit the independent audit through propose_role_claim_audit. Unsupported assertions remain contradicted or insufficient. Do not revise the entry, infer absence from name search, lower importance, or claim certification. No further session or allowance is granted. After compaction restore the task with read_role_session_context offset=0 and each nextOffset, then re-read decisive originals.\n${JSON.stringify({priorNavigation:grant.navigation,priorExactReadUnitIds:a.exactReadUnitIds,priorDiscoveredUnitIds:a.discoveredUnitIds})}`;
        const recorder=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:input.sourceId,operationId:input.batchId});
        let session:PiAgentSession|undefined,requestOrdinal=0,evidenceEpoch=0;
        const abort=()=>void session?.abort();
        try{
          await recorder.record('validation.completed',{phase:'role-review-work',planHash:a.planHash,workId:a.workId,logicalTaskHash:taskHash,
            priorTaskHash:a.taskHash,packetHash:contentHash(prompt),continuationAuthorityHash:authorityHash,limits:a.limits,modelCallsMode:'enforce',retainedUsage:a.budget.state.usage});
          session=await PiAgentSession.create({workspace:await LocalFileWorkspace.create(root),...(profile?{profile}:{}),...(options.model?{model:options.model}:{}),
            saveSession:false,autoCompaction:true,includeProjectInstructions:false,includeLocalTools:false,includeNwhExtension:false,
            interactionMode:'compiler',additionalTools:work.tools,systemPromptOverride:COMPILER_SYSTEM_PROMPT,
            requestBudget:[grant.budget,...(options.requestBudget?(Array.isArray(options.requestBudget)?options.requestBudget:[options.requestBudget]):[])],
            onRequestObservation:async observation=>{
              if(observation.phase==='context')requestOrdinal++;
              await recorder.record('validation.completed',{phase:'role-request-observation',planHash:a.planHash,workId:a.workId,logicalTaskHash:taskHash,
                continuationAuthorityHash:authorityHash,sessionOrdinal:1,requestOrdinal,evidenceEpoch,measurement:describeRequest(observation),budget:grant.budget.snapshot()},
                recorder.rootContext,{blobRef:await recorder.putBlob(observation.value)});
            },onTool:options.onModelToolCall,onToolResult:options.onModelToolResult,onText:options.onModelText,onThinking:options.onModelThinking,
            onEvent:event=>{work.onContextEvent?.(event);if(event.type==='compaction_end'&&event.result)evidenceEpoch++;options.onModelEvent?.(event);},
            trace:{parent:recorder.rootContext,invocationName:a.workId,attempt:1,metadata:{sourceId:input.sourceId,compilerBatchId:input.batchId,continuationAuthorityHash:authorityHash},
              parts:[{id:'role-review-work',kind:'compiler.batch',role:'user',authority:'untrusted-source',label:a.workId,content:prompt}]}});
          options.signal?.addEventListener('abort',abort,{once:true});options.signal?.throwIfAborted();
          await session.promptWithReport(prompt,{timeoutMs:options.promptTimeoutMs??600_000});
          if(!store.claimAudit(input.candidateId))throw roleWorkStop('continued audit ended without its receipt; preserve this single-use continuation');
          await recorder.record('validation.completed',{phase:'role-review-work-usage',workId:a.workId,budget:grant.budget.report()});await recorder.finish('succeeded');
        }catch(error){
          await recorder.record('validation.completed',{phase:'role-review-work-stopped',workId:a.workId,budget:grant.budget.report()});
          await recorder.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:String(error),retryable:false});throw error;
        }finally{options.signal?.removeEventListener('abort',abort);await session?.dispose();}
      });
      if(!dispatched)throw roleWorkStop('claim continuation did not dispatch; inspect the original scope');
      result.status='succeeded';
    }catch(error){result.status='failed';result.error=String(error);throw error;}
    finally{
      result.usage={...grant.budget.report(),state:readRoleClaimContinuation(root,a.planHash,a.workId)!.usage};
      result.receiptHash=contentHash(store.journal.history(ROLE_CLAIM_AUDIT_TOOL,a.workId).at(-1)??null);
      grant.budget.close();await fs.writeFile(grant.file+(startRecovery?'.start-recovery.result.json':'.result.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
    }
    return result;
  };
  return options.acquireLock===false?execute():withWorkspaceOperationLock(root,'compiler',execute);
}
