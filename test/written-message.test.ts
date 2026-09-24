import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { eventProposalSchema, writtenMessageSchema, type Entity, type EventProposal } from "../src/world/model.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { committedTextDeliveries } from "../src/world/text-delivery.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { PlayerTurnService, buildActorScopedActionContext, createPlayerActionModelBoundary, playerActionCandidateSchema } from "../src/world/player-action.js";
import { decisionContextRequirements } from "../src/agent/decision-context.js";
import type { ActorDecisionView } from "../src/world/actor-decision-view.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scenes = [
  { source: "Mara and Eli exchange messages through a terminal; the live connection is open.", text: "  Take the north gate.\nWait for me.  " },
  { source: "岚与青通过终端互发文字，此刻连接已经开启。", text: "  改走北门。\n等我回来。  " },
];

async function fixture(scene = scenes[0]!, configure?: (context: WorldModelContext) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-written-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.source), evidence = source.evidence(scene.source);
  const entities: Entity[] = [
    ...["author", "recipient", "outsider"].map(id => ({ id, kind: "character" as const, canonicalName: id, aliases: [], evidence })),
    { id: "terminal", kind: "artifact", canonicalName: "terminal", aliases: [], evidence },
  ];
  entities[0]!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "mediated", channels: [{ id: "keyboard", modality: "text", processTemplateId: "messaging", actorRoleId: "author", peerRoleId: "recipient", carrierRoleId: "terminal", activePhaseIds: ["open"] }] };
  const template = processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "messaging", name: "Text connection", ownerRoles: [
    ...["author", "recipient"].map(id => ({ id, label: id, allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 })),
    { id: "terminal", label: "terminal", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 },
  ], phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open", transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"], visibility: "public", induction: { kind: "domain-module", moduleId: "test-messaging", moduleVersion: "1" }, evidence: [] });
  const context: WorldModelContext = { sourceId: source.source.id, entities: new Map(entities.map(entity => [entity.id, entity])), rules: new Map(), actorGoals: [], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), processTemplates: new Map([[template.id, template]]) };
  configure?.(context);
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Messages", { version: 1, operations: [] }, undefined, source.source.id);
  const base: EventProposal = { proposalId: "open", branchId: "main", expectedParentCommit: genesis, source: "background", title: "Open connection", participants: ["author", "recipient", "terminal"], participantPresence: [{ entityId: "author", mode: "remote" }, { entityId: "recipient", mode: "remote" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [] };
  const start = { op: "start-process" as const, localRef: "local-session", process: { templateId: template.id, ownerBindings: ["author", "recipient", "terminal"].map(id => ({ roleId: id, entityIds: [id] })), phaseId: "open", progress: 0 } };
  const opened = await engine.commitProposal({ ...base, proposedProcesses: { version: 1, operations: [start] } });
  expect(opened.report.errors).toEqual([]);
  const session = Object.keys((await engine.projections.project(opened.newHead)).processes.instances)[0]!;
  const send: EventProposal = { ...base, proposalId: "send", expectedParentCommit: opened.newHead, title: "Send new text", writtenMessages: [{ authorId: "author", recipientIds: ["recipient"], content: scene.text, channelBinding: { channelId: "keyboard", processId: session } }] };
  return { root, engine, context, base, start, genesis, opened, session, send };
}

it.each(scenes)("commits exact new text and derives isolated delivery without knowledge: $source", async scene => {
  const f = await fixture(scene);
  expect((await f.engine.previewProposal(f.send)).report.errors).toEqual([]);
  expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  const sent = await f.engine.commitProposal(f.send);
  expect(sent.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(sent.newHead, { fresh: true, useCheckpoints: false });
  const event = replay.history.at(-1)!.event;
  expect(event.writtenMessages).toEqual(f.send.writtenMessages);
  expect(event.spokenUtterances).toBeUndefined();
  expect(event.progressCertificate).toMatchObject({ utteranceCount: 0, messageCount: 1, channels: ["text"] });
  expect(committedTextDeliveries(replay.history, "recipient")).toEqual([{ eventId: event.eventId, messageIndex: 0, recipientId: "recipient", authorId: "author", content: scene.text }]);
  expect(committedTextDeliveries(replay.history, "outsider")).toEqual([]);
  expect(committedTextDeliveries(replay.history.map(({ event }) => ({ event })), "recipient")).toEqual([]);
  expect(replay.knowledge.actors).toEqual({});
  expect(replay.state.values).toEqual({});
  expect(await new WorldEngine(f.root, f.context).projections.project(sent.newHead)).toEqual(replay);
  const changed = await f.engine.objects.putEvent({ ...event, writtenMessages: [...event.writtenMessages!, ...event.writtenMessages!] });
  const commit = await f.engine.objects.putCommit({ ...await f.engine.objects.getCommit(sent.newHead), eventHashes: [changed] });
  await expect(new WorldEngine(f.root, f.context).projections.project(commit, { fresh: true, useCheckpoints: false })).rejects.toThrow("Progress certificate");
});

it("rejects forged recipients, absent carriers, representations, and same-event session authority atomically", async () => {
  const f = await fixture();
  for (const change of [
    (p: EventProposal) => { p.participants = p.participants.filter(id => id !== "terminal"); },
    (p: EventProposal) => { p.participants.push("outsider"); p.participantPresence!.push({ entityId: "outsider", mode: "remote" }); p.writtenMessages![0]!.recipientIds = ["outsider"]; },
    (p: EventProposal) => { p.participantPresence![1]!.mode = "represented"; },
    (p: EventProposal) => { p.participantPresence = []; },
    (p: EventProposal) => { p.writtenMessages![0]!.channelBinding.channelId = "foreign"; },
    (p: EventProposal) => { p.writtenMessages![0]!.channelBinding.processId = "local-session"; p.proposedProcesses = { version: 1, operations: [f.start] }; },
  ]) {
    const bad = structuredClone(f.send); change(bad);
    expect((await f.engine.commitProposal(bad)).report.accepted).toBe(false);
    expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
  }
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: f.opened.newHead, proposalId: "pause", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const bad = { ...f.send, expectedParentCommit: paused.newHead, proposedProcesses: { version: 1 as const, operations: [{ op: "resume-process" as const, processRef: f.session }] } };
  expect((await f.engine.commitProposal(bad)).report.errors.some(issue => issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
  const resumed = await f.engine.commitProposal({ ...f.base, expectedParentCommit: paused.newHead, proposalId: "resume", proposedProcesses: bad.proposedProcesses });
  expect(resumed.report.errors).toEqual([]);
  expect((await f.engine.commitProposal({ ...f.send, expectedParentCommit: resumed.newHead })).report.errors).toEqual([]);
});

it.each(["audio", "hidden"] as const)("rejects %s channels as text authority", async kind => {
  const f = await fixture(scenes[0]!, context => {
    if (kind === "audio") context.entities.get("author")!.agencyProfile!.channels[0]!.modality = "audio";
    else context.processTemplates!.get("messaging")!.visibility = "engine";
  });
  expect((await f.engine.commitProposal(f.send)).report.errors.some(issue => issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(f.opened.newHead);
});

it("keeps deliveries on their ancestry, preserves repeats, and revalidates the sending session on cold replay", async () => {
  const f = await fixture();
  await f.engine.branches.create({ id: "sibling", name: "Before sending", parentBranchId: "main", forkCommitId: f.opened.newHead, headCommitId: f.opened.newHead });
  const first = await f.engine.commitProposal(f.send);
  expect(first.report.errors).toEqual([]);
  await f.engine.branches.create({ id: "fork", name: "After sending", parentBranchId: "main", forkCommitId: first.newHead, headCommitId: first.newHead });
  const repeat = await f.engine.commitProposal({ ...f.send, branchId: "fork", proposalId: "repeat", expectedParentCommit: first.newHead });
  expect(repeat.report.errors).toEqual([]);
  const paused = await f.engine.commitProposal({ ...f.base, branchId: "fork", expectedParentCommit: repeat.newHead, proposalId: "pause", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const cold = new WorldEngine(f.root, f.context);
  const replay = await cold.projections.project(paused.newHead, { fresh: true, useCheckpoints: false });
  const deliveries = committedTextDeliveries(replay.history, "recipient");
  expect(deliveries.map(item => item.content)).toEqual([scenes[0]!.text, scenes[0]!.text]);
  expect(new Set(deliveries.map(item => item.eventId)).size).toBe(2);
  expect(committedTextDeliveries((await cold.projections.project(await cold.branches.readHead("sibling"))).history, "recipient")).toEqual([]);
  expect(committedTextDeliveries((await cold.projections.project(await cold.branches.readHead("main"))).history, "recipient")).toHaveLength(1);
  const sentEvent = replay.history.find(item => item.event.eventId === deliveries[0]!.eventId)!.event;
  const forged = structuredClone(sentEvent);
  forged.writtenMessages![0]!.channelBinding.processId = "foreign-session";
  const eventHash = await f.engine.objects.putEvent(forged);
  const commitHash = await f.engine.objects.putCommit({ ...await f.engine.objects.getCommit(first.newHead), eventHashes: [eventHash] });
  await expect(cold.projections.project(commitHash, { fresh: true, useCheckpoints: false })).rejects.toThrow("AGENCY_CHANNEL_UNAVAILABLE");
});

it("cannot omit actorId to let an action-incapacitated author send text", async () => {
  const f = await fixture(scenes[0]!, context => {
    context.processTemplates!.set("restricted", processTemplateSchema.parse({
      ontologyVersion: "process-template-v1", id: "restricted", name: "Cannot act", ownerRoles: [{ id: "patient", label: "patient", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "impaired", label: "Impaired", terminal: false }, { id: "recovered", label: "Recovered", terminal: true }], initialPhaseId: "impaired", transitions: [{ fromPhaseId: "impaired", toPhaseId: "recovered", minimumProgress: 1 }], outcomeIds: ["recovered"], visibility: "public", induction: { kind: "domain-module", moduleId: "test-action-restriction", moduleVersion: "1" }, evidence: [],
      incapacity: { version: "incapacity-process-v1", ownerRoleId: "patient", capacity: "action", recoveryPhaseId: "recovered", duration: { kind: "unknown" } },
    }));
  });
  // A host-provided historical seed represents the pre-existing restriction.
  const head = await f.engine.createBranch("impaired", "Impaired author", { version: 1, operations: [] }, undefined, f.context.sourceId, undefined, [], {}, { projectionSeed: {
    version: 1, semantics: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0,
    processes: { version: 1, operations: [
      { op: "start-process", process: { ...f.start.process, id: f.session } },
      { op: "start-process", process: { id: "restriction", templateId: "restricted", ownerBindings: [{ roleId: "patient", entityIds: ["author"] }], phaseId: "impaired", progress: 0, startedAtElapsedDays: 0 } },
    ] },
  } });
  const result = await f.engine.commitProposal({ ...f.send, branchId: "impaired", expectedParentCommit: head });
  expect(result.report.errors.some(issue => issue.code === "CHARACTER_ACTION_INCAPACITATED")).toBe(true);
  expect(await f.engine.branches.readHead("impaired")).toBe(head);
});

it("rejects another author's message and ambiguous recipient lists at the typed boundary", async () => {
  const f = await fixture();
  expect(eventProposalSchema.safeParse({ ...f.send, actorId: "recipient" }).success).toBe(false);
  expect(writtenMessageSchema.safeParse({ ...f.send.writtenMessages![0], recipientIds: ["recipient", "recipient"] }).success).toBe(false);
  expect(writtenMessageSchema.safeParse({ ...f.send.writtenMessages![0], content: " \n " }).success).toBe(false);
  expect(buildNwhToolRecoveryAdvice("propose_player_action", "AGENCY_CHANNEL_UNAVAILABLE")).toMatchObject({ category: "host-repair-required", retryable: false });
});

function receiveCandidate(actorId: string, message: NonNullable<ActorDecisionView["pendingMessages"]>[number], understood = true, accepted = true) {
  return playerActionCandidateSchema.parse({ title: "Read delivered message", participants: [], intent: { kind: "reflect", summary: "Consider the delivered instructions" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [],
    proposedSemantics: { version: 1, operations: [
      { op: "record-proposition", localRef: "local-p", proposition: { subjectEntityId: actorId, relationId: "requested-route", object: { kind: "literal", value: "north-gate" }, polarity: "positive", modality: "asserted" } },
      { op: "record-attribution", localRef: "local-a", attribution: { propositionId: "local-p", holderKind: "character", holderEntityId: message.authorId, attitude: "asserts", certainty: 1 } },
      { op: "record-claim", localRef: "local-c", claim: { propositionId: "local-p", status: "asserted" } },
      { op: "record-acquisition", localRef: "local-r", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId, claimId: "local-c", propositionId: "local-p", basis: { mode: "read", origin: "branch-message", messageEventId: message.eventId, messageIndex: message.messageIndex, attributionId: "local-a" }, reception: { received: true, understood, belief: !understood ? "undecided" : accepted ? "accepted" : "rejected" } } },
    ] }, proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId, claimId: "local-c", propositionId: "local-p", attributionId: "local-a", acquisitionId: "local-r", acquisitionMode: "read", status: !understood ? "heard" : accepted ? "believes" : "disbelieves", confidence: 1 }] } });
}

it.each(scenes)("reads delivered branch text through the player boundary with no physical sender: $source", async scene => {
  const f = await fixture(scene);
  const sent = await f.engine.commitProposal(f.send);
  const context = await buildActorScopedActionContext(f.engine, "recipient", sent.newHead);
  const message = context.decision!.pendingMessages![0]!;
  expect(message.content).toBe(scene.text);
  expect(context.knowledge).toEqual([]);
  expect(context.presentEntities.map(entity => entity.id)).not.toContain("author");
  expect((await buildActorScopedActionContext(f.engine, "outsider", sent.newHead)).decision?.pendingMessages).toBeUndefined();
  const candidate = receiveCandidate("recipient", message);
  const boundary = createPlayerActionModelBoundary(context), encoded = boundary.encodeCandidate(candidate);
  expect(boundary.decodeCandidate(encoded)).toEqual(candidate);
  expect(JSON.stringify(encoded)).not.toContain(message.eventId);
  expect(decisionContextRequirements({ ...boundary.context, intendedCandidate: encoded })?.dependencyEdges.some(edge => edge.reason === "candidate-message-receipt")).toBe(true);
  expect(() => decisionContextRequirements({ ...boundary.context, decision: { ...(boundary.context.decision as object), pendingMessages: undefined }, intendedCandidate: encoded })).toThrow("dependency");
  const result = await new PlayerTurnService(f.engine, () => candidate, () => "You read the message.").turn({ branchId: "main", actorId: "recipient", utterance: "Read the message" });
  expect(result.issues).toEqual([]);
  expect(result.accepted).toBe(true);
  const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  const record = Object.values(replay.knowledge.acquisitions!)[0]!;
  expect(record).toMatchObject({ actorId: "recipient", reception: { understood: true, belief: "accepted" } });
  expect(replay.history.at(-1)!.event.spokenUtterances).toBeUndefined();
  expect(replay.state.values).toEqual({});
  expect(replay.knowledge.actors.author).toBeUndefined();
  expect((await buildActorScopedActionContext(f.engine, "recipient", result.newHead)).decision?.pendingMessages).toBeUndefined();
  const duplicate = await f.engine.commitProposal({ ...f.base, expectedParentCommit: result.newHead, proposalId: "duplicate-receipt", proposedSemantics: candidate.proposedSemantics, proposedKnowledge: candidate.proposedKnowledge });
  expect(duplicate.report.errors.some(issue => issue.code === "BRANCH_TEXT_ALREADY_RECEIVED")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(result.newHead);
});

it("separates text delivery from understanding and belief even after the sending session is paused", async () => {
  const f = await fixture();
  const sent = await f.engine.commitProposal(f.send);
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: sent.newHead, proposalId: "pause", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  const message = (await buildActorScopedActionContext(f.engine, "recipient", paused.newHead)).decision!.pendingMessages![0]!;
  for (const understood of [true, false]) {
    const branchId = `read-${understood}`;
    await f.engine.branches.create({ id: branchId, name: branchId, parentBranchId: "main", forkCommitId: paused.newHead, headCommitId: paused.newHead });
    const candidate = receiveCandidate("recipient", message, understood, false);
    const result = await f.engine.commitProposal({ ...f.base, branchId, expectedParentCommit: paused.newHead, proposalId: "receive", proposedSemantics: candidate.proposedSemantics, proposedKnowledge: candidate.proposedKnowledge });
    expect(result.report.errors).toEqual([]);
    const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
    expect(Object.values(replay.knowledge.acquisitions!)[0]!.reception).toEqual({ received: true, understood, belief: understood ? "rejected" : "undecided" });
    expect(replay.state.values).toEqual({});
  }
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
});

it("rejects a foreign recipient, branch, index, source, and represented reader without moving head", async () => {
  const f = await fixture();
  await f.engine.branches.create({ id: "sibling", name: "Before text", parentBranchId: "main", forkCommitId: f.opened.newHead, headCommitId: f.opened.newHead });
  const sent = await f.engine.commitProposal(f.send);
  const message = (await buildActorScopedActionContext(f.engine, "recipient", sent.newHead)).decision!.pendingMessages![0]!;
  const candidate = receiveCandidate("recipient", message);
  const read: EventProposal = { ...f.base, expectedParentCommit: sent.newHead, proposalId: "receive", proposedSemantics: candidate.proposedSemantics, proposedKnowledge: candidate.proposedKnowledge };
  for (const mutate of [
    (p: EventProposal) => { p.branchId = "sibling"; p.expectedParentCommit = f.opened.newHead; },
    (p: EventProposal) => { const op = p.proposedSemantics!.operations[3]!; if (op.op === "record-acquisition" && "messageIndex" in op.acquisition.basis) op.acquisition.basis.messageIndex = 1; },
    (p: EventProposal) => { p.participantPresence = [{ entityId: "recipient", mode: "represented" }]; },
    (p: EventProposal) => { const op = p.proposedSemantics!.operations[1]!; if (op.op === "record-attribution") op.attribution.holderEntityId = "outsider"; },
    (p: EventProposal) => { const foreign = receiveCandidate("outsider", message); p.proposedSemantics = foreign.proposedSemantics; p.proposedKnowledge = foreign.proposedKnowledge; p.participants.push("outsider"); p.participantPresence!.push({ entityId: "outsider", mode: "remote" }); },
  ]) {
    const bad = structuredClone(read); mutate(bad);
    expect((await f.engine.commitProposal(bad)).report.accepted).toBe(false);
    expect(await f.engine.branches.readHead(bad.branchId)).toBe(bad.expectedParentCommit);
  }
  expect(buildNwhToolRecoveryAdvice("propose_player_action", "BRANCH_TEXT_HISTORY_UNAVAILABLE")).toMatchObject({ category: "lookup-miss", retryable: true });
  expect(buildNwhToolRecoveryAdvice("propose_player_action", "BRANCH_TEXT_ALREADY_RECEIVED")).toMatchObject({ category: "scope-or-lifecycle", retryable: false });
});
