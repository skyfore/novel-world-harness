import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { entityMentionSchema, SourceAnnotationStore } from "../src/compiler/annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "../src/compiler/entity-resolution.js";
import { executeUpstreamRepairFinish } from "../src/compiler/upstream-repair-finish.js";
import { authorizeUpstreamRepairFinishRevision, continueUpstreamRepairFinishRevision, inspectUpstreamRepairFinishRevisionAuthority } from "../src/compiler/upstream-repair-finish-revision.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { planUpstreamRepair } from "../src/compiler/upstream-repair-planner.js";
import { assertUpstreamSemanticPresenceProjection, checkUpstreamRepairMutation, stageUpstreamRepair } from "../src/compiler/upstream-repair-staging.js";
import { captureUpstreamRepairCheckpoint } from "../src/compiler/upstream-repair-checkpoint.js";
import { verifyUpstreamRepairPlan } from "../src/compiler/upstream-repair-preflight.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { reviewSourcePatternObligation } from "../src/compiler/source-pattern-obligation-review.js";
import { prepareCompilerBatches } from "../src/compiler/batches.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { contentHash } from "../src/world/canonical.js";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { upstreamRepairSnapshotIssues } from "../src/compiler/upstream-repair-snapshot.js";
import { proposalObligationRequirementResult } from "../src/compiler/upstream-repair-evaluation.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { freezeUpstreamRepairFinishIntent } from "../src/compiler/upstream-repair-finish-intent.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("compiles a reviewed missing source occurrence before its downstream schema is retried", async () => {
  const text = [
    "Chapter 1",
    "Thirteen strikes Adams apart. The metal rods assemble into Adams again.",
    "Chapter 2",
    "Thirteen kicks Adams apart. The metal rods assemble into Adams again. A bell rings elsewhere.",
  ].join("\n");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-semantic-event-"));
  roots.push(root);
  const fixture = await createEvidenceFixture(root, text);
  const sourceId = fixture.source.id;
  const bytes = Buffer.from(text);
  const anchor = (quote: string, occurrence = 0) => {
    const needle = Buffer.from(quote);
    let start = -1;
    let searchFrom = 0;
    for (let index = 0; index <= occurrence; index += 1) {
      start = bytes.indexOf(needle, searchFrom);
      searchFrom = start + needle.length;
    }
    if (start < 0) throw new Error(`Missing fixture quote: ${quote}`);
    return textAnchorForByteRange(sourceId, bytes, start, start + Buffer.byteLength(quote));
  };
  const manifest = (await new SegmentStore(root).readManifest(sourceId))!;
  const [firstSegment, secondSegment] = manifest.segments;
  expect(firstSegment).toBeDefined();
  expect(secondSegment).toBeDefined();
  const occurrence = "Thirteen kicks Adams apart. The metal rods assemble into Adams again.";

  const canonical = new CanonicalModelStore(root);
  await canonical.putEntity({
    id: "thirteen",
    kind: "character",
    canonicalName: "Thirteen",
    aliases: [],
    evidence: fixture.evidence("Thirteen"),
  });
  await canonical.putEntity({
    id: "adams",
    kind: "artifact",
    canonicalName: "Adams",
    aliases: [],
    evidence: fixture.evidence("Adams"),
  });
  await canonical.putEvent({
    id: "first-adams-reassembly",
    title: "Adams reassembles after the first strike",
    readerSummary: "Thirteen strikes Adams apart and the metal rods assemble back into Adams.",
    participants: ["thirteen", "adams"],
    participantPresence: [{ entityId: "thirteen", mode: "physical" }],
    storyTime: { kind: "ordinal", label: "first recovery", orderHint: 1 },
    preconditions: [],
    observedOutcome: {
      version: 1,
      operations: [{ op: "set", entityId: "adams", field: "artifact.condition", value: 1 }],
    },
    causalParents: [],
    evidence: fixture.evidence("Thirteen strikes Adams apart. The metal rods assemble into Adams again."),
    confidence: 1,
  });

  const annotations = new SourceAnnotationStore(root);
  const resolutions = new EntityResolutionStore(root);
  for (const [mentionId, entityId, surface, kind] of [
    ["mention-thirteen", "thirteen", "Thirteen", "character"],
    ["mention-adams", "adams", "Adams", "artifact"],
  ] as const) {
    const mention = entityMentionSchema.parse({
      version: 1,
      id: mentionId,
      sourceId,
      annotationType: "entity-mention",
      anchor: anchor(surface, entityId === "thirteen" ? 1 : 2),
      surface,
      form: "proper",
      kindCandidates: [kind],
      confidence: 1,
      derivation: { runId: "source-review", worker: "fixture", ontologyVersion: "observation-v1" },
    });
    const mentionProposalId = `proposal-${mentionId}`;
    await annotations.stage(sourceId, {
      version: 1,
      id: mentionProposalId,
      annotationType: "entity-mention",
      payload: mention,
      generatedBy: { worker: "fixture" },
      createdAt: "2026-09-26T00:00:00Z",
    });
    await annotations.commitProposals(sourceId, [mentionProposalId]);
    const resolution = identityResolutionSchema.parse({
      version: 1,
      id: `resolution-${entityId}`,
      sourceId,
      mentionId,
      status: "resolved",
      entityId,
      candidates: [{
        entityId,
        confidence: 1,
        basisMentionIds: [mentionId],
        evidenceAssertionIds: [],
        rationale: "The exact proper-name mention identifies the canonical participant.",
      }],
      rationale: "Independent source identity review.",
      derivation: { runId: "source-review", worker: "fixture", ontologyVersion: "entity-resolution-v1" },
    });
    const resolutionProposalId = `proposal-resolution-${entityId}`;
    await resolutions.stage(sourceId, {
      version: 1,
      id: resolutionProposalId,
      payload: resolution,
      generatedBy: { worker: "fixture" },
      createdAt: "2026-09-26T00:00:00Z",
    });
    await resolutions.commitProposals(sourceId, [resolutionProposalId]);
  }

  const executableBatch = (await prepareCompilerBatches(root, fixture.source)).find(batch =>
    batch.semanticStage === "executable" && batch.segmentIds.length === 1 && batch.segmentIds[0] === firstSegment!.id)!;
  const obligation = new CompilerProposalObligations(root, sourceId, executableBatch.id);
  const originalInput = {
    proposal_id: "schema-adams-reassembly",
    payload: {
      ontologyVersion: "action-schema-v1",
      id: "schema-adams-reassembly",
      name: "Adams reassembles after impact",
      visibility: "public",
      roles: [{ id: "agent", label: "Reassembling artifact", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 }],
      initiatorRoleId: "agent",
      parameters: [],
      preconditions: [],
      stateEffects: [],
      effectEnvelope: { maxStateOperations: 0, allowedStateFields: [], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
      induction: { kind: "source-pattern", supportingEventIds: ["first-adams-reassembly"] },
    },
    evidence_segment_ids: [firstSegment!.id],
  };
  const invalidDomainCorrection = {
    ...originalInput,
    payload: {
      ...originalInput.payload,
      induction: { kind: "domain-module", moduleId: "artifact-reassembly", moduleVersion: "1" },
    },
  };
  obligation.record("propose_action_schema", originalInput, "failed", "A source action requires at least two supporting events.");
  obligation.record("propose_action_schema", invalidDomainCorrection, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
  obligation.record("propose_action_schema", invalidDomainCorrection, "failed", "Domain modules are host-managed.");
  const authority = obligation.inspectSourcePatternUpstreamAuthority("propose_action_schema", originalInput.proposal_id);
  const requirementId = authority.requirementIds[0]!;
  expect(await new RequirementLedger(root, sourceId).definitions()).toEqual([]);

  const planReview = {
    version: 1,
    sourceId,
    sourceSha256: fixture.source.contentSha256,
    planId: "repair-missing-adams-reassembly",
    batchId: "repair-missing-adams-reassembly-batch",
    requirementSetHash: authority.requirementSetHash,
    requirementIds: authority.requirementIds,
    proposalObligation: authority.proposalObligation,
    predecessorReceiptRefs: [],
    segmentIds: [secondSegment!.id],
    citableEvidenceRefs: [secondSegment!.id],
    authorizationRef: "host-reviewed-missing-event",
    retryBudgetRef: "missing-event-budget",
    diagnostics: [{
      code: "CANONICAL_EVENT_MISSING",
      requirementId,
      triggerAnchor: anchor("assemble", 1),
      extentAnchors: [anchor(occurrence)],
      participantMentionIds: ["mention-thirteen", "mention-adams"],
    }],
  };
  await expect(planUpstreamRepair(root, {
    ...planReview,
    proposalObligation: { ...authority.proposalObligation, historyHash: "0".repeat(64) },
    requirementSetHash: "0".repeat(64),
  })).rejects.toThrow("history or failed inputs changed");
  const planned = await planUpstreamRepair(root, planReview);
  expect(planned.status).toBe("ready-for-host-authorization");
  const plan = planned.plan!;
  expect(plan.proposalObligation).toEqual(authority.proposalObligation);
  const semantic = plan.semanticEventCreations![0]!;
  expect(plan.allowedCreations.map(item => item.kind).sort()).toEqual([
    "canonical-event",
    "event-mention",
    "event-participation",
    "event-participation",
    "event-resolution",
  ]);
  expect(semantic.participants.map(item => item.entityId)).toEqual(["thirteen", "adams"]);

  const ledger = new UpstreamRepairLedger(root, sourceId);
  await ledger.register(plan);
  expect(upstreamRepairSnapshotIssues({ upstreamRepairJournal: await ledger.history() }, sourceId, fixture.source.contentSha256)).toEqual([]);
  await ledger.authorize(plan.planHash);
  const mentionInput = {
    proposal_id: "proposal-reassembly-mention",
    annotation_id: semantic.eventMentionId,
    trigger_selector: { segment_id: secondSegment!.id, exact: "assemble" },
    trigger: "assemble",
    extent_selectors: [{ segment_id: secondSegment!.id, exact: occurrence }],
    event_type_candidates: ["state-change"],
    participant_mention_ids: ["mention-thirteen", "mention-adams"],
    salience: "major",
    confidence: 1,
  };
  const target = { kind: "event-mention" as const, id: semantic.eventMentionId };
  for (const trigger of ["invented", "invented again"]) {
    await expect(stageUpstreamRepair(root, sourceId, plan.planHash, target, { ...mentionInput, trigger })).rejects.toThrow();
  }
  const failedState = await ledger.inspect();
  expect(failedState.plans[0]!.state).toBe("needs-host-review");
  const failedAttemptRef = failedState.attempts.at(-1)!.attemptRef;
  await ledger.authorizeHostCorrection(plan.planHash, { failedAttemptRef, inputHash: contentHash(mentionInput), auditRef: "host-reviewed-source.json", reason: "Restore exact source trigger and frozen participant inventory." });
  await expect(stageUpstreamRepair(root, sourceId, plan.planHash, target, { ...mentionInput, confidence: 0.5 })).rejects.toThrow("Only the exact reviewed host correction");
  await expect(ledger.startModelSession(plan.planHash, { artifactKind: target.kind, artifactId: target.id, proposalId: mentionInput.proposal_id, promptHash: contentHash("retry") })).rejects.toThrow("Only the exact reviewed host correction");
  const mentionStage = await stageUpstreamRepair(root, sourceId, plan.planHash, target, mentionInput);
  expect((await ledger.inspect()).attempts.filter(item => item.failed)).toHaveLength(2);
  await expect(ledger.authorizeHostCorrection(plan.planHash, { failedAttemptRef, inputHash: contentHash(mentionInput), auditRef: "again", reason: "Do not replay consumed authority" })).rejects.toThrow();
  const eventInput = {
    proposal_id: "proposal-reassembly-event",
    payload: {
      id: semantic.canonicalEventId,
      title: "Adams reassembles after being kicked apart",
      readerSummary: "Thirteen kicks Adams apart, but the metal rods assemble themselves back into Adams.",
      participants: ["thirteen", "adams"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      causalParents: [],
      confidence: 1,
    },
    evidence_segment_ids: [secondSegment!.id],
    evidence_selectors: [{
      segment_id: secondSegment!.id,
      exact: occurrence,
      target_path: "/id",
      relation: "supports",
      strength: "explicit",
    }],
  };
  const legacyStageWorld = async (
    kind: "canonical-event" | "event-participation",
    id: string,
    raw: Record<string, unknown>,
    dependencies: Array<{ attemptRef: string; proposalHash: string }>,
  ) => {
    const attemptRef = await ledger.startAttempt(plan.planHash, {
      artifactKind: kind,
      artifactId: id,
      proposalId: String(raw.proposal_id),
      inputHash: contentHash(raw),
      toolInput: raw,
    });
    const tools = createCompilerProposalToolset(root, {}, { upstreamRepair: {
      planHash: plan.planHash,
      beforeStage: async (actualKind, actualId, payload) => {
        expect({ actualKind, actualId }).toEqual({ actualKind: kind, actualId: id });
        await ledger.recordValidated(plan.planHash, attemptRef, contentHash(payload), [...dependencies].sort((left, right) => left.attemptRef.localeCompare(right.attemptRef)));
      },
    } });
    await tools.beginBatch(plan.sourceScope.segmentIds, plan.batchId, sourceId);
    const tool = tools.tools.find(item => item.name === `propose_${kind.replaceAll("-", "_")}`)!;
    const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
    const result = await tool.execute(attemptRef, prepared as never, undefined, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    const envelope = await new ProposalStore(root).readEnvelope("pending", String(raw.proposal_id));
    const proposalHash = contentHash(envelope);
    await ledger.recordStaged(plan.planHash, attemptRef, proposalHash);
    return { attemptRef, proposalHash, envelope };
  };
  const mentionDependency = { attemptRef: mentionStage.attemptRef, proposalHash: mentionStage.proposalHash };
  const eventStage = await legacyStageWorld("canonical-event", semantic.canonicalEventId, eventInput, [mentionDependency]);
  const eventEnvelope = await new ProposalStore(root).readEnvelope("pending", "proposal-reassembly-event");
  const verified = await verifyUpstreamRepairPlan(root, plan);
  await expect(assertUpstreamSemanticPresenceProjection(root, "canonical-event", eventEnvelope.payload)).rejects.toThrow("must explicitly project participantPresence");
  const presenceError = await assertUpstreamSemanticPresenceProjection(root, "canonical-event", eventEnvelope.payload).catch(error => error as Error);
  expect(buildNwhToolRecoveryAdvice("propose_canonical_event", String(presenceError)).retryable).toBe(true);
  expect(() => checkUpstreamRepairMutation(
    verified,
    "canonical-event",
    semantic.canonicalEventId,
    eventEnvelope.payload,
    new Map(),
    [anchor("A bell rings elsewhere.")],
  )).toThrow("Semantic event exact evidence escapes its reviewed source occurrence");
  const resolutionInput = {
    proposal_id: "proposal-reassembly-resolution",
    resolution_id: semantic.eventResolutionId,
    event_mention_ids: [semantic.eventMentionId],
    status: "new-event",
    canonical_event_id: semantic.canonicalEventId,
    relation: "coreference",
    candidates: [{
      canonical_event_id: semantic.canonicalEventId,
      relation: "coreference",
      confidence: 1,
      basis_event_mention_ids: [semantic.eventMentionId],
      evidence_assertion_ids: [],
      rationale: "The reviewed event mention directly narrates this new canonical occurrence.",
    }],
    supersedes_resolution_ids: [],
    rationale: "The source explicitly introduces the missing reassembly occurrence.",
  };
  await stageUpstreamRepair(root, sourceId, plan.planHash, { kind: "event-resolution", id: semantic.eventResolutionId }, resolutionInput);
  const participationInputs = new Map<string, Record<string, unknown>>();
  for (const participant of semantic.participants) {
    const character = participant.entityId === "thirteen";
    const input = {
      proposal_id: `proposal-participation-${participant.entityId}`,
      payload: {
        id: participant.participationId,
        eventId: semantic.canonicalEventId,
        entityId: participant.entityId,
        role: character ? "agent" : "patient",
        presence: "physical",
        confidence: 1,
      },
      evidence_segment_ids: [secondSegment!.id],
      evidence_selectors: [{
        segment_id: secondSegment!.id,
        exact: character ? "Thirteen kicks Adams apart" : "Adams apart. The metal rods assemble into Adams again",
        target_path: "/role",
        relation: "supports",
        strength: character ? "explicit" : "strong-inference",
        ...(character ? {} : { interpretation: "Adams is the affected artifact that reassembles." }),
      }],
    };
    participationInputs.set(participant.entityId, input);
    const staged = await legacyStageWorld("event-participation", participant.participationId, input, [
      { attemptRef: eventStage.attemptRef, proposalHash: eventStage.proposalHash },
      mentionDependency,
    ]);
    if (!character) await expect(assertUpstreamSemanticPresenceProjection(root, "event-participation", staged.envelope.payload, new Map([[`canonical-event:${semantic.canonicalEventId}`, eventEnvelope.payload]]))).rejects.toThrow("presence to non-character");
  }

  const finishInput = {
    outcome: "complete" as const,
    reviewed_segments: [{
      segment_id: secondSegment!.id,
      disposition: "proposed" as const,
      summary: "Reviewed the missing Adams reassembly occurrence and its complete participant trace.",
    }],
    summary: "Compile the exact host-reviewed missing canonical event.",
  };
  await ledger.recordFinishReview(plan.planHash, finishInput);
  const preFinishState = await ledger.inspect();
  const originalIntent = freezeUpstreamRepairFinishIntent({
    version: 1,
    planHash: plan.planHash,
    sourceId,
    sourceSha256: plan.sourceScope.sourceSha256,
    requirementSetHash: plan.requirementSetHash,
    authorizationHeadHash: (await ledger.history()).at(-1)!.hash,
    input: finishInput,
    proposals: [...plan.allowedWrites, ...plan.allowedCreations].map(slot => {
      const attempt = preFinishState.attempts.findLast(item => item.started.planHash === plan.planHash && item.started.artifactKind === slot.kind && item.started.artifactId === slot.id && item.staged)!;
      const staged = preFinishState.records.find(item => item.payload.kind === "attempt-staged" && item.payload.attemptRef === attempt.attemptRef)!.payload;
      if (staged.kind !== "attempt-staged" || !attempt.validatedHash) throw new Error("fixture staged attempt is incomplete");
      return { artifactKind: slot.kind, artifactId: slot.id, proposalId: attempt.started.proposalId, proposalHash: staged.proposalHash, attemptRef: attempt.attemptRef, payloadHash: attempt.validatedHash };
    }).sort((left, right) => left.attemptRef.localeCompare(right.attemptRef)),
    baselines: plan.baselineRefs.map(ref => ({ ...ref, payload: verified.payloads.get(`${ref.kind}:${ref.id}`) })).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
  });
  await ledger.freezeFinish(originalIntent);
  await expect(executeUpstreamRepairFinish(root, sourceId, plan.planHash)).rejects.toThrow("Original finish validation failed");
  expect(await new CompilerFinishReceipts(root, sourceId, plan.batchId).read()).toBeUndefined();
  expect((await ledger.inspect()).plans[0]).toMatchObject({ state: "needs-host-review", finishIntent: originalIntent, originalFinishIntent: originalIntent });
  const revisionAuthority = await inspectUpstreamRepairFinishRevisionAuthority(root, sourceId, plan.planHash);
  const slots = new Map(revisionAuthority.slots.map(slot => [`${slot.artifactKind}:${slot.artifactId}`, slot]));
  const replacementIds = new Map([
    [`canonical-event:${semantic.canonicalEventId}`, "proposal-reassembly-event-host-revision"],
    [`event-resolution:${semantic.eventResolutionId}`, "proposal-reassembly-resolution-host-revision"],
    ...semantic.participants.map(participant => [`event-participation:${participant.participationId}`, `proposal-participation-${participant.entityId}-host-revision`] as const),
  ]);
  const correctedEventInput = {
    ...eventInput,
    proposal_id: replacementIds.get(`canonical-event:${semantic.canonicalEventId}`)!,
    payload: { ...eventInput.payload, participantPresence: [{ entityId: "thirteen", mode: "physical" }] },
  };
  const corrections = [...replacementIds].map(([key, replacementProposalId]) => {
    const slot = slots.get(key)!;
    let toolInput: Record<string, unknown>;
    if (key === `canonical-event:${semantic.canonicalEventId}`) toolInput = correctedEventInput;
    else if (key === `event-participation:${semantic.participants.find(item => item.entityId === "adams")!.participationId}`) {
      const original = participationInputs.get("adams")!, payload = original.payload as Record<string, unknown>;
      const { presence: _presence, ...correctedPayload } = payload;
      toolInput = { ...original, proposal_id: replacementProposalId, payload: correctedPayload };
    } else toolInput = { ...(slot.toolInput as Record<string, unknown>), proposal_id: replacementProposalId };
    return {
      artifactKind: slot.artifactKind,
      artifactId: slot.artifactId,
      originalAttemptRef: slot.originalAttemptRef,
      originalProposalId: slot.originalProposalId,
      originalInputHash: slot.originalInputHash,
      replacementProposalId,
      inputHash: contentHash(toolInput),
      toolInput,
    };
  });
  const revisionReview = {
    version: 1 as const,
    sourceId,
    planHash: plan.planHash,
    failedFinishRef: revisionAuthority.failedFinishRef,
    originalIntentHash: revisionAuthority.originalIntentHash,
    originalGraphHash: revisionAuthority.originalGraphHash,
    auditRef: "test:reviewed-pre-receipt-presence-revision",
    reason: "Project physical presence for the character participant and remove presence from the artifact participation.",
    corrections,
  };
  const receiptRead = vi.spyOn(CompilerFinishReceipts.prototype, "read").mockResolvedValueOnce({ state: "prepared" } as never);
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revisionReview)).rejects.toThrow("forbidden after any prepared or completed receipt");
  receiptRead.mockRestore();
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, { ...revisionReview, originalGraphHash: "0".repeat(64) })).rejects.toThrow("same-scope authority");
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, {
    ...revisionReview,
    corrections: revisionReview.corrections.map((correction, index) => index ? correction : { ...correction, originalProposalId: "wrong-original-proposal" }),
  })).rejects.toThrow("exact original slot fields");
  const eventSlot = slots.get(`canonical-event:${semantic.canonicalEventId}`)!;
  const unchangedEventInput = { ...(eventSlot.toolInput as Record<string, unknown>), proposal_id: "unchanged-event-revision" };
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, {
    ...revisionReview,
    corrections: [{ artifactKind: eventSlot.artifactKind, artifactId: eventSlot.artifactId, originalAttemptRef: eventSlot.originalAttemptRef,
      originalProposalId: eventSlot.originalProposalId, originalInputHash: eventSlot.originalInputHash, replacementProposalId: "unchanged-event-revision",
      inputHash: contentHash(unchangedEventInput), toolInput: unchangedEventInput }],
  })).rejects.toThrow("material semantic correction");
  const mentionSlot = slots.get(`event-mention:${semantic.eventMentionId}`)!;
  const widenedMentionInput = { ...(mentionSlot.toolInput as Record<string, unknown>), proposal_id: "proposal-reassembly-mention-host-revision" };
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, {
    ...revisionReview,
    corrections: [...revisionReview.corrections, {
      artifactKind: mentionSlot.artifactKind,
      artifactId: mentionSlot.artifactId,
      originalAttemptRef: mentionSlot.originalAttemptRef,
      originalProposalId: mentionSlot.originalProposalId,
      originalInputHash: mentionSlot.originalInputHash,
      replacementProposalId: "proposal-reassembly-mention-host-revision",
      inputHash: contentHash(widenedMentionInput),
      toolInput: widenedMentionInput,
    }],
  })).rejects.toThrow("exactly the materially changed slots and every changed descendant");
  const revision = await authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revisionReview);
  await expect(authorizeUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revisionReview)).rejects.toThrow("prior revision");
  await expect(continueUpstreamRepairFinishRevision(root, sourceId, plan.planHash, "0".repeat(64))).rejects.toThrow("Exact active finish revision");
  vi.spyOn(UpstreamRepairLedger.prototype, "recordStaged").mockRejectedValueOnce(new Error("injected post-write finish revision interruption"));
  await expect(continueUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revision.revisionHash)).rejects.toThrow("requires host recovery of the exact pending draft");
  vi.restoreAllMocks();
  const revisedIntent = await continueUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revision.revisionHash);
  const revisedState = (await ledger.inspect()).plans[0]!;
  expect(revisedState).toMatchObject({ state: "finish-frozen", originalFinishIntent: originalIntent, finishIntent: revisedIntent, finishRevision: { completed: true } });
  expect(revisedIntent.input).toEqual(originalIntent.input);
  expect((await ledger.history()).filter(record => record.payload.kind === "finish-revision-authorized")).toHaveLength(1);
  expect((await new ProposalStore(root).readEnvelope("rejected", eventInput.proposal_id)).payload).toEqual(eventEnvelope.payload);
  const receipt = await executeUpstreamRepairFinish(root, sourceId, plan.planHash);
  expect(receipt.state).toBe("completed");
  await expect(continueUpstreamRepairFinishRevision(root, sourceId, plan.planHash, revision.revisionHash)).rejects.toThrow("consumed");

  const checkpoint = (await captureUpstreamRepairCheckpoint(root, sourceId))!;
  expect(checkpoint.drafts.filter(item => item.store === "world").map(item => item.status)).toEqual(["pending", "pending", "pending"]);
  expect(checkpoint.drafts.filter(item => item.store !== "world").map(item => item.status)).toEqual(["accepted", "accepted"]);

  const converged = await convergeWorldProposals(root, sourceId);
  expect(converged.canonical.blocked).toEqual([]);
  expect(converged.canonical.accepted.map(item => item.id).sort()).toEqual([
    "proposal-participation-adams-host-revision",
    "proposal-participation-thirteen-host-revision",
    "proposal-reassembly-event-host-revision",
  ]);
  expect(converged.upstreamRepairIssues).toBeUndefined();
  expect((await canonical.getEvent(semantic.canonicalEventId))?.observedOutcome.operations).toEqual([]);
  expect((await canonical.listEventParticipations()).filter(item => item.eventId === semantic.canonicalEventId)).toHaveLength(2);
  expect((await new ProposalStore(root).list("pending", sourceId))).toEqual([]);
  expect((await ledger.inspect()).plans[0]!.state).toBe("converged");
  const convergedCheckpoint = (await captureUpstreamRepairCheckpoint(root, sourceId))!;
  expect(convergedCheckpoint.drafts.filter(item => item.store === "world").map(item => item.status)).toEqual(["accepted", "accepted", "accepted"]);

  const correctedInput = {
    proposal_id: "schema-adams-reassembly",
    payload: {
      ontologyVersion: "action-schema-v1",
      id: "schema-adams-reassembly",
      name: "Impact triggers Adams reassembly",
      visibility: "public",
      roles: [
        { id: "actor", label: "Character striking Adams", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
        { id: "artifact", label: "Reassembling artifact", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 },
      ],
      initiatorRoleId: "actor",
      parameters: [],
      preconditions: [],
      stateEffects: [{
        op: "set",
        entity: { kind: "role", roleId: "artifact" },
        field: "artifact.condition",
        value: { source: "literal", value: 1 },
      }],
      effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["artifact.condition"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
      induction: { kind: "source-pattern", supportingEventIds: ["first-adams-reassembly", semantic.canonicalEventId] },
    },
    evidence_segment_ids: [firstSegment!.id],
    evidence_selectors: [{
      segment_id: firstSegment!.id,
      exact: "Thirteen strikes Adams apart",
      target_path: "/roles/0",
      relation: "supports" as const,
      strength: "explicit" as const,
    }, {
      segment_id: firstSegment!.id,
      exact: "The metal rods assemble into Adams again",
      target_path: "/stateEffects/0",
      relation: "supports" as const,
      strength: "explicit" as const,
    }],
  };
  const failedInputHashes = obligation.history("propose_action_schema", correctedInput.proposal_id)
    .filter(attempt => attempt.status === "failed")
    .map(attempt => attempt.inputHash);
  const review = {
    version: 1 as const,
    sourceId,
    batchId: executableBatch.id,
    tool: "propose_action_schema" as const,
    proposalId: correctedInput.proposal_id,
    failedInputHashes,
    upstreamPlanHash: plan.planHash,
    upstreamReceiptFingerprint: receipt.fingerprint,
    reason: "Independent source review verified the second reassembly occurrence and corrected the initiator role.",
    auditRef: "test:missing-event-source-pattern-correction",
    input: correctedInput,
  };
  const preview = await reviewSourcePatternObligation(root, review);
  expect(preview).toMatchObject({
    status: "verified-preview",
    executableCertification: false,
    binding: {
      failedInputHashes: expect.arrayContaining(failedInputHashes),
      addedDependencies: [{ kind: "canonical-event", id: semantic.canonicalEventId }],
    },
    batchSegmentIds: [firstSegment!.id],
  });
  await expect(reviewSourcePatternObligation(root, {
    ...review,
    input: {
      ...correctedInput,
      evidence_segment_ids: [secondSegment!.id],
      evidence_selectors: correctedInput.evidence_selectors.map(selector => ({
        ...selector,
        segment_id: secondSegment!.id,
        exact: selector.target_path === "/roles/0" ? "Thirteen kicks Adams apart" : "The metal rods assemble into Adams again",
      })),
    },
  })).rejects.toThrow("cannot widen or replace");
  await expect(reviewSourcePatternObligation(root, review, true)).resolves.toMatchObject({ status: "staged" });
  const staged = await new ProposalStore(root).read("pending", correctedInput.proposal_id, actionSchemaSchema);
  expect(staged.payload.induction).toEqual({
    kind: "source-pattern",
    supportingEventIds: ["first-adams-reassembly", semantic.canonicalEventId],
  });
  expect(staged.payload.evidence.map(item => item.span.sourceId)).toEqual([sourceId]);
  expect(obligation.verifySourcePatternUpstreamAuthority(plan.proposalObligation!, {
    upstreamPlanHash: plan.planHash,
    addedCanonicalEventIds: [semantic.canonicalEventId],
  })).toMatchObject({
    correction: { receiptFingerprint: receipt.fingerprint },
  });
  const evaluation = proposalObligationRequirementResult({
    batchIds: [executableBatch.id],
    canonical: {
      events: await canonical.listEvents(),
      actionSchemas: [staged.payload],
      actionConstraints: [],
      normTemplates: [],
      processTemplates: [],
    },
  }, plan);
  expect(evaluation.requirements).toEqual([expect.objectContaining({ id: requirementId, state: "satisfied", diagnostics: [] })]);
  expect(proposalObligationRequirementResult({
    batchIds: [executableBatch.id],
    canonical: {
      events: await canonical.listEvents(),
      actionSchemas: [{ id: staged.payload.id, induction: { kind: "source-pattern", supportingEventIds: ["first-adams-reassembly"] } }],
      actionConstraints: [],
      normTemplates: [],
      processTemplates: [],
    },
  }, plan).requirements[0]).toMatchObject({ state: "blocked", diagnostics: [expect.stringContaining("UPSTREAM_SUPPORT_MISSING")] });
  expect(obligation.unresolved()).toEqual([]);
  expect(obligation.history("propose_action_schema", correctedInput.proposal_id).at(-1)).toMatchObject({
    status: "succeeded",
    hostReview: {
      auditRef: review.auditRef,
      sourcePatternDependencyCorrection: {
        upstreamPlanHash: plan.planHash,
        receiptFingerprint: receipt.fingerprint,
      },
    },
  });
  await expect(reviewSourcePatternObligation(root, review, true)).rejects.toThrow("unreviewed failed identity");
}, 30_000);
