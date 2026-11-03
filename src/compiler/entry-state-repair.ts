import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../world/canonical.js";
import { artifactProposalSchema, canonicalEventSchema, evidenceAssertionSchema } from "../world/model.js";
import { ProposalStore } from "../world/canonical-model.js";
import { RequirementLedger, type LedgerRecord } from "./requirement-ledger.js";
import { SegmentStore } from "./segments.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { inheritConsumerRevalidationBudgets, prepareConsumerRevalidation, revalidationRecords, verifyConsumerRevalidationRecord } from "./identity-consumer-revalidation.js";
import { identityUpstreamDirectory } from "./identity-requirement-acceptance.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { consumerRevalidationDirectory, consumerRevalidationId } from "./identity-consumer-revalidation-model.js";
import { revalidatedConsumerBudgetOrigin } from "./identity-consumer-revalidated-plan.js";
import { verifyIdentityUpstreamSession } from "./identity-upstream-session.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { compilerPayloadEvidence } from "./proposals.js";
import { entryDeltaBindingContext } from "./entry-delta-binding.js";
import { entryDeltaBindingEnvelopes } from "./entry-delta-binding-repair.js";
import { assertReviewPreviewAllowance } from "./review-preview-allowance.js";
import { ENTRY_STATE_REPAIR, ENTRY_DELTA_BINDING_REPAIR, entryStateWritableBaselines, ENTRY_STATE_LIMITS, entryStateCriteria, entryStateIntentSchema, entryStateRepairId,
  entryStateRepairDirectory, entryStateModelContract, entryStateStop, lowerEntryStateRepair, validateEntryStateHistory, validateEntryStateIntent,
  entryRepairFolder, type EntryRepairPolicy, type EntryStateIntent, type EntryStateRecord } from "./entry-state-repair-model.js";

export const readStateFile = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const maybeStateFile = async (file: string) => { try { return await readStateFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
export const entryStateRecords = (history: readonly LedgerRecord[], taskId: string) => history.flatMap(r =>
  r.payload.kind === "entry-state-repair" && r.payload.record.intent.taskId === taskId ? [r.payload.record] : []);
const implementationFiles = ["./entry-state-repair-model.ts", "./entry-state-repair.ts", "./entry-state.ts", "./entry-wording.ts", "./entry-delta-binding.ts", "./entry-delta-binding-repair.ts", "../world/event-execution.ts", "./entry-presence-repair-model.ts", "./entry-repair-catalog.ts", "../world/entry-contract.ts", "../world/bodily-state.ts", "../workflow/entry-state-repair.ts",
  "../world/model.ts", "../world/entry-agency.ts", "./validator.ts", "./proposals.ts", "./requirement-ledger.ts", "./review-preview-allowance.ts"];
export async function entryStateImplementationHash() {
  // Both src/ and dist/ entry points bind the same retained source implementation.
  const sourceDirectory = new URL("../../src/compiler/", import.meta.url);
  return contentHash(await Promise.all(implementationFiles.map(async f => [f, contentHash(await fs.readFile(fileURLToPath(new URL(f, sourceDirectory)), "utf8"))])));
}

export async function assertEntryStatePreviewAllowance(directory: string, stage: string, scopeHash: string, proposalHash?: string) {
  let text: string;
  try { text = await fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  assertReviewPreviewAllowance(text.trim() ? text.trimEnd().split("\n").map(line => JSON.parse(line).message) : [], {
    previewTool: "preview_entry_state_repair", terminalTool: "submit_entry_state_repair", correctionsRemaining: 1,
    stop: entryStateStop, matchesScope: args => args.scopeHash === scopeHash && args.phase === stage
      && (stage !== "entry-state-check" || args.proposalHash === proposalHash),
  });
}

/** Freeze the exact supported negative review, not a replacement of its result. */
export async function prepareEntryStateRepair(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string, policy: EntryRepairPolicy = ENTRY_STATE_REPAIR) {
  const history = await new RequirementLedger(root, sourceId).history(), all = revalidationRecords(history, taskId);
  const parent = all.findLast(r => r.scope.ref === ref);
  if (!parent || !authorizationRef.trim()) throw entryStateStop("An authorized original negative entry review is required");
  const parents = all.filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(parent.scope));
  const directory = path.join(consumerRevalidationDirectory(root, parent.scope), entryRepairFolder(policy));
  const saved = await maybeStateFile(path.join(directory, "intent.json"));
  if (saved) {
    const intent = entryStateIntentSchema.parse(saved);
    if (intent.policy !== policy || intent.authorizationRef !== authorizationRef || intent.ref !== ref || intent.taskId !== taskId || intent.sourceId !== sourceId)
      throw entryStateStop("Frozen state repair authority changed");
    const context = await readStateFile(path.join(directory, "context.json"));
    if (contentHash(context) !== intent.contextHash) throw entryStateStop("Frozen state context changed");
    return { intent, context, parents, directory };
  }
  for (const r of parents) await verifyConsumerRevalidationRecord(root, r);
  const original = all.find(r => r.scope.ref === ref && !r.scope.compilerCorrection);
  if (!original) throw entryStateStop("Original consumer lineage missing");
  const p = await prepareConsumerRevalidation(root, sourceId, taskId, ref, original.scope.authorizationRef);
  const target = parent.scope.reviewContract?.target;
  if (target?.kind !== "character-entry") throw entryStateStop("Exact entry review contract required");
  const [, actorId, eventId] = ref.split("/");
  if (!actorId || !eventId || ref !== `entry/${actorId}/${eventId}`) throw entryStateStop("Exact actor/event ref required");
  const catalog = (await loadCompilerArtifactRecords(root, sourceId)).filter(r => r.status === "canonical");
  if (policy !== ENTRY_DELTA_BINDING_REPAIR && catalog.some(r => r.kind === "event-execution" && (r.payload as any).canonicalEventId === eventId && (r.payload as any).entryCheckpoint?.actorId === actorId))
    throw entryStateStop("Execution-owned checkpoint needs its owning typed repair; this contract cannot change it");
  const baselines = catalog.filter(r => r.kind === "canonical-event" && r.logicalId === eventId
    || policy === ENTRY_DELTA_BINDING_REPAIR && r.kind === "event-execution" && (r.payload as any).canonicalEventId === eventId && (r.payload as any).entryCheckpoint?.actorId === actorId)
    .map(r => ({ kind: r.kind, id: r.logicalId, revisionHash: contentHash(r.payload), payload: r.payload, evidenceAssertions: r.evidenceAssertions }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const parentInput = await readStateFile(path.join(consumerRevalidationDirectory(root, parent.scope), "execution-v1", "consumer-revalidation.input.json"));
  if (contentHash(parentInput) !== parents[0]?.inputHash) throw entryStateStop("Original complete evidence packet is missing");
  const context = { originalInput: parentInput, negativeJudgments: parents.map(r => r.output) };
  const origin = await revalidatedConsumerBudgetOrigin(root, parents);
  const upstream = (await new UpstreamRepairLedger(root, sourceId).inspect()).plans.find(p => p.plan.planHash === parent.scope.upstreamPlanHash);
  if (!upstream) throw entryStateStop("Original receipt-bound upstream plan is missing");
  const cumulative = await inheritConsumerRevalidationBudgets(identityUpstreamDirectory(root, upstream.plan), path.dirname(consumerRevalidationDirectory(root, parent.scope)));
  if (origin.budgetFiles.some(f => !cumulative.priorBudgetFiles.some(current => current.path === f.path && current.hash === f.hash))
    || cumulative.priorUsage.modelCalls < origin.priorUsage.modelCalls || cumulative.priorUsage.totalPayloadBytes < origin.priorUsage.totalPayloadBytes)
    throw entryStateStop("Current task charges lost part of the original negative review history");
  const intent = entryStateIntentSchema.parse({ version: 1, policy, sourceId, sourceHash: parent.scope.sourceHash,
    taskId, ref, actorId, eventId, identityIntentHash: parent.scope.identityIntentHash, originalBudgetHash: parent.scope.originalBudgetHash,
    parentReviewId: consumerRevalidationId(parent.scope), parentRecordHashes: parents.map(contentHash), parentReceiptFingerprint: parent.scope.receiptFingerprint,
    upstreamPlanHash: parent.scope.upstreamPlanHash, authorizationRef, createdAt: new Date().toISOString(), implementationHash: await entryStateImplementationHash(),
    contextHash: contentHash(context), requirementIds: parent.scope.requirementIds, retainedQuestionIds: parents[0]?.output.phase === "consumer-revalidation" ? parents[0].output.retainedQuestionIds : [],
    totalConsumers: p.prepared.inventory.consumers.length, requirementPrefix: { length: history.length, head: history.at(-1)!.hash },
    priorUsage: cumulative.priorUsage, priorBudgetFiles: cumulative.priorBudgetFiles, baselines });
  validateEntryStateIntent(intent, parents);
  return { intent, context, parents, directory };
}

export async function stateEvidence(root: string, intent: EntryStateIntent, selectors: Extract<EntryStateRecord, { phase: "entry-state-proposal" }>["output"]["evidence"]) {
  const manifest = await new SegmentStore(root).readManifest(intent.sourceId);
  const source = await WorkspaceStore.openReadOnly(root).getSource(intent.sourceId);
  if (!source || source.contentSha256 !== intent.sourceHash || !manifest)
    throw entryStateStop("Original immutable source unavailable");
  await readSourceMaterial(root, source);
  const context = await readStateFile(path.join(entryStateRepairDirectory(root, intent), "context.json"));
  return Promise.all(selectors.map(async selector => {
    const segment = manifest.segments.find(s => s.id === selector.segment_id);
    if (!segment || !context.originalInput.requiredSourceSegmentIds.includes(segment.id)) throw entryStateStop("Selector escaped the supplied original evidence; copy originalInput.evidencePacket.sources[].id once");
    return { selector, anchor: await resolveTextSelectorAnchor(root, segment, selector) };
  }));
}

export function entryStateInput(intent: EntryStateIntent, context: unknown, previous: EntryStateRecord[]) {
  const { priorBudgetFiles: _, ...scope } = intent;
  const entry = canonicalEventSchema.parse(intent.baselines.find(b => b.kind === "canonical-event")!.payload).characterEntryCheckpoints!.find(e => e.actorId === intent.actorId)!;
  return { policy: intent.policy, scope, scopeHash: contentHash(intent), context, criteria: entryStateCriteria,
    ...(intent.policy === ENTRY_DELTA_BINDING_REPAIR ? { bindingDeltas: (() => {
      const { sourceEntry, binding } = entryDeltaBindingContext(intent);
      return { canonicalDelta: sourceEntry.delta, canonicalDeltaHash: contentHash(sourceEntry.delta), executionDelta: binding.entryCheckpoint!.delta,
        executionDeltaHash: contentHash(binding.entryCheckpoint!.delta), requiredBindingIndices: sourceEntry.delta.operations.map((_, i) => i) };
    })() } : intent.policy === ENTRY_STATE_REPAIR
      ? { stateOperations: entry.delta.operations.map((operation, index) => ({ index, operation, operationHash: contentHash(operation) })) }
      : { entryWordingFields: { readerSetup: entry.readerSetup, actorObservation: entry.actorObservation } }),
    phase: previous.length ? "entry-state-check" : "entry-state-proposal", proposalHash: previous.length ? contentHash((previous[0] as any).output) : null,
    proposal: previous.length ? (previous[0] as any).output : null,
    proposedArtifacts: previous[0]?.phase === "entry-state-proposal" && previous[0].output.disposition === "repaired"
      ? lowerEntryStateRepair(intent, previous[0]).map(b => ({ kind: b.kind, id: b.id, payload: b.payload })) : null,
    limits: ENTRY_STATE_LIMITS, executableEntry: false, retainedQuestionIds: intent.retainedQuestionIds, parentResumeAllowed: false };
}

export function entryStateSelectors(output: import("./entry-state-repair-model.js").EntryStateOutput) {
  const all = [...output.evidence, ...(output.phase === "entry-state-proposal" ? ("set" in output.edit ? output.edit.set : "fields" in output.edit ? output.edit.fields : output.edit.bindings).flatMap(s => s.evidence) : [])];
  return [...new Map(all.map(s => [contentHash(s), s])).values()];
}

export function stateEnvelopes(intent: EntryStateIntent, proposal: Extract<EntryStateRecord, { phase: "entry-state-proposal" }>) {
  if (intent.policy === ENTRY_DELTA_BINDING_REPAIR) return entryDeltaBindingEnvelopes(intent, proposal);
  return lowerEntryStateRepair(intent, proposal).map((b, index) => {
    const old = intent.baselines[index]!, event = canonicalEventSchema.parse(b.payload);
    const entryIndex = event.characterEntryCheckpoints!.findIndex(c => c.actorId === intent.actorId);
    const entryPrefix = `/characterEntryCheckpoints/${entryIndex}`;
    const prefix = `${entryPrefix}/delta`, operations = `${prefix}/operations/`;
    const edit = proposal.output.edit;
    if ("bindings" in edit) throw entryStateStop("Binding edits require their frozen binding policy");
    const wording = "fields" in edit;
    const worker = wording ? "entry-wording-repair" : "entry-state-repair", idPrefix = wording ? "wording" : "state";
    const changedFields = wording ? edit.fields.map(f => `${entryPrefix}/${f.field}`) : [];
    const original = canonicalEventSchema.parse(old.payload).characterEntryCheckpoints![entryIndex]!;
    const removed = new Set(wording ? [] : edit.remove.map(r => r.index));
    const oldIndices = original.delta.operations.flatMap((_, i) => removed.has(i) ? [] : [i]);
    const assertions = old.evidenceAssertions.flatMap(a => {
      const p = a.target.jsonPointer;
      if (wording) return changedFields.some(f => f === p || f.startsWith(p + "/") || p.startsWith(f + "/")) ? [] : [a];
      if (prefix === p || prefix.startsWith(p + "/")) return [];
      if (!p.startsWith(operations)) return p === prefix + "/operations" ? [] : [a];
      const [part, ...rest] = p.slice(operations.length).split("/"), i = Number(part), next = oldIndices.indexOf(i);
      if (!Number.isInteger(i) || next < 0) return [];
      return [{ ...a, target: { ...a.target, jsonPointer: operations + next + (rest.length ? "/" + rest.join("/") : "") } }];
    });
    const bindings = wording ? edit.fields.map(f => ({ jsonPointer: `${entryPrefix}/${f.field}`, selectors: f.evidence, strength: f.strength, interpretation: f.rationale }))
      : [{ jsonPointer: prefix, selectors: proposal.output.evidence, strength: "strong-inference" as const, interpretation: proposal.output.rationale },
      ...edit.set.map((s, i) => ({ jsonPointer: operations + (oldIndices.length + i), selectors: s.evidence, strength: s.strength, interpretation: s.rationale }))];
    assertions.push(...bindings.map((binding, j) => evidenceAssertionSchema.parse({ version: 1,
      id: `${idPrefix}-${entryStateRepairId(intent).slice(0, 32)}-${index}-${j}`, target: { artifactKind: b.kind, artifactId: b.id, jsonPointer: binding.jsonPointer },
      anchors: binding.selectors.map(selector => {
        const found = proposal.evidence.find(e => contentHash(e.selector) === contentHash(selector));
        if (!found) throw entryStateStop("State field lacks its exact resolved source selector");
        return found.anchor;
      }), relation: "supports", strength: binding.strength, interpretation: binding.interpretation,
      derivation: { runId: proposal.traceRunId, worker, provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash, ontologyVersion: "evidence-v1" } })));
    return artifactProposalSchema(canonicalEventSchema).parse({
      id: `${idPrefix}-${entryStateRepairId(intent).slice(0, 32)}-${index}`, kind: b.kind, schemaVersion: 1, payload: b.payload,
      evidence: compilerPayloadEvidence(b.payload), evidenceAssertions: assertions, createdAt: intent.createdAt,
      generatedBy: { worker, provider: "openai-codex", model: "gpt-6.1-sol", promptHash: proposal.inputHash } });
  });
}

export async function verifyEntryStateRecord(root: string, record: EntryStateRecord, history?: LedgerRecord[]) {
  const s = record.intent, directory = entryStateRepairDirectory(root, s), ledger = history ?? await new RequirementLedger(root, s.sourceId).history();
  const existing = entryStateRecords(ledger, s.taskId).filter(r => entryStateRepairId(r.intent) === entryStateRepairId(s));
  const records = existing.some(r => r.phase === record.phase) ? existing.slice(0, existing.findIndex(r => r.phase === record.phase) + 1) : [...existing, record];
  validateEntryStateHistory(records, revalidationRecords(ledger, s.taskId));
  const context = await readStateFile(path.join(directory, "context.json"));
  if (contentHash(await readStateFile(path.join(directory, "intent.json"))) !== contentHash(s) || contentHash(context) !== s.contextHash
    || ledger[s.requirementPrefix.length - 1]?.hash !== s.requirementPrefix.head) throw entryStateStop("Original state intent or journal prefix changed");
  const parents = revalidationRecords(ledger, s.taskId).filter(r => consumerRevalidationId(r.scope) === s.parentReviewId);
  if (contentHash(context.originalInput) !== parents[0]?.inputHash || contentHash(context.negativeJudgments) !== contentHash(parents.map(r => r.output)))
    throw entryStateStop("State context changed its original source packet or negative judgments");
  if ("output" in record) {
    const previous = records.slice(0, -1), input = entryStateInput(s, context, previous);
    if (record.inputHash !== contentHash(input) || contentHash(await readStateFile(path.join(directory, `${record.phase}.input.json`))) !== record.inputHash
      || contentHash(await stateEvidence(root, s, entryStateSelectors(record.output))) !== contentHash(record.evidence)) throw entryStateStop("State evidence or complete input changed");
    const checkpoint = await verifyIdentityUpstreamSession(root, directory, record.phase, { ...record, planHash: contentHash(s) }, entryStateModelContract);
    await assertEntryStatePreviewAllowance(directory, record.phase, contentHash(s), input.proposalHash ?? undefined);
    const budget = await readStateFile(path.join(directory, `${record.phase}.budget.json`));
    const prior = { ...s.priorUsage };
    if (record.phase === "entry-state-check") {
      const b = await readStateFile(path.join(directory, "entry-state-proposal.budget.json"));
      prior.modelCalls += b.state.usage.modelCalls; prior.totalPayloadBytes += b.state.usage.totalPayloadBytes;
    }
    if (contentHash(checkpoint.output) !== contentHash(record.output) || budget.scopeHash !== contentHash(s) || contentHash(budget.priorUsage) !== contentHash(prior)
      || budget.originalBudgetHash !== s.originalBudgetHash || contentHash(budget.limits) !== contentHash(ENTRY_STATE_LIMITS))
      throw entryStateStop("State actual submission or original allowance changed");
  } else {
    const proposal = records[0] as Extract<EntryStateRecord, { phase: "entry-state-proposal" }>;
    const envelopes = stateEnvelopes(s, proposal), writable = entryStateWritableBaselines(s);
    if (!existing.some(r => contentHash(r) === contentHash(record))) {
      const readonly = s.baselines.filter(b => !writable.some(w => w.kind === b.kind && w.id === b.id));
      if (readonly.length) {
        const actual = (await loadCompilerArtifactRecords(root, s.sourceId)).filter(r => r.status === "canonical");
        for (const b of readonly) {
          const current = actual.find(r => r.kind === b.kind && r.logicalId === b.id);
          if (contentHash(current?.payload) !== b.revisionHash
            || contentHash(current?.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id))) !== contentHash(b.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id))))
            throw entryStateStop("Read-only entry owner changed before the sealed commit or acceptance");
        }
      }
    }
    if (contentHash(record.artifacts) !== contentHash(envelopes.map((e, i) => ({ kind: e.kind, id: writable[i]!.id, proposalId: e.id,
      beforeHash: writable[i]!.revisionHash, afterHash: contentHash(e.payload), envelopeHash: contentHash(e) })))) throw entryStateStop("Commit intent changed deterministic typed proposals");
    if (record.phase === "entry-state-applied") {
      const actual = (await loadCompilerArtifactRecords(root, s.sourceId)).filter(r => r.status === "canonical");
      const historical = existing.some(r => contentHash(r) === contentHash(record));
      for (const [i, e] of envelopes.entries()) {
        const current = actual.find(r => r.kind === e.kind && r.logicalId === writable[i]!.id);
        if (contentHash(await new ProposalStore(root).readEnvelope("accepted", e.id)) !== contentHash(e)
          || !historical && (contentHash(current?.payload) !== contentHash(e.payload)
            || contentHash(current?.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id))) !== contentHash(e.evidenceAssertions.slice().sort((a, b) => a.id.localeCompare(b.id)))))
          throw entryStateStop("Applied receipt lacks its exact active accepted proposal and evidence");
      }
    }
  }
}

export { entryRepairCatalogBaselines as entryStateCatalogBaselines } from "./entry-repair-catalog.js";
