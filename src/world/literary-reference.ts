import { branchAcquisitionRevision } from "./branch-acquisition.js";
import { createHash } from "node:crypto";
import { contentHash } from "./canonical.js";
import { observeCommittedEvent } from "./actor-visible.js";
import { buildNarrativeSourceReferences, type NarrativeEvidenceCandidate, type NarrativeSourceReference } from "./narrative-source.js";
import { resolveCommitSourceId } from "./source-scope.js";
import type { WorldEngine } from "./engine.js";
import type { StoryTime } from "./model.js";

export type LiteraryReferenceRecord = {
  ref: string;
  sourceId: string;
  span: { startByte: number; endByte: number; startLine: number; endLine: number; exactHash: string };
  purpose: "style-only";
  eventId: string;
  commitId: string;
  storyTime: StoryTime;
  speakerId?: string;
  addresseeIds: string[];
  sceneRefs: string[];
  goalRefs: string[];
  visibility: { actorId: string; basis: "committed-observation" | "committed-utterance" | "understood-expression"; acquisitionId?: string; expressionId?: string; expressionHash?: string };
};
export type LiteraryReferenceIndex = {
  version: "literary-reference/v1";
  branchId: string;
  atCommit: string;
  actorId: string;
  sourceId?: string;
  records: LiteraryReferenceRecord[];
  revisionHash: string;
};

/** Derived pointers, not a second copy of the novel or permission to utter canon. */
export async function buildLiteraryReferenceIndex(input: {
  engine: WorldEngine; workspaceRoot: string; branchId: string; atCommit: string; actorId: string;
  sourceId?: string; forbiddenNames?: readonly string[];
}): Promise<{ index: LiteraryReferenceIndex; references: NarrativeSourceReference[] }> {
  const branch = await input.engine.branches.read(input.branchId);
  if (branch.headCommitId !== input.atCommit) throw new Error("LITERARY_REFERENCE_STALE_HEAD: Stop this rendering lookup; rebuild the same actor view at the intended committed head. Never reuse another branch's references or retry unchanged.");
  const [context, projection] = await Promise.all([input.engine.contextForCommit(input.atCommit), input.engine.projections.project(input.atCommit)]);
  if (context.entities.get(input.actorId)?.kind !== "character") throw new Error("Literary reference viewpoint must be a character in this frozen context.");
  const sourceId = await resolveCommitSourceId(input.engine, context, input.atCommit, input.sourceId, "Literary reference index");
  const candidates: NarrativeEvidenceCandidate[] = [];
  type Basis = Omit<LiteraryReferenceRecord, "ref" | "sourceId" | "span" | "purpose">;
  const bases = new Map<string, Basis>();
  const add = (candidate: NarrativeEvidenceCandidate, basis: Basis) => {
    const occurrenceId = contentHash({ basis, evidence: candidate.evidence, texts: candidate.admittedTexts });
    bases.set(occurrenceId, basis);
    candidates.push({ ...candidate, occurrenceId });
  };
  const receipts = Object.values(projection.knowledge.acquisitions ?? {}).filter(receipt => receipt.actorId === input.actorId && receipt.reception.understood);
  const realized = new Set(projection.history.flatMap(entry => entry.event.realizesCanonicalEventIds ?? []));
  const receiptsByCommit = new Map<string, typeof receipts>();
  for (const receipt of receipts) {
    const group = receiptsByCommit.get(receipt.acquiredAtCommit) ?? [];
    group.push(receipt); receiptsByCommit.set(receipt.acquiredAtCommit, group);
  }
  for (const entry of [...projection.history].reverse()) {
    const event = entry.event;
    const observation = observeCommittedEvent(event, input.actorId);
    if (!observation) continue;
    const base = {
      eventId: event.eventId, commitId: entry.commitId, storyTime: event.logicalTime.storyTime ?? { kind: "unknown" as const },
      addresseeIds: [] as string[], sceneRefs: event.progress?.scene?.sceneId ? [event.progress.scene.sceneId] : [],
      goalRefs: entry.semanticDelta?.operations.flatMap(op => op.op === "open-goal" && op.goal.actorId === input.actorId ? [op.goal.id] : []) ?? [],
    };
    for (const [index, utterance] of (event.spokenUtterances ?? []).entries()) {
      if (utterance.speakerId !== input.actorId && !utterance.addresseeIds.includes(input.actorId)) continue;
      add({ evidence: event.evidence, relevance: ["exact committed utterance", `utterance ${index}`], anchors: [utterance.content], admittedTexts: [utterance.content] },
        { ...base, speakerId: utterance.speakerId, addresseeIds: [...utterance.addresseeIds], visibility: { actorId: input.actorId, basis: "committed-utterance" } });
    }
    // No fallback to event.title or summary synthesized for all participants:
    // an explicit actor observation must itself match the original source bytes.
    const explicit = event.actorObservations?.find(item => item.actorId === input.actorId);
    if (explicit) add({ evidence: event.evidence, relevance: ["exact committed actor observation"], anchors: [explicit.summary], admittedTexts: [explicit.summary] },
      { ...base, visibility: { actorId: input.actorId, basis: "committed-observation" } });
    for (const receipt of receiptsByCommit.get(entry.commitId) ?? []) {
      const canonical = context.acquisitions?.get(receipt.acquisitionId);
      const branchAcquisition = projection.semantics.acquisitions?.[receipt.acquisitionId];
      const acquisition = canonical ?? branchAcquisition;
      if (!acquisition || acquisition.actorId !== input.actorId || acquisition.propositionId !== receipt.propositionId
        || receipt.revisionHash !== (canonical ? contentHash(canonical) : branchAcquisitionRevision(branchAcquisition!))) continue;
      const basis = acquisition.basis;
      if (!basis || !("expressionId" in basis)) continue;
      const expression = context.utteranceExpressions?.get(basis.expressionId);
      if (!expression || !realized.has(expression.canonicalEventId)) continue;
      for (const fragment of expression.fragments) {
        const anchor = fragment.anchor;
        add({ evidence: [{ span: { sourceId: anchor.sourceId, startByte: anchor.startByte, endByte: anchor.endByte, startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash }, strength: "explicit" }],
          relevance: ["exact expression previously understood by this actor"], anchors: [fragment.text], admittedTexts: [fragment.text] },
          { ...base, speakerId: expression.speakerId, addresseeIds: [...expression.addresseeIds], visibility: { actorId: input.actorId, basis: "understood-expression", acquisitionId: receipt.acquisitionId, expressionId: expression.id, expressionHash: contentHash(expression) } });
      }
    }
  }
  const references = await buildNarrativeSourceReferences({ workspaceRoot: input.workspaceRoot, sourceId, candidates, forbiddenNames: input.forbiddenNames });
  const records = references.map(reference => ({ ...bases.get(reference.occurrenceId!)!, ref: reference.ref, sourceId: reference.sourceId,
    span: { startByte: reference.startByte, endByte: reference.endByte, startLine: reference.startLine, endLine: reference.endLine, exactHash: contentHashText(reference.text) }, purpose: "style-only" as const }));
  const value = { version: "literary-reference/v1" as const, branchId: input.branchId, atCommit: input.atCommit, actorId: input.actorId, ...(sourceId ? { sourceId } : {}), records };
  return { index: { ...value, revisionHash: contentHash(value) }, references };
}

const contentHashText = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
