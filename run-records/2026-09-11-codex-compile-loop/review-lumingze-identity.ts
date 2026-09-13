import fs from 'node:fs/promises';
import { CanonicalModelStore } from '../../src/world/canonical-model.js';
import { ActorModelStore } from '../../src/world/actors.js';
import { SourceAnnotationStore } from '../../src/compiler/annotations.js';
import { EntityResolutionStore } from '../../src/compiler/entity-resolution.js';
import { EvidenceAssertionStore } from '../../src/compiler/evidence-assertions.js';
import { SegmentStore } from '../../src/compiler/segments.js';
import { WorkspaceStore } from '../../src/storage/workspace-store.js';
import { SourceMaterialStore } from '../../src/storage/source-material-store.js';
import { createCompilerProposalToolset } from '../../src/compiler/proposal-tools.js';
import { CompilerFinishReceipts } from '../../src/compiler/finish-receipts.js';
import { convergeWorldProposals } from '../../src/compiler/converge.js';
import { inspectCompilerStatus } from '../../src/compiler/status.js';
import { contentHash } from '../../src/world/canonical.js';
import { withWorkspaceOperationLock } from '../../src/util/workspace-lock.js';
const root=process.cwd(),dir=new URL('./',import.meta.url),apply=process.argv.includes('--apply');
await withWorkspaceOperationLock(root,'compiler',async()=>{
 const state=JSON.parse(await fs.readFile(new URL('state.json',dir),'utf8')),sid=state.sourceId;
 if(state.attempt!==16||state.status!=='needs-review'||state.knowledgeRepair.pending)throw Error('Incident changed');
 const status=(await inspectCompilerStatus(root,sid)).sources[0]!;
 if(status.sourceIntegrity!=='verified'||status.hasUnresolvedObligations||status.worldProposalInventory.pending)throw Error('Unreviewed obligations');
 const doc=await WorkspaceStore.openReadOnly(root).getSource(sid);if(!doc)throw Error('Source absent');
 const bytes=await new SourceMaterialStore().read(doc);if(!bytes)throw Error('Source bytes absent');
 const lines=bytes.toString('utf8').split('\n');
 if(!lines[1689]?.includes('眼前这个男孩跟路鸣泽相差十万八千里，一丝一毫的相似都找不出来。')||!lines[66]?.includes('堂弟'))throw Error('Source distinction changed');
 const canon=new CanonicalModelStore(root),annotations=new SourceAnnotationStore(root),resolutions=new EntityResolutionStore(root);
 const original='char-lumingze',separate='char-lumingze-boy';
 if((await canon.listEntities()).some(e=>e.id===separate))throw Error('New identity already exists; inspect original attempt');
 const groups=[{kind:'canonical-event',method:'listEvents',ids:['event-lumingfei-vision-fall-00010','event-lumingze-visit-001','event-near-crash-00014']},{kind:'event-participation',method:'listEventParticipations',ids:['part-crash-lz-00014','part-lz-lz-001']},{kind:'scene-occurrence',method:'listSceneOccurrences',ids:['scene-exam-00010','scene-mountain-drive-00014']}];
 const allGroups:Record<string,any[]>={};
 for(const m of Object.getOwnPropertyNames(Object.getPrototypeOf(canon)).filter(k=>k.startsWith('list')&&k!=='listRevisions'&&k!=='list'))allGroups[m]=await (canon as any)[m]();
 const actors=new ActorModelStore(root);for(const m of ['listModels','listGoals'])if(typeof (actors as any)[m]==='function'){const data=await (actors as any)[m]();if(JSON.stringify(data).includes(original))throw Error('Additional actor dependency requires review');}
 const manifest=await new SegmentStore(root).readManifest(sid);if(!manifest)throw Error('Manifest absent');
 const assertions=new EvidenceAssertionStore(root);
 const replacements=[];
 for(const group of groups)for(const id of group.ids){
  const before=allGroups[group.method]!.find(d=>d.id===id);if(!before||!JSON.stringify(before).includes(original))throw Error('Dependency changed '+id);
  const after=JSON.parse(JSON.stringify(before),(_k,v)=>v===original?separate:v);
  const segment=manifest.segments.find(s=>s.startByte===before.evidence[0].span.startByte&&s.endByte===before.evidence[0].span.endByte);if(!segment)throw Error('Missing exact segment '+id);
  const selectors:any[]=[];
  for(const a of await assertions.listForArtifact(group.kind,id))for(const anchor of a.anchors){
   const s=manifest.segments.find(s=>anchor.startByte>=s.startByte&&anchor.endByte<=s.endByte);if(!s)throw Error('Unbound original assertion');
   selectors.push({segment_id:s.id,exact:bytes.subarray(anchor.startByte,anchor.endByte).toString('utf8'),target_path:a.target.jsonPointer,relation:a.relation,strength:a.strength,...(a.interpretation?{interpretation:a.interpretation}:{})});
  }
  const changedPaths:string[]=[];const walk=(v:any,path:string)=>{if(v===original)changedPaths.push(path);else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))walk(x,path+'/'+k);};walk(before,'');
  const sourceLine=segment.startLine===1614?1689:segment.startLine===1888?1962:2682;
  const exact=lines[sourceLine-1]!.trim();
  for(const path of changedPaths)selectors.push({segment_id:segment.id,exact,target_path:path,relation:'supports',strength:'strong-inference',interpretation:'Host original-source review distinguishes the recurring boy from the cousin; exact source scene identifies this referent. Preserve presence mode and all other semantics.'});
  for(const selector of selectors){const s=manifest.segments.find(s=>s.id===selector.segment_id)!;if(!bytes.subarray(s.startByte,s.endByte).toString('utf8').includes(selector.exact))throw Error('Selector outside source '+id);}
  delete after.evidence;
  replacements.push({kind:group.kind,method:group.method,before,after,selectors,segmentId:segment.id});
 }
 const selected=(await resolutions.list(sid)).filter(r=>['em-boy-vision-1','em-lumingze-003','m-lumingze-1'].includes(r.mentionId));
 if(selected.length!==3||selected.some(r=>r.entityId!==original))throw Error('Resolution closure changed');
 const annotationBefore=await annotations.list(sid),resolutionBefore=await resolutions.list(sid);
 const oldBatch=`reconcile-${sid}-bounded-codex-target-review-v1-20260912-3`,oldStore=new CompilerFinishReceipts(root,sid,oldBatch),old=await oldStore.read();if(old?.state!=='completed')throw Error('Predecessor incomplete');await oldStore.verify(old);
 const report=old.identity.input.target_reviews?.find(r=>r.target==='event:event-lumingze-visit-001');
 if(report?.summary!=='The visit and warning are explicit, including the newly available Black Sheep Wall phrase, but there is no claim/proposition record compatible with a KnowledgeDelta and no registered field represents the newly available capability. No supported typed effect can be added.')throw Error('Original report changed');
 const batchId=`host-lumingze-identity-${sid}-v1`,review={reviewedAt:new Date().toISOString(),batchId,sourceId:sid,sourceHash:manifest.sourceSha256,report,predecessorFingerprint:old.fingerprint,sourceLines:[...lines.slice(66,79),...lines.slice(1682,1707),...lines.slice(1956,1979),...lines.slice(2680,2708)],finding:'The original cousin entity is grounded in line 67. Line 1690 explicitly distinguishes the named boy from that cousin; lines 1968 and 2683 connect subsequent appearances. Exact-name matching alone produced three false resolutions and seven downstream reference errors. Separate the referent without asserting his hidden nature or changing presence, event outcomes, checkpoints or canon chronology. Knowledge supplement remains blocked until this identity repair passes.',selected,replacements,allGroups,resolutionBefore,annotationBefore,namespace:state.semanticRunId};
 if(!apply){await fs.writeFile(new URL('host-review-lumingze-identity-preview.json',dir),JSON.stringify(review,null,2));console.log(JSON.stringify({ready:true,resolutions:selected.length,replacements:replacements.length}));return;}
 const preview=JSON.parse(await fs.readFile(new URL('host-review-lumingze-identity-preview.json',dir),'utf8'));for(const key of ['allGroups','selected','replacements','resolutionBefore','annotationBefore'])if(contentHash(preview[key])!==contentHash((review as any)[key]))throw Error('Reviewed baseline changed '+key);
 await fs.writeFile(new URL('host-review-lumingze-identity.json',dir),JSON.stringify(review,null,2),{flag:'wx'});
 const toolset=createCompilerProposalToolset(root);await toolset.beginBatch([],batchId,sid);
 const call=(name:string,input:unknown)=>toolset.tools.find(t=>t.name===name)!.execute(name,input as never,undefined,undefined,{}as never);
 const seg=manifest.segments.find(s=>s.startLine===1888)!;
 await call('propose_entity',{proposal_id:'entity-lumingze-boy-host-v1',payload:{id:separate,kind:'character',canonicalName:'路鸣泽',aliases:[]},evidence_segment_ids:[seg.id],evidence_selectors:[{segment_id:seg.id,exact:'路鸣泽。',target_path:'/canonicalName',relation:'supports',strength:'explicit'},{segment_id:seg.id,exact:lines[1960]!.trim(),target_path:'/kind',relation:'supports',strength:'strong-inference',interpretation:'The scene presents a speaking boy; no hidden ontological identity is asserted.'}]});
 for(const r of selected)await call('propose_entity_resolution',{proposal_id:r.id+'-boy-host-v1',resolution_id:r.id+'-boy-host-v1',mention_id:r.mentionId,status:'new-entity',entity_id:separate,supersedes_resolution_id:r.id,candidates:[{entity_id:separate,confidence:0.99,basis_mention_ids:[r.mentionId,'em-lumingze-003'].filter((v,i,a)=>a.indexOf(v)===i),evidence_assertion_ids:[],rationale:'Original source explicitly distinguishes the recurring boy from the cousin; retain the old resolution revision.'}],rationale:'Host source review corrects a same-name conflation, with exact supersession and source continuity.'});
 for(const r of replacements)await call('propose_'+r.kind.replaceAll('-','_'),{proposal_id:r.before.id+'-boy-host-v1',payload:r.after,evidence_segment_ids:[r.segmentId],evidence_selectors:r.selectors});
 await call('finish_compiler_batch',{outcome:'complete',reviewed_segments:[],summary:'Host source review splits boy and cousin identities and repairs the reviewed dependency closure; no checkpoint, state outcome, or knowledge effect changed.'});
 const receipts=new CompilerFinishReceipts(root,sid,batchId),receipt=await receipts.read();if(receipt?.state!=='completed')throw Error('Finish incomplete');await receipts.verify(receipt);
 const convergence=await convergeWorldProposals(root,sid);if(convergence.canonical.blocked.length||convergence.possibilities.blocked.length)throw Error(JSON.stringify(convergence));
 for(const [method,rows]of Object.entries(allGroups)){const current=await (canon as any)[method]();for(const row of rows){const replacement=replacements.find(r=>r.method===method&&r.before.id===row.id);const expected=replacement?JSON.parse(JSON.stringify(row),(_k,v)=>v===original?separate:v):row;if(contentHash(current.find((d:any)=>d.id===row.id))!==contentHash(expected))throw Error('Unexpected canonical change '+row.id);}}
 for(const a of annotationBefore)if(contentHash(await annotations.read(sid,a.id))!==contentHash(a))throw Error('Annotation changed');
 state.identityRepair={batchId,receiptFingerprint:receipt.fingerprint,reviewPath:'run-records/2026-09-11-codex-compile-loop/host-review-lumingze-identity.json',verifiedAt:new Date().toISOString(),entityId:separate};
 await fs.writeFile(new URL('state.tmp.json',dir),JSON.stringify(state,null,2));await fs.rename(new URL('state.tmp.json',dir),new URL('state.json',dir));
 console.log(JSON.stringify({repaired:true,receipt:receipt.fingerprint,convergence}));
});
