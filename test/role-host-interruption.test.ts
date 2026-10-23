import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {createEvidenceFixture} from './helpers/evidence.js';
import {ensureSourceStructure} from '../src/compiler/structure.js';
import {CanonicalModelStore} from '../src/world/canonical-model.js';
import {loadCurrentRoleRoster} from '../src/compiler/role-roster-tools.js';
import {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import {roleReviewBudget,inspectRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import {inspectRoleHostInterruption,grantRoleHostInterruption,inspectInterruptedRoleSession} from '../src/compiler/role-host-interruption.js';
import {runWithRoleContextRecovery} from '../src/workflow/role-session-context.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
import {workspaceStateDir} from '../src/agent/runtime-paths.js';
import {withWorkspaceOperationLock} from '../src/util/workspace-lock.js';
import {contentHash} from '../src/world/canonical.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(pendingTool=false,quota=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-host-interruption-'));roots.push(root);
  const f=await createEvidenceFixture(root,'Hero opens the door.\n');await ensureSourceStructure(root,f.source);
  await new CanonicalModelStore(root).putEntity({id:'hero',canonicalName:'Hero',kind:'character',aliases:[],evidence:f.evidence('Hero')});
  const {roster,structure}=await loadCurrentRoleRoster(root,f.source.id),batchId=`role-roster-${f.source.id}-interruption`;
  const store=await RoleReviewWorkStore.open(root,{version:1,sourceId:f.source.id,sourceHash:roster.sourceSha256,subjectHash:roster.subjectHash,
    batchId,structureHash:contentHash(structure),spans:[{start:0,end:f.source.bytes}],legacyDraftHashes:[]});
  const work={workId:store.workId('source',0),prompt:'Original source evidence: Hero opens the door.',tools:[],complete:()=>false};
  const limits={maxModelCalls:12,maxRequestBytes:48000,maxTotalPayloadBytes:100000};
  const budget=roleReviewBudget(root,store.planHash,work.workId,limits,false,'progress');
  budget.beginCall({});budget.recordValidatedProgress(`draft:${contentHash(work.prompt)}`);budget.beginCall({});budget.close();
  await store.beginAttempt(work.workId);
  await expect(runWithRoleContextRecovery(store,work,async()=>{throw Error('process interrupted');})).rejects.toThrow('process interrupted');
  const recorder=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:f.source.id,operationId:batchId});
  await recorder.record('validation.completed',{phase:'role-review-work',planHash:store.planHash,workId:work.workId,packetHash:contentHash(work.prompt+'\nSession instructions')});
  await recorder.record('validation.completed',{phase:'role-request-observation',planHash:store.planHash,workId:work.workId,logicalTaskHash:contentHash(work.prompt),sessionOrdinal:0});
  if(pendingTool)await recorder.record('tool.call.started',{toolName:'propose_role_source_review'},{...recorder.rootContext,toolCallId:'unsettled'});
  if(quota)await recorder.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:'You have hit your ChatGPT usage limit',retryable:false});
  const archive=path.join(workspaceStateDir(root),'locks','recovered','compiler-fixture.lock');await fs.mkdir(archive,{recursive:true});
  const owner={version:1,pid:99999999,token:'old-owner',startedAt:new Date(Date.now()-60000).toISOString(),host:{hostname:'fixture',bootId:'boot',pidNamespace:'pid:fixture'}};
  const proof={version:1,recoveredAt:new Date(Date.now()+1).toISOString(),host:owner.host,owner,archivePath:archive};
  await fs.writeFile(path.join(archive,'owner.json'),JSON.stringify(owner));await fs.writeFile(path.join(archive,'recovery.json'),JSON.stringify(proof));
  await new TraceStore(root).initialize();
  const input={planHash:store.planHash,workId:work.workId,runId:recorder.manifest.id,lockRecoveryArchive:archive,implementationRef:'test fixture'};
  return {root,store,work,limits,input};
}

it('resumes only the next original context and keeps prior usage, progress, claims and invocation limits',async()=>{
  const f=await fixture(),before=inspectRoleReviewBudget(f.root,f.store.planHash,f.work.workId),preview=await inspectRoleHostInterruption(f.root,f.input);
  await expect(fs.stat(preview.file)).rejects.toMatchObject({code:'ENOENT'});
  await expect(grantRoleHostInterruption(f.root,f.input,preview.authorityHash)).rejects.toThrow("compiler lock");
  await withWorkspaceOperationLock(f.root,'compiler',async()=>{
    await grantRoleHostInterruption(f.root,f.input,preview.authorityHash);
    await expect(grantRoleHostInterruption(f.root,f.input,preview.authorityHash)).rejects.toMatchObject({code:'EEXIST'});
    const resume={policy:'host-interruption' as const,planHash:f.store.planHash,workId:f.work.workId,authorityHash:preview.authorityHash};
    expect((await inspectInterruptedRoleSession(f.store,resume)).taskHash).toBe(contentHash(f.work.prompt));
    expect(await f.store.beginAttempt(f.work.workId)).toBe(2);
    let calls=0;
    await runWithRoleContextRecovery(f.store,f.work,async work=>{
      calls++;expect(work.sessionOrdinal).toBe(1);expect(work.retainedBudgetRequired).toBe(true);
      const result=await work.tools.find(t=>t.name==='read_role_session_context')!.execute('restore',{offset:0} as never,undefined,undefined,{} as ExtensionContext);
      expect(JSON.parse((result.content[0] as {text:string}).text).text).toBe(f.work.prompt);
    },undefined,resume);
    expect(calls).toBe(1);expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.work.workId)).toEqual(before);
    await expect(inspectInterruptedRoleSession(f.store,resume)).rejects.toThrow('already consumed');
    await expect(f.store.beginAttempt(f.work.workId)).rejects.toThrow('invocation allowance exhausted');
  });
});

it('rejects quota errors and uncertain in-flight tool results instead of relabeling them as host recovery',async()=>{
  const pending=await fixture(true);await expect(inspectRoleHostInterruption(pending.root,pending.input)).rejects.toThrow('tool result is uncertain');
  const quota=await fixture(false,true);await expect(inspectRoleHostInterruption(quota.root,quota.input)).rejects.toThrow('not a reconciled host interruption');
});

it('rejects a changed budget after authorization and a foreign recovery archive',async()=>{
  const f=await fixture(),preview=await inspectRoleHostInterruption(f.root,f.input);
  await withWorkspaceOperationLock(f.root,'compiler',()=>grantRoleHostInterruption(f.root,f.input,preview.authorityHash));
  const budget=roleReviewBudget(f.root,f.store.planHash,f.work.workId,f.limits,true,'progress');budget.beginCall({});budget.close();
  await expect(inspectInterruptedRoleSession(f.store,{policy:'host-interruption',planHash:f.store.planHash,workId:f.work.workId,authorityHash:preview.authorityHash})).rejects.toThrow('changed after host review');
  await expect(inspectRoleHostInterruption(f.root,{...f.input,lockRecoveryArchive:f.root})).rejects.toThrow('outside this workspace');
});
