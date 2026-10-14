import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {createEvidenceFixture} from './helpers/evidence.js';
import {CanonicalModelStore} from '../src/world/canonical-model.js';
import {contentHash} from '../src/world/canonical.js';
import {worldStorageRoot} from '../src/world/paths.js';
import {ensureSourceStructure,baseStructuralUnits} from '../src/compiler/structure.js';
import {loadCurrentRoleRoster} from '../src/compiler/role-roster-tools.js';
import {RoleReviewWorkStore} from '../src/compiler/role-review-work.js';
import {RoleContextCheckpoint} from '../src/compiler/role-context-window.js';
import {roleReviewBudget,inspectRoleReviewBudget,inspectRetainedRoleReviewBudget} from '../src/compiler/role-review-budget.js';
import {inspectRoleClaimContinuation,claimRoleClaimContinuation,readRoleClaimContinuation,assertRoleClaimContinuationHistory,inspectRoleClaimStartRecovery} from '../src/compiler/role-claim-continuation.js';
import {captureRoleWorkAllowance} from '../src/compiler/role-judgment-repair-service.js';
import {validateRoleDevelopmentExpectations} from '../src/compiler/role-roster.js';
import {withWorkspaceOperationLock} from '../src/util/workspace-lock.js';
import {TraceStore} from '../src/trace/store.js';
import {TraceRecorder} from '../src/trace/recorder.js';
import {PiAgentSession} from '../src/agent/pi-session.js';
import {runBoundedRoleReview,type RoleWorkInvocation} from '../src/workflow/role-review-bounded.js';
import {RoleSessionContext} from '../src/workflow/role-session-context.js';
import {continueRoleClaim} from '../src/workflow/role-claim-continuation.js';

const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
type FixtureOptions={toolFailure?:boolean;pending?:boolean;mutation?:boolean;otherFailure?:boolean;searchOnly?:boolean;secondContext?:boolean;legacyPrompt?:boolean;budgetResponse?:boolean;providerResponse?:boolean;ordinary?:boolean};
async function fixture(options:FixtureOptions={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwh-claim-continuation-'));roots.push(root);
  const f=await createEvidenceFixture(root,'Voyager opens the door.\nA stranger observes the road.\n');await ensureSourceStructure(root,f.source);
  await new CanonicalModelStore(root).putEntity({id:'voyager',canonicalName:'Voyager',kind:'character',aliases:[],evidence:f.evidence('Voyager')});
  const {roster,structure}=await loadCurrentRoleRoster(root,f.source.id),candidateId=roster.candidates[0]!.id,batchId=`role-roster-${f.source.id}-continuation`;
  const store=await RoleReviewWorkStore.open(root,{version:1,sourceId:f.source.id,sourceHash:roster.sourceSha256,subjectHash:roster.subjectHash,batchId,
    structureHash:contentHash(structure),spans:[{start:0,end:f.source.bytes}],legacyDraftHashes:[]});
  await store.submit('source',0,{summary:'An opening and a separate observation',findings:[],openQuestions:[]},()=>{});
  const unit=baseStructuralUnits(structure)[0]!,counterunit=baseStructuralUnits(structure).at(-1)!;
  const entry={candidateId,importance:'major' as const,rationale:'Central causal action',basisUnitIds:[unit.id],
    developmentExpectation:{kind:'unknown' as const,rationale:'No lasting change or continuity established',basisUnitIds:[unit.id]}};
  store.journal.record('propose_role_roster_entry',{subjectHash:store.plan.subjectHash,entry},'succeeded');
  const workId=store.claimWorkId(candidateId),workflowOptions={root,sourceId:f.source.id,compilerBatchId:batchId,configPath:path.join(root,'absent.yaml')};
  let original:RoleWorkInvocation|undefined;
  await expect(runBoundedRoleReview({...workflowOptions,...(!options.ordinary?{claimAuditScope:{planHash:store.planHash,atlasRevision:store.atlasRevision(),entriesHash:store.entriesHash(),candidateIds:[candidateId],missingSourceWorkIds:[]}}:{})},async work=>{
    if(options.ordinary){
      expect(work.tools.some(t=>t.name==='preview_role_claim_audit')).toBe(true);
      expect(work.prompt).toContain('12-model-call no-progress window');
      expect(work.prompt).toContain('Preview success validates structure and evidence access only');
    }
    original=work;throw Error('fixture retains original task');
  })).rejects.toThrow('fixture retains original task');
  if(options.legacyPrompt)original={...original!,prompt:'Older audit instructions without a disclosed progress window.\n'+original!.prompt.split('\n').at(-1)!};
  const taskHash=contentHash(original!.prompt),prompt=new RoleSessionContext(original!).invocation().prompt;
  const checkpoint=await RoleContextCheckpoint.open(root,store.planHash,workId,taskHash);
  const contextDir=path.join(worldStorageRoot(root),'compiler','role-review-work','context-loops',store.planHash,contentHash(workId),taskHash);
  await fs.mkdir(contextDir,{recursive:true});const claim={planHash:store.planHash,workId,taskHash,ordinal:0};
  await fs.writeFile(path.join(contextDir,'0.json'),JSON.stringify({claim,hash:contentHash(claim)}));
  if(options.secondContext)await fs.writeFile(path.join(contextDir,'1.json'),'{}');
  const budget=roleReviewBudget(root,store.planHash,workId,{maxModelCalls:3,maxRequestBytes:48000,maxTotalPayloadBytes:100000},false,'progress');
  const recorder=await TraceRecorder.start(new TraceStore(root),{kind:'prepare',sourceId:f.source.id,operationId:batchId});
  await recorder.record('validation.completed',{phase:'role-review-work',planHash:store.planHash,workId,packetHash:contentHash(prompt)});
  await recorder.record('context.assembled',{phase:'before-agent-start'},recorder.rootContext,{blobRef:await recorder.putBlob(prompt)});
  for(let i=0;i<3;i++){budget.beginCall({});await recorder.record('llm.request.started',{});await recorder.record('llm.response.completed',{});}
  try{budget.beginCall({});}catch{}
  if(options.budgetResponse||options.providerResponse)await recorder.record('llm.response.failed',{
    errorMessage:options.providerResponse?'Provider quota':inspectRoleReviewBudget(root,store.planHash,workId).state.failure!.message,
    usage:{input:0,output:0,totalTokens:0}},recorder.rootContext,{callId:'untransported-stop'});
  await recorder.record('validation.completed',{phase:'role-request-observation',planHash:store.planHash,workId,logicalTaskHash:taskHash,sessionOrdinal:0,evidenceEpoch:0});
  const call=async(name:string,args:unknown,body:unknown,last=false)=>{
    const id='call-'+name,result={content:[{type:'text',text:JSON.stringify(body)}]};
    await recorder.record('tool.call.started',{toolName:name},recorder.rootContext,{toolCallId:id,blobRef:await recorder.putBlob(args)});
    if(last&&options.pending)return;
    await recorder.record(last&&options.toolFailure?'tool.call.failed':'tool.call.completed',{toolName:name},recorder.rootContext,{toolCallId:id,blobRef:await recorder.putBlob(result)});
    await checkpoint.record(name,args,result);
  };
  await call('read_role_review_atlas',{}, {pages:[{page:0,summary:'An opening and a separate observation'}]});
  await call(options.mutation?'preview_role_claim_audit':'read_role_work_evidence',options.searchOnly?{query:'stranger'}:{unitId:counterunit.id},{units:[{unitId:counterunit.id,excerpt:'stranger'}]},true);
  await recorder.record('validation.completed',{phase:'role-review-work-stopped',workId,compactions:[],budget:budget.report()});
  await recorder.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:options.otherFailure?'Error: quota':`Error: ${inspectRoleReviewBudget(root,store.planHash,workId).state.failure!.message}`,retryable:false});budget.close();
  const packet=JSON.parse(original!.prompt.split('\n').at(-1)!);
  return {root,store,workId,roster,unit,counterunit,entry,contextDir,workflowOptions,packet,input:{sourceId:f.source.id,batchId,candidateId,runId:recorder.manifest.id,
    authorizationRef:'user-authorized-systemic-repair',diagnosisRef:'fixture-read-only-stop',implementationRef:'fixture-verified-fix',additionalCalls:2}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const draft=(f:Fixture,verdict='supported')=>({candidateId:f.input.candidateId,claimRevision:f.packet.claimRevision,atlasRevision:f.packet.atlasRevision,packetHash:f.packet.packetHash,
  verdict,rationale:'Independent original evidence review',basisUnitIds:[f.unit.id],counterevidence:{searchedUnitIds:[f.counterunit.id],rationale:'Read the separate observation'},
  checks:['importance','identity','development'].map(kind=>({kind,verdict:kind==='development'?verdict:'supported',rationale:'Evidence assessed separately',basisUnitIds:[f.unit.id]}))});

it.each([
  [{toolFailure:true},'tool failure'],[{pending:true},'settled source navigation'],[{mutation:true},'successful reads'],
  [{otherFailure:true},'exact settled'],[{secondContext:true},'session allowance'],
  [{providerResponse:true},'provider response failure'],
] as const)('refuses ineligible histories before granting anything: %j',async(options,message)=>{
  const f=await fixture(options);await expect(inspectRoleClaimContinuation(f.root,f.input)).rejects.toThrow(message);
});
it('accepts only the local untransported budget refusal and exposes previews in ordinary audits',async()=>{
  const f=await fixture({budgetResponse:true,ordinary:true});
  await expect(inspectRoleClaimContinuation(f.root,f.input)).resolves.toMatchObject({authority:{budget:{state:{blocked:true}}}});
});
it('keeps search results as navigation and binds source, claim, trace, budget and unused attempt',async()=>{
  const f=await fixture({searchOnly:true}),p=await inspectRoleClaimContinuation(f.root,f.input);
  expect(p.authority.exactReadUnitIds).toEqual([]);expect(p.authority.discoveredUnitIds).toEqual([f.counterunit.id]);
  await expect(claimRoleClaimContinuation(f.root,f.input,p.authorityHash)).rejects.toThrow('compiler lock');
  await withWorkspaceOperationLock(f.root,'compiler',async()=>{
    await expect(claimRoleClaimContinuation(f.root,{...f.input,additionalCalls:3},p.authorityHash)).rejects.toThrow('authority changed');
  });
  await f.store.beginAttempt(f.workId);
  await expect(inspectRoleClaimContinuation(f.root,f.input)).rejects.toThrow('invocation attempt');
});
it('rejects changes to the claim/evidence and any consumed proposal receipt',async()=>{
  const f=await fixture();
  f.store.journal.record('propose_role_roster_entry',{subjectHash:f.store.plan.subjectHash,entry:{...f.entry,rationale:'Changed after failure'}},'succeeded');
  await expect(inspectRoleClaimContinuation(f.root,f.input)).rejects.toThrow('changed since the failed');
  f.store.journal.record('propose_role_claim_audit',f.store.claimEnvelope(f.input.candidateId,draft(f,'insufficient')),'succeeded');
  await expect(inspectRoleClaimContinuation(f.root,f.input)).rejects.toThrow('unaudited claim');
});

it.each(['supported','insufficient','unread','exhausted','compacted'] as const)('continues the exact legacy audit with cumulative charges and all ordinary gates: %s',async mode=>{
  const f=await fixture({legacyPrompt:true}),preview=await inspectRoleClaimContinuation(f.root,f.input);
  const before=inspectRoleReviewBudget(f.root,f.store.planHash,f.workId),frozen=await Promise.all(preview.authority.retainedFiles.map(async r=>fs.readFile(path.join(worldStorageRoot(f.root),r.path),'utf8')));
  const create=vi.spyOn(PiAgentSession,'create').mockImplementation(async options=>{
    const budget=(Array.isArray(options.requestBudget)?options.requestBudget[0]:options.requestBudget)!;
    return {promptWithReport:async(prompt:string)=>{
      expect(prompt).toContain('exactly 2 additional model calls');expect(budget.snapshot().modelCalls).toBe(3);budget.beginCall({});
      const tools=options.additionalTools!;
      expect(tools.some(t=>['request_role_session_rebuild','request_role_work_evidence','propose_role_roster_entry'].includes(t.name))).toBe(false);
      const call=(name:string,input:unknown)=>tools.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{} as ExtensionContext);
      if(mode==='exhausted'){budget.beginCall({});budget.beginCall({});}
      if(mode==='compacted'){
        options.onEvent?.({type:'compaction_end',result:{summary:'Summary is not original evidence',firstKeptEntryId:'x',tokensBefore:10},aborted:false,willRetry:false,reason:'overflow'} as never);
        const blocked=await call('propose_role_claim_audit',draft(f));expect(blocked.isError).toBe(true);
        let offset=0;for(;;){const r=JSON.parse((await call('read_role_session_context',{offset})).content[0]!.text as string);if(r.nextOffset===undefined)break;offset=r.nextOffset;}
      }
      if(mode!=='unread')await call('read_role_work_evidence',{unitId:f.counterunit.id});
      const value=draft(f,mode==='insufficient'?'insufficient':'supported');
      const pre=JSON.parse((await call('preview_role_claim_audit',value)).content[0]!.text as string);
      expect(pre.valid).toBe(mode!=='unread');expect(f.store.claimAudit(f.input.candidateId)).toBeUndefined();
      await call('propose_role_claim_audit',value);
    },dispose:async()=>{},abort:async()=>{}} as unknown as PiAgentSession;
  });
  const run=continueRoleClaim(f.workflowOptions,f.input,preview.authorityHash),succeeds=!['unread','exhausted'].includes(mode);
  if(succeeds){
    await expect(run).resolves.toMatchObject({status:'succeeded'});
    expect(f.store.claimAudit(f.input.candidateId)?.verdict).toBe(mode==='insufficient'?'insufficient':'supported');
    await expect(assertRoleClaimContinuationHistory(f.store)).resolves.toBeUndefined();
    expect(validateRoleDevelopmentExpectations({...f.roster,reviews:[{runId:'independent',subjectHash:f.roster.subjectHash,reviewedUnitIds:f.roster.unitIds,entries:[f.entry],missingMajorCharacters:[]}]}).length).toBeGreaterThan(0);
  }else await expect(run).rejects.toThrow(mode==='exhausted'?'model-call limit':'evidence');
  expect(create).toHaveBeenCalledOnce();expect(f.store.stagedEntries()).toEqual([f.entry]);
  expect(inspectRoleReviewBudget(f.root,f.store.planHash,f.workId)).toEqual(before);
  const after=readRoleClaimContinuation(f.root,f.store.planHash,f.workId)!;
  expect(after.usage.usage.modelCalls).toBe(mode==='exhausted'?5:4);
  expect(inspectRetainedRoleReviewBudget(f.root,f.store.planHash,f.workId).state).toMatchObject({blocked:true,usage:{modelCalls:mode==='exhausted'?5:4}});
  for(const [i,file] of preview.authority.retainedFiles.entries())expect(await fs.readFile(path.join(worldStorageRoot(f.root),file.path),'utf8')).toBe(frozen[i]);
  const retainedFiles:Array<{path:string;hash:string}>=[];
  const allowance=await captureRoleWorkAllowance(f.store,f.workId,retainedFiles);
  expect(allowance).toMatchObject({attempts:2,contextSessions:2,budget:{state:{blocked:true,usage:{modelCalls:mode==='exhausted'?5:4}}}});
  expect(retainedFiles.filter(f=>f.path.includes('claim-continuation'))).toHaveLength(3);
  await expect(continueRoleClaim(f.workflowOptions,f.input,preview.authorityHash)).rejects.toThrow(/already claimed|unaudited claim|unresolved/);
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow('invocation allowance exhausted');
  expect(create).toHaveBeenCalledOnce();expect(f.store.auditComplete()).toBe(false);
  if(mode==='supported'){
    const prior=preview.authority.retainedFiles[0]!;
    await fs.appendFile(path.join(worldStorageRoot(f.root),prior.path),'\n');
    await expect(assertRoleClaimContinuationHistory(f.store)).rejects.toThrow('predecessor history changed');
    await expect(f.store.assertQuestionLedger()).rejects.toThrow('predecessor history changed');
  }
});

it('does not revive a claimed continuation after a crash or hide a pending charge',async()=>{
  const f=await fixture(),p=await inspectRoleClaimContinuation(f.root,f.input);
  await withWorkspaceOperationLock(f.root,'compiler',async()=>{const grant=await claimRoleClaimContinuation(f.root,f.input,p.authorityHash);grant.budget.beginCall({});grant.budget.close();});
  await expect(continueRoleClaim(f.workflowOptions,f.input,p.authorityHash)).rejects.toThrow('already claimed');
  await fs.writeFile(p.file+'.usage.json.pending','uncertain');
  expect(()=>readRoleClaimContinuation(f.root,f.store.planHash,f.workId)).toThrow('uncertain');
});

it('checks the host configuration before consuming a single-use grant',async()=>{
  const f=await fixture(),p=await inspectRoleClaimContinuation(f.root,f.input);
  await expect(continueRoleClaim({...f.workflowOptions,configPath:undefined as never},f.input,p.authorityHash)).rejects.toThrow('configPath before claiming');
  await expect(fs.stat(p.file)).rejects.toMatchObject({code:'ENOENT'});
  expect((await inspectRoleClaimContinuation(f.root,f.input)).authorityHash).toBe(p.authorityHash);
});
async function preDispatchFailure(f:Fixture,charged=false){
  const p=await inspectRoleClaimContinuation(f.root,f.input);
  await withWorkspaceOperationLock(f.root,'compiler',async()=>{
    const grant=await claimRoleClaimContinuation(f.root,f.input,p.authorityHash);
    if(charged)grant.budget.beginCall({});
    const result={status:'failed',authorityHash:p.authorityHash,error:'Host configuration failure before dispatch',
      usage:{...grant.budget.report(),state:readRoleClaimContinuation(f.root,f.store.planHash,f.workId)!.usage},receiptHash:contentHash(null)};
    grant.budget.close();await fs.writeFile(p.file+'.result.json',JSON.stringify(result),{flag:'wx'});
  });
  const saved=await fs.readFile(p.file+'.result.json','utf8');
  return {p,saved,recovery:{expectedResultHash:contentHash(JSON.parse(saved)),authorizationRef:'same-host-grant-pre-dispatch-repair',implementationRef:'verified-preflight-repair'}};
}
it('recovers only dispatch of the same uncharged grant, preserving its failed result and budget cap',async()=>{
  const f=await fixture(),{p,saved,recovery}=await preDispatchFailure(f);
  const preview=await inspectRoleClaimStartRecovery(f.root,f.input,p.authorityHash,recovery);
  const create=vi.spyOn(PiAgentSession,'create').mockImplementation(async options=>({promptWithReport:async()=>{
    const budget=(Array.isArray(options.requestBudget)?options.requestBudget[0]:options.requestBudget)!;
    expect(budget.snapshot().modelCalls).toBe(3);budget.beginCall({});
    const call=(name:string,input:unknown)=>options.additionalTools!.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{} as ExtensionContext);
    await call('read_role_work_evidence',{unitId:f.counterunit.id});await call('propose_role_claim_audit',draft(f));
  },dispose:async()=>{},abort:async()=>{}} as unknown as PiAgentSession));
  await expect(continueRoleClaim(f.workflowOptions,f.input,p.authorityHash,{input:recovery,authorityHash:preview.authorityHash})).resolves.toMatchObject({status:'succeeded'});
  expect(await fs.readFile(p.file+'.result.json','utf8')).toBe(saved);
  expect(readRoleClaimContinuation(f.root,f.store.planHash,f.workId)).toMatchObject({authority:{limits:{maxModelCalls:5}},usage:{usage:{modelCalls:4}}});
  await expect(assertRoleClaimContinuationHistory(f.store)).resolves.toBeUndefined();
  expect(inspectRetainedRoleReviewBudget(f.root,f.store.planHash,f.workId).state).toMatchObject({blocked:true,usage:{modelCalls:4}});
  await expect(continueRoleClaim(f.workflowOptions,f.input,p.authorityHash,{input:recovery,authorityHash:preview.authorityHash})).rejects.toThrow('already consumed');
  expect(create).toHaveBeenCalledOnce();
});
it.each(['charged','attempted','stale'] as const)('refuses pre-dispatch recovery when it cannot prove unused dispatch: %s',async mode=>{
  const f=await fixture(),{p,recovery}=await preDispatchFailure(f,mode==='charged');
  if(mode==='attempted')await f.store.beginAttempt(f.workId);
  if(mode==='stale')recovery.expectedResultHash=contentHash('stale');
  await expect(inspectRoleClaimStartRecovery(f.root,f.input,p.authorityHash,recovery)).rejects.toThrow(/zero additional|may already have started/);
});
