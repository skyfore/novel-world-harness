import { z } from 'zod';
import { roleSourceWorkSchema, roleWorkStop, type RoleSourceWork } from './role-review-work.js';
import { assertSourcePartIntegration } from './role-source-parts.js';

export const integrationCorrectionSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  findings: z.array(z.object({bindingIndex:z.number().int().nonnegative(),observation:z.string().trim().min(1).max(1200)}).strict()).max(64),
}).strict();
export function integrationBindings(parts: readonly RoleSourceWork[], coreIds: ReadonlySet<string>) {
  const bindings: Array<{name:string;unitIds:string[]}> = [];
  for(const finding of parts.flatMap(p=>p.findings)) {
    const refs=finding.unitIds.filter(id=>coreIds.has(id));
    if(!refs.length)continue;
    const existing=bindings.find(b=>b.name===finding.name);
    if(existing)existing.unitIds=[...new Set([...existing.unitIds,...refs])];
    else bindings.push({name:finding.name,unitIds:refs});
  }
  return bindings;
}
/** Indices only compress identifiers; all text and exact bindings remain intact. */
export function integrationPacket(parts:RoleSourceWork[], failed:RoleSourceWork, originals:Array<{unitId:string|null;text:string;continued:boolean}>,coreIds:ReadonlySet<string>) {
  const ids=[...new Set([...originals.flatMap(f=>f.unitId?[f.unitId]:[]),...parts.flatMap(p=>p.findings.flatMap(f=>f.unitIds)),...failed.findings.flatMap(f=>f.unitIds)])];
  const bindings=integrationBindings(parts,coreIds),questions=parts.flatMap(p=>p.openQuestions);
  const refs=(unitIds:string[])=>unitIds.map(id=>ids.indexOf(id));
  const note=(n:RoleSourceWork)=>({...n,findings:n.findings.map(f=>({name:f.name,observation:f.observation,unitIndexes:refs(f.unitIds)}))});
  const packet={unitIds:ids,originalColumns:['unitIndex','text','continued'],originals:originals.map(f=>[f.unitId===null?null:ids.indexOf(f.unitId),f.text,f.continued] as const),
    partDrafts:parts.map(note),failedProposal:note(failed),bindings:bindings.map((b,bindingIndex)=>({bindingIndex,name:b.name,unitIndexes:refs(b.unitIds)}))};
  const decode=(raw:unknown)=>{
    const value=integrationCorrectionSchema.parse(raw),indexes=value.findings.map(f=>f.bindingIndex);
    if(indexes.length!==bindings.length || new Set(indexes).size!==bindings.length || indexes.some(i=>!bindings[i]))throw roleWorkStop('integration correction must supply every bindings[].bindingIndex exactly once; no guessed, duplicated or missing indexes; stop after this corrected attempt');
    const expanded=roleSourceWorkSchema.parse({summary:value.summary,findings:bindings.map((b,i)=>({...b,observation:value.findings.find(f=>f.bindingIndex===i)!.observation})),openQuestions:questions});
    assertSourcePartIntegration(parts,expanded,coreIds);
    return expanded;
  };
  // Immutable responsibilities must fit before any model call is charged.
  decode({summary:'x',findings:bindings.map((_,bindingIndex)=>({bindingIndex,observation:'x'}))});
  return {packet,bindings,decode};
}
