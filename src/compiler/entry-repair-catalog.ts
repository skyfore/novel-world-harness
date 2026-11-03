import { contentHash } from "../world/canonical.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { entryPresenceRepairId, entryPresenceStop, type EntryPresenceIntent, type EntryPresenceRecord } from "./entry-presence-repair-model.js";
import { entryPresenceRecords, presenceEnvelopes, verifyEntryPresenceRecord } from "./entry-presence-repair.js";
import { entryStateRecords, stateEnvelopes, verifyEntryStateRecord } from "./entry-state-repair.js";
import { entryStateRepairId, type EntryStateRecord } from "./entry-state-repair-model.js";

/** Rewind all typed entry repairs in ledger order. Neither a stale receipt nor
 * independently rewinding each repair kind may hide an intervening revision. */
export async function entryRepairCatalogBaselines(root: string, sourceId: string, taskId: string, planHash: string, current: ReadonlyMap<string, unknown>) {
  const history = await new RequirementLedger(root, sourceId).history();
  const presence = entryPresenceRecords(history, taskId), state = entryStateRecords(history, taskId);
  const applied = history.flatMap(r => r.payload.kind === "entry-presence-repair" && r.payload.record.phase === "entry-presence-applied"
    || r.payload.kind === "entry-state-repair" && r.payload.record.phase === "entry-state-applied" ? [r.payload.record] : [])
    .filter(r => r.intent.taskId === taskId && r.intent.upstreamPlanHash === planHash);
  if (!applied.length) return [];
  const actual = (await loadCompilerArtifactRecords(root, sourceId)).filter(r => r.status === "canonical");
  const payloads = new Map(current), assertions = new Map(actual.map(r => [`${r.kind}:${r.logicalId}`, r.evidenceAssertions]));
  type Assertions = EntryPresenceIntent["baselines"][number]["evidenceAssertions"];
  const sorted = (items: Assertions) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const revisions = new Map<string, { kind: EntryPresenceIntent["baselines"][number]["kind"]; id: string; payload: unknown; committed: boolean;
    assertions: Assertions; originalAssertions: Assertions }>();
  for (const record of applied.reverse()) {
    let envelopes;
    if (record.phase === "entry-presence-applied") {
      const group = presence.filter(r => entryPresenceRepairId(r.intent) === entryPresenceRepairId(record.intent));
      for (const r of group) await verifyEntryPresenceRecord(root, r, history);
      envelopes = presenceEnvelopes(record.intent, group[0] as Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>);
    } else {
      const group = state.filter(r => entryStateRepairId(r.intent) === entryStateRepairId(record.intent));
      for (const r of group) await verifyEntryStateRecord(root, r, history);
      envelopes = stateEnvelopes(record.intent, group[0] as Extract<EntryStateRecord, { phase: "entry-state-proposal" }>);
    }
    for (const [index, b] of record.intent.baselines.entries()) {
      const key = `${b.kind}:${b.id}`, envelope = envelopes[index]!, later = revisions.get(key);
      if (contentHash(payloads.get(key)) !== contentHash(envelope.payload)
        || contentHash(sorted(assertions.get(key) ?? [])) !== contentHash(sorted(envelope.evidenceAssertions)))
        throw entryPresenceStop("Applied entry revision changed outside its receipt chain");
      payloads.set(key, b.payload); assertions.set(key, b.evidenceAssertions);
      revisions.set(key, { kind: b.kind, id: b.id, payload: b.payload, committed: true,
        assertions: later?.assertions ?? envelope.evidenceAssertions, originalAssertions: b.evidenceAssertions });
    }
  }
  return [...revisions.values()];
}
