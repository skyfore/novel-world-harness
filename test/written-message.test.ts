import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
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
  const base: EventProposal = { proposalId: "open", branchId: "main", expectedParentCommit: genesis, source: "background", title: "Open connection", participants: ["author", "recipient", "terminal"], participantPresence: [{ entityId: "author", mode: "remote" }, { entityId: "recipient", mode: "remote" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence };
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
    context.processTemplates = new Map(context.processTemplates).set("restricted", processTemplateSchema.parse({
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

function sendCandidate(content: string, channel: { id: string; processId: string; peerEntityIds: string[] }) {
  return playerActionCandidateSchema.parse({ title: "Send text", participants: channel.peerEntityIds, proposedDelta: { version: 1, operations: [] },
    intent: { kind: "act", summary: "Send a written message", controlledAct: { eventTitle: "Send text", actorObservation: "You send a written message.", interactionMode: "direct",
      interaction: { kind: "text", channel: "text", content, addresseeIds: channel.peerEntityIds, channelBinding: { channelId: channel.id, processId: channel.processId } } } } });
}

it.each(scenes)("sends and independently reads/replies through player and NPC boundaries: $source", async scene => {
  const { respondToNpcInteractions } = await import("../src/world/npc-reaction.js");
  const f = await fixture(scene, context => {
    context.entities.get("recipient")!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "mediated", channels: [{ id: "reply", modality: "text", processTemplateId: "messaging", actorRoleId: "recipient", peerRoleId: "author", carrierRoleId: "terminal", activePhaseIds: ["open"] }] };
  });
  const before = await buildActorScopedActionContext(f.engine, "author", f.opened.newHead);
  const candidate = sendCandidate(scene.text, before.decision!.agency!.channels[0]!);
  const boundary = createPlayerActionModelBoundary(before);
  const encoded = boundary.encodeCandidate(candidate);
  expect(JSON.stringify(encoded)).not.toContain(f.session);
  expect(boundary.decodeCandidate(encoded)).toEqual(candidate);
  expect(decisionContextRequirements({ ...boundary.context, intendedCandidate: encoded })?.dependencyEdges.some(edge => edge.reason === "candidate-channel")).toBe(true);
  const sent = await new PlayerTurnService(f.engine, () => candidate, () => "Sent").turn({ branchId: "main", actorId: "author", utterance: "Send this text" });
  expect(sent.issues).toEqual([]);
  expect(sent.accepted).toBe(true);
  const trigger = (await f.engine.projections.project(sent.newHead)).history.at(-1)!.event;
  expect(trigger.writtenMessages?.[0]?.content).toBe(scene.text);
  expect(trigger.spokenUtterances).toBeUndefined();
  expect(trigger.participantPresence).toContainEqual({ entityId: "recipient", mode: "remote" });
  let calls = 0;
  const reasoner = (input: import("../src/world/npc-reaction.js").NpcReactionReasoningInput) => {
    calls++;
    const message = input.actorContext.decision!.pendingMessages![0]!;
    const receipt = receiveCandidate("recipient", message);
    const reply = sendCandidate(scene.text, input.actorContext.decision!.agency!.channels[0]!);
    return { responseKind: "text", eventTitle: "Read and reply", npcObservation: "You read and reply.", playerObservation: "A written reply arrives.", emotion: { label: "calm", intensity: 0.2 },
      interaction: reply.intent!.controlledAct!.interaction, proposedDelta: { version: 1, operations: [] }, proposedSemantics: receipt.proposedSemantics, proposedKnowledge: receipt.proposedKnowledge };
  };
  const args = { engine: f.engine, branchId: "main", playerId: "author", playerCandidate: candidate, triggerEvent: trigger, reasoner };
  const replied = await respondToNpcInteractions(args);
  expect(replied.failures).toEqual([]);
  expect(replied.responses).toHaveLength(1);
  const cold = await new WorldEngine(f.root, f.context).projections.project(replied.newHead, { fresh: true, useCheckpoints: false });
  expect(cold.history.at(-1)!.event.writtenMessages?.[0]).toMatchObject({ authorId: "recipient", content: scene.text, channelBinding: { channelId: "reply", processId: f.session } });
  expect(cold.history.at(-1)!.event.spokenUtterances).toBeUndefined();
  expect(Object.values(cold.semantics.acquisitions ?? {})).toHaveLength(1);
  expect((await buildActorScopedActionContext(f.engine, "recipient", replied.newHead)).decision?.pendingMessages).toBeUndefined();
  expect((await respondToNpcInteractions(args)).newHead).toBe(replied.newHead);
  expect(calls).toBe(1);
  const forged = await respondToNpcInteractions({ ...args, triggerEvent: { ...trigger, eventId: "forged-trigger" } });
  expect(forged.failures[0]?.error).toContain("BRANCH_TEXT_HISTORY_UNAVAILABLE");
  expect(calls).toBe(1);
  expect(await f.engine.branches.readHead("main")).toBe(replied.newHead);
});

it.each(scenes)("schedules model text and rejects paused sends: $source", async scene => {
  const { modelActorProposalSource } = await import("../src/world/model-actor-policy.js");
  const { WorldRuntime } = await import("../src/world/runtime.js");
  const f = await fixture(scene, context => { context.actorGoals = [{ id: "send-goal", actorId: "author", description: "Send the instructions", priority: 1, requiresKnowledge: [], targetIds: ["recipient"], evidence: context.entities.get("author")!.evidence }]; });
  const source = modelActorProposalSource(f.engine, { goals: async () => [], modelFor: async () => null, reasoner: input => {
    expect(JSON.stringify(input)).not.toContain(f.session);
    const channel = input.actor.decision?.agency?.channels.find(item => item.modality === "text");
    if (!channel) return null;
    const { requiresKnowledge: _requires, forbidsKnowledge: _forbids, ...template } = sendCandidate(scene.text, channel);
    return template;
  } });
  const candidates = await source({ branchId: "main", commitId: f.opened.newHead });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.proposal.writtenMessages?.[0]?.content).toBe(scene.text);
  expect((await f.engine.previewProposal(candidates[0]!.proposal)).report.errors).toEqual([]);
  const runtime = new WorldRuntime(f.engine, () => [], () => "Sent", source);
  const moved = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(moved.rejectedProposals).toEqual([]);
  expect(moved.committedEvents).toHaveLength(1);
  const cold = await new WorldEngine(f.root, f.context).projections.project(moved.newHead, { fresh: true, useCheckpoints: false });
  expect(cold.history.at(-1)!.event.writtenMessages?.[0]?.content).toBe(scene.text);
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: moved.newHead, proposalId: "pause-model-text", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  expect((await f.engine.commitProposal({ ...candidates[0]!.proposal, expectedParentCommit: paused.newHead })).report.accepted).toBe(false);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
});

it.each(scenes)("renders committed text exactly and retries presentation without a new event: $source", async scene => {
  const { PlayConversationStore } = await import("../src/world/play-conversation.js");
  const { buildPlayOpeningFrame, playScenePrompt } = await import("../src/world/play-opening.js");
  const { renderNarrationBlocks } = await import("../src/world/utterance-rendering.js");
  const f = await fixture(scene);
  const sent = await f.engine.commitProposal(f.send);
  const history = (await f.engine.projections.project(sent.newHead)).history;
  const event = history.at(-1)!.event;
  const contexts = await import("../src/world/workspace-runtime.js");
  const { WorldRuntime } = await import("../src/world/runtime.js");
  // This fixture supplies an explicit host module; reuse its engine rather than claiming a persisted compiler snapshot.
  const runtime = new WorldRuntime(f.engine, () => []);
  vi.spyOn(contexts, "openWorkspaceWorld").mockResolvedValue({ engine: f.engine, runtime } as Awaited<ReturnType<typeof contexts.openWorkspaceWorld>>);
  const conversations = new PlayConversationStore(f.root);
  for (const actorId of ["author", "recipient", "outsider"]) {
    await conversations.append({ branchId: "main", actorId, atCommit: sent.newHead, eventId: event.eventId, role: "player", status: "accepted", text: "Continue" });
    const frame = await buildPlayOpeningFrame(f.root, "main", actorId, f.context.sourceId);
    const locked = frame.resolvedAct!.lockedUtterances;
    if (actorId === "outsider") { expect(locked).toEqual([]); continue; }
    expect(locked).toEqual([expect.objectContaining({ text: scene.text, channel: "text", mode: "verbatim" })]);
    expect(playScenePrompt(frame, "turn")).toContain("written messages");
    const id = locked[0]!.utteranceId!;
    expect(() => renderNarrationBlocks({ version: "narration-blocks-v1", blocks: [{ kind: "committed-utterance", utteranceId: "wrong" }] }, locked)).toThrow("unknown, duplicate, or out-of-order");
    const blocks = { version: "narration-blocks-v1", blocks: [{ kind: "prose", text: "Written message:\n" }, { kind: "committed-utterance", utteranceId: id }] };
    expect(renderNarrationBlocks(blocks, locked)).toBe(`Written message:\n${scene.text}`);
    expect(renderNarrationBlocks(blocks, locked)).toBe(`Written message:\n${scene.text}`);
    expect(await f.engine.branches.readHead("main")).toBe(sent.newHead);
  }
});

it.each(scenes)("reads a delivered message autonomously after disconnection without sending or leaking belief: $source", async scene => {
  const { modelActorProposalSource } = await import("../src/world/model-actor-policy.js");
  const { WorldRuntime } = await import("../src/world/runtime.js");
  const f = await fixture(scene, context => {
    context.entities.get("recipient")!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "mediated", channels: [] };
    context.actorGoals = [{ id: "read-goal", actorId: "recipient", description: "Consider the instructions", priority: 1, requiresKnowledge: [], targetIds: [], evidence: context.entities.get("recipient")!.evidence }];
  });
  const sent = await f.engine.commitProposal(f.send);
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: sent.newHead, proposalId: "pause-before-read", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const source = modelActorProposalSource(f.engine, { goals: async () => [], modelFor: async () => null, reasoner: input => {
    const message = input.actor.decision?.pendingMessages?.[0];
    if (!message) return null;
    const { requiresKnowledge: _requires, forbidsKnowledge: _forbids, ...template } = receiveCandidate(input.actor.actorId, message, true, false);
    return template;
  } });
  const runtime = new WorldRuntime(f.engine, () => [], () => "Read", source);
  const read = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(read.rejectedProposals).toEqual([]);
  expect(read.committedEvents).toHaveLength(1);
  const replay = await new WorldEngine(f.root, f.context).projections.project(read.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.writtenMessages).toBeUndefined();
  expect(replay.history.at(-1)!.event.spokenUtterances).toBeUndefined();
  expect(Object.values(replay.semantics.acquisitions ?? {})[0]?.reception).toEqual({ received: true, understood: true, belief: "rejected" });
  expect((await buildActorScopedActionContext(f.engine, "author", read.newHead)).decision?.experiences).toBeUndefined();
  expect((await source({ branchId: "main", commitId: read.newHead }))).toEqual([]);
});

it.each(scenes)("lets an NPC read after disconnection but rejects borrowing the sender's channel: $source", async scene => {
  const { respondToNpcInteractions } = await import("../src/world/npc-reaction.js");
  const f = await fixture(scene);
  const before = await buildActorScopedActionContext(f.engine, "author", f.opened.newHead);
  const candidate = sendCandidate(scene.text, before.decision!.agency!.channels[0]!);
  const sent = await new PlayerTurnService(f.engine, () => candidate, () => "Sent").turn({ branchId: "main", actorId: "author", utterance: "Send" });
  expect(sent.accepted).toBe(true);
  const triggerEvent = (await f.engine.projections.project(sent.newHead)).history.at(-1)!.event;
  const paused = await f.engine.commitProposal({ ...f.base, expectedParentCommit: sent.newHead, proposalId: "pause-npc-text", proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const args = { engine: f.engine, branchId: "main", playerId: "author", playerCandidate: candidate, triggerEvent };
  const refused = await respondToNpcInteractions({ ...args, reasoner: () => ({ responseKind: "text", eventTitle: "Invalid reply", npcObservation: "Reply", playerObservation: "Reply", emotion: { label: "calm", intensity: 0.1 },
    interaction: { kind: "text", channel: "text", content: "Reply", addresseeIds: ["author"], channelBinding: { channelId: "keyboard", processId: f.session } }, proposedDelta: { version: 1, operations: [] } }) });
  expect(refused.responses).toEqual([]);
  expect(refused.failures[0]?.error).toContain("AGENCY_CHANNEL_UNAVAILABLE");
  expect(refused.newHead).toBe(paused.newHead);
  const read = await respondToNpcInteractions({ ...args, reasoner: input => {
    const receipt = receiveCandidate("recipient", input.actorContext.decision!.pendingMessages![0]!, false, false);
    return { responseKind: "ignore", eventTitle: "Receive text", npcObservation: "The symbols are not understood.", playerObservation: "No reply", emotion: { label: "uncertain", intensity: 0.1 },
      proposedDelta: { version: 1, operations: [] }, proposedSemantics: receipt.proposedSemantics, proposedKnowledge: receipt.proposedKnowledge };
  } });
  expect(read.failures).toEqual([]);
  expect(read.responses).toHaveLength(1);
  const projection = await new WorldEngine(f.root, f.context).projections.project(read.newHead, { fresh: true, useCheckpoints: false });
  expect(Object.values(projection.semantics.acquisitions ?? {})[0]?.reception).toEqual({ received: true, understood: false, belief: "undecided" });
  expect(projection.history.at(-1)!.event.actorObservations?.find(item => item.actorId === "author")?.summary).toBe("通信渠道暂未传来回应。");
  expect(projection.history.at(-1)!.event.writtenMessages).toBeUndefined();
});
