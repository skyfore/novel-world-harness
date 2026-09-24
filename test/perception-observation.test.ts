import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { repairForEvent } from "./helpers/upstream-repair.js";
import { deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema, propositionSchema } from "../src/world/model.js";
import { contentHash } from "../src/world/canonical.js";
import { SourceAnnotationStore, entityMentionSchema, eventMentionSchema, quotationSchema } from "../src/compiler/annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "../src/compiler/entity-resolution.js";
import { EventResolutionStore, eventResolutionSchema } from "../src/compiler/event-resolution.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { perceptionObservationSchema, validatePerceptionObservation } from "../src/world/perception-observation.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const scenes = [
  { actor: "Ada", place: "gate", trigger: "sees", sentence: "At the gate, Ada sees the gate close.", report: "Bo later reports that the gate closed." },
  { actor: "宁", place: "码头", trigger: "看见", sentence: "宁站在码头，看见码头关闭。", report: "维后来转述码头已经关闭。" },
];
async function setup(scene: typeof scenes[number]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-perception-")); roots.push(root);
  const text = `${scene.sentence}\n${scene.report}`, source = await createEvidenceFixture(root, text), canon = new CanonicalModelStore(root);
  const bytes = Buffer.from(text), anchor = (text: string) => { const start = bytes.indexOf(Buffer.from(text)); return textAnchorForByteRange(source.source.id, bytes, start, start + Buffer.byteLength(text)); };
  for (const [id, kind, canonicalName] of [["observer", "character", scene.actor], ["site", "location", scene.place]] as const) await canon.putEntity({ id, kind, canonicalName, aliases: [], evidence: source.evidence(canonicalName) });
  const derivation = { runId: "test", worker: "test", ontologyVersion: "observation-v1" } as const;
  const mention = entityMentionSchema.parse({ version: 1, id: "observer-mention", sourceId: source.source.id, derivation, annotationType: "entity-mention", anchor: anchor(scene.actor), surface: scene.actor, form: "proper", kindCandidates: ["character"], confidence: 1 });
  const perception = eventMentionSchema.parse({ version: 1, id: "perception-mention", sourceId: source.source.id, derivation, annotationType: "event-mention", trigger: scene.trigger, triggerAnchor: anchor(scene.trigger), extentAnchors: [anchor(scene.sentence)], eventTypeCandidates: ["perception"], participantMentionIds: [mention.id], salience: "major", confidence: 1 });
  await new SourceAnnotationStore(root).replaceCurrent(source.source.id, [mention, perception]);
  const identity = identityResolutionSchema.parse({ version: 1, id: "observer-resolution", sourceId: source.source.id, mentionId: mention.id, status: "resolved", entityId: "observer", candidates: [{ entityId: "observer", confidence: 1, basisMentionIds: [mention.id], evidenceAssertionIds: [], rationale: "Explicit observer" }], rationale: "Explicit observer", derivation: { runId: "test", worker: "test", ontologyVersion: "entity-resolution-v1" } });
  await new EntityResolutionStore(root).replaceCurrent(source.source.id, [identity]);
  const resolution = eventResolutionSchema.parse({ version: 1, id: "perception-resolution", sourceId: source.source.id, eventMentionIds: [perception.id], status: "resolved", canonicalEventId: "close", relation: "coreference", candidates: [{ canonicalEventId: "close", relation: "coreference", confidence: 1, basisEventMentionIds: [perception.id], evidenceAssertionIds: [], rationale: "Explicit occurrence" }], supersedesResolutionIds: [], rationale: "Explicit occurrence", derivation: { runId: "test", worker: "test", ontologyVersion: "event-resolution-v1" } });
  await new EventResolutionStore(root).replaceCurrent(source.source.id, [resolution]);
  const event = canonicalEventSchema.parse({ id: "close", title: "The observer sees the closure", participants: ["observer", "site"], participantPresence: [{ entityId: "observer", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "set", entityId: "site", field: "location.open", value: false }] }, causalParents: [], confidence: 1, evidence: source.evidence(scene.sentence) });
  await canon.putEvent(event);
  const proposition = propositionSchema.parse({ id: "closed", subjectEntityId: "site", relationId: "location.open", object: { kind: "literal", value: false }, polarity: "positive", modality: "asserted", evidence: source.evidence(scene.sentence) });
  await canon.putProposition(proposition);
  await canon.putClaim({ id: "closed-claim", subject: "site", predicate: "location.open", object: false, epistemicType: "explicit-fact", evidence: source.evidence(scene.sentence) });
  const payload = { ontologyVersion: "perception-observation-v1", id: "perception", observerId: "observer", canonicalEventId: event.id, cut: "event-end", channel: "vision", phenomenon: { kind: "state-value", entityId: "site", field: "location.open", value: false }, access: { locationId: "site", conditions: [{ op: "fact-equals", entityId: "observer", field: "character.location", value: "site" }] }, lowering: { status: "mapped", mechanism: "direct-vision-v1" }, trace: { observerMentionId: mention.id, eventMentionId: perception.id } };
  const paths = ["/observerId", "/canonicalEventId", "/cut", "/channel", "/access/locationId", "/access/conditions/0", "/phenomenon/entityId", "/phenomenon/field", "/phenomenon/value"];
  const input = { proposal_id: "perception-proposal", payload, evidence_segment_ids: [source.segmentId], evidence_selectors: paths.map(target_path => ({ segment_id: source.segmentId, exact: scene.sentence, target_path, relation: "supports", strength: "explicit" })) };
  const operation = { op: "learn", actorId: "observer", claimId: "closed-claim", propositionId: "closed", acquisitionMode: "observed", perceptionId: "perception", status: "knows", confidence: 1 } as const;
  const initial = { version: 1 as const, operations: [{ op: "set" as const, entityId: "observer", field: "character.alive", value: true }, { op: "set" as const, entityId: "observer", field: "character.location", value: "site" }, { op: "set" as const, entityId: "site", field: "location.open", value: true }] };
  return { root, source, canon, anchor, mention, perception, resolution, event, payload, input, operation, initial };
}

it.each(scenes.flatMap(scene => [false, true].map(repair => ({ ...scene, repair }))))("repair=$repair grounds perception across compile, rebuild and runtime cut: $actor", async scene => {
  const { root, source, canon, perception, input, operation: legacyOperation, initial, event, resolution } = await setup(scene);
  const operation = scene.repair ? { ...legacyOperation, acquisitionId: "seen-closure", status: "believes" as const } : legacyOperation;
  if (scene.repair) {
    const prior = eventResolutionSchema.parse({ ...resolution, status: "unresolved", canonicalEventId: undefined, relation: undefined, candidates: [] });
    await new EventResolutionStore(root).replaceCurrent(source.source.id, [prior]);
    await repairForEvent({ root, sourceId: source.source.id, sourceSha256: source.source.contentSha256, segmentId: source.segmentId, bytes: Buffer.from(`${scene.sentence}\n${scene.report}`), event,
      diagnostic: { code: "EVENT_RESOLUTION_REVISION", mentionId: perception.id, revisionHash: contentHash(perception), resolutionId: prior.id, resolutionHash: contentHash(prior), candidates: [{ id: event.id, revisionHash: contentHash(event) }] },
      proposal: slot => ({ proposal_id: "repair-perception-resolution", resolution_id: slot.id, event_mention_ids: [perception.id], status: "resolved", canonical_event_id: event.id, relation: "coreference",
        candidates: [{ canonical_event_id: event.id, relation: "coreference", confidence: 1, basis_event_mention_ids: [perception.id], evidence_assertion_ids: [], rationale: "Original explicit perception" }], supersedes_resolution_ids: [prior.id], rationale: "Reviewed original occurrence" }) });
  }
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "sense", source.source.id);
  const propose = toolset.tools.find(item => item.name === "propose_perception_observation")!;
  await expect(propose.execute("missing", { ...input, evidence_selectors: input.evidence_selectors.slice(1) } as never, undefined, undefined, {} as never)).rejects.toThrow("PERCEPTION_EVIDENCE_MISSING");
  await propose.execute("grounded", input as never, undefined, undefined, {} as never);
  if (scene.repair) {
    const fields = ["/actorId", "/canonicalEventId", "/cut", "/claimId", "/propositionId", "/basis/mode", "/basis/perceptionId", "/reception/received", "/reception/understood", "/reception/belief"];
    await toolset.tools.find(item => item.name === "propose_acquisition")!.execute("acquire", { proposal_id: "seen-closure", payload: { ontologyVersion: "acquisition-v1", id: "seen-closure", actorId: "observer", canonicalEventId: event.id, cut: "event-end", claimId: "closed-claim", propositionId: "closed", basis: { mode: "observed", perceptionId: "perception" }, reception: { received: true, understood: true, belief: "accepted" } }, evidence_segment_ids: [source.segmentId], evidence_selectors: fields.map(target_path => ({ segment_id: source.segmentId, exact: scene.sentence, target_path, relation: "supports", strength: "explicit" })) } as never, undefined, undefined, {} as never);
  }
  await toolset.tools.find(item => item.name === "finish_compiler_batch")!.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "One directly grounded perception" } as never, undefined, undefined, {} as never);
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const observation = (await canon.listPerceptionObservations())[0]!;
  expect(observation.trace.eventMentionHash).toBe(contentHash(perception));
  await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(scene.sentence), delta: initial, participantPresence: event.participantPresence });
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot);
  const bundle = await cache.candidateSnapshot(source.source), archived = await cache.archiveCandidate(source.source);
  expect(buildPreparedClosure(bundle).nodes.find(item => item.kind === "perception-observation")?.dependsOn).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "event", id: event.id }), expect.objectContaining({ kind: "annotation", id: perception.id })]));
  const stale = structuredClone(bundle);
  stale.compilerSnapshot.annotations = stale.compilerSnapshot.annotations.map(item => item.id === perception.id ? { ...perception, eventTypeCandidates: ["communication"] } : item);
  expect(buildPreparedClosure(stale).issues.some(item => item.code === "CLOSURE_REVISION_MISMATCH")).toBe(true);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-perception-clone-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, `${scene.sentence}\n${scene.report}`);
  await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(cloneSource.source, archived.bundleHash!);
  const contextStore = new WorldContextStore(cloneRoot), context = await contextStore.captureCurrent(cloneSource.source.id), engine = new WorldEngine(cloneRoot, context);
  const head = await engine.createBranch("main", "Before closing", initial, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
  const equalOutcome = { ...initial, operations: initial.operations.map(item => item.field === "location.open" ? { ...item, value: false } : item) };
  await expect(engine.createBranch("equal-state", "State does not prove perception", equalOutcome, { version: 1, operations: [operation] })).rejects.toThrow(scene.repair ? "ACQUISITION_CUT_NOT_CURRENT" : "PERCEPTION_CUT_NOT_CURRENT");
  const runtime = new WorldRuntime(engine, () => []); await runtime.forkBranch("main", head, "unchanged", "Before perception");
  const unlocated = await engine.createBranch("unlocated", "Observer location unresolved", { ...initial, operations: initial.operations.filter(item => item.field !== "character.location") }, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
  await runtime.forkBranch("unlocated", unlocated, "absent", "Unresolved access fork");
  const proposal = { proposalId: "see", branchId: "main", expectedParentCommit: head, source: "canon-candidate", title: "See the gate close", participants: event.participants, participantPresence: event.participantPresence, possibilityId: "canon-close", preconditions: [], proposedTime: { kind: "unknown" }, proposedDelta: event.observedOutcome, proposedKnowledge: { version: 1, operations: [operation] }, causalParents: [], evidence: [] };
  const { perceptionId: _deleted, ...relabeled } = operation;
  expect((await engine.commitProposal({ ...proposal, proposedKnowledge: { version: 1, operations: [relabeled] } } as never)).report.errors.some(item => item.code === "PERCEPTION_REQUIRED")).toBe(true);
  expect((await engine.commitProposal({ ...proposal, branchId: "absent", expectedParentCommit: unlocated } as never)).report.errors.some(item => item.code === "PERCEPTION_ACCESS_NOT_PROVEN")).toBe(true);
  const accepted = await engine.commitProposal(proposal as never);
  expect(accepted.report.errors).toEqual([]);
  expect((await engine.projections.project(accepted.newHead, { fresh: true, useCheckpoints: false })).knowledge.actors.observer?.["closed-claim"]).toMatchObject({ perceptionId: observation.id, status: scene.repair ? "believes" : "knows" });
  expect((await engine.projections.project(head, { fresh: true, useCheckpoints: false })).knowledge.actors.observer?.["closed-claim"]).toBeUndefined();
  expect((await engine.commitProposal({ ...proposal, expectedParentCommit: accepted.newHead, possibilityId: undefined } as never)).report.errors.some(item => ["PERCEPTION_CUT_NOT_CURRENT", "ACQUISITION_CUT_NOT_CURRENT"].includes(item.code))).toBe(true);
  const bindings = new EvidenceAssertionStore(root);
  await bindings.replaceForArtifact("perception-observation", observation.id, contentHash(observation), []);
  await expect(cache.candidateSnapshot(source.source)).rejects.toThrow("Perception observation evidence");
  if (scene.repair) {
    const repair = (await new UpstreamRepairLedger(root, source.source.id).inspect()).plans[0]!;
    expect(repair.plan.requirementIds).toEqual(["occurrence:state-effect"]);
    expect(repair.evaluation).toBeUndefined(); // A source fix cannot certify an unfreezable downstream candidate.
  }
  expect((await contextStore.load(context.canonicalSnapshotHash!)).perceptionObservations?.get(observation.id)).toEqual(observation);
});

it.each(scenes)("rejects relabeled reports and preserves frozen identity/occurrence proof: $actor", async scene => {
  const { validatePerceptionObservationTrace, hydratePerceptionObservationInput, loadPerceptionTraceCatalog } = await import("../src/compiler/perception-observation-trace.js");
  const { root, source, canon, anchor, perception, event, payload, input, operation } = await setup(scene);
  const observation = hydratePerceptionObservationInput(payload, source.evidence(scene.sentence), await loadPerceptionTraceCatalog(root, source.source.id));
  const catalog = { entities: new Map((await canon.listEntities()).map(item => [item.id, item])), events: new Map((await canon.listEvents()).map(item => [item.id, item])) };
  expect(await validatePerceptionObservationTrace(root, observation)).toEqual([]);
  expect(validatePerceptionObservation({ ...observation, channel: "hearing" }, catalog).some(item => item.code === "PERCEPTION_MECHANISM_UNSUPPORTED")).toBe(true);
  expect(validatePerceptionObservation(observation, { ...catalog, events: new Map([[event.id, { ...event, participantPresence: [{ entityId: "observer", mode: "represented" }] }]]) }).some(item => item.code === "PERCEPTION_ACCESS_UNSUPPORTED")).toBe(true);
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "report-relabel", source.source.id);
  const { evidence: _source, ...eventPayload } = event, { perceptionId: _proof, ...relabeled } = operation;
  await expect(toolset.tools.find(item => item.name === "propose_canonical_event")!.execute("observed", { proposal_id: "unproved", payload: { ...eventPayload, observedKnowledge: { version: 1, operations: [relabeled] } }, evidence_segment_ids: [source.segmentId] } as never, undefined, undefined, {} as never)).rejects.toThrow("PERCEPTION_REQUIRED");
  expect(await canon.getEvent(event.id)).toEqual(event);
  const lateEvent = { ...event, id: "report", evidence: source.evidence(scene.report) };
  const late = { ...observation, canonicalEventId: lateEvent.id };
  expect(validatePerceptionObservation(late, { ...catalog, events: new Map([[lateEvent.id, lateEvent]]) }).some(item => item.code === "PERCEPTION_OCCURRENCE_MISMATCH")).toBe(true);
  expect((await validatePerceptionObservationTrace(root, late)).some(item => item.code === "PERCEPTION_EVENT_TRACE_MISMATCH")).toBe(true);
  const annotations = new SourceAnnotationStore(root);
  const quotation = quotationSchema.parse({ version: 1, id: "report-quote", sourceId: source.source.id, derivation: { runId: "test", worker: "test", ontologyVersion: "observation-v1" }, annotationType: "quotation", anchor: anchor(scene.sentence), mode: "indirect", speakerMentionId: "observer-mention", addresseeMentionIds: [], attributionConfidence: 1, interpretation: "This occurrence is quoted as a later report, not directly witnessed" });
  await annotations.replaceCurrent(source.source.id, [...await annotations.list(source.source.id), quotation]);
  expect((await validatePerceptionObservationTrace(root, observation)).some(item => item.code === "PERCEPTION_QUOTED_REPORT")).toBe(true);
  const quoted = createCompilerProposalToolset(root); await quoted.beginBatch([], "quoted-report", source.source.id);
  await quoted.tools.find(item => item.name === "propose_perception_observation")!.execute("report", input as never, undefined, undefined, {} as never);
  await expect(quoted.tools.find(item => item.name === "finish_compiler_batch")!.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "A report is not direct perception" } as never, undefined, undefined, {} as never)).rejects.toThrow("PERCEPTION_QUOTED_REPORT");
  expect(await canon.listPerceptionObservations()).toEqual([]);
  await annotations.replaceCurrent(source.source.id, (await annotations.list(source.source.id)).filter(item => item.id !== quotation.id).map(item => item.id === perception.id ? { ...perception, eventTypeCandidates: ["communication"] } : item));
  expect((await validatePerceptionObservationTrace(root, observation)).some(item => item.code === "PERCEPTION_TRACE_REVISION_MISMATCH")).toBe(true);
});

it.each(scenes)("retains unsupported sensory meaning without granting observed knowledge: $actor", async scene => {
  const { validatePerceptionAcquisition } = await import("../src/world/perception-observation.js");
  const { root, source, canon, input, operation } = await setup(scene);
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "unmapped-sense", source.source.id);
  const payload = { ...input.payload, phenomenon: { kind: "sensory-phenomenon", description: scene.sentence }, lowering: { status: "unmapped", reason: "unsupported-phenomenon" } };
  const evidence_selectors = [...input.evidence_selectors.filter(item => !item.target_path.startsWith("/phenomenon/")), { segment_id: source.segmentId, exact: scene.sentence, target_path: "/phenomenon/description", relation: "supports", strength: "explicit" }];
  await toolset.tools.find(item => item.name === "propose_perception_observation")!.execute("retain", { ...input, payload, evidence_selectors } as never, undefined, undefined, {} as never);
  await toolset.tools.find(item => item.name === "finish_compiler_batch")!.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "Source perception retained without executable meaning" } as never, undefined, undefined, {} as never);
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const observation = (await canon.listPerceptionObservations())[0]!;
  expect(observation.lowering.status).toBe("unmapped");
  expect(validatePerceptionAcquisition(operation, { observations: new Map([[observation.id, observation]]), propositions: new Map((await canon.listPropositions()).map(item => [item.id, item])) }).some(item => item.code === "PERCEPTION_UNMAPPED")).toBe(true);
});
it.each(scenes)("consumes independently evidenced observed acquisition at its actual cut: $actor", async original => {
  const reopening = original.actor === "Ada" ? "Later the gate reopens." : "后来码头重新开放。";
  const scene = { ...original, sentence: `${original.sentence} ${original.actor} understands the closure and believes the observation.`, report: `${original.report} ${reopening}` };
  const { root, source, canon, event, input, operation, initial } = await setup(scene);
  await canon.putEvent({ ...event, readerSummary: scene.sentence, observedKnowledge: { version: 1, operations: [{ ...operation, acquisitionId: "saw-closure", status: "believes" }] } });
  const tools = createCompilerProposalToolset(root); await tools.beginBatch([], "observed-acquisition", source.source.id);
  const invoke = (name: string, payload: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, payload as never, undefined, undefined, {} as never);
  await invoke("propose_perception_observation", input);
  const payload = { ontologyVersion: "acquisition-v1", id: "saw-closure", actorId: "observer", canonicalEventId: event.id, cut: "event-end", claimId: "closed-claim", propositionId: "closed", basis: { mode: "observed", perceptionId: "perception" }, reception: { received: true, understood: true, belief: "accepted" } };
  const paths = ["/actorId", "/canonicalEventId", "/cut", "/claimId", "/propositionId", "/basis/mode", "/basis/perceptionId", "/reception/received", "/reception/understood", "/reception/belief"];
  await invoke("propose_acquisition", { proposal_id: "saw-closure", payload, evidence_segment_ids: [source.segmentId], evidence_selectors: paths.map(target_path => ({ segment_id: source.segmentId, exact: scene.sentence, target_path, relation: "supports", strength: "explicit" })) });
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Direct observation with separate reception" });
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const context = await new WorldContextStore(root).captureCurrent(source.source.id), engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Before closure", initial, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
  const learn = { ...operation, acquisitionId: payload.id, status: "believes" };
  const proposal = { proposalId: "see", branchId: "main", expectedParentCommit: head, source: "canon-candidate", title: "Observe the closure", participants: event.participants, participantPresence: event.participantPresence, possibilityId: "canon-close", preconditions: [], proposedTime: { kind: "unknown" }, proposedDelta: event.observedOutcome, proposedKnowledge: { version: 1, operations: [learn] }, causalParents: [], evidence: [] };
  const wrong = await engine.commitProposal({ ...proposal, possibilityId: undefined } as never);
  expect(wrong.report.errors.some(issue => issue.code === "ACQUISITION_CUT_NOT_CURRENT")).toBe(true);
  const committed = await engine.commitProposal(proposal as never); expect(committed.report.errors).toEqual([]);
  const replay = await engine.projections.project(committed.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.knowledge.acquisitions?.[payload.id]?.reception).toEqual(payload.reception);
  expect(replay.knowledge.actors.observer?.["closed-claim"]).toMatchObject({ acquisitionId: payload.id, perceptionId: "perception", status: "believes" });
  // Consumer cut fixture: a later world change must not re-run the old perception there.
  const reporter = original.actor === "Ada" ? "Bo" : "维";
  await canon.putEntity({ id: "reporter", kind: "character", canonicalName: reporter, aliases: [], evidence: source.evidence(reporter) });
  const reopen = canonicalEventSchema.parse({ ...event, id: "reopen", title: "The site reopens", evidence: source.evidence(reopening), readerSummary: "The world has changed after the observation", observedOutcome: { version: 1, operations: [{ op: "set", entityId: "site", field: "location.open", value: true }] } });
  const lateEvent = canonicalEventSchema.parse({ ...event, id: "late-entry", title: "After reopening", readerSummary: "The earlier observation remains a past experience", observedOutcome: { version: 1, operations: [] }, characterEntryCheckpoints: [{ actorId: "observer", readerSetup: "The earlier closure was witnessed", actorObservation: "I witnessed the closure", participantPresence: [{ entityId: "observer", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "observer", field: "character.location", value: "site" }] } }] });
  await canon.putEvent(reopen); await canon.putEvent(lateEvent);
  for (const [fromEventId, toEventId] of [[event.id, reopen.id], [reopen.id, lateEvent.id]]) await canon.putEventRelation({ id: `${fromEventId}-before-${toEventId}`, fromEventId: fromEventId!, toEventId: toEventId!, type: "before", operationality: "non-operational", status: "explicit", confidence: 1, evidence: source.evidence(scene.sentence) });
  await new InitialWorldStore(root).put({ version: 1, delta: initial, evidence: source.evidence(scene.sentence), participantPresence: [{ entityId: "reporter", mode: "physical" }], checkpoint: { mode: "chronological", rationale: "Before closure", beforeCanonicalEventId: event.id, storyTime: event.storyTime } });
  const lateContext = await new WorldContextStore(root).captureCurrent(source.source.id);
  const cutBundle = { source: { id: source.source.id }, canonical: { initialWorld: lateContext.initialWorld!, events: [...lateContext.events!.values()], entities: [...lateContext.entities.values()], eventRelations: lateContext.eventRelations, eventExecutions: [], semanticEffects: [], processTemplates: [], actionSchemas: [], rules: [], eventParticipations: [] } } as never;
  const lateSeed = deriveCharacterEntrySeed(cutBundle, "observer");
  const lateEngine = new WorldEngine(root, lateContext);
  const lateHead = await lateEngine.createBranch("historical-perception", "After reopening", lateSeed.delta, lateSeed.knowledge, undefined, undefined, [], {}, { projectionSeed: lateSeed.projectionSeed, realizesCanonicalEventIds: lateSeed.realizesCanonicalEventIds });
  const lateReplay = await lateEngine.projections.project(lateHead, { fresh: true, useCheckpoints: false });
  expect(lateReplay.state.values.site?.["location.open"]).toBe(true);
  expect(lateReplay.knowledge.acquisitions?.[payload.id]?.acquiredAtCommit).toBe(lateHead);
  expect(lateReplay.knowledge.actors.observer?.["closed-claim"]?.perceptionId).toBe("perception");
  const strippedSeed = structuredClone(lateSeed.projectionSeed!); delete strippedSeed.knowledgeHistory;
  await expect(lateEngine.createBranch("wrong-cut", "Old perception at current cut", lateSeed.delta, lateSeed.knowledge, undefined, undefined, [], {}, { projectionSeed: strippedSeed, realizesCanonicalEventIds: lateSeed.realizesCanonicalEventIds })).rejects.toThrow("PERCEPTION_ACCESS_NOT_PROVEN");

});
