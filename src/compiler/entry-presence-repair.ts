import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../world/canonical.js";
import { artifactProposalSchema, canonicalEventSchema, eventParticipationSchema, evidenceAssertionSchema } from "../world/model.js";
import { ProposalStore } from "../world/canonical-model.js";
import { RequirementLedger, type LedgerRecord } from "./requirement-ledger.js";
import { SegmentStore } from "./segments.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { prepareConsumerRevalidation, revalidationRecords, verifyConsumerRevalidationRecord } from "./identity-consumer-revalidation.js";
import { consumerRevalidationDirectory, consumerRevalidationId } from "./identity-consumer-revalidation-model.js";
import { revalidatedConsumerBudgetOrigin } from "./identity-consumer-revalidated-plan.js";
import { verifyIdentityUpstreamSession } from "./identity-upstream-session.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { compilerPayloadEvidence } from "./proposals.js";
import { assertReviewPreviewAllowance } from "./review-preview-allowance.js";
import { ENTRY_PRESENCE_REPAIR, ENTRY_PRESENCE_LIMITS, entryPresenceCriteria, entryPresenceIntentSchema, entryPresenceRepairId,
  entryPresenceRepairDirectory, entryPresenceModelContract, entryPresenceStop, lowerEntryPresenceRepair, validateEntryPresenceHistory, validateEntryPresenceIntent,
  type EntryPresenceIntent, type EntryPresenceRecord } from "./entry-presence-repair-model.js";

export const readPresenceFile = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const maybePresenceFile = async (file: string) => { try { return await readPresenceFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
export const entryPresenceRecords = (history: readonly LedgerRecord[], taskId: string) => history.flatMap(r =>
  r.payload.kind === "entry-presence-repair" && r.payload.record.intent.taskId === taskId ? [r.payload.record] : []);
const implementationFiles = ["./entry-presence-repair-model.ts", "./entry-presence-repair.ts", "./entry-presence.ts", "../workflow/entry-presence-repair.ts",
  "../world/model.ts", "../world/entry-agency.ts", "./validator.ts", "./proposals.ts", "./requirement-ledger.ts", "./review-preview-allowance.ts"];
export async function entryPresenceImplementationHash() {
  // Both src/ and dist/ entry points bind the same retained source implementation.
  const sourceDirectory = new URL("../../src/compiler/", import.meta.url);
  return contentHash(await Promise.all(implementationFiles.map(async f => [f, contentHash(await fs.readFile(fileURLToPath(new URL(f, sourceDirectory)), "utf8"))])));
}

export async function assertEntryPresencePreviewAllowance(directory: string, stage: string, scopeHash: string, proposalHash?: string) {
  let text: string;
  try { text = await fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  assertReviewPreviewAllowance(text.trim() ? text.trimEnd().split("\n").map(line => JSON.parse(line).message) : [], {
    previewTool: "preview_entry_presence_repair", terminalTool: "submit_entry_presence_repair", correctionsRemaining: 1,
    stop: entryPresenceStop, matchesScope: args => args.scopeHash === scopeHash && args.phase === stage
      && (stage !== "entry-presence-check" || args.proposalHash === proposalHash),
  });
}

/** Freeze the exact supported negative review, not a replacement of its result. */
export async function prepareEntryPresenceRepair(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string) {
  const history = await new RequirementLedger(root, sourceId).history(), all = revalidationRecords(history, taskId);
  const parent = all.findLast(r => r.scope.ref === ref);
  if (!parent || !authorizationRef.trim()) throw entryPresenceStop("An authorized original negative entry review is required");
  const parents = all.filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(parent.scope));
  const directory = path.join(consumerRevalidationDirectory(root, parent.scope), "presence-repair");
  const saved = await maybePresenceFile(path.join(directory, "intent.json"));
  if (saved) {
    const intent = entryPresenceIntentSchema.parse(saved);
    if (intent.authorizationRef !== authorizationRef || intent.ref !== ref || intent.taskId !== taskId || intent.sourceId !== sourceId)
      throw entryPresenceStop("Frozen presence repair authority changed");
    const context = await readPresenceFile(path.join(directory, "context.json"));
    if (contentHash(context) !== intent.contextHash) throw entryPresenceStop("Frozen presence context changed");
    return { intent, context, parents, directory };
  }
  for (const r of parents) await verifyConsumerRevalidationRecord(root, r);
  const original = all.find(r => r.scope.ref === ref && !r.scope.compilerCorrection);
  if (!original) throw entryPresenceStop("Original consumer lineage missing");
  const p = await prepareConsumerRevalidation(root, sourceId, taskId, ref, original.scope.authorizationRef);
  const target = parent.scope.reviewContract?.target;
  if (target?.kind !== "character-entry") throw entryPresenceStop("Exact entry review contract required");
  const [, actorId, eventId] = ref.split("/");
  if (!actorId || !eventId || ref !== `entry/${actorId}/${eventId}`) throw entryPresenceStop("Exact actor/event ref required");
  const catalog = (await loadCompilerArtifactRecords(root, sourceId)).filter(r => r.status === "canonical");
  if (catalog.some(r => r.kind === "event-execution" && (r.payload as any).canonicalEventId === eventId && (r.payload as any).entryCheckpoint?.actorId === actorId))
    throw entryPresenceStop("Execution-owned checkpoint needs its owning typed repair; this contract cannot change it");
  const baselines = catalog.filter(r => r.kind === "canonical-event" && r.logicalId === eventId || r.kind === "event-participation"
    && (r.payload as any).eventId === eventId && (r.payload as any).entityId === actorId)
    .map(r => ({ kind: r.kind, id: r.logicalId, revisionHash: contentHash(r.payload), payload: r.payload, evidenceAssertions: r.evidenceAssertions }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const parentInput = await readPresenceFile(path.join(consumerRevalidationDirectory(root, parent.scope), "execution-v1", "consumer-revalidation.input.json"));
  if (contentHash(parentInput) !== parents[0]?.inputHash) throw entryPresenceStop("Original complete evidence packet is missing");
  const context = { originalInput: parentInput, negativeJudgments: parents.map(r => r.output) };
  const origin = await revalidatedConsumerBudgetOrigin(root, parents);
  const intent = entryPresenceIntentSchema.parse({ version: 1, policy: ENTRY_PRESENCE_REPAIR, sourceId, sourceHash: parent.scope.sourceHash,
    taskId, ref, actorId, eventId, identityIntentHash: parent.scope.identityIntentHash, originalBudgetHash: parent.scope.originalBudgetHash,
    parentReviewId: consumerRevalidationId(parent.scope), parentRecordHashes: parents.map(contentHash), parentReceiptFingerprint: parent.scope.receiptFingerprint,
    upstreamPlanHash: parent.scope.upstreamPlanHash, authorizationRef, createdAt: new Date().toISOString(), implementationHash: await entryPresenceImplementationHash(),
    contextHash: contentHash(context), requirementIds: parent.scope.requirementIds, retainedQuestionIds: parents[0]?.output.phase === "consumer-revalidation" ? parents[0].output.retainedQuestionIds : [],
    totalConsumers: p.prepared.inventory.consumers.length, requirementPrefix: { length: history.length, head: history.at(-1)!.hash },
    priorUsage: origin.priorUsage, priorBudgetFiles: origin.budgetFiles, baselines });
  validateEntryPresenceIntent(intent, parents);
  return { intent, context, parents, directory };
}

export async function presenceEvidence(root: string, intent: EntryPresenceIntent, selectors: Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>["output"]["evidence"]) {
  const manifest = await new SegmentStore(root).readManifest(intent.sourceId);
  const source = await WorkspaceStore.openReadOnly(root).getSource(intent.sourceId);
  if (!source || source.contentSha256 !== intent.sourceHash || !manifest)
    throw entryPresenceStop("Original immutable source unavailable");
  await readSourceMaterial(root, source);
  const context = await readPresenceFile(path.join(entryPresenceRepairDirectory(root, intent), "context.json"));
  return Promise.all(selectors.map(async selector => {
    const segment = manifest.segments.find(s => s.id === selector.segment_id);
    if (!segment || !context.originalInput.requiredSourceSegmentIds.includes(segment.id)) throw entryPresenceStop("Selector escaped the supplied original evidence; copy originalInput.evidencePacket.sources[].id once");
    return { selector, anchor: await resolveTextSelectorAnchor(root, segment, selector) };
  }));
}

export function entryPresenceInput(intent: EntryPresenceIntent, context: unknown, previous: EntryPresenceRecord[]) {
  const { priorBudgetFiles: _, ...scope } = intent;
  return { policy: ENTRY_PRESENCE_REPAIR, scope, scopeHash: contentHash(intent), context, criteria: entryPresenceCriteria,
    phase: previous.length ? "entry-presence-check" : "entry-presence-proposal", proposalHash: previous.length ? contentHash((previous[0] as any).output) : null,
    proposal: previous.length ? (previous[0] as any).output : null,
    proposedArtifacts: previous[0]?.phase === "entry-presence-proposal" && previous[0].output.disposition === "uncertainty-preserved"
      ? lowerEntryPresenceRepair(intent, previous[0]).map(b => ({ kind: b.kind, id: b.id, payload: b.payload })) : null,
    limits: ENTRY_PRESENCE_LIMITS, executableEntry: false, retainedQuestionIds: intent.retainedQuestionIds, parentResumeAllowed: false };
}

export function presenceEnvelopes(intent: EntryPresenceIntent, proposal: Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>) {
  return lowerEntryPresenceRepair(intent, proposal).map((b, index) => {
    const old = intent.baselines[index]!;
    const event = b.kind === "canonical-event" ? canonicalEventSchema.parse(b.payload) : null;
    const entryIndex = event?.characterEntryCheckpoints?.findIndex(c => c.actorId === intent.actorId);
    const actorIndex = event?.participantPresence?.findIndex(p => p.entityId === intent.actorId);
    const ownIndex = event?.characterEntryCheckpoints?.[entryIndex!]?.participantPresence.findIndex(p => p.entityId === intent.actorId);
    const paths = event ? ["/title", "/readerSummary", `/participantPresence/${actorIndex}/mode`, `/characterEntryCheckpoints/${entryIndex}`,
      `/characterEntryCheckpoints/${entryIndex}/admission`, `/characterEntryCheckpoints/${entryIndex}/participantPresence/${ownIndex}/mode`] : ["/presence"];
    const overlap = (a: string, p: string) => a === p || a.startsWith(p + "/") || p.startsWith(a + "/");
    const assertions = old.evidenceAssertions.filter(a => !paths.some(p => overlap(a.target.jsonPointer, p)));
    assertions.push(...paths.map((jsonPointer, j) => evidenceAssertionSchema.parse({ version: 1,
      id: `presence-${entryPresenceRepairId(intent).slice(0, 32)}-${index}-${j}`, target: { artifactKind: b.kind, artifactId: b.id, jsonPointer },
      anchors: proposal.evidence.map(e => e.anchor), relation: "supports", strength: "explicit",
      derivation: { runId: proposal.traceRunId, worker: "entry-presence-repair", provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash, ontologyVersion: "evidence-v1" } })));
    return artifactProposalSchema(b.kind === "canonical-event" ? canonicalEventSchema : eventParticipationSchema).parse({
      id: `presence-${entryPresenceRepairId(intent).slice(0, 32)}-${index}`, kind: b.kind, schemaVersion: 1, payload: b.payload,
      evidence: compilerPayloadEvidence(b.payload), evidenceAssertions: assertions, createdAt: intent.createdAt,
      generatedBy: { worker: "entry-presence-repair", provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash } });
  });
}

export async function verifyEntryPresenceRecord(root: string, record: EntryPresenceRecord, history?: LedgerRecord[]) {
  const s = record.intent, directory = entryPresenceRepairDirectory(root, s), ledger = history ?? await new RequirementLedger(root, s.sourceId).history();
  const existing = entryPresenceRecords(ledger, s.taskId).filter(r => entryPresenceRepairId(r.intent) === entryPresenceRepairId(s));
  const records = existing.some(r => r.phase === record.phase) ? existing.slice(0, existing.findIndex(r => r.phase === record.phase) + 1) : [...existing, record];
  validateEntryPresenceHistory(records, revalidationRecords(ledger, s.taskId));
  const context = await readPresenceFile(path.join(directory, "context.json"));
  if (contentHash(await readPresenceFile(path.join(directory, "intent.json"))) !== contentHash(s) || contentHash(context) !== s.contextHash
    || ledger[s.requirementPrefix.length - 1]?.hash !== s.requirementPrefix.head) throw entryPresenceStop("Original presence intent or journal prefix changed");
  const parents = revalidationRecords(ledger, s.taskId).filter(r => consumerRevalidationId(r.scope) === s.parentReviewId);
  if (contentHash(context.originalInput) !== parents[0]?.inputHash || contentHash(context.negativeJudgments) !== contentHash(parents.map(r => r.output)))
    throw entryPresenceStop("Presence context changed its original source packet or negative judgments");
  if ("output" in record) {
    const previous = records.slice(0, -1), input = entryPresenceInput(s, context, previous);
    if (record.inputHash !== contentHash(input) || contentHash(await readPresenceFile(path.join(directory, `${record.phase}.input.json`))) !== record.inputHash
      || contentHash(await presenceEvidence(root, s, record.output.evidence)) !== contentHash(record.evidence)) throw entryPresenceStop("Presence evidence or complete input changed");
    const checkpoint = await verifyIdentityUpstreamSession(root, directory, record.phase, { ...record, planHash: contentHash(s) }, entryPresenceModelContract);
    await assertEntryPresencePreviewAllowance(directory, record.phase, contentHash(s), input.proposalHash ?? undefined);
    const budget = await readPresenceFile(path.join(directory, `${record.phase}.budget.json`));
    const prior = { ...s.priorUsage };
    if (record.phase === "entry-presence-check") {
      const b = await readPresenceFile(path.join(directory, "entry-presence-proposal.budget.json"));
      prior.modelCalls += b.state.usage.modelCalls; prior.totalPayloadBytes += b.state.usage.totalPayloadBytes;
    }
    if (contentHash(checkpoint.output) !== contentHash(record.output) || budget.scopeHash !== contentHash(s) || contentHash(budget.priorUsage) !== contentHash(prior)
      || budget.originalBudgetHash !== s.originalBudgetHash || contentHash(budget.limits) !== contentHash(ENTRY_PRESENCE_LIMITS))
      throw entryPresenceStop("Presence actual submission or original allowance changed");
  } else {
    const proposal = records[0] as Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>;
    const envelopes = presenceEnvelopes(s, proposal);
    if (contentHash(record.artifacts) !== contentHash(envelopes.map((e, i) => ({ kind: e.kind, id: s.baselines[i]!.id, proposalId: e.id,
      beforeHash: s.baselines[i]!.revisionHash, afterHash: contentHash(e.payload), envelopeHash: contentHash(e) })))) throw entryPresenceStop("Commit intent changed deterministic typed proposals");
    if (record.phase === "entry-presence-applied") {
      const actual = (await loadCompilerArtifactRecords(root, s.sourceId)).filter(r => r.status === "canonical");
      const historical = existing.some(r => contentHash(r) === contentHash(record));
      for (const [i, e] of envelopes.entries()) {
        const current = actual.find(r => r.kind === e.kind && r.logicalId === s.baselines[i]!.id);
        if (contentHash(await new ProposalStore(root).readEnvelope("accepted", e.id)) !== contentHash(e)
          || !historical && (contentHash(current?.payload) !== contentHash(e.payload)
            || contentHash(current?.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id))) !== contentHash(e.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id)))))
          throw entryPresenceStop("Applied receipt lacks its exact active accepted proposal and evidence");
      }
    }
  }
}

/** Only exact accepted outputs may explain catalog drift. Return comparison
 * baselines; active world payloads and unresolved obligations stay untouched. */
export async function entryPresenceCatalogBaselines(root: string, sourceId: string, taskId: string, planHash: string, current: ReadonlyMap<string, unknown>) {
  const history = await new RequirementLedger(root, sourceId).history(), records = entryPresenceRecords(history, taskId);
  const appliedRecords = records.filter(r => r.phase === "entry-presence-applied" && r.intent.upstreamPlanHash === planHash);
  if (!appliedRecords.length) return [];
  const actual = (await loadCompilerArtifactRecords(root, sourceId)).filter(r => r.status === "canonical");
  const payloads = new Map(current), assertions = new Map(actual.map(r => [`${r.kind}:${r.logicalId}`, r.evidenceAssertions]));
  const sorted = (items: EntryPresenceIntent["baselines"][number]["evidenceAssertions"]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const revisions = new Map<string, { kind: EntryPresenceIntent["baselines"][number]["kind"]; id: string; payload: unknown; committed: boolean;
    assertions: EntryPresenceIntent["baselines"][number]["evidenceAssertions"]; originalAssertions: EntryPresenceIntent["baselines"][number]["evidenceAssertions"] }>();
  // Rewind exact accepted revisions in reverse ledger order. An older receipt
  // is immutable evidence, not a requirement that it stay the active head.
  for (const applied of appliedRecords.reverse()) {
    const group = records.filter(r => entryPresenceRepairId(r.intent) === entryPresenceRepairId(applied.intent));
    for (const r of group) await verifyEntryPresenceRecord(root, r, history);
    const envelopes = presenceEnvelopes(applied.intent, group[0] as Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>);
    for (const [index, b] of applied.intent.baselines.entries()) {
      const key = `${b.kind}:${b.id}`, envelope = envelopes[index]!, later = revisions.get(key);
      if (contentHash(payloads.get(key)) !== contentHash(envelope.payload)
        || contentHash(sorted(assertions.get(key) ?? [])) !== contentHash(sorted(envelope.evidenceAssertions)))
        throw entryPresenceStop("Applied presence revision changed outside its receipt chain");
      payloads.set(key, b.payload); assertions.set(key, b.evidenceAssertions);
      revisions.set(key, { kind: b.kind, id: b.id, payload: b.payload, committed: true,
        assertions: later?.assertions ?? envelope.evidenceAssertions, originalAssertions: b.evidenceAssertions });
    }
  }
  return [...revisions.values()];
}
