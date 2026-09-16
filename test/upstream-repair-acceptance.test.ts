import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { attributionSchema, canonicalEventSchema, evidenceAssertionSchema, propositionSchema } from "../src/world/model.js";
import { contentHash } from "../src/world/canonical.js";
import { SourceAnnotationStore, quotationSchema } from "../src/compiler/annotations.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { registerSourceRequirements, settleSourceRequirements } from "../src/compiler/requirement-service.js";
import { planUpstreamRepair } from "../src/compiler/upstream-repair-planner.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { stageUpstreamRepair } from "../src/compiler/upstream-repair-staging.js";
import { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } from "../src/compiler/upstream-repair-finish.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { settleUpstreamRepairRequirements } from "../src/compiler/upstream-repair-evaluation.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

// Independent source expectations are frozen before candidate world records.
const scenes = [
  { text: 'Ira reads the note: "Help. People are trapped." Sol hums outside.', reader: "Ira", short: "Help.", content: "People are trapped.", utterance: "Help. People are trapped." },
  { text: 'Venn sleeps. The note reads: "Beware. The bridge is broken." Neri reads it.', reader: "Neri", short: "Beware.", content: "The bridge is broken.", utterance: "Beware. The bridge is broken." },
];
it.each(scenes.flatMap(scene => [true, false].map(complete => ({ ...scene, complete }))))("rechecks the original downstream knowledge requirement after quotation repair: $reader / complete=$complete", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-acceptance-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), sourceId = source.source.id, bytes = Buffer.from(scene.text);
  const anchor = (quote: string) => { const start = bytes.indexOf(Buffer.from(quote)); return textAnchorForByteRange(sourceId, bytes, start, start + Buffer.byteLength(quote)); };
  const definition = await registerSourceRequirements(root, { sourceId, id: "read-report", scopeDecisionRef: "independent-source-expectation", spec: {
    version: 1, sourceId, sourceSha256: source.source.contentSha256,
    review: { method: "independent-source-review", reviewer: "acceptance-fixture-author", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "original-reading-cut" },
    cases: [{ id: "reading", kind: "knowledge-cut", scene: "Reading the complete note", rationale: "The reader acquires the report only on reading it", evidence: [anchor(scene.text)],
      actorId: "reader", acquisitionEventId: "reading", claimId: "report", contentExpectation: scene.content,
      beforeEventIds: [], afterEventIds: ["reading"], expectedBefore: false, expectedAfter: true, expectedStatus: "believes" }],
  } });
  const before = (await settleSourceRequirements(root, sourceId)).results[0]!;
  expect(before.requirements.some(item => item.state !== "satisfied")).toBe(true);
  const canonical = new CanonicalModelStore(root), proposals = new ProposalStore(root), annotations = new SourceAnnotationStore(root);
  await canonical.putEntity({ id: "reader", kind: "character", canonicalName: scene.reader, aliases: [], evidence: source.evidence(scene.reader) });
  await canonical.putEntity({ id: "note", kind: "artifact", canonicalName: "note", aliases: [], evidence: source.evidence("note") });
  const quotation = quotationSchema.parse({ version: 1, id: "quote", sourceId, annotationType: "quotation", anchor: anchor(scene.short), mode: "direct", addresseeMentionIds: [], attributionConfidence: 1,
    derivation: { runId: "original", worker: "fixture", ontologyVersion: "observation-v1" } });
  await annotations.stage(sourceId, { version: 1, id: "original-quote", annotationType: "quotation", payload: quotation, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await annotations.commitProposals(sourceId, ["original-quote"]);
  const proposition = propositionSchema.parse({ id: "content", subjectEntityId: "note", relationId: "reports", object: { kind: "literal", value: scene.content }, polarity: "positive", modality: "asserted", evidence: source.evidence(scene.content) });
  await canonical.putProposition(proposition);
  const assertion = evidenceAssertionSchema.parse({ version: 1, id: "report-content", target: { artifactKind: "proposition", artifactId: proposition.id, jsonPointer: "/object/value" }, anchors: [anchor(scene.content)], relation: "supports", strength: "explicit", derivation: { runId: "source-review", worker: "fixture", ontologyVersion: "evidence-v1" } });
  await new EvidenceAssertionStore(root).replaceForArtifact("proposition", proposition.id, contentHash(proposition), [assertion]);
  await canonical.putClaim({ id: "report", subject: "note", predicate: "reports", object: scene.content, epistemicType: "character-claim", evidence: source.evidence(scene.content) });
  const attribution = attributionSchema.parse({ id: "reported", propositionId: proposition.id, holderKind: "document", holderEntityId: "note", attitude: "reports", certainty: 1, quotationIds: [quotation.id], evidence: source.evidence(scene.utterance) });
  const event = canonicalEventSchema.parse({ id: "reading", title: "Reading", participants: ["reader", "note"], participantPresence: [{ entityId: "reader", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], causalParents: [], confidence: 1, evidence: source.evidence(scene.text), observedOutcome: { version: 1, operations: [] },
    observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "reader", claimId: "report", propositionId: proposition.id, attributionId: attribution.id, acquisitionMode: "read", status: "believes", confidence: 1 }] } });
  const envelope = <T extends typeof attribution | typeof event>(id: string, kind: string, payload: T) => ({ id, kind, schemaVersion: 1, payload, evidence: payload.evidence, generatedBy: { worker: "downstream-fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await proposals.writePending(envelope("reported-proposal", "attribution", attribution), attributionSchema);
  await proposals.writePending(envelope("reading-proposal", "canonical-event", event), canonicalEventSchema);
  const originalDrafts = await Promise.all(["reported-proposal", "reading-proposal"].map(id => proposals.readEnvelope("pending", id)));
  const blocked = await convergeWorldProposals(root, sourceId);
  expect(blocked.canonical.accepted).toEqual([]);
  expect(JSON.stringify(blocked.canonical.blocked)).toContain("INVALID_ATTRIBUTION_TRACE");
  expect((await settleSourceRequirements(root, sourceId)).results[0]!.requirements.some(item => item.state !== "satisfied")).toBe(true);

  const planned = await planUpstreamRepair(root, { version: 1, sourceId, sourceSha256: source.source.contentSha256, planId: "complete-quote", batchId: "upstream-quote",
    requirementSetHash: definition.revisionHash, requirementIds: before.requirements.map(item => item.id), predecessorReceiptRefs: [], segmentIds: [source.segmentId], citableEvidenceRefs: [source.segmentId], authorizationRef: "host-complete-utterance-review", retryBudgetRef: "original-budget",
    diagnostics: before.requirements.map(item => ({ code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: quotation.id, revisionHash: contentHash(quotation), expectedAnchor: anchor(scene.utterance), requirementId: item.id })) });
  const plan = planned.plan!, ledger = new UpstreamRepairLedger(root, sourceId);
  await ledger.register(plan); await ledger.authorize(plan.planHash);
  await stageUpstreamRepair(root, sourceId, plan.planHash, { kind: "quotation", id: quotation.id }, { proposal_id: "complete-quote", annotation_id: quotation.id,
    selector: { segment_id: source.segmentId, exact: scene.complete ? scene.utterance : scene.short }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  await prepareUpstreamRepairFinish(root, sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: source.segmentId, disposition: "proposed", summary: "Reviewed complete utterance" }], summary: "Original scoped quotation extension" });
  await executeUpstreamRepairFinish(root, sourceId, plan.planHash);
  expect((await ledger.inspect()).plans[0]!.state).toBe("finished");
  const repaired = quotationSchema.parse(await annotations.read(sourceId, quotation.id));
  expect({ ...repaired, anchor: quotation.anchor, derivation: quotation.derivation }).toEqual(quotation);
  await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(scene.reader), participantPresence: [{ entityId: "reader", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "reader", field: "character.alive", value: true }] } });
  await new CompilerBatchStore(root).replaceCompleted(sourceId, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const converged = await convergeWorldProposals(root, sourceId);
  if (!scene.complete) {
    expect(converged.canonical.accepted).toEqual([]);
    expect(JSON.stringify(converged.canonical.blocked)).toContain("INVALID_ATTRIBUTION_TRACE");
    expect(await Promise.all(["reported-proposal", "reading-proposal"].map(id => proposals.readEnvelope("pending", id)))).toEqual(originalDrafts);
    const stillBlocked = (await settleSourceRequirements(root, sourceId)).results[0]!;
    expect(stillBlocked.requirements.map(item => item.id)).toEqual(before.requirements.map(item => item.id));
    expect(stillBlocked.requirements.some(item => item.state !== "satisfied")).toBe(true);
    await expect(settleUpstreamRepairRequirements(root, sourceId)).rejects.toThrow("source proposal(s) are still pending");
    expect((await ledger.inspect()).plans[0]!.state).toBe("finished");
    expect((await ledger.history()).some(record => record.payload.kind === "evaluated")).toBe(false);
    return;
  }
  expect(converged.canonical.blocked).toEqual([]);
  expect(converged.canonical.accepted.map(item => item.id).sort()).toEqual(["reading-proposal", "reported-proposal"]);
  expect(await Promise.all(["reported-proposal", "reading-proposal"].map(id => proposals.readEnvelope("accepted", id)))).toEqual(originalDrafts);
  const settled = (await settleSourceRequirements(root, sourceId)).results[0]!;
  expect(settled.requirements.map(item => item.id)).toEqual(before.requirements.map(item => item.id));
  expect(settled.requirements.every(item => item.state === "satisfied")).toBe(true);
  const evaluation = await settleUpstreamRepairRequirements(root, sourceId);
  expect(evaluation.issues).toEqual([]);
  expect(evaluation.results[0]!.result.requirements.every(item => item.state === "satisfied")).toBe(true);
  expect((await ledger.inspect()).plans[0]!.state).toBe("evaluated");
});

const spokenScenes = [
  { text: 'Ari tells Wen, who is waiting for news, "The cellar is flooded." Fenn watches a bird.', speaker: "Ari", listener: "Wen", content: "The cellar is flooded." },
  { text: 'Dax counts stones. "The north stair is unsafe," Lio tells Mira, who is waiting for news.', speaker: "Lio", listener: "Mira", content: "The north stair is unsafe" },
];
it.each(spokenScenes.flatMap(scene => [true, false].map(resolve => ({ ...scene, resolve }))))("requires downstream identity after missing mention repair: $listener / resolved=$resolve", async scene => {
  const { createCompilerProposalToolset } = await import("../src/compiler/proposal-tools.js");
  const { discoverUpstreamRepairDiagnostics } = await import("../src/compiler/upstream-repair-discovery.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-missing-mention-acceptance-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), sourceId = source.source.id, bytes = Buffer.from(scene.text);
  const anchor = (quote: string) => { const start = bytes.indexOf(Buffer.from(quote)); return textAnchorForByteRange(sourceId, bytes, start, start + Buffer.byteLength(quote)); };
  const definition = await registerSourceRequirements(root, { sourceId, id: "heard-report", scopeDecisionRef: "independent-listener-cut", spec: {
    version: 1, sourceId, sourceSha256: source.source.contentSha256,
    review: { method: "independent-source-review", reviewer: "acceptance-fixture-author", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "original-hearing-cut" },
    cases: [{ id: "hearing", kind: "knowledge-cut", scene: "Hearing the warning", rationale: "Only the addressed listener receives the warning", evidence: [anchor(scene.text)],
      actorId: "listener", acquisitionEventId: "hearing", claimId: "warning", contentExpectation: scene.content,
      beforeEventIds: [], afterEventIds: ["hearing"], expectedBefore: false, expectedAfter: true, expectedStatus: "believes" }],
  } });
  const before = (await settleSourceRequirements(root, sourceId)).results[0]!;
  const canonical = new CanonicalModelStore(root), proposals = new ProposalStore(root), annotations = new SourceAnnotationStore(root);
  for (const [id, name] of [["speaker", scene.speaker], ["listener", scene.listener]]) await canonical.putEntity({ id: id!, kind: "character", canonicalName: name!, aliases: [], evidence: source.evidence(name!) });
  const tools = async (batch: string) => {
    const set = createCompilerProposalToolset(root); await set.beginBatch([], batch, sourceId);
    return (name: string, input: unknown) => set.tools.find(item => item.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  };
  const setup = await tools("listener-identity");
  await setup("propose_entity_mention", { proposal_id: "listener-mention", annotation_id: "listener-mention", selector: { segment_id: source.segmentId, exact: scene.listener }, surface: scene.listener, form: "proper", kind_candidates: ["character"], confidence: 1 });
  await setup("propose_entity_resolution", { proposal_id: "listener-resolution", resolution_id: "listener-resolution", mention_id: "listener-mention", status: "resolved", entity_id: "listener",
    candidates: [{ entity_id: "listener", confidence: 1, basis_mention_ids: ["listener-mention"], evidence_assertion_ids: [], rationale: "Explicit named listener" }], rationale: "Original source identity" });
  await setup("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Original listener identity" });
  const quotation = quotationSchema.parse({ version: 1, id: "spoken-quote", sourceId, annotationType: "quotation", anchor: anchor(scene.content), mode: "direct", speakerMentionId: "missing-speaker", addresseeMentionIds: ["listener-mention"], attributionConfidence: 1,
    derivation: { runId: "original", worker: "fixture", ontologyVersion: "observation-v1" } });
  await annotations.stage(sourceId, { version: 1, id: "original-quote", annotationType: "quotation", payload: quotation, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await annotations.commitProposals(sourceId, ["original-quote"]);
  const proposition = propositionSchema.parse({ id: "warning-content", subjectEntityId: "speaker", relationId: "warns", object: { kind: "literal", value: scene.content }, polarity: "positive", modality: "asserted", evidence: source.evidence(scene.content) });
  await canonical.putProposition(proposition);
  const assertion = evidenceAssertionSchema.parse({ version: 1, id: "warning-content-evidence", target: { artifactKind: "proposition", artifactId: proposition.id, jsonPointer: "/object/value" }, anchors: [anchor(scene.content)], relation: "supports", strength: "explicit", derivation: { runId: "source-review", worker: "fixture", ontologyVersion: "evidence-v1" } });
  await new EvidenceAssertionStore(root).replaceForArtifact("proposition", proposition.id, contentHash(proposition), [assertion]);
  await canonical.putClaim({ id: "warning", subject: "speaker", predicate: "warns", object: scene.content, epistemicType: "character-claim", speaker: "speaker", evidence: source.evidence(scene.content) });
  const attribution = attributionSchema.parse({ id: "warning-attribution", propositionId: proposition.id, holderKind: "character", holderEntityId: "speaker", attitude: "asserts", certainty: 1, quotationIds: [quotation.id], evidence: source.evidence(scene.text) });
  const event = canonicalEventSchema.parse({ id: "hearing", title: "Hearing", participants: ["speaker", "listener"], participantPresence: [{ entityId: "speaker", mode: "physical" }, { entityId: "listener", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], causalParents: [], confidence: 1, evidence: source.evidence(scene.text), observedOutcome: { version: 1, operations: [] },
    observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "listener", claimId: "warning", propositionId: proposition.id, attributionId: attribution.id, acquisitionMode: "told", sourceActorId: "speaker", status: "believes", confidence: 1 }] } });
  const envelope = <T extends typeof attribution | typeof event>(id: string, kind: string, payload: T) => ({ id, kind, schemaVersion: 1, payload, evidence: payload.evidence, generatedBy: { worker: "downstream-fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await proposals.writePending(envelope("warning-proposal", "attribution", attribution), attributionSchema);
  await proposals.writePending(envelope("hearing-proposal", "canonical-event", event), canonicalEventSchema);
  const draftIds = ["warning-proposal", "hearing-proposal"], originalDrafts = await Promise.all(draftIds.map(id => proposals.readEnvelope("pending", id)));
  const blocked = await convergeWorldProposals(root, sourceId);
  expect(blocked.canonical.accepted).toEqual([]);
  expect(JSON.stringify(blocked.canonical.blocked)).toContain("speaker mention 'missing-speaker' is not resolved");
  const discovery = await discoverUpstreamRepairDiagnostics(root, sourceId);
  const finding = discovery.findings.find(item => item.diagnostic.code === "QUOTATION_SPEAKER_MENTION_MISSING")!;
  expect(finding).toBeDefined();
  const planned = await planUpstreamRepair(root, { version: 1, sourceId, sourceSha256: source.source.contentSha256, planId: "missing-speaker-plan", batchId: "repair-speaker",
    requirementSetHash: definition.revisionHash, requirementIds: before.requirements.map(item => item.id), predecessorReceiptRefs: [], segmentIds: [source.segmentId], citableEvidenceRefs: [source.segmentId], authorizationRef: "host-missing-speaker-review", retryBudgetRef: "original-budget",
    diagnostics: before.requirements.map(item => ({ ...finding.diagnostic, requirementId: item.id })) });
  const plan = planned.plan!, ledger = new UpstreamRepairLedger(root, sourceId);
  expect(plan.allowedWrites).toEqual([]);
  expect(plan.allowedCreations.map(item => [item.kind, item.id])).toEqual([["entity-mention", "missing-speaker"]]);
  await ledger.register(plan); await ledger.authorize(plan.planHash);
  await stageUpstreamRepair(root, sourceId, plan.planHash, { kind: "entity-mention", id: "missing-speaker" }, { proposal_id: "source-speaker", annotation_id: "missing-speaker", selector: { segment_id: source.segmentId, exact: scene.speaker }, surface: scene.speaker, form: "proper", kind_candidates: ["character"], confidence: 1 });
  await prepareUpstreamRepairFinish(root, sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: source.segmentId, disposition: "proposed", summary: "Reviewed named speaker mention" }], summary: "Original missing mention repair" });
  await executeUpstreamRepairFinish(root, sourceId, plan.planHash);
  expect(await annotations.read(sourceId, quotation.id)).toEqual(quotation);
  expect((await convergeWorldProposals(root, sourceId)).canonical.accepted).toEqual([]);
  expect((await settleSourceRequirements(root, sourceId)).results[0]!.requirements.some(item => item.state !== "satisfied")).toBe(true);
  // The normal downstream identity phase remains necessary; the repair grants no identity by itself.
  const resolve = await tools("speaker-identity");
  await resolve("propose_entity_resolution", { proposal_id: "speaker-resolution", resolution_id: "speaker-resolution", mention_id: "missing-speaker", status: scene.resolve ? "resolved" : "unresolved",
    ...(scene.resolve ? { entity_id: "speaker" } : {}), candidates: scene.resolve ? [{ entity_id: "speaker", confidence: 1, basis_mention_ids: ["missing-speaker"], evidence_assertion_ids: [], rationale: "Explicit named speaker" }] : [], rationale: scene.resolve ? "Independent source identity" : "No identity conclusion submitted" });
  await resolve("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Original downstream identity result" });
  await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(scene.text), participantPresence: [{ entityId: "listener", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "listener", field: "character.alive", value: true }, { op: "set", entityId: "listener", field: "character.plan", value: "wait for news" }] } });
  await new CompilerBatchStore(root).replaceCompleted(sourceId, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const converged = await convergeWorldProposals(root, sourceId);
  if (!scene.resolve) {
    expect(converged.canonical.accepted).toEqual([]);
    expect(JSON.stringify(converged.canonical.blocked)).toContain("speaker mention 'missing-speaker' is not resolved");
    expect(await Promise.all(draftIds.map(id => proposals.readEnvelope("pending", id)))).toEqual(originalDrafts);
    const unresolved = (await settleSourceRequirements(root, sourceId)).results[0]!;
    expect(unresolved.requirements.map(item => item.id)).toEqual(before.requirements.map(item => item.id));
    expect(unresolved.requirements.some(item => item.state !== "satisfied")).toBe(true);
    await expect(settleUpstreamRepairRequirements(root, sourceId)).rejects.toThrow("source proposal(s) are still pending");
    expect((await ledger.inspect()).plans[0]!.state).toBe("finished");
    return;
  }
  expect(converged.canonical.blocked).toEqual([]);
  expect(converged.canonical.accepted.map(item => item.id).sort()).toEqual(draftIds.slice().sort());
  expect(await Promise.all(draftIds.map(id => proposals.readEnvelope("accepted", id)))).toEqual(originalDrafts);
  const evaluation = await settleUpstreamRepairRequirements(root, sourceId);
  expect(evaluation.issues).toEqual([]);
  expect(evaluation.results[0]!.result.requirements.map(item => item.id).sort()).toEqual(before.requirements.map(item => item.id).sort());
  expect(evaluation.results[0]!.result.requirements.every(item => item.state === "satisfied")).toBe(true);
  expect((await ledger.inspect()).plans[0]!.state).toBe("evaluated");
});
