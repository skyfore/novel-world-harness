import { hydrateAcquisition, acquisitionCatalog, validateAcquisitionOperation } from "../src/world/acquisition.js";
import { modelActorProposalSource } from "../src/world/model-actor-policy.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { respondToNpcInteractions } from "../src/world/npc-reaction.js";
import type { ActorDecisionView } from "../src/world/actor-decision-view.js";
import { PlayerTurnService, buildActorScopedActionContext, createPlayerActionModelBoundary, playerActionCandidateSchema } from "../src/world/player-action.js";
import { decisionContextRequirements } from "../src/agent/decision-context.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { canonicalEventSchema, propositionSchema, type EventProposal, type Entity } from "../src/world/model.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import { utteranceExpressionSchema } from "../src/world/utterance-expression.js";
import { contentHash } from "../src/world/canonical.js";
import { StateSchemaRegistry, DEFAULT_STATE_FIELDS } from "../src/world/state.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { mapActorOutcome } from "../src/world/actor-outcome.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scenes = [
  { quote: "The gate is shut.", text: "Mara leaves the note: The gate is shut. Eli reads the note through the terminal while the document remains in the archive." },
  { quote: "渡口已经关闭。", text: "岚在档案室留下便条：渡口已经关闭。远处的青通过终端阅读便条，原件仍在档案室。" },
];
async function fixture(scene: typeof scenes[number], configure?: (context: WorldModelContext) => void, written = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-text-channel-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), evidence = source.evidence(scene.text);
  const start = Buffer.byteLength(scene.text.slice(0, scene.text.indexOf(scene.quote)));
  const anchor = textAnchorForByteRange(source.source.id, Buffer.from(scene.text), start, start + Buffer.byteLength(scene.quote));
  const proposition = propositionSchema.parse({ id: "content", subjectEntityId: "gate", relationId: "is-shut", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted", evidence });
  const event = canonicalEventSchema.parse({ id: "writing", title: "Write note", readerSummary: "A note exists", participants: ["writer", "document", "reader"], participantPresence: [{ entityId: "writer", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence });
  const expression = utteranceExpressionSchema.parse({ ontologyVersion: "utterance-expression-v1", id: "expression", canonicalEventId: event.id, speakerId: "writer", addresseeIds: ["reader"], modality: "writing", documentId: "document", quotation: { quotationId: "quotation", revisionHash: contentHash(anchor), anchor }, fragments: [{ anchor, text: scene.quote }], propositionId: proposition.id, propositions: [{ propositionId: proposition.id, revisionHash: contentHash(proposition), snapshot: proposition }], evidence });
  const entities: Entity[] = [
    ...["writer", "reader", "outsider"].map(id => ({ id, kind: "character" as const, canonicalName: id, aliases: [], evidence })),
    ...["gate", "archive"].map(id => ({ id, kind: "location" as const, canonicalName: id, aliases: [], evidence })),
    ...["document", "terminal"].map(id => ({ id, kind: "artifact" as const, canonicalName: id, aliases: [], evidence })),
  ];
  entities.find(item => item.id === "reader")!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily", channels: [{ id: "screen", modality: "text", processTemplateId: "access", actorRoleId: "reader", peerRoleId: "document", carrierRoleId: "terminal", activePhaseIds: ["open"] }] };
  const process = processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "access", name: "Document access", ownerRoles: [
    { id: "reader", label: "Reader", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    ...["document", "terminal"].map(id => ({ id, label: id, allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 })),
  ], phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open", transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"], visibility: "public", induction: { kind: "domain-module", moduleId: "test-document-access", moduleVersion: "1" }, evidence: [] });
  const context: WorldModelContext = { sourceId: source.source.id, entities: new Map(entities.map(item => [item.id, item])), rules: new Map(), actorGoals: [], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), events: new Map([[event.id, event]]), propositions: new Map([[proposition.id, proposition]]), utteranceExpressions: new Map([[expression.id, expression]]),
    claims: new Map([["claim", { id: "claim", subject: "gate", predicate: "is-shut", object: true, epistemicType: "character-claim", evidence }]]),
    attributions: new Map([["report", { id: "report", propositionId: "content", holderKind: "document", holderEntityId: "document", attitude: "asserts", certainty: 1, quotationIds: ["quotation"], expressionIds: [expression.id], evidence }]]), processTemplates: new Map([[process.id, process]]) };
  configure?.(context);
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Document", { version: 1, operations: [
    { op: "set", entityId: "reader", field: "character.location", value: "gate" }, { op: "set", entityId: "document", field: "artifact.location", value: "archive" },
  ] }, undefined, source.source.id, undefined, evidence, {}, { realizesCanonicalEventIds: written ? [event.id] : [] });
  const base: EventProposal = { proposalId: "read", branchId: "main", expectedParentCommit: genesis, source: "background", title: "Read remote document", participants: ["reader", "document", "terminal"], participantPresence: [{ entityId: "reader", mode: "remote" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [] };
  const startProcess = { op: "start-process" as const, localRef: "local-access", process: { templateId: "access", ownerBindings: [{ roleId: "reader", entityIds: ["reader"] }, { roleId: "document", entityIds: ["document"] }, { roleId: "terminal", entityIds: ["terminal"] }], phaseId: "open", progress: 0 } };
  const opened = await engine.commitProposal({ ...base, proposalId: "open", proposedProcesses: { version: 1, operations: [startProcess] } });
  expect(opened.report.errors).toEqual([]);
  const session = Object.keys((await engine.projections.project(opened.newHead)).processes.instances)[0]!;
  const read: EventProposal = { ...base, expectedParentCommit: opened.newHead, proposedSemantics: { version: 1, operations: [{ op: "record-acquisition", localRef: "local-reading", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId: "reader", claimId: "claim", propositionId: "content", basis: { mode: "read", expressionId: "expression", attributionId: "report", documentId: "document", channelBinding: { channelId: "screen", processId: session } }, reception: { received: true, understood: true, belief: "accepted" } } }] },
    proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "reader", claimId: "claim", propositionId: "content", expressionId: "expression", attributionId: "report", acquisitionId: "local-reading", acquisitionMode: "read", status: "believes", confidence: 1 }] } };
  return { root, context, engine, genesis, opened, session, read, base, startProcess };
}

it.each(scenes)("reads an exact existing document over a pre-event text session: $quote", async scene => {
  const f = await fixture(scene);
  const preview = await f.engine.previewProposal(f.read);
  expect(preview.report.errors).toEqual([]);
  expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  const mapped = mapActorOutcome(f.read, id => `entity-${id}`, id => id.startsWith("local-") ? id : `ref-${id}`);
  expect(JSON.stringify(mapped)).toContain(`ref-${f.session}`);
  const received = await f.engine.commitProposal(f.read);
  expect(received.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(received.newHead, { fresh: true, useCheckpoints: false });
  expect(Object.values(replay.knowledge.acquisitions!)[0]).toMatchObject({ actorId: "reader", reception: { understood: true, belief: "accepted" } });
  expect(replay.state.values.document?.["artifact.location"]).toBe("archive");
  expect(replay.state.values.gate?.["location.open"]).toBeUndefined();
  expect(replay.knowledge.actors.outsider).toBeUndefined();
  expect(replay.history.at(-1)!.event.spokenUtterances).toBeUndefined();
});

it("rejects invalid remote document authority and same-event resume without changing head", async () => {
  const f = await fixture(scenes[0]!);
  for (const change of [
    (p: EventProposal) => { p.participants = p.participants.filter(id => id !== "terminal"); },
    (p: EventProposal) => { p.participantPresence = [{ entityId: "reader", mode: "represented" }]; },
    (p: EventProposal) => { const op = p.proposedSemantics!.operations[0]!; if (op.op === "record-acquisition" && op.acquisition.basis.mode === "read") op.acquisition.basis.channelBinding!.channelId = "foreign"; },
  ]) {
    const bad = structuredClone(f.read); change(bad);
    expect((await f.engine.commitProposal(bad)).report.accepted).toBe(false);
    expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  }
  const paused = await f.engine.commitProposal({ ...f.base, proposalId: "pause", expectedParentCommit: f.opened.newHead, proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const selfResumed = await f.engine.commitProposal({ ...f.read, expectedParentCommit: paused.newHead, proposedProcesses: { version: 1, operations: [{ op: "resume-process", processRef: f.session }] } });
  expect(selfResumed.report.errors.some(issue => issue.code === "BRANCH_TEXT_CHANNEL_UNPROVEN")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
});

it("stops text-channel authority failures for host repair", () => {
  expect(buildNwhToolRecoveryAdvice("propose_player_action", "BRANCH_TEXT_CHANNEL_UNPROVEN")).toMatchObject({ category: "host-repair-required", retryable: false });
});

it("does not treat audio, an undisclosed mechanism, or future writing as readable text", async () => {
  for (const kind of ["audio", "hidden", "future"] as const) {
    const f = await fixture(scenes[0]!, context => {
      if (kind === "audio") context.entities.get("reader")!.agencyProfile!.channels[0]!.modality = "audio";
      if (kind === "hidden") context.processTemplates!.get("access")!.visibility = "engine";
    }, kind !== "future");
    expect((await buildActorScopedActionContext(f.engine, "reader", f.opened.newHead)).decision?.readableTexts).toBeUndefined();
    const rejected = await f.engine.commitProposal(f.read);
    expect(rejected.report.accepted).toBe(false);
    expect(rejected.report.errors.some(issue => ["BRANCH_TEXT_CHANNEL_UNPROVEN", "BRANCH_ACQUISITION_DOCUMENT_UNAVAILABLE"].includes(issue.code))).toBe(true);
    expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  }
});

it("retains physical document location checks and never infers understanding or belief", async () => {
  const f = await fixture(scenes[1]!);
  const physical = structuredClone(f.read);
  physical.participantPresence = [{ entityId: "reader", mode: "physical" }];
  const record = physical.proposedSemantics!.operations[0]!;
  if (record.op === "record-acquisition" && record.acquisition.basis.mode === "read") {
    record.acquisition.basis.channelBinding = undefined; record.acquisition.basis.locationId = "gate";
  }
  expect((await f.engine.commitProposal(physical)).report.accepted).toBe(false);
  const moved = await f.engine.commitProposal({ ...f.base, expectedParentCommit: f.opened.newHead, proposalId: "deliver-document", participantPresence: [{ entityId: "reader", mode: "physical" }], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "document", field: "artifact.location", value: "gate" }] } });
  expect(moved.report.errors).toEqual([]);
  const received = await f.engine.commitProposal({ ...physical, expectedParentCommit: moved.newHead });
  expect(received.report.errors).toEqual([]);
  for (const understood of [false, true]) {
    const branchId = `reception-${understood}`;
    await f.engine.branches.create({ id: branchId, name: branchId, parentBranchId: "main", forkCommitId: f.opened.newHead, headCommitId: f.opened.newHead });
    const proposal = structuredClone(f.read); proposal.branchId = branchId;
    const operation = proposal.proposedSemantics!.operations[0]!;
    if (operation.op === "record-acquisition") operation.acquisition.reception = { received: true, understood, belief: understood ? "rejected" : "undecided" };
    const learning = proposal.proposedKnowledge!.operations[0]!;
    if (learning.op === "learn") learning.status = understood ? "disbelieves" : "heard";
    const result = await f.engine.commitProposal(proposal);
    expect(result.report.errors).toEqual([]);
    const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
    expect(Object.values(replay.knowledge.acquisitions!)[0]).toMatchObject({ reception: { understood, belief: understood ? "rejected" : "undecided" } });
    expect(replay.state.values.gate?.["location.open"]).toBeUndefined();
  }
});

it.each(scenes)("offers only accessible text and commits a scoped player reading: $quote", async scene => {
  const f = await fixture(scene);
  const context = await buildActorScopedActionContext(f.engine, "reader", f.opened.newHead);
  const text = context.decision!.readableTexts![0]!;
  expect(text.fragments).toEqual([scene.quote]);
  expect(context.knowledge).toEqual([]);
  expect(context.presentEntities.map(entity => entity.id)).not.toContain("writer");
  expect((await buildActorScopedActionContext(f.engine, "outsider", f.opened.newHead)).decision?.readableTexts).toBeUndefined();
  const candidate = readingCandidate("reader", text);
  const boundary = createPlayerActionModelBoundary(context);
  const encoded = boundary.encodeCandidate(candidate);
  expect(boundary.decodeCandidate(encoded)).toEqual(candidate);
  const encodedLearning = encoded.proposedKnowledge!.operations[0]!;
  expect(encodedLearning.op === "learn" && encodedLearning.expressionId).not.toBe(text.expressionId);
  expect(decisionContextRequirements({ ...boundary.context, intendedCandidate: encoded })?.dependencyEdges.some(edge => edge.reason === "candidate-text-receipt")).toBe(true);
  expect(() => decisionContextRequirements({ ...boundary.context, decision: { ...(boundary.context.decision as object), readableTexts: undefined }, intendedCandidate: encoded })).toThrow("dependency");
  const result = await new PlayerTurnService(f.engine, () => candidate, () => "You read the displayed note.").turn({ branchId: "main", actorId: "reader", utterance: "Read the terminal" });
  expect(result.issues).toEqual([]);
  expect(result.accepted).toBe(true);
  const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.participants).toEqual(expect.arrayContaining(["reader", "document", "terminal"]));
  expect(replay.history.at(-1)!.event.participantPresence).toEqual([{ entityId: "reader", mode: "remote" }]);
  expect(Object.values(replay.knowledge.acquisitions!)[0]!.actorId).toBe("reader");
  const paused = await f.engine.commitProposal({ ...f.base, proposalId: "close-after-reading", expectedParentCommit: result.newHead, proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  expect((await buildActorScopedActionContext(f.engine, "reader", paused.newHead)).decision?.readableTexts).toBeUndefined();
  const stale = await new PlayerTurnService(f.engine, () => candidate, () => "Rejected").turn({ branchId: "main", actorId: "reader", utterance: "Read again" });
  expect(stale.accepted).toBe(false);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
});

function readingCandidate(actorId: string, text: NonNullable<ActorDecisionView["readableTexts"]>[number]) {
  return playerActionCandidateSchema.parse({ title: "Read the terminal", participants: [text.documentId], intent: { kind: "reflect", summary: "Understand the displayed note" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [],
    proposedSemantics: { version: 1, operations: [
      { op: "record-claim", localRef: "local-text-claim", claim: { propositionId: text.propositionId, status: "asserted" } },
      { op: "record-acquisition", localRef: "local-text-receipt", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId, claimId: "local-text-claim", propositionId: text.propositionId,
        basis: { mode: "read", expressionId: text.expressionId, attributionId: text.attributionId, documentId: text.documentId, channelBinding: text.channelBinding }, reception: { received: true, understood: true, belief: "accepted" } } },
    ] }, proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId, claimId: "local-text-claim", propositionId: text.propositionId, expressionId: text.expressionId, attributionId: text.attributionId, acquisitionId: "local-text-receipt", acquisitionMode: "read", status: "believes", confidence: 1 }] } });
}

it.each(scenes)("autonomous reading uses the same isolated text view and runtime commit: $quote", async scene => {
  const f = await fixture(scene, context => { context.actorGoals = [{ id: "read-note", actorId: "reader", description: "Read the note", priority: 1, requiresKnowledge: [], evidence: context.entities.get("reader")!.evidence }]; });
  const source = modelActorProposalSource(f.engine, { goals: async () => [], modelFor: async () => null,
    reasoner: input => {
      const text = input.actor.decision?.readableTexts?.[0];
      if (!text) return null;
      expect(text.fragments).toEqual([scene.quote]);
      expect(text.expressionId).not.toBe("expression");
      expect(text.channelBinding.processId).not.toBe(f.session);
      const { requiresKnowledge: _requires, forbidsKnowledge: _forbids, ...action } = readingCandidate(input.actor.actorId, text);
      return action;
    } });
  const result = await new WorldRuntime(f.engine, () => [], () => "Read", source).move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(result.rejectedProposals).toEqual([]);
  expect(result.committedEvents).toHaveLength(1);
  const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  expect(Object.values(replay.knowledge.acquisitions!)[0]!.actorId).toBe("reader");
  expect(replay.history.at(-1)!.event.participantPresence).toEqual([{ entityId: "reader", mode: "remote" }]);
});

it.each(scenes)("NPC can privately read a terminal in response without disclosing the note: $quote", async scene => {
  const f = await fixture(scene);
  const playerCandidate = playerActionCandidateSchema.parse({ title: "Ask", participants: ["reader"], intent: { kind: "act", summary: "Ask to read", controlledAct: { eventTitle: "Ask", actorObservation: "You ask", interaction: { kind: "speech", content: "Read your terminal.", channel: "audible", addresseeIds: ["reader"] } } }, proposedDelta: { version: 1, operations: [] }, preconditions: [], requiresKnowledge: [], forbidsKnowledge: [] });
  const spoken = await f.engine.commitProposal({ ...f.base, expectedParentCommit: f.opened.newHead, proposalId: "request", participants: ["writer", "reader"], participantPresence: [{ entityId: "writer", mode: "physical" }, { entityId: "reader", mode: "physical" }], spokenUtterances: [{ speakerId: "writer", addresseeIds: ["reader"], channel: "audible", content: "Read your terminal." }] });
  expect(spoken.report.errors).toEqual([]);
  const triggerEvent = (await f.engine.projections.project(spoken.newHead)).history.at(-1)!.event;
  const result = await respondToNpcInteractions({ engine: f.engine, branchId: "main", playerId: "writer", playerCandidate, triggerEvent, reasoner: input => {
    const reading = readingCandidate("reader", input.actorContext.decision!.readableTexts![0]!);
    return { responseKind: "other", eventTitle: "Read", npcObservation: "You read the terminal", playerObservation: "Private text must not be disclosed", emotion: { label: "calm", intensity: 0.1 }, preconditions: [], proposedDelta: { version: 1, operations: [] }, proposedSemantics: reading.proposedSemantics, proposedKnowledge: reading.proposedKnowledge, communicatedClaimIds: [], requiresKnowledge: [], forbidsKnowledge: [] };
  } });
  expect(result.failures).toEqual([]);
  expect(result.responses).toHaveLength(1);
  const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  expect(Object.values(replay.knowledge.acquisitions!)[0]!.actorId).toBe("reader");
  expect(replay.knowledge.actors.writer).toBeUndefined();
  expect(replay.history.at(-1)!.event.actorObservations?.find(item => item.actorId === "writer")?.summary).not.toContain("Private text");
});

it.each(scenes)("compiled reading receipts require actual event access after branch divergence: $quote", async scene => {
  const { f, learning, proposal } = await compiledReadingFixture(scene);
  const absent = await f.engine.commitProposal(proposal);
  expect(absent.report.errors.some(issue => issue.code === "ACQUISITION_DOCUMENT_ACCESS_UNPROVEN")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  const moved = await f.engine.commitProposal({ ...f.base, expectedParentCommit: f.opened.newHead, proposalId: "bring-note", participantPresence: [{ entityId: "reader", mode: "physical" }], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "document", field: "artifact.location", value: "gate" }] } });
  expect(moved.report.errors).toEqual([]);
  const received = await f.engine.commitProposal({ ...proposal, expectedParentCommit: moved.newHead });
  expect(received.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(received.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.knowledge.acquisitions?.["canonical-reading"]?.actorId).toBe("reader");
  const event = replay.history.at(-1)!.event;
  const mediatedEntities = new Map(f.context.entities);
  const reader = mediatedEntities.get("reader")!;
  mediatedEntities.set("reader", { ...reader, agencyProfile: { ...reader.agencyProfile!, embodiment: "mediated" } });
  expect(validateAcquisitionOperation(learning, acquisitionCatalog({ ...f.context, entities: mediatedEntities }), {
    knowledge: replay.knowledge, currentEventIds: new Set(["reading"]), realizedEventIds: new Set(["writing", "reading"]),
    occurrence: { eventId: event.eventId, participants: event.participants, participantPresence: event.participantPresence, before: replay.state, after: replay.state },
  }).some(issue => issue.code === "ACQUISITION_DOCUMENT_ACCESS_UNPROVEN")).toBe(true);
  const tampered = await f.engine.objects.putEvent({ ...event, participantPresence: [{ entityId: "reader", mode: "represented" }] });
  const commit = await f.engine.objects.putCommit({ ...await f.engine.objects.getCommit(received.newHead), eventHashes: [tampered] });
  await expect(new WorldEngine(f.root, f.context).projections.project(commit, { fresh: true, useCheckpoints: false })).rejects.toThrow("ACQUISITION_DOCUMENT_ACCESS_UNPROVEN");
  expect(buildNwhToolRecoveryAdvice("propose_player_action", "ACQUISITION_DOCUMENT_ACCESS_UNPROVEN")).toMatchObject({ category: "host-repair-required", retryable: false });
});

async function compiledReadingFixture(scene: typeof scenes[number], remote = false) {
  const learning = { op: "learn" as const, actorId: "reader", claimId: "claim", propositionId: "content", expressionId: "expression", attributionId: "report", acquisitionId: "canonical-reading", acquisitionMode: "read" as const, status: "believes" as const, confidence: 1 };
  const f = await fixture(scene, context => {
    const reading = canonicalEventSchema.parse({ ...context.events!.get("writing")!, id: "reading", title: "Read note", participants: ["reader", "document", ...(remote ? ["terminal"] : [])], participantPresence: [{ entityId: "reader", mode: remote ? "remote" : "physical" }], observedKnowledge: { version: 1, operations: [learning] } });
    context.events = new Map(context.events).set(reading.id, reading);
    const record = hydrateAcquisition({ ontologyVersion: "acquisition-v1", id: "canonical-reading", actorId: "reader", canonicalEventId: reading.id, cut: "event-end", claimId: "claim", propositionId: "content", basis: { mode: "read", expressionId: "expression", attributionId: "report", documentId: "document", ...(remote ? { textChannel: { channelId: "screen", processTemplateId: "access" } } : {}) }, reception: { received: true, understood: true, belief: "accepted" } }, reading.evidence, acquisitionCatalog(context));
    context.acquisitions = new Map([[record.id, record]]);
  });
  const proposal: EventProposal = { ...f.base, source: "canon-candidate", possibilityId: "canon-reading", expectedParentCommit: f.opened.newHead, participants: ["reader", "document", ...(remote ? ["terminal"] : [])], participantPresence: [{ entityId: "reader", mode: remote ? "remote" : "physical" }], proposedKnowledge: { version: 1, operations: [learning] } };
  return { f, learning, proposal };
}

it.each(scenes)("resolves compiled text channels only against unique pre-event sessions: $quote", async scene => {
  const { f, proposal } = await compiledReadingFixture(scene, true);
  const acquisition = f.context.acquisitions!.get("canonical-reading")!;
  expect(acquisition.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "entity", id: "reader" }), expect.objectContaining({ kind: "entity", id: "document" }), expect.objectContaining({ kind: "process-template", id: "access" })]));
  const absent = await f.engine.commitProposal({ ...proposal, expectedParentCommit: f.genesis });
  expect(absent.report.accepted).toBe(false); // stale head is independently rejected
  await f.engine.branches.create({ id: "before-channel", name: "Before", parentBranchId: "main", forkCommitId: f.genesis, headCommitId: f.genesis });
  const noSession = await f.engine.commitProposal({ ...proposal, branchId: "before-channel", expectedParentCommit: f.genesis });
  expect(noSession.report.errors.some(issue => issue.code === "ACQUISITION_TEXT_CHANNEL_UNPROVEN")).toBe(true);
  await f.engine.branches.create({ id: "ambiguous", name: "Ambiguous", parentBranchId: "main", forkCommitId: f.opened.newHead, headCommitId: f.opened.newHead });
  const duplicate = await f.engine.commitProposal({ ...f.base, branchId: "ambiguous", expectedParentCommit: f.opened.newHead, proposalId: "duplicate-channel", proposedProcesses: { version: 1, operations: [{ ...f.startProcess, localRef: "local-second" }] } });
  expect(duplicate.report.errors).toEqual([]);
  const ambiguous = await f.engine.commitProposal({ ...proposal, branchId: "ambiguous", expectedParentCommit: duplicate.newHead });
  expect(ambiguous.report.errors.some(issue => issue.code === "ACQUISITION_TEXT_CHANNEL_UNPROVEN")).toBe(true);
  expect(await f.engine.branches.readHead("ambiguous")).toBe(duplicate.newHead);
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: f.opened.newHead, proposalId: "pause", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const selfResumed = await f.engine.commitProposal({ ...proposal, expectedParentCommit: paused.newHead, proposedProcesses: { version: 1, operations: [{ op: "resume-process", processRef: f.session }] } });
  expect(selfResumed.report.errors.some(issue => issue.code === "ACQUISITION_TEXT_CHANNEL_UNPROVEN")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
  const resumed = await f.engine.commitProposal({ ...f.base, expectedParentCommit: paused.newHead, proposalId: "resume", proposedProcesses: { version: 1, operations: [{ op: "resume-process", processRef: f.session }] } });
  expect(resumed.report.errors).toEqual([]);
  const received = await f.engine.commitProposal({ ...proposal, expectedParentCommit: resumed.newHead });
  expect(received.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(received.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.knowledge.acquisitions?.["canonical-reading"]?.actorId).toBe("reader");
  expect(replay.state.values.document?.["artifact.location"]).toBe("archive");
  expect(replay.state.values.reader?.["character.location"]).toBe("gate");
});
