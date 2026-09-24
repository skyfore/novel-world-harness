import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { ActorModelStore, deterministicActorProposalSource, type CharacterGoal } from "../src/world/actors.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { canonicalEventSchema, type EventProposal, type EventRelation } from "../src/world/model.js";
import type { NormTemplate } from "../src/world/norm-ontology.js";
import type { ProcessTemplate } from "../src/world/process-ontology.js";
import { probeEntryDriver } from "../src/compiler/entry-driver-probe.js";
import { contentHash } from "../src/world/canonical.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

// Independent source expectations: NPC initiative vs a due environmental process.
// The guarded canonical consequence is legal only if its enabling event survives.
const scenes = [
  { id: "gate", focal: "林", npc: "周", npcDriver: true,
    text: "林尚未行动。周可以先决定看守闸口。林持有通行资格，准备提交申请，获准后才能过闸。林也可以撤回申请。周须在一天内回报；雨水将在一天后到达。",
    initiative: "看守闸口", cause: "提交申请", effect: "过闸", cancel: "撤回申请", process: "雨水到达" },
  { id: "lamp", focal: "Mara", npc: "Orr", npcDriver: false,
    text: "Orr must report within a day. The tide arrives after a day even if Mara takes no action. Mara holds permission to request a signal; only the signal enables her departure. Mara may cancel that request. Orr has no other plan.",
    initiative: "watch the lamp", cause: "request a signal", effect: "depart", cancel: "cancel the request", process: "tide arrives" },
];

it.each(scenes)("preserves autonomy and causal divergence through fork, resume and replay: $id", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-p6-exit-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), evidence = source.evidence(scene.text);
  const expected = Object.freeze({ driver: scene.npcDriver ? "actor" : "background", blockedCanon: ["cause", "consequence"],
    causeTitle: scene.cause, consequenceTitle: scene.effect, sourceSha256: source.source.contentSha256 });
  const cause = canonicalEventSchema.parse({ id: "cause", title: scene.cause, participants: ["focal"],
    participantPresence: [{ entityId: "focal", mode: "physical" }], storyTime: { kind: "unknown" },
    preconditions: [{ op: "fact-equals", entityId: "focal", field: "character.title", value: "permitted" }],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "focal", field: "character.plan", value: scene.cause }] },
    evidence, causalParents: [], confidence: 1 });
  const consequence = canonicalEventSchema.parse({ id: "consequence", title: scene.effect, participants: ["focal"],
    participantPresence: [{ entityId: "focal", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "focal", field: "character.plan", value: scene.effect }] },
    evidence, causalParents: [cause.id], confidence: 1 });
  const relation: EventRelation = { id: "necessary-cause", fromEventId: cause.id, toEventId: consequence.id,
    type: "enables", operationality: "necessary", status: "explicit", confidence: 1, evidence };
  const duty: NormTemplate = { ontologyVersion: "norm-template-v1", id: "report-duty", name: "Report within a day",
    modality: "obligation", actionPattern: { kind: "ad-hoc", actionKindId: "report" }, appliesWhen: [], exceptions: [],
    defaultDeadlineDays: 1, reparations: [], priority: 1, defeasible: false, overridesTemplateIds: [], status: "supported",
    visibility: "public", knownByClaimIds: [], induction: { kind: "source-pattern", supportingEventIds: ["premise"] }, evidence };
  const timer: ProcessTemplate = { ontologyVersion: "process-template-v1", id: "weather", name: scene.process,
    ownerRoles: [{ id: "witness", label: "Witness", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
    phases: [{ id: "pending", label: "Pending", terminal: false }, { id: "arrived", label: "Arrived", terminal: true }], initialPhaseId: "pending",
    transitions: [{ fromPhaseId: "pending", toPhaseId: "arrived", minimumProgress: 1, onDue: { advanceBy: 1, outcomeId: "arrival" } }],
    cadence: { kind: "elapsed-days", intervalDays: 1 }, outcomeIds: ["arrival"], visibility: "observable",
    induction: { kind: "source-pattern", supportingEventIds: ["premise"] }, evidence };
  const goal: CharacterGoal = { id: "npc-initiative", actorId: "npc", description: scene.initiative, priority: 1,
    requiresKnowledge: [], activation: { preconditions: [], afterCanonicalEventIds: [] }, evidence,
    candidateAction: { title: scene.initiative, preconditions: [], proposedDelta: { version: 1,
      operations: [{ op: "set", entityId: "npc", field: "character.plan", value: scene.initiative }] } } };
  const context: WorldModelContext = { sourceId: source.source.id,
    entities: new Map([["focal", scene.focal], ["npc", scene.npc]].map(([id, name]) => [id!, { id: id!, kind: "character", canonicalName: name!, aliases: [], evidence }])),
    events: new Map([cause, consequence, canonicalEventSchema.parse({ id: "premise", title: scene.text, participants: ["npc"],
      storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence })].map(event => [event.id, event])),
    eventRelations: [relation], actorGoals: scene.npcDriver ? [goal] : [], claims: new Map(), rules: new Map(),
    normTemplates: new Map([[duty.id, duty]]), processTemplates: new Map([[timer.id, timer]]),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) };
  const engine = new WorldEngine(root, context);
  const proposal = (head: string, id: string, extra: Partial<EventProposal> = {}): EventProposal => ({ proposalId: id,
    branchId: "main", expectedParentCommit: head, source: "background", title: id, participants: ["npc"],
    participantPresence: [{ entityId: "npc", mode: "physical" }], proposedTime: { kind: "unknown" },
    preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence, ...extra });
  const genesis = await engine.createBranch("main", "Original", { version: 1, operations: [
    { op: "set", entityId: "focal", field: "character.alive", value: true },
    { op: "set", entityId: "npc", field: "character.alive", value: true },
    { op: "set", entityId: "focal", field: "character.title", value: "permitted" },
  ] });
  const start = await engine.commitProposal(proposal(genesis, "start-mechanisms", {
    proposedNorms: { version: 1, operations: [{ op: "instantiate-norm", localRef: "local-duty", norm: { templateId: duty.id, subjectActorId: "npc", description: "Report" } }] },
    proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-weather",
      process: { templateId: timer.id, ownerBindings: [{ roleId: "witness", entityIds: ["npc"] }], progress: 0 } }] },
  }));
  expect(start.report.accepted).toBe(true);
  let entryHead = start.newHead;
  if (!scene.npcDriver) {
    const clock = await engine.commitProposal(proposal(entryHead, "one-day-elapses", { timeAdvance: { amount: 1, unit: "day" } }));
    expect(clock.report.accepted).toBe(true); entryHead = clock.newHead;
  }
  const entry = await engine.projections.project(entryHead);
  expect(entry.history.every(item => item.event.actorId !== "focal")).toBe(true);
  const witness = await probeEntryDriver(engine, root, { branchId: "main", head: entryHead, actorId: "focal",
    sourceId: source.source.id, subjectSnapshotHash: contentHash(expected), entryCutHash: contentHash({ entryHead, expected }) });
  expect(witness.lane).toBe(expected.driver);
  expect(witness.events.every(item => item.event.actorId !== "focal" && !item.event.realizesCanonicalEventIds?.length)).toBe(true);
  expect(witness.resultingHead).not.toBe(entryHead);
  expect(await engine.branches.readHead("main")).toBe(entryHead);
  expect(await engine.projections.project(entryHead, { fresh: true, useCheckpoints: false })).toEqual(entry);

  const sourceCandidates = ({ branchId, commitId }: { branchId: string; commitId: string }) =>
    [cause, consequence].map(event => canonicalEventToPossibility(event, branchId, commitId, [relation]));
  const runtime = new WorldRuntime(engine, sourceCandidates, undefined,
    deterministicActorProposalSource(engine, new ActorModelStore(root), { excludedActorIds: new Set(["focal"]) }));
  await runtime.forkBranch("main", entryHead, "unchanged", "Cause remains available");
  await runtime.forkBranch("main", entryHead, "unknown", "Permission unknown");
  const missing = await engine.commitProposal(proposal(entryHead, "remove-permission", { branchId: "unknown",
    proposedDelta: { version: 1, operations: [{ op: "unset", entityId: "focal", field: "character.title" }] } }));
  expect(missing.report.accepted).toBe(true);
  const unknown = await runtime.refreshFrontier("unknown");
  expect(unknown.evaluated.find(item => item.possibility.canonicalEventId === "cause")!.status).not.toBe("eligible");

  const cancel = proposal(entryHead, "cancel-cause", { source: "player", actorId: "focal", title: scene.cancel,
    participants: ["focal", "npc"], participantPresence: [{ entityId: "focal", mode: "physical" }, { entityId: "npc", mode: "physical" }], supersedesCanonicalEventIds: [cause.id],
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: "focal", field: "character.plan", value: scene.cancel }] } });
  const cancelled = await runtime.move({ branchId: "main", playerProposal: cancel, maxActorCandidates: 0, maxBackgroundCandidates: 0 });
  expect(cancelled.committedEvents).toHaveLength(1);
  const broken = await runtime.refreshFrontier("main");
  for (const id of expected.blockedCanon) {
    const item = broken.evaluated.find(item => item.possibility.canonicalEventId === id)!;
    expect(item.status).toBe(id === cause.id ? "superseded" : "invalidated");
    // Default canonical affinity is already maximal; it grants no legality.
    expect(item.factors.canonAffinity).toBe(1);
  }
  const divergent = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 4 });
  const projection = await engine.projections.project(divergent.newHead);
  expect(projection.state.values.focal?.["character.plan"]).toBe(scene.cancel);
  expect(projection.history.flatMap(item => item.event.realizesCanonicalEventIds ?? [])).not.toContain("consequence");
  expect(divergent.committedEvents.length).toBeGreaterThan(0);
  expect(projection.history.filter(item => divergent.committedEvents.includes(contentHash(item.event))).every(item => item.event.actorId !== "focal" && item.event.progressCertificate.channels.length > 0)).toBe(true);
  expect(Object.keys(projection.processes.instances)).toHaveLength(1);
  expect(Object.keys(projection.norms.instances)).toHaveLength(1);

  const reopened = new WorldEngine(root, context), resumed = new WorldRuntime(reopened, sourceCandidates, undefined,
    deterministicActorProposalSource(reopened, new ActorModelStore(root), { excludedActorIds: new Set(["focal"]) }));
  expect(await reopened.projections.project(divergent.newHead, { fresh: true, useCheckpoints: false })).toEqual(projection);
  await resumed.forkBranch("main", divergent.newHead, "diverged-copy", "Resume divergent history");
  expect(await reopened.projections.project(await reopened.branches.readHead("diverged-copy"))).toEqual(projection);
  const retry = await resumed.move({ branchId: "main", playerProposal: cancel, maxActorCandidates: 0, maxBackgroundCandidates: 0 });
  expect(retry.committedEvents).toEqual([]);
  expect(retry.newHead).toBe(divergent.newHead);
  const settled = await resumed.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 4 });
  expect(settled.committedEvents).toEqual([]);
  expect(await reopened.projections.project(settled.newHead)).toEqual(projection);
  expect(await reopened.projections.project(entryHead, { fresh: true, useCheckpoints: false })).toEqual(entry);
  expect(await reopened.projections.project(await reopened.branches.readHead("unchanged"))).toEqual(entry);

  const positive = await resumed.move({ branchId: "unchanged", maxActorCandidates: 0, maxBackgroundCandidates: 4 });
  const positiveProjection = await reopened.projections.project(positive.newHead);
  expect(positiveProjection.state.values.focal?.["character.plan"]).toBe(scene.effect);
  expect(positiveProjection.history.flatMap(item => item.event.realizesCanonicalEventIds ?? [])).toEqual(expect.arrayContaining([cause.id, consequence.id]));
  expect(await reopened.branches.readHead("main")).toBe(divergent.newHead);
  expect(await reopened.branches.readHead("diverged-copy")).toBe(divergent.newHead);
}, 20_000);
