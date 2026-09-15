import fs from 'node:fs/promises';
import { CanonicalModelStore } from '../../src/world/canonical-model.js';
import { characterEntryCheckpointSchema } from '../../src/world/model.js';
import { contentHash } from '../../src/world/canonical.js';
import { WorkspaceStore } from '../../src/storage/workspace-store.js';
import { SourceMaterialStore } from '../../src/storage/source-material-store.js';
import { inspectCompilerStatus } from '../../src/compiler/status.js';
import { CompilerFinishReceipts } from '../../src/compiler/finish-receipts.js';
import { EvidenceAssertionStore } from '../../src/compiler/evidence-assertions.js';
import { createCompilerProposalToolset } from '../../src/compiler/proposal-tools.js';
import { convergeWorldProposals } from '../../src/compiler/converge.js';
import { assertReconciliationDeferralsReviewed } from '../../src/compiler/reconciliation-review-ledger.js';
import { compilerFailureCauseFingerprint } from '../../src/runtime/codex-compile-loop.js';
import { withWorkspaceOperationLock } from '../../src/util/workspace-lock.js';
const root=process.cwd(),dir=new URL('./',import.meta.url);
await withWorkspaceOperationLock(root,'compiler',async()=>{
 const state=JSON.parse(await fs.readFile(new URL('state.json',dir),'utf8'));
 if(state.attempt!==52||state.status!=='needs-review'||state.knowledgeRepair.pending)throw Error('Incident changed');
 const status=(await inspectCompilerStatus(root,state.sourceId)).sources[0]!;
 if(status.sourceIntegrity!=='verified'||status.hasUnresolvedObligations||status.worldProposalInventory.pending)throw Error('Unreviewed obligations');
 const canon=new CanonicalModelStore(root),events=await canon.listEvents();
 const event=events.find(e=>e.id==='event-breakfast-meeting-00004');if(!event||event.characterEntryCheckpoints?.length)throw Error('Entry target changed');
 const sorted=events.slice().sort((a,b)=>Math.min(...a.evidence.map(r=>r.span.startLine))-Math.min(...b.evidence.map(r=>r.span.startLine))||(a.narrativeContext?.discourseOrder??0)-(b.narrativeContext?.discourseOrder??0)||a.id.localeCompare(b.id));
 for(const actor of ['char-gudeli-an','char-shushu','char-shenshen'])if(sorted.find(e=>(!e.narrativeContext||e.narrativeContext.mode==='scene')&&e.participantPresence?.some(p=>p.entityId===actor&&p.mode==='physical'))?.id!==event.id)throw Error('First-entry target changed');
 const originalBatch=`reconcile-${state.sourceId}-bounded-codex-target-review-v1-20260912-1`,predecessor=new CompilerFinishReceipts(root,state.sourceId,originalBatch),old=await predecessor.read();if(old?.state!=='completed')throw Error('Original finish missing');await predecessor.verify(old);
 const reports=old.identity.input.target_reviews?.filter(r=>['event:event-breakfast-meeting-00004'].includes(r.target));if(reports?.length!==1||reports.some(r=>r.disposition!=='unsupported'))throw Error('Original reports changed');
 const source=await WorkspaceStore.openReadOnly(root).getSource(state.sourceId);if(!source)throw Error('Source missing');const bytes=await new SourceMaterialStore().read(source);if(!bytes)throw Error('Immutable source missing');const lines=bytes.toString('utf8').split('\n');
 const exact=(needle:string)=>{const matches=lines.slice(346,359).filter(l=>l.includes(needle));if(matches.length!==1)throw Error('Anchor not unique');return matches[0]!.trim();};
 const hotel=exact('次日上午，丽晶酒店。'),family=exact('九楼行政层VIP餐吧，路明非全家倾巢出动。'),seated=exact('对着被叔叔婶婶夹在中间的路明非发问。'),arrival=exact('直达电梯打开了门，花白头发的魁梧老人');
 if(!(await canon.listEntities()).some(e=>e.id==='loc-lijing-hotel'&&e.kind==='location'))throw Error('Known hotel entity missing');
 const checkpoints=[
  {actorId:'char-gudeli-an',actorObservation:'你与叶胜、酒德亚纪一起来到丽晶酒店九楼餐吧，准备走向路明非一家所在的桌边。'},
  {actorId:'char-shushu',actorObservation:'你已坐在丽晶酒店餐吧的桌边，路明非在你和婶婶之间。'},
  {actorId:'char-shenshen',actorObservation:'你已在丽晶酒店餐吧的桌边，正在四下打量这个场所，路明非在你和叔叔之间。'},
 ].map(({actorId,actorObservation})=>characterEntryCheckpointSchema.parse({actorId,readerSetup:'面试次日上午，路明非一家已在丽晶酒店九楼VIP餐吧等候，古德里安与叶胜、酒德亚纪刚到。这是教授走到桌边打招呼之前，尚未发生本次会面的介绍和说明。',actorObservation,participantPresence:[{entityId:'char-gudeli-an',mode:'physical'},{entityId:'char-shushu',mode:'physical'},{entityId:'char-shenshen',mode:'physical'}],delta:{version:1,operations:[{op:'set',entityId:actorId,field:'character.location',value:'loc-lijing-hotel'}]}}));
 const next={...event,characterEntryCheckpoints:checkpoints};
 const batch=`host-breakfast-pre-entry-${state.sourceId}-v1`,reviewPath='run-records/2026-09-11-codex-compile-loop/host-review-breakfast-entry-checkpoints.json';
 await fs.writeFile(new URL('host-review-breakfast-entry-checkpoints.json',dir),JSON.stringify({reviewedAt:new Date().toISOString(),priorState:state,originalBatch,originalReceipt:old.fingerprint,reports,original:event,next,sourceQuotes:{hotel,family,seated,arrival},reason:'The exact original unsupported report says the professor, uncle and aunt cannot receive pre-event state. Immutable source expressly locates the family at the hotel VIP bar before the greeting and the professor arriving with the two examiners. The checkpoint is immediately before he greets them: all three are already within the existing hotel location, so no new entity or inferred motivation is needed. Add only each own character.location at the verified hotel, reader setup and direct physical observations. Do not add scholarship terms, admissions outcomes, private family motives, or the later parental-affection statement to any actor knowledge. The professor arrival cue supports a strong inference of his immediate pre-greeting placement; family seating is explicit. Preserve every previous event field, original reports, and publication gates. The two examiner checkpoints from the previous repair remain separate and are not changed.',validation:'Character entry, entry-context, compiler finish/obligation and loop regressions plus strict type check and normal schema/evidence/commit verification.'},null,2),{flag:'wx'});
 const toolset=createCompilerProposalToolset(root);await toolset.beginBatch([],batch,state.sourceId);const call=(name:string,input:unknown)=>toolset.tools.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{} as never);
 const segment='a28585b1cf867f3e3a16-00004-f50b153c1580';
 const assertions=await new EvidenceAssertionStore(root).listForArtifact('canonical-event',event.id);
 const selectors=assertions.flatMap(a=>a.anchors.map(anchor=>({segment_id:segment,exact:bytes.subarray(anchor.startByte,anchor.endByte).toString('utf8'),target_path:a.target.jsonPointer,relation:a.relation,strength:a.strength,...(a.interpretation?{interpretation:a.interpretation}:{})})));
 for(let index=0;index<checkpoints.length;index++)for(const field of ['readerSetup','actorObservation','participantPresence','delta'])for(const quote of [hotel,family,seated,arrival])selectors.push({segment_id:segment,exact:quote,target_path:`/characterEntryCheckpoints/${index}/${field}`,relation:'supports',strength:'strong-inference',interpretation:'Immediate pre-greeting hotel checkpoint: family already seated, professor arriving. Location only; subsequent dialogue and its knowledge remain after the checkpoint.'});
 const {evidence,...payload}=next;await call('propose_canonical_event',{proposal_id:'event-breakfast-host-checkpoints-v1',payload,evidence_segment_ids:[segment],evidence_selectors:selectors});
 await call('finish_compiler_batch',{outcome:'complete',reviewed_segments:[],summary:'Source-reviewed pre-greeting hotel-location checkpoints for the professor, uncle and aunt; no future conversation or private motives added.'});
 const receipts=new CompilerFinishReceipts(root,state.sourceId,batch),receipt=await receipts.read();if(receipt?.state!=='completed')throw Error('Finish incomplete');await receipts.verify(receipt);
 const result=await convergeWorldProposals(root,state.sourceId);if(result.canonical.blocked.length||result.possibilities.blocked.length)throw Error(JSON.stringify(result));
 const current=await canon.listEvents();for(const e of events)if(contentHash(current.find(c=>c.id===e.id))!==contentHash(e.id===event.id?next:e))throw Error('Unexpected event change');
 await predecessor.verify(old);
 let gate=false;try{await assertReconciliationDeferralsReviewed(root,state.sourceId);}catch(e){if(String(e).includes('host source review'))gate=true;else throw e;}if(!gate)throw Error('Original review gate lost');
 state.appliedRepairHistory.push(state.appliedRepair);state.appliedRepair={repairId:'breakfast-source-reviewed-location-checkpoints-v1',failureFingerprint:compilerFailureCauseFingerprint({category:'missing-source-backed-hotel-entry',targetIds:['char-gudeli-an','char-shushu','char-shenshen'],dependencyIds:[event.id]}),reviewPath,appliedAt:new Date().toISOString()};
 await fs.writeFile(new URL('host-review-breakfast-entry-checkpoints-result.json',dir),JSON.stringify({receipt:receipt.fingerprint,gateRetained:gate,onlyEntryCheckpointAdded:true}));
 await fs.writeFile(new URL('state.tmp.json',dir),JSON.stringify(state,null,2));await fs.rename(new URL('state.tmp.json',dir),new URL('state.json',dir));console.log(JSON.stringify({ready:true,receipt:receipt.fingerprint,gateRetained:gate}));
});
