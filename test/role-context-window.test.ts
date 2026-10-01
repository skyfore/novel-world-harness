import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect,afterEach,vi} from 'vitest';
import {RoleContextWindow,RoleContextPressure,RoleContextCheckpoint} from '../src/compiler/role-context-window.js';
import {ModelRequestBudget,installModelRequestBudget} from '../src/agent/model-request-budget.js';
import {contentHash} from '../src/world/canonical.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
it('repackages before transport without clearing or consuming the persistent call allowance',()=>{
 const window=new RoleContextWindow(),paid=new ModelRequestBudget({maxModelCalls:2,maxRequestBytes:48000,maxTotalPayloadBytes:96000});
 paid.beginCall({});
 const stream=vi.fn(),agent={streamFunction:stream,onPayload:undefined} as unknown as Parameters<typeof installModelRequestBudget>[0];
 installModelRequestBudget(agent,[window,paid]);
 expect(()=>agent.streamFunction({} as never,{messages:'x'.repeat(37000)} as never)).toThrow(RoleContextPressure);
 expect(stream).not.toHaveBeenCalled(); expect(paid.snapshot().modelCalls).toBe(1);expect(paid.isBlocked()).toBe(false);
 const replacement=new RoleContextWindow(),next={streamFunction:stream,onPayload:undefined} as unknown as Parameters<typeof installModelRequestBudget>[0];
 installModelRequestBudget(next,[replacement,paid]);next.streamFunction({} as never,{} as never);
 expect(paid.snapshot().modelCalls).toBe(2);
 expect(()=>next.streamFunction({} as never,{} as never)).toThrow('model-call limit');
});
it('checks provider transformations before payload admission',async()=>{
 const window=new RoleContextWindow(),paid=new ModelRequestBudget({maxModelCalls:2,maxRequestBytes:48000,maxTotalPayloadBytes:96000});
 const agent={streamFunction:vi.fn(),onPayload:async()=>({expanded:'x'.repeat(50000)})} as unknown as Parameters<typeof installModelRequestBudget>[0];
 installModelRequestBudget(agent,[window,paid]);
 await expect(agent.onPayload!({},{} as never)).rejects.toThrow(RoleContextPressure);
 expect(paid.snapshot().payloads).toBe(0);expect(paid.isBlocked()).toBe(false);
});
it('forecasts a large tool response without truncating it',()=>{
 const window=new RoleContextWindow();window.beginCall({content:'x'.repeat(20000)});
 const reply={content:'y'.repeat(13000)};window.observeResult({offset:5},reply);
 expect(window.pressure).toBeUndefined();expect(reply.content.length).toBe(13000);
 expect(window.metrics().forecastBytes).toBeGreaterThan(33000);
 expect(()=>window.beginCall({content:'x'.repeat(37000)})).toThrow(RoleContextPressure);
});
it('persists cursors but never original text or a false semantic summary',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-context-'));roots.push(root);
 const plan=contentHash('plan'),packet=contentHash('packet'),store=await RoleContextCheckpoint.open(root,plan,'work',packet);
 await store.record('read_role_review_notes',{offset:5},{content:[{type:'text',text:JSON.stringify({records:[{noteId:'note',text:'sensitive evidence'}],nextOffset:10})}]});
 await store.handoff(new RoleContextPressure(37000,'context'));
 const restored=await RoleContextCheckpoint.open(root,plan,'work',packet);
 expect(restored.manifest().generation).toBe(1);expect(restored.directory().accesses[0]).toMatchObject({args:{offset:5},nextOffset:10,refs:['note']});
 expect(JSON.stringify(restored.manifest())).not.toContain('sensitive evidence');
 await expect(restored.handoff(new RoleContextPressure(37000,'context'))).rejects.toThrow('no new access');
 await expect(RoleContextCheckpoint.open(root,plan,'work',contentHash('changed'))).rejects.toThrow('scope or integrity');
});

it('merges UTF-8 core, neighbor and paginated originals exactly once',async()=>{
 const {reassembleRoleContext}=await import('../src/compiler/role-review-context.js');
 const original='龙😀'.repeat(2100),bytes=Buffer.from(original);
 const units=[{id:'long',anchor:{startByte:0,endByte:bytes.length}}];
 const boundary=Buffer.byteLength(Array.from(original).slice(0,2000).join(''));
 const spans=[{start:0,end:boundary},{start:boundary,end:bytes.length}];
 const result=reassembleRoleContext(bytes,units,[spans[0]!],[
  {tool:'read_role_work_evidence',args:{unitId:'long',offset:0}},
  {tool:'read_role_work_evidence',args:{unitId:'long',offset:4000}},
  {tool:'read_role_work_neighbor',args:{direction:'next'}}
 ],{page:0,spans});
 expect(result.packet.fragments.map(f=>f.text).join('')).toBe(original);
 expect(result.packet.ranges).toEqual([{start:0,end:bytes.length}]);
 expect(result.deliveredUnitIds).toEqual(['long']);
});
it('never promotes partial originals or discovery excerpts to complete evidence',async()=>{
 const {reassembleRoleContext}=await import('../src/compiler/role-review-context.js');
 const bytes=Buffer.from('龙'.repeat(4500));
 const units=[{id:'long',anchor:{startByte:0,endByte:bytes.length}}];
 const partial=reassembleRoleContext(bytes,units,[],[{tool:'read_role_work_evidence',args:{unitId:'long',offset:0}}]);
 expect(partial.deliveredUnitIds).toEqual([]);
 expect(partial.packet.fragments[0]?.continued).toBe(true);
 expect(partial.packet.fragments[0]?.text).toBe('龙'.repeat(4000));
 const search=reassembleRoleContext(bytes,units,[],[{tool:'read_role_work_evidence',args:{query:'龙'}}]);
 expect(search.packet.fragments).toEqual([]);
 expect(search.deliveredUnitIds).toEqual([]);
 expect(()=>reassembleRoleContext(bytes,units,[],[{tool:'read_role_work_evidence',args:{unitId:'foreign'}}])).toThrow('foreign evidence');
});
it('stops an oversized evidence union instead of silently dropping original text',async()=>{
 const {reassembleRoleContext}=await import('../src/compiler/role-review-context.js');
 const bytes=Buffer.from('龙'.repeat(7000)),units=[{id:'long',anchor:{startByte:0,endByte:bytes.length}}];
 expect(()=>reassembleRoleContext(bytes,units,[{start:0,end:bytes.length}],[])).toThrow('narrower semantic task');
});

it('keeps read-gate bookkeeping outside the serialized evidence packet',async()=>{
 const {reassembleRoleContext}=await import('../src/compiler/role-review-context.js');
 const bytes=Buffer.from('first second');
 const units=[{id:'unit-first',anchor:{startByte:0,endByte:5}},{id:'unit-second',anchor:{startByte:6,endByte:12}}];
 const assembled=reassembleRoleContext(bytes,units,[{start:0,end:12}],[]);
 const serialized=JSON.stringify(assembled.packet);
 expect(assembled.deliveredUnitIds).toEqual(['unit-first','unit-second']);
 expect(serialized.match(/unit-first/g)).toHaveLength(1);
 expect(serialized.match(/unit-second/g)).toHaveLength(1);
 expect(assembled.packet.fragments.map(f=>f.text).join('')).toBe(bytes.toString());
 const limit=Buffer.byteLength(serialized);
 expect(()=>reassembleRoleContext(bytes,units,[{start:0,end:12}],[],undefined,limit)).not.toThrow();
 expect(()=>reassembleRoleContext(bytes,units,[{start:0,end:12}],[],undefined,limit-1)).toThrow('narrower semantic task');
});

it('reassembles actual returned ranges when a repeated offset skips already delivered text',async()=>{
 const {reassembleRoleContext}=await import('../src/compiler/role-review-context.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role-range-'));roots.push(root);
 const checkpoint=await RoleContextCheckpoint.open(root,contentHash('plan'),'work',contentHash('packet'));
 await checkpoint.record('read_role_work_evidence',{unitId:'u',offset:0},{content:[{type:'text',text:JSON.stringify({units:[{unitId:'u',text:'龙'.repeat(4000),startOffset:2000,endOffset:6000}]})}]});
 const bytes=Buffer.from('龙'.repeat(6000)),unit={id:'u',anchor:{startByte:0,endByte:bytes.length}};
 const result=reassembleRoleContext(bytes,[unit],[{start:0,end:6000}],checkpoint.originalAccesses(),undefined,24000);
 expect(result.deliveredUnitIds).toEqual(['u']);
 expect(result.packet.fragments.map(f=>f.text).join('')).toBe(bytes.toString());
});
