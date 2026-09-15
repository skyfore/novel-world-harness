import fs from 'node:fs/promises';
import { CanonicalModelStore } from '../../src/world/canonical-model.js';
import { contentHash } from '../../src/world/canonical.js';
import { WorkspaceStore } from '../../src/storage/workspace-store.js';
import { SourceMaterialStore } from '../../src/storage/source-material-store.js';
import { inspectCompilerStatus } from '../../src/compiler/status.js';
import { CompilerFinishReceipts } from '../../src/compiler/finish-receipts.js';
import { EvidenceAssertionStore } from '../../src/compiler/evidence-assertions.js';
import { SourceAnnotationStore } from '../../src/compiler/annotations.js';
import { createCompilerProposalToolset } from '../../src/compiler/proposal-tools.js';
import { convergeWorldProposals } from '../../src/compiler/converge.js';
import { assertReconciliationDeferralsReviewed } from '../../src/compiler/reconciliation-review-ledger.js';
import { compilerFailureCauseFingerprint } from '../../src/runtime/codex-compile-loop.js';
import { withWorkspaceOperationLock } from '../../src/util/workspace-lock.js';
const root=process.cwd(),dir=new URL('./',import.meta.url);
await withWorkspaceOperationLock(root,'compiler',async()=>{
 const state=JSON.parse(await fs.readFile(new URL('state.json',dir),'utf8'));
 if(state.attempt!==48||state.status!=='needs-review'||state.knowledgeRepair.pending)throw Error('Incident changed');
 const status=(await inspectCompilerStatus(root,state.sourceId)).sources[0]!;
 if(status.sourceIntegrity!=='verified'||status.hasUnresolvedObligations||status.worldProposalInventory.pending)throw Error('Unreviewed obligations');
 const canon=new CanonicalModelStore(root),events=await canon.listEvents(),relations=await canon.listEventRelations();
 if(events.find(e=>e.id==='event-accept-00005')?.causalParents.length!==0||relations.find(r=>r.id==='rel-car-accept-00005')?.type!=='before')throw Error('Prior temporal correction missing');
 const originalBatch=`reconcile-${state.sourceId}-bounded-codex-target-review-v1-20260912-1`,predecessor=new CompilerFinishReceipts(root,state.sourceId,originalBatch),old=await predecessor.read();if(old?.state!=='completed')throw Error('Original finish missing');await predecessor.verify(old);
 const report=old.identity.input.target_reviews?.find(r=>r.target==='event:event-accept-00005');if(report?.disposition!=='unsupported'||!report.summary.includes('entry checkpoint'))throw Error('Original report changed');
 const annotations=await new SourceAnnotationStore(root).list(state.sourceId,'discourse-segment');
 const layers=['ds-cinema-00005','ds-roadside-00005'].map(id=>annotations.find(a=>a.id===id));if(layers.some(l=>!l||l.annotationType!=='discourse-segment'||l.kind!=='scene'))throw Error('Existing scene annotation missing');
 const source=await WorkspaceStore.openReadOnly(root).getSource(state.sourceId);if(!source)throw Error('Source missing');const bytes=await new SourceMaterialStore().read(source);if(!bytes)throw Error('Immutable source missing');const lines=bytes.toString('utf8').split('\n');
 const specs=[
  ['event-nono-entry-00005','有人用力推开放映厅的门。','ds-cinema-00005'],
  ['event-makeover-00005','两个妆容精致的女孩如狼似虎地扑上来','ds-cinema-00005'],
  ['event-departure-00005','路明非点点头，顺从地往外走去','ds-cinema-00005'],
  ['event-car-stop-00005','发动机熄火了，车停在一家24小时药店','ds-roadside-00005'],
  ['event-accept-00005','想好了，我接受。','ds-roadside-00005'],
  ['event-phone-enrollment-00005','路明非打开手机，拨通了古德里安教授的号码','ds-roadside-00005'],
  ['event-norma-activation-00005','验证通过，选项开启。路明非','ds-roadside-00005'],
  ['event-helicopter-00005','看见低空飞行着逼近的巨大黑影','ds-roadside-00005'],
 ] as const;
 const targets=specs.map(([id,needle,layerId])=>{
  const event=events.find(e=>e.id===id);if(!event||event.narrativeContext)throw Error('Target already has context or is missing');
  const matches=lines.flatMap((l,i)=>i>=692&&i<787&&l.includes(needle)?[{line:i+1,exact:l.trim()}]:[]);if(matches.length!==1)throw Error('Anchor not unique');
  const match=matches[0]!;return {original:event,exact:match.exact,next:{...event,narrativeContext:{layerId,discourseOrder:match.line,mode:'scene' as const}}};
 });
 if(targets.some((t,i)=>i>0&&t.next.narrativeContext.discourseOrder<=targets[i-1]!.next.narrativeContext.discourseOrder))throw Error('Source order changed');
 const batch=`host-roadside-discourse-${state.sourceId}-v1`,reviewPath='run-records/2026-09-11-codex-compile-loop/host-review-roadside-discourse.json';
 await fs.writeFile(new URL('host-review-roadside-discourse.json',dir),JSON.stringify({reviewedAt:new Date().toISOString(),priorState:state,originalBatch,originalReceipt:old.fingerprint,report,layers,targets,sourceLines:lines.slice(692,787),reason:'All eight current events use one broad source evidence segment and lack narrativeContext. Both audit first-embodied selection and runtime entry-context sort that tie by event ID, making accept precede Nono entering the cinema. Source explicitly orders entrance, makeover, departure, car stop, acceptance, enrollment call, Norma activation, helicopter sighting. Bind existing scene annotations and store source-line discourseOrder for all eight events so unannotated zero-valued ties cannot remain. This is textual sequence only; do not infer story-time numbers, new causality, actor knowledge, state effects or checkpoints. The earlier unsupported report is retained; its chosen first-entry target was wrong, which does not prove that a valid checkpoint already exists at the corrected target. Preserve prior relation correction and every publication/review gate.',validation:'Entry-context, character-entry-play, compiler-audit, reconciliation and proposal/finish regressions plus strict type check and normal typed proposal convergence.'},null,2),{flag:'wx'});
 const tools=createCompilerProposalToolset(root);await tools.beginBatch([],batch,state.sourceId);const call=(name:string,input:unknown)=>tools.tools.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{} as never);
 const segment='a28585b1cf867f3e3a16-00005-12c9137e67cf';
 for(const target of targets){
  const assertions=await new EvidenceAssertionStore(root).listForArtifact('canonical-event',target.original.id);
  const selectors=assertions.flatMap(a=>a.anchors.map(anchor=>({segment_id:segment,exact:bytes.subarray(anchor.startByte,anchor.endByte).toString('utf8'),target_path:a.target.jsonPointer,relation:a.relation,strength:a.strength,...(a.interpretation?{interpretation:a.interpretation}:{})})));
  selectors.push({segment_id:segment,exact:target.exact,target_path:'/narrativeContext',relation:'supports',strength:'explicit'});
  const {evidence,...payload}=target.next;await call('propose_canonical_event',{proposal_id:`${target.original.id}-host-discourse-v1`,payload,evidence_segment_ids:[segment],evidence_selectors:selectors});
 }
 await call('finish_compiler_batch',{outcome:'complete',reviewed_segments:[],summary:'Restore source-backed textual scene ordering for the cinema/roadside batch, preserving all world-time, effects and checkpoints.'});
 const receipts=new CompilerFinishReceipts(root,state.sourceId,batch),receipt=await receipts.read();if(receipt?.state!=='completed')throw Error('Finish incomplete');await receipts.verify(receipt);
 const result=await convergeWorldProposals(root,state.sourceId);if(result.canonical.blocked.length||result.possibilities.blocked.length)throw Error(JSON.stringify(result));
 const current=await canon.listEvents();for(const event of events)if(contentHash(current.find(e=>e.id===event.id))!==contentHash(targets.find(t=>t.original.id===event.id)?.next??event))throw Error('Unexpected event mutation');
 if(contentHash(await canon.listEventRelations())!==contentHash(relations))throw Error('Relations changed');
 await predecessor.verify(old);
 let gate=false;try{await assertReconciliationDeferralsReviewed(root,state.sourceId);}catch(e){if(String(e).includes('host source review'))gate=true;else throw e;}if(!gate)throw Error('Original review gate lost');
 state.appliedRepairHistory.push(state.appliedRepair);state.appliedRepair={repairId:'cinema-roadside-source-discourse-order-v1',failureFingerprint:compilerFailureCauseFingerprint({category:'first-entry-target-from-alphabetic-tie',targetIds:['char-nuonuo'],dependencyIds:specs.map(s=>s[0])}),reviewPath,appliedAt:new Date().toISOString()};
 await fs.writeFile(new URL('host-review-roadside-discourse-result.json',dir),JSON.stringify({receipt:receipt.fingerprint,gateRetained:gate,onlyNarrativeContextChanged:true}));
 await fs.writeFile(new URL('state.tmp.json',dir),JSON.stringify(state,null,2));await fs.rename(new URL('state.tmp.json',dir),new URL('state.json',dir));console.log(JSON.stringify({ready:true,receipt:receipt.fingerprint,gateRetained:gate}));
});
