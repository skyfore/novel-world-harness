import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { type EventProposal, type BranchAcquisition } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { buildActorDecisionView, mapActorDecisionView } from "../src/world/actor-decision-view.js";
import { mapActorOutcome, validateActorOutcomeScope, validateActorOutcomeOwnership } from "../src/world/actor-outcome.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(text: string, remote = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-branch-acquisition-")); roots.push(root);
  const source = await createEvidenceFixture(root, text);
  const context: WorldModelContext = { entities: new Map([...["speaker", "listener", "outsider"].map(id => [id, { id, kind: "character", canonicalName: id, aliases: [], evidence: source.evidence(text) }] as const), ["gate", { id: "gate", kind: "location", canonicalName: "gate", aliases: [], evidence: source.evidence(text) }]]), propositions: new Map(), claims: new Map(), attributions: new Map(), acquisitions: new Map(), rules: new Map(), actorGoals: [], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) };
  if (remote) {
    context.entities = new Map(context.entities).set("radio", { id: "radio", kind: "artifact", canonicalName: "Radio", aliases: [], evidence: source.evidence(text) })
      .set("other-gate", { id: "other-gate", kind: "location", canonicalName: "Other gate", aliases: [], evidence: source.evidence(text) });
    context.processTemplates = new Map([["call", processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "call", name: "Call",
      ownerRoles: [{ id: "sender", label: "Sender", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }, { id: "receiver", label: "Receiver", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }, { id: "carrier", label: "Carrier", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open", transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"], visibility: "public", induction: { kind: "domain-module", moduleId: "test-radio", moduleVersion: "1" }, evidence: [] })]]);
    context.entities = new Map(context.entities).set("speaker", { ...context.entities.get("speaker")!, agencyProfile: { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily", channels: [{ id: "phone", modality: "audio", processTemplateId: "call", actorRoleId: "sender", peerRoleId: "receiver", carrierRoleId: "carrier", activePhaseIds: ["open"] }] } });
  }
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Source cut", { version: 1, operations: [...["speaker", "listener", "outsider"].flatMap(entityId => [{ op: "set" as const, entityId, field: "character.alive", value: true }, { op: "set" as const, entityId, field: "character.location", value: remote && entityId === "listener" ? "other-gate" : "gate" }]), { op: "set", entityId: "gate", field: "location.open", value: false }] });
  await engine.branches.create({ id: "sibling", name: "Sibling", parentBranchId: "main", forkCommitId: genesis, headCommitId: genesis });
  let ready = genesis, session: string | undefined;
  if (remote) {
    const started = await engine.commitProposal({ proposalId: "connect", branchId: "main", expectedParentCommit: genesis, source: "background", title: "Open a call", participants: ["speaker", "listener", "radio"], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
      proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-call", process: { templateId: "call", ownerBindings: [{ roleId: "sender", entityIds: ["speaker"] }, { roleId: "receiver", entityIds: ["listener"] }, { roleId: "carrier", entityIds: ["radio"] }], progress: 0 } }] } });
    expect(started.report.errors).toEqual([]);
    ready = started.newHead;
    session = Object.keys((await engine.projections.project(ready)).processes.instances)[0]!;
  }
  const proposal = (head: string, basis: BranchAcquisition["basis"] = { mode: "told", utteranceIndex: 0, attributionId: "local-a" }, reception: BranchAcquisition["reception"] = { received: true, understood: true, belief: "accepted" }): EventProposal => ({
    proposalId: "new-experience", branchId: "main", expectedParentCommit: head, source: "background", title: "An alternate event", participants: ["speaker", "listener", "gate", ...(remote ? ["radio"] : [])], participantPresence: [{ entityId: "speaker", mode: remote ? "remote" : "physical" }, { entityId: "listener", mode: remote ? "remote" : "physical" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
    spokenUtterances: [{ speakerId: "speaker", addresseeIds: ["listener"], content: text, channel: "audible", ...(remote ? { channelBinding: { channelId: "phone", processId: session! } } : {}) }],
    proposedSemantics: { version: 1, operations: [
      { op: "record-proposition", localRef: "local-p", proposition: { subjectEntityId: "gate", relationId: "location.open", object: { kind: "literal", value: false }, polarity: "positive", modality: "asserted" } },
      { op: "record-attribution", localRef: "local-a", attribution: { propositionId: "local-p", holderKind: "character", holderEntityId: "speaker", attitude: "asserts", certainty: 1 } },
      { op: "record-claim", localRef: "local-c", claim: { propositionId: "local-p", status: "asserted" } },
      { op: "record-acquisition", localRef: "local-x", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId: "listener", claimId: "local-c", propositionId: "local-p", basis, reception } },
    ] },
    proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "listener", claimId: "local-c", propositionId: "local-p", acquisitionId: "local-x", acquisitionMode: basis.mode, ...("attributionId" in basis ? { attributionId: basis.attributionId, sourceActorId: "speaker" } : {}), status: !reception.understood || reception.belief === "undecided" ? "heard" : reception.belief === "rejected" ? "disbelieves" : "believes", confidence: 1 }] },
  });
  return { engine, context, genesis, ready, session, proposal, root };
}
it.each(["Ada tells Bo that the gate is shut.", "宁告诉维，城门已经关闭。"])("new branch receipt, recall, inference, fork and cold replay: %s", async text => {
  const { engine, context, genesis, proposal, root } = await setup(text);
  const first = await engine.commitProposal(proposal(genesis));
  expect(first.report.errors).toEqual([]); expect(first.newHead).toBeTruthy();
  const cut = await engine.projections.project(first.newHead);
  const record = Object.values(cut.semantics.acquisitions!)[0]!;
  expect(record.introducedBy.eventId).toBe(cut.history.at(-1)!.event.eventId);
  expect(record).not.toHaveProperty("canonicalEventId");
  expect(cut.knowledge.acquisitions![record.id]?.actorId).toBe("listener");
  expect((await new KnowledgeProjector(engine).view("outsider", first.newHead)).knowledge).toEqual([]);
  expect((await engine.projections.project(genesis)).semantics.acquisitions).toBeUndefined();
  expect((await engine.projections.project(await engine.branches.readHead("sibling"))).knowledge.actors.listener).toBeUndefined();
  expect(context.acquisitions!.size).toBe(0);
  const decision = await buildActorDecisionView(engine, "listener", first.newHead, { visibleEntityIds: new Set(["listener", "speaker", "gate"]), knownClaimIds: new Set([record.claimId]) });
  expect(decision.experiences).toEqual([{ acquisitionId: record.id, claimId: record.claimId, propositionId: record.propositionId }]);
  const recall = proposal(first.newHead, { mode: "remembered", priorAcquisitionId: record.id });
  recall.proposedSemantics!.operations = [{ op: "record-acquisition", localRef: "local-x", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId: "listener", claimId: record.claimId, propositionId: record.propositionId, basis: { mode: "remembered", priorAcquisitionId: record.id }, reception: record.reception } }];
  Object.assign(recall.proposedKnowledge!.operations[0]!, { claimId: record.claimId, propositionId: record.propositionId });
  expect(validateActorOutcomeScope(recall, { actorId: "listener", visibleEntityIds: new Set(["listener"]), decision })).toEqual([]);
  const mapped = mapActorOutcome(recall, id => `entity-${id}`, id => id.startsWith("local-") ? id : `ref-${id}`);
  expect(JSON.stringify(mapped)).toContain(`ref-${record.id}`);
  expect(mapActorDecisionView(decision, id => id, id => `ref-${id}`).experiences![0]!.acquisitionId).toBe(`ref-${record.id}`);
  const { buildActorScopedActionContext, createPlayerActionModelBoundary, deterministicPlayerIntentCandidate } = await import("../src/world/player-action.js");
  const actorContext = await buildActorScopedActionContext(engine, "listener", first.newHead);
  const boundary = createPlayerActionModelBoundary(actorContext);
  const candidate = { ...deterministicPlayerIntentCandidate("reflect", { utterance: "recall", context: actorContext }), proposedSemantics: recall.proposedSemantics, proposedKnowledge: recall.proposedKnowledge };
  const encoded = boundary.encodeCandidate(candidate);
  expect(JSON.stringify(encoded)).not.toContain(record.id);
  expect(boundary.decodeCandidate(encoded).proposedSemantics).toEqual(recall.proposedSemantics);
  expect(boundary.decodeCandidate(encoded).proposedKnowledge).toEqual(recall.proposedKnowledge);
  const remembered = await engine.commitProposal(recall); expect(remembered.report.errors).toEqual([]);
  const inference = proposal(remembered.newHead, { mode: "inferred", premiseAcquisitionIds: [Object.keys((await engine.projections.project(remembered.newHead)).semantics.acquisitions!).find(id => id !== record.id)!], rationale: "An accepted closed gate prevents passage" });
  const inferred = await engine.commitProposal(inference); expect(inferred.report.errors).toEqual([]);
  const live = await engine.projections.project(inferred.newHead);
  const replay = await new WorldEngine(root, context).projections.project(inferred.newHead, { useCheckpoints: false });
  expect(replay).toEqual(live);
  const foreign = proposal(await engine.branches.readHead("sibling"), { mode: "remembered", priorAcquisitionId: record.id }); foreign.branchId = "sibling";
  expect((await engine.commitProposal(foreign)).report.accepted).toBe(false);
});
it("rejects missing/misattributed speech, unsupported observation, wrong receipt and orphan experience atomically", async () => {
  const { engine, genesis, proposal } = await setup("A warning is spoken.");
  const variants = [proposal(genesis), proposal(genesis), proposal(genesis), proposal(genesis), proposal(genesis, { mode: "observed", locationId: "gate", entityId: "gate", field: "location.open", value: true })];
  delete variants[0]!.spokenUtterances;
  variants[1]!.spokenUtterances![0]!.addresseeIds = ["speaker"];
  variants[2]!.proposedKnowledge!.operations = [];
  (variants[3]!.proposedKnowledge!.operations[0]! as any).status = "knows";
  for (const invalid of variants) { expect((await engine.commitProposal(invalid)).report.accepted).toBe(false); expect(await engine.branches.readHead("main")).toBe(genesis); }
  const good = proposal(genesis, { mode: "observed", locationId: "gate", entityId: "gate", field: "location.open", value: false });
  const committed = await engine.commitProposal(good); expect(committed.report.errors).toEqual([]);
});
it.each([{ understood: false, belief: "undecided" }, { understood: true, belief: "rejected" } ] as const)("preserves reception without promoting to truth: $belief", async reception => {
  const { engine, genesis, proposal } = await setup("A disputed warning.");
  const result = await engine.commitProposal(proposal(genesis, undefined, { received: true, ...reception })); expect(result.report.errors).toEqual([]);
  const view = await new KnowledgeProjector(engine).view("listener", result.newHead);
  if (reception.understood) expect(view.knowledge[0]!.fact.status).toBe("disbelieves");
  else { expect(view.knowledge).toEqual([]); expect(Object.values((await engine.projections.project(result.newHead)).knowledge.actors.listener!)[0]!.status).toBe("heard"); }
});
it("keeps actual and believed speech sources separate", async () => {
  const { engine, genesis, proposal } = await setup("The courier speaks under a borrowed name.");
  const input = proposal(genesis, { mode: "deceived-misattributed", utteranceIndex: 0, attributionId: "local-a", actualSourceActorId: "speaker", believedSourceActorId: "outsider" });
  const result = await engine.commitProposal(input); expect(result.report.errors).toEqual([]);
  const projection = await engine.projections.project(result.newHead);
  expect(Object.values(projection.knowledge.actors.listener!)[0]!.sourceActorId).toBe("speaker");
  const view = await new KnowledgeProjector(engine).view("listener", result.newHead);
  expect(view.knowledge[0]!.fact.sourceActorId).toBe("outsider");
  expect(view.knowledge[0]!.attribution!.holderEntityId).toBe("outsider");
  expect(JSON.stringify(view.knowledge)).not.toContain(':"speaker"');
  const replay = proposal(result.newHead);
  replay.proposedSemantics = undefined;
  replay.proposedKnowledge = projection.history.at(-1)!.knowledgeDelta;
  expect((await engine.commitProposal(replay)).report.errors).toContainEqual(expect.objectContaining({ code: "BRANCH_ACQUISITION_CUT_MISMATCH" }));
  expect(await engine.branches.readHead("main")).toBe(result.newHead);
});
it("reads only an already-realized document with proven physical access", async () => {
  const { validateBranchAcquisitionOperation } = await import("../src/world/branch-acquisition.js");
  const { engine, genesis, proposal, context } = await setup("A written warning lies at the gate.");
  const committed = await engine.commitProposal(proposal(genesis));
  const projection = structuredClone(await engine.projections.project(committed.newHead));
  const record = Object.values(projection.semantics.acquisitions!)[0]!;
  // The frozen writing contract is independent of the acquiring event. Runtime
  // access and its realization cut are the conditions exercised here.
  const { introducedBy, ...original } = record;
  const value = { ...original, id: "branch-acquisition-reading", basis: { mode: "read" as const, expressionId: "letter-expression", attributionId: "letter-attribution", documentId: "letter", locationId: "gate" }, introducedBy: { ...introducedBy, eventId: "read-now" } };
  projection.semantics.acquisitions![value.id] = value;
  const state = structuredClone(projection.state); state.values.letter = { "artifact.location": "gate" };
  const ctx = { ...context, entities: new Map([...context.entities, ["letter", { id: "letter", kind: "artifact" as const, canonicalName: "letter", aliases: [], evidence: [] }]]),
    branchSemantics: projection.semantics,
    attributions: new Map([["letter-attribution", { id: "letter-attribution", propositionId: record.propositionId, holderKind: "document" as const, holderEntityId: "letter", attitude: "asserts" as const, certainty: 1, expressionIds: ["letter-expression"], evidence: [] }]]),
    utteranceExpressions: new Map([["letter-expression", { id: "letter-expression", canonicalEventId: "write", modality: "writing", documentId: "letter", propositionId: record.propositionId, addresseeIds: ["listener"] } as never]]),
    realizedCanonicalEventIds: new Set(["write"]),
    branchOccurrence: { eventId: "read-now", participants: ["listener", "letter"], participantPresence: [{ entityId: "listener", mode: "physical" as const }], before: state, after: state },
  };
  const operation = { op: "learn" as const, actorId: "listener", claimId: record.claimId, propositionId: record.propositionId, acquisitionId: value.id, acquisitionMode: "read" as const, expressionId: "letter-expression", attributionId: "letter-attribution", status: "believes" as const, confidence: 1 };
  expect(validateBranchAcquisitionOperation(operation, ctx, projection.knowledge)).toEqual([]);
  expect(validateBranchAcquisitionOperation(operation, { ...ctx, realizedCanonicalEventIds: new Set() }, projection.knowledge)).toContainEqual(expect.objectContaining({ code: "BRANCH_ACQUISITION_DOCUMENT_UNAVAILABLE" }));
  state.values.letter!["artifact.location"] = "elsewhere";
  expect(validateBranchAcquisitionOperation(operation, ctx, projection.knowledge)).toContainEqual(expect.objectContaining({ code: "BRANCH_ACQUISITION_DOCUMENT_UNAVAILABLE" }));
});

it.each(["Ada calls Bo by radio from another city and says the gate is shut.", "宁通过无线电从另一座城告诉维，城门已经关闭。"])("receives remote speech through a committed channel without physical copresence: %s", async text => {
  const { engine, context, genesis, ready, session, proposal, root } = await setup(text, true);
  expect((await engine.previewProposal(proposal(ready))).report.errors).toEqual([]);
  expect(await engine.branches.readHead("main")).toBe(ready);
  const first = await engine.commitProposal(proposal(ready));
  expect(first.report.errors).toEqual([]);
  const projected = await engine.projections.project(first.newHead, { fresh: true, useCheckpoints: false });
  const receipt = Object.values(projected.knowledge.acquisitions!)[0]!;
  expect(receipt).toMatchObject({ actorId: "listener", reception: { received: true, understood: true, belief: "accepted" } });
  expect(projected.state.values.listener!["character.location"]).toBe("other-gate");
  expect(projected.state.values.speaker!["character.location"]).toBe("gate");
  expect((await new KnowledgeProjector(engine).view("outsider", first.newHead)).knowledge).toEqual([]);
  expect((await new WorldEngine(root, context).projections.project(first.newHead, { fresh: true, useCheckpoints: false })).knowledge).toEqual(projected.knowledge);
  expect((await engine.projections.project(genesis)).knowledge.acquisitions).toBeUndefined();
  for (const reception of [{ received: true, understood: false, belief: "undecided" }, { received: true, understood: true, belief: "rejected" }] as const) {
    const id = reception.understood ? "rejected" : "ununderstood";
    await engine.branches.create({ id, name: id, parentBranchId: "main", forkCommitId: ready, headCommitId: ready });
    const result = await engine.commitProposal({ ...proposal(ready, undefined, reception), branchId: id });
    expect(result.report.errors).toEqual([]);
    const view = await new KnowledgeProjector(engine).view("listener", result.newHead);
    if (reception.understood) expect(view.knowledge[0]!.fact.status).toBe("disbelieves");
    else expect(view.knowledge).toEqual([]);
    expect((await engine.projections.project(result.newHead, { fresh: true, useCheckpoints: false })).state.values.gate!["location.open"]).toBe(false);
  }
  const beforeSession = { ...proposal(genesis), branchId: "sibling" };
  expect((await engine.commitProposal(beforeSession)).report.errors.some(issue => issue.code === "BRANCH_ACQUISITION_CHANNEL_UNPROVEN")).toBe(true);
  expect(await engine.branches.readHead("sibling")).toBe(genesis);
  const invalid = [proposal(first.newHead), proposal(first.newHead), proposal(first.newHead)];
  delete invalid[0]!.spokenUtterances![0]!.channelBinding;
  invalid[1]!.participantPresence![1]!.mode = "represented";
  invalid[2]!.spokenUtterances![0]!.addresseeIds = ["outsider"];
  invalid[2]!.participants.push("outsider");
  for (const input of invalid) { expect((await engine.commitProposal(input)).report.accepted).toBe(false); expect(await engine.branches.readHead("main")).toBe(first.newHead); }
  const paused = await engine.commitProposal({ ...proposal(first.newHead), proposalId: "pause", spokenUtterances: undefined, proposedSemantics: undefined, proposedKnowledge: undefined,
    proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: session!, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  expect((await engine.commitProposal(proposal(paused.newHead))).report.errors.some(issue => issue.code === "BRANCH_ACQUISITION_CHANNEL_UNPROVEN" || issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(await engine.branches.readHead("main")).toBe(paused.newHead);
  const selfAuthorizing = { ...proposal(paused.newHead), proposedProcesses: { version: 1 as const, operations: [{ op: "resume-process" as const, processRef: session! }] } };
  expect((await engine.commitProposal(selfAuthorizing)).report.errors.some(issue => issue.code === "BRANCH_ACQUISITION_CHANNEL_UNPROVEN")).toBe(true);
  expect(await engine.branches.readHead("main")).toBe(paused.newHead);
});

it("stops remote receipt authority failures without a lookup or unchanged retry", () => {
  expect(buildNwhToolRecoveryAdvice("propose_npc_reaction", "BRANCH_ACQUISITION_CHANNEL_UNPROVEN")).toMatchObject({ category: "host-repair-required", retryable: false });
});

it.each([false, true])("receives a prior delivered utterance once, without resaying it (remote=%s)", async remote => {
  const { engine, context, genesis, ready, session, proposal, root } = await setup("A delivered warning about the gate.", remote);
  const spoken = await engine.commitProposal({ ...proposal(ready), proposedSemantics: undefined, proposedKnowledge: undefined });
  expect(spoken.report.errors).toEqual([]);
  const history = await engine.projections.project(spoken.newHead);
  const speechEvent = history.history.at(-1)!.event;
  expect(history.history.at(-1)!.speechDeliveries).toEqual([{ utteranceIndex: 0, recipientId: "listener", delivery: remote ? "remote" : "physical" }]);
  const view = await buildActorDecisionView(engine, "listener", spoken.newHead, { visibleEntityIds: new Set(context.entities.keys()), knownClaimIds: new Set() });
  expect(view.pendingSpeech).toEqual([{ eventId: speechEvent.eventId, utteranceIndex: 0, speakerId: "speaker", content: "A delivered warning about the gate.", delivery: remote ? "remote" : "physical" }]);
  expect((await buildActorDecisionView(engine, "outsider", spoken.newHead, { visibleEntityIds: new Set(context.entities.keys()), knownClaimIds: new Set() })).pendingSpeech).toBeUndefined();
  const encodedView = mapActorDecisionView(view, id => `entity-${id}`, id => `ref-${id}`);
  expect(encodedView.pendingSpeech![0]!.eventId).toBe(`ref-${speechEvent.eventId}`);
  let head = spoken.newHead;
  if (remote) {
    const paused = await engine.commitProposal({ ...proposal(head), proposalId: "pause-before-receipt", spokenUtterances: undefined, proposedSemantics: undefined, proposedKnowledge: undefined,
      proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: session!, reasonId: "closed" }] } });
    expect(paused.report.errors).toEqual([]); head = paused.newHead;
  }
  const receive = { ...proposal(head, { mode: "told", utteranceEventId: speechEvent.eventId, utteranceIndex: 0, attributionId: "local-a" }), source: "actor" as const, actorId: "listener", spokenUtterances: undefined };
  expect(validateActorOutcomeScope(receive, { actorId: "listener", visibleEntityIds: new Set(context.entities.keys()), decision: view })).toEqual([]);
  expect(JSON.stringify(mapActorOutcome(receive, id => id, id => id.startsWith("local-") ? id : `ref-${id}`))).toContain(`ref-${speechEvent.eventId}`);
  const foreign = { ...receive, branchId: "sibling", expectedParentCommit: genesis };
  expect((await engine.commitProposal(foreign)).report.accepted).toBe(false);
  expect(await engine.branches.readHead("sibling")).toBe(genesis);
  const wrong = structuredClone(receive);
  const wrongReceipt = wrong.proposedSemantics!.operations.find(op => op.op === "record-acquisition")!;
  if (wrongReceipt.op === "record-acquisition" && wrongReceipt.acquisition.basis.mode === "told") wrongReceipt.acquisition.basis.utteranceIndex = 1;
  expect((await engine.commitProposal(wrong)).report.accepted).toBe(false);
  expect(await engine.branches.readHead("main")).toBe(head);
  const falseAttribution = structuredClone(receive);
  const attribution = falseAttribution.proposedSemantics!.operations.find(op => op.op === "record-attribution")!;
  if (attribution.op === "record-attribution") attribution.attribution.holderEntityId = "outsider";
  expect(validateActorOutcomeOwnership(falseAttribution, history).length).toBeGreaterThan(0);
  expect((await engine.commitProposal(falseAttribution)).report.accepted).toBe(false);
  expect(await engine.branches.readHead("main")).toBe(head);
  const received = await engine.commitProposal(receive);
  expect(received.report.errors).toEqual([]);
  const replay = await new WorldEngine(root, context).projections.project(received.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.spokenUtterances).toBeUndefined();
  expect(Object.values(replay.knowledge.acquisitions!)).toEqual([expect.objectContaining({ actorId: "listener" })]);
  expect((await buildActorDecisionView(engine, "listener", received.newHead, { visibleEntityIds: new Set(context.entities.keys()), knownClaimIds: new Set() })).pendingSpeech).toBeUndefined();
  const duplicate = await engine.commitProposal({ ...receive, proposalId: "duplicate-receipt", expectedParentCommit: received.newHead });
  expect(duplicate.report.errors.some(issue => issue.code === "BRANCH_SPEECH_ALREADY_RECEIVED")).toBe(true);
  expect(await engine.branches.readHead("main")).toBe(received.newHead);
});

it("offers one scoped delivery correction and stops consumed or inactive receipts", () => {
  const advice = buildNwhToolRecoveryAdvice("propose_npc_reaction", "BRANCH_SPEECH_HISTORY_UNAVAILABLE");
  expect(advice).toMatchObject({ category: "lookup-miss", retryable: true });
  expect(advice.retryCondition).toContain("At most one");
  for (const field of ["decision.pendingSpeech", "eventId", "utteranceIndex", "speakerId"]) expect(advice.steps.join(" ")).toContain(field);
  expect(buildNwhToolRecoveryAdvice("propose_npc_reaction", "BRANCH_SPEECH_ALREADY_RECEIVED")).toMatchObject({ category: "scope-or-lifecycle", retryable: false });
  expect(buildNwhToolRecoveryAdvice("propose_npc_reaction", "BRANCH_SPEECH_HISTORY_UNAVAILABLE", { activeToolNames: [] })).toMatchObject({ category: "scope-or-lifecycle", retryable: false });
});
