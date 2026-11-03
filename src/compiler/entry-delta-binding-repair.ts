import { contentHash } from "../world/canonical.js";
import { artifactProposalSchema, evidenceAssertionSchema } from "../world/model.js";
import { eventExecutionSchema } from "../world/event-execution.js";
import { compilerPayloadEvidence } from "./proposals.js";
import { entryDeltaBindingEditSchema, lowerEntryDeltaBinding } from "./entry-delta-binding.js";
import { entryStateRepairId, entryStateStop, type EntryStateIntent, type EntryStateRecord } from "./entry-state-repair-model.js";

export function entryDeltaBindingEnvelopes(intent: EntryStateIntent, proposal: Extract<EntryStateRecord, { phase: "entry-state-proposal" }>) {
  if (proposal.output.disposition !== "repaired") throw entryStateStop("Blocked binding proposal grants no mutation");
  const edit = entryDeltaBindingEditSchema.parse(proposal.output.edit);
  return lowerEntryDeltaBinding(intent, edit).map((b, index) => {
    const prefix = "/entryCheckpoint/delta", id = `binding-${entryStateRepairId(intent).slice(0, 32)}-${index}`;
    const assertions = b.evidenceAssertions.filter(a => { const p = a.target.jsonPointer;
      return p !== prefix && !p.startsWith(prefix + "/") && !prefix.startsWith(p + "/"); });
    const bindings = [{ pointer: prefix, evidence: proposal.output.evidence, strength: "strong-inference" as const, rationale: proposal.output.rationale },
      ...edit.bindings.map(b => ({ ...b, pointer: `${prefix}/operations/${b.index}` }))];
    assertions.push(...bindings.map((binding, i) => evidenceAssertionSchema.parse({ version: 1, id: `${id}-${i}`,
      target: { artifactKind: "event-execution", artifactId: b.id, jsonPointer: binding.pointer },
      anchors: binding.evidence.map(selector => {
        const found = proposal.evidence.find(e => contentHash(e.selector) === contentHash(selector));
        if (!found) throw entryStateStop("Copied entry operation lacks its exact source selector");
        return found.anchor;
      }), relation: "supports", strength: binding.strength, interpretation: binding.rationale,
      derivation: { runId: proposal.traceRunId, worker: "entry-delta-binding-repair", provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash, ontologyVersion: "evidence-v1" } })));
    return artifactProposalSchema(eventExecutionSchema).parse({ id, kind: "event-execution", schemaVersion: 1, payload: b.payload,
      evidence: compilerPayloadEvidence(b.payload), evidenceAssertions: assertions, createdAt: intent.createdAt,
      generatedBy: { worker: "entry-delta-binding-repair", provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash } });
  });
}
