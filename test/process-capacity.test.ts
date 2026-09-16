import { deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { applyProcessDelta, emptyProcessState } from "../src/world/process-effects.js";
import { buildSceneExecutionContracts } from "../src/compiler/scene-execution-contracts.js";
import { executeSceneEvent } from "../src/compiler/scene-state.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema, processProposalOperationSchema } from "../src/world/model.js";
import { processTemplateSchema, dueProcessInstances } from "../src/world/process-ontology.js";
import { lacksCapacity, capacityUseIssues } from "../src/world/process-capacity.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { contentHash } from "../src/world/canonical.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const capacities = ["action", "speech", "perception"] as const;
const scenes = [
  { actor: "Rin", helper: "Mira", site: "station", english: true },
  { actor: "宁", helper: "维", site: "码头", english: false },
].flatMap(scene => [false, true].map(known => ({ ...scene, known })));
it.each(scenes)("executes source-grounded incapacity and recovers only by committed mechanisms: $actor / known=$known", async scene => {
  const duration = scene.known ? { kind: "days", days: 2 } : { kind: "unknown" };
  const text = scene.english
    ? `At the station, Rin plans to leave and Mira stands beside Rin. A spell stops Rin from acting, speaking and perceiving. ${scene.known ? "Its effect wears off after two days." : "Nobody knows how long it will last."} Mira applies the antidote and Rin recovers all three capacities. Later Mira applies the same antidote again to cure Rin.`
    : `宁准备离开码头，维站在宁身边。咒语使宁无法行动、说话和感知。${scene.known ? "效果在两天后消退。" : "没有人知道效果会持续多久。"}维施用解药，宁恢复了这三种能力。后来维再次施用同样的解药治愈宁。`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-capacity-")); roots.push(root);
  const source = await createEvidenceFixture(root, text), canon = new CanonicalModelStore(root);
  for (const [id, canonicalName, kind] of [["patient", scene.actor, "character"], ["helper", scene.helper, "character"], ["site", scene.site, "location"]] as const) await canon.putEntity({ id, canonicalName, kind, aliases: [], evidence: source.evidence(canonicalName) });
  const event = canonicalEventSchema.parse({ id: "onset", title: "The spell takes effect", participants: ["patient"], participantPresence: [{ entityId: "patient", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: source.evidence(text) });
  await canon.putEvent(event);
  await canon.putProposition({ id: "at-site", subjectEntityId: "patient", relationId: "character.location", object: { kind: "entity", entityId: "site" }, polarity: "positive", modality: "asserted", evidence: source.evidence(text) });
  await canon.putClaim({ id: "at-site", subject: "patient", predicate: "character.location", object: "site", epistemicType: "explicit-fact", evidence: source.evidence(text) });
  for (const id of ["treatment", "treatment-again"]) await canon.putEvent({ ...event, id, title: "The antidote restores capacity", participants: ["patient", "helper"], participantPresence: [{ entityId: "patient", mode: "physical" }, { entityId: "helper", mode: "physical" }] });
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "capacity", source.source.id);
  const invoke = (name: string, input: unknown) => toolset.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  const role = (id: string) => ({ id, label: id, allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 });
  const action = { ontologyVersion: "action-schema-v1", id: "treat", name: "Apply the antidote", roles: [role("helper"), role("patient")], initiatorRoleId: "helper", parameters: [], preconditions: ["helper", "patient"].map(roleId => ({ op: "fact-equals", entity: { kind: "role", roleId }, field: "character.location", value: { source: "literal", value: "site" } })), stateEffects: [], effectEnvelope: { maxStateOperations: 0, allowedStateFields: [], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false }, visibility: "public", knownByClaimIds: [], induction: { kind: "source-pattern", supportingEventIds: ["treatment", "treatment-again"] } };
  await invoke("propose_action_schema", { proposal_id: "treat", payload: action, evidence_segment_ids: [source.segmentId] });
  for (const capacity of capacities) {
    const template = { ontologyVersion: "process-template-v1", id: `incapacity-${capacity}`, name: `Loss of ${capacity}`, ownerRoles: [role("patient")], phases: [{ id: "impaired", label: "Impaired", terminal: false }, { id: "recovered", label: "Recovered", terminal: true }], initialPhaseId: "impaired", transitions: [{ fromPhaseId: "impaired", toPhaseId: "recovered", minimumProgress: 1, ...(scene.known ? { onDue: { advanceBy: 1, outcomeId: "recovered" } } : {}) }], ...(scene.known ? { cadence: { kind: "elapsed-days", intervalDays: 2 } } : {}), outcomeIds: ["recovered"], visibility: "public", knownByClaimIds: [], induction: { kind: "source-pattern", supportingEventIds: [event.id, "treatment", "treatment-again"] }, incapacity: { version: "incapacity-process-v1", ownerRoleId: "patient", capacity, recoveryPhaseId: "recovered", duration }, actorControls: [{ op: "advance-process", actionPattern: { kind: "schema", schemaId: "treat" }, fromPhaseId: "impaired", toPhaseId: "recovered", maximumAdvance: 1 }, { op: "finish-process", actionPattern: { kind: "schema", schemaId: "treat" }, fromPhaseId: "recovered", outcomeId: "recovered" }] };
    const selectors = ["/incapacity/ownerRoleId", "/incapacity/capacity", "/incapacity/recoveryPhaseId", "/incapacity/duration"].map(target_path => ({ segment_id: source.segmentId, exact: text, target_path, relation: "supports", strength: "explicit" }));
    await invoke("propose_process_template", { proposal_id: template.id, payload: template, evidence_segment_ids: [source.segmentId], evidence_selectors: selectors });
    await invoke("propose_semantic_effect", { proposal_id: `effect-${capacity}`, payload: { ontologyVersion: "semantic-effect-v1", id: `effect-${capacity}`, canonicalEventId: event.id, subjectEntityId: "patient", validTime: event.storyTime, kind: "temporary-incapacity", args: { capacity, duration }, lowering: { status: "mapped", processTemplateId: template.id } }, evidence_segment_ids: [source.segmentId], evidence_selectors: ["/canonicalEventId", "/subjectEntityId", "/kind", "/validTime", "/args/capacity", "/args/duration"].map(target_path => ({ segment_id: source.segmentId, exact: text, target_path, relation: "supports", strength: "explicit" })) });
  }
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Capacity processes preserve known and unknown recovery times" });
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const initial = { version: 1 as const, operations: [{ op: "set" as const, entityId: "patient", field: "character.alive", value: true }, { op: "set" as const, entityId: "helper", field: "character.alive", value: true }, { op: "set" as const, entityId: "patient", field: "character.location", value: "site" }, { op: "set" as const, entityId: "helper", field: "character.location", value: "site" }, { op: "set" as const, entityId: "patient", field: "character.plan", value: "leave" }] };
  await new InitialWorldStore(root).put({ version: 1, delta: initial, participantPresence: [{ entityId: "patient", mode: "physical" }], evidence: source.evidence(text) });
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot), bundle = await cache.candidateSnapshot(source.source), archived = await cache.archiveCandidate(source.source);
  expect(buildPreparedClosure(bundle).nodes.find(node => node.kind === "semantic-effect")?.dependsOn.some(ref => ref.kind === "process")).toBe(true);
  // The independent scene consumer must retain onset processes while replaying
  // an ordered cut, and must not certify an action that runtime rejects.
  const sceneBundle = structuredClone(bundle);
  const sceneOnset = { ...event, storyTime: { kind: "ordinal" as const, label: "onset", orderHint: 1 } };
  const attempt = { ...event, id: "attempt", storyTime: { kind: "ordinal" as const, label: "attempt", orderHint: 2 }, observedOutcome: { version: 1 as const, operations: [{ op: "set" as const, entityId: "patient", field: "character.plan", value: "leave now" }] } };
  sceneBundle.canonical.events = [sceneOnset, attempt];
  sceneBundle.canonical.semanticEffects = sceneBundle.canonical.semanticEffects!.map(effect => ({ ...effect, validTime: sceneOnset.storyTime }));
  sceneBundle.canonical.initialWorld.checkpoint = { beforeCanonicalEventId: sceneOnset.id, storyTime: sceneOnset.storyTime } as never;
  sceneBundle.canonical.eventParticipations = [{ id: "attempt-agent", eventId: attempt.id, entityId: "patient", role: "agent", evidence: source.evidence(text) }] as never;
  const sceneStart = executeSceneEvent(sceneBundle, sceneOnset);
  expect(Object.keys(sceneStart.beforeProcesses.instances)).toHaveLength(0);
  expect(Object.keys(sceneStart.processes.instances)).toHaveLength(3);
  expect(() => executeSceneEvent(sceneBundle, attempt)).toThrow("CHARACTER_ACTION_INCAPACITATED");
  sceneBundle.canonical.sceneOccurrences = [{ ontologyVersion: "scene-occurrence-v1", id: "loss-scene", discourseSegmentIds: [source.segmentId], eventIds: [sceneOnset.id], viewpointActorIds: ["patient"], presentActorIds: ["patient"], entryConditions: [], exitConditions: [], evidence: source.evidence(text) }];
  const sceneContract = buildSceneExecutionContracts(sceneBundle).contracts[0]!;
  expect(sceneContract.requiredMechanismIds).toEqual(capacities.map(capacity => `process/incapacity-${capacity}`).sort());
  const revisedMechanism = structuredClone(sceneBundle);
  revisedMechanism.canonical.processTemplates[0]!.name += " revised";
  expect(buildSceneExecutionContracts(revisedMechanism).contracts[0]!.revisionHash).not.toBe(sceneContract.revisionHash);
  const unmappedScene = structuredClone(sceneBundle);
  unmappedScene.canonical.semanticEffects![0]!.lowering = { status: "unmapped", reason: "No supported mechanism" } as never;
  expect(() => executeSceneEvent(unmappedScene, sceneOnset)).toThrow("SEMANTIC_EFFECT_UNMAPPED");
  const entryBundle = structuredClone(sceneBundle);
  const beforeEntry = { ...sceneOnset, readerSummary: "The spell removes the patient's capacities", narrativeContext: { layerId: "main", mode: "scene" as const, discourseOrder: 1 } };
  const passingTime = { ...beforeEntry, id: "passing-time", title: "A day passes", storyTime: { kind: "ordinal" as const, label: "one day later", orderHint: 2 }, timeAdvance: { amount: 1, unit: "day" as const }, narrativeContext: { layerId: "main", mode: "scene" as const, discourseOrder: 2 } };
  const entryEvent = { ...beforeEntry, id: "helper-entry", participants: ["helper", "patient"], participantPresence: [{ entityId: "helper", mode: "physical" as const }, { entityId: "patient", mode: "physical" as const }], storyTime: { kind: "ordinal" as const, label: "arrival", orderHint: 3 }, narrativeContext: { layerId: "main", mode: "scene" as const, discourseOrder: 3 }, characterEntryCheckpoints: [{ actorId: "helper", readerSetup: "The patient remains incapacitated", actorObservation: "The patient lies still", participantPresence: [{ entityId: "helper", mode: "physical" as const }], delta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "helper", field: "character.location", value: "site" }] } }] };
  entryBundle.canonical.events = [beforeEntry, passingTime, entryEvent];
  entryBundle.canonical.eventParticipations = [];
  const entrySeed = deriveCharacterEntrySeed(entryBundle, "helper");
  expect(entrySeed.projectionSeed!.elapsedDays).toBe(1);
  expect(entrySeed.projectionSeed!.processes.operations).toHaveLength(3);
  for (const operation of entrySeed.projectionSeed!.processes.operations) if (operation.op === "start-process") {
    expect(operation.process.startedAtElapsedDays).toBe(0);
    expect(operation.process.dueAtElapsedDays).toBe(scene.known ? 2 : undefined);
  }
  const seedProcessContext = { entities: new Map(entryBundle.canonical.entities.map(item => [item.id, item])), templates: new Map(entryBundle.canonical.processTemplates.map(item => [item.id, item])) };
  const seedProvenance = { commitId: "entry", eventId: "entry", eventHash: "a".repeat(64) };
  expect(() => applyProcessDelta(emptyProcessState("entry"), entrySeed.projectionSeed!.processes, seedProcessContext, seedProvenance, 1)).toThrow("PROCESS_ONSET_TIME_INVALID");
  expect(processProposalOperationSchema.safeParse({ op: "start-process", localRef: "local-backdated", process: { templateId: "incapacity-action", ownerBindings: [{ roleId: "patient", entityIds: ["patient"] }], progress: 0, startedAtElapsedDays: 0 } }).success).toBe(false);
  const futureSeed = structuredClone(entrySeed.projectionSeed!.processes);
  const futureStart = futureSeed.operations[0]!;
  if (futureStart.op === "start-process") futureStart.process.startedAtElapsedDays = 2;
  expect(() => applyProcessDelta(emptyProcessState("entry"), futureSeed, { ...seedProcessContext, allowHistoricalStarts: true }, seedProvenance, 1)).toThrow("PROCESS_ONSET_TIME_INVALID");
  const restored = applyProcessDelta(emptyProcessState("entry"), entrySeed.projectionSeed!.processes, { ...seedProcessContext, allowHistoricalStarts: true }, seedProvenance, 3);
  expect(dueProcessInstances(restored, 3)).toHaveLength(scene.known ? 3 : 0);
  expect(lacksCapacity("patient", "action", restored, seedProcessContext.templates)).toBe(true);
  const entryContext = await new WorldContextStore(root).capturePrepared(source.source.id, contentHash(entryBundle), {
    ...entryBundle.canonical, sceneOccurrences: [], events: [...entryBundle.canonical.events, ...bundle.canonical.events.filter(item => item.id !== event.id)],
  });
  const entryEngine = new WorldEngine(root, entryContext);
  const entryHead = await entryEngine.createBranch("late-entry", "A day after onset", entrySeed.delta, entrySeed.knowledge, undefined, undefined, [], { storyTime: entrySeed.storyTime }, { projectionSeed: entrySeed.projectionSeed, realizesCanonicalEventIds: entrySeed.realizesCanonicalEventIds });
  const entryReplay = await entryEngine.projections.project(entryHead, { fresh: true, useCheckpoints: false });
  expect(entryReplay.state.logicalTime.elapsedDays).toBe(1);
  expect(Object.values(entryReplay.processes.instances).map(item => item.dueAtElapsedDays)).toEqual(capacities.map(() => scene.known ? 2 : undefined));
  expect(lacksCapacity("patient", "action", entryReplay.processes, entryContext.processTemplates!)).toBe(true);
  const entryRuntime = new WorldRuntime(entryEngine, () => []);
  await entryRuntime.forkBranch("late-entry", entryHead, "late-fork", "Same historical onset");
  const forkHead = (await entryEngine.branches.read("late-fork")).headCommitId!;
  expect((await entryEngine.projections.project(forkHead, { fresh: true, useCheckpoints: false })).processes.instances).toEqual(entryReplay.processes.instances);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-capacity-clone-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, text); await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(cloneSource.source, archived.bundleHash!);
  const contexts = new WorldContextStore(cloneRoot), context = await contexts.captureCurrent(cloneSource.source.id), engine = new WorldEngine(cloneRoot, context);
  const head = await engine.createBranch("main", "Before incapacity", initial, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
  const runtime = new WorldRuntime(engine, () => []); await runtime.forkBranch("main", head, "untouched", "No onset");
  const proposal = { proposalId: "onset", branchId: "main", expectedParentCommit: head, source: "canon-candidate", title: "The spell takes effect", participants: ["patient"], participantPresence: event.participantPresence, possibilityId: "canon-onset", preconditions: [], proposedTime: { kind: "unknown" }, proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [] };
  const duplicate = await engine.commitProposal({ ...proposal, proposedProcesses: { version: 1, operations: ["local-first", "local-second"].map(localRef => ({ op: "start-process", localRef, process: { templateId: "incapacity-action", ownerBindings: [{ roleId: "patient", entityIds: ["patient"] }], progress: 0 } })) } } as never);
  expect(duplicate.report.errors.some(issue => issue.message.includes("INCAPACITY_ONSET_DUPLICATE"))).toBe(true);
  const onset = await engine.commitProposal(proposal as never); expect(onset.report.errors).toEqual([]);
  const disabled = await engine.projections.project(onset.newHead, { fresh: true, useCheckpoints: false });
  expect(Object.values(disabled.processes.instances)).toHaveLength(3);
  for (const capacity of capacities) expect(lacksCapacity("patient", capacity, disabled.processes, context.processTemplates!)).toBe(true);
  const speak = { ...proposal, proposalId: "speak", possibilityId: undefined, expectedParentCommit: onset.newHead, source: "actor", actorId: "patient", participants: ["patient", "helper"], spokenUtterances: [{ speakerId: "patient", addresseeIds: ["helper"], content: "I can speak" }] };
  expect((await engine.commitProposal(speak as never)).report.errors.map(issue => issue.code)).toEqual(expect.arrayContaining(["CHARACTER_ACTION_INCAPACITATED", "CHARACTER_SPEECH_INCAPACITATED"]));
  expect((await engine.commitProposal({ ...speak, actorId: undefined, source: "background" } as never)).report.errors.some(issue => issue.code === "CHARACTER_SPEECH_INCAPACITATED")).toBe(true);
  expect(capacityUseIssues({ knowledge: { version: 1, operations: [{ op: "learn", actorId: "patient", claimId: "seen", propositionId: "seen", acquisitionMode: "observed", status: "heard", confidence: 1 }] } }, disabled.processes, disabled.processes, context.processTemplates!).some(issue => issue.code === "CHARACTER_PERCEPTION_INCAPACITATED")).toBe(true);
  const seen = await engine.commitProposal({ ...proposal, proposalId: "sense", source: "background", possibilityId: undefined, expectedParentCommit: onset.newHead, proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "patient", claimId: "at-site", propositionId: "at-site", acquisitionMode: "observed", status: "heard", confidence: 1 }] } } as never);
  expect(seen.report.errors.some(issue => issue.code === "CHARACTER_PERCEPTION_INCAPACITATED")).toBe(true);
  const ids = Object.keys(disabled.processes.instances);
  const pause = await engine.commitProposal({ ...proposal, proposalId: "pause", source: "background", possibilityId: undefined, expectedParentCommit: onset.newHead, proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: ids[0], reasonId: "pause" }] } } as never);
  expect(pause.report.errors.some(issue => issue.message.includes("INCAPACITY_RECOVERY_UNAUTHORIZED"))).toBe(true);
  const recoveryOperations = ids.flatMap(processRef => [{ op: "advance-process", processRef, amount: 1, phaseId: "recovered" }, { op: "finish-process", processRef, outcomeId: "recovered" }]);
  const recover = { ...proposal, proposalId: "recover", source: "background", expectedParentCommit: onset.newHead, possibilityId: undefined, participants: ["patient", "helper"], proposedProcesses: { version: 1, operations: recoveryOperations } };
  expect((await engine.commitProposal(recover as never)).report.errors.some(issue => issue.message.includes("INCAPACITY_RECOVERY_UNAUTHORIZED"))).toBe(true);
  const wait = await engine.commitProposal({ ...proposal, proposalId: "wait", source: "background", possibilityId: undefined, expectedParentCommit: onset.newHead, timeAdvance: { amount: scene.known ? 2 : 100, unit: "day" } } as never); expect(wait.report.errors).toEqual([]);
  const waited = await engine.projections.project(wait.newHead, { fresh: true, useCheckpoints: false });
  for (const capacity of capacities) expect(lacksCapacity("patient", capacity, waited.processes, context.processTemplates!)).toBe(true);
  expect(dueProcessInstances(waited.processes, waited.state.logicalTime.elapsedDays!)).toHaveLength(scene.known ? 3 : 0);
  const actionInvocation = { lane: "schema-bound", schemaId: "treat", roleBindings: [{ roleId: "helper", entityIds: ["helper"] }, { roleId: "patient", entityIds: ["patient"] }], parameters: {} };
  if (!scene.known) {
    const wrongPatient = await engine.commitProposal({ ...recover, expectedParentCommit: wait.newHead, source: "actor", actorId: "helper", action: { ...actionInvocation, roleBindings: [{ roleId: "helper", entityIds: ["helper"] }, { roleId: "patient", entityIds: ["helper"] }] } } as never);
    expect(wrongPatient.report.errors.some(issue => issue.code === "ACTOR_OUTCOME_AUTHORITY_REQUIRED" || issue.message.includes("INCAPACITY_RECOVERY_UNAUTHORIZED")), JSON.stringify(wrongPatient.report.errors)).toBe(true);
    const inventedDeadline = await engine.commitProposal({ ...recover, expectedParentCommit: wait.newHead, source: "actor", actorId: "helper", action: actionInvocation, proposedProcesses: { version: 1, operations: [{ op: "advance-process", processRef: ids[0], amount: 1, phaseId: "recovered", dueAtElapsedDays: 101 }] } } as never);
    expect(inventedDeadline.report.accepted).toBe(false);
  }
  const recovered = await engine.commitProposal({ ...recover, expectedParentCommit: wait.newHead, ...(scene.known ? {} : { source: "actor", actorId: "helper", action: actionInvocation }) } as never); expect(recovered.report.errors).toEqual([]);
  const replay = await engine.projections.project(recovered.newHead, { fresh: true, useCheckpoints: false });
  for (const capacity of capacities) expect(lacksCapacity("patient", capacity, replay.processes, context.processTemplates!)).toBe(false);
  const spoke = await engine.commitProposal({ ...speak, expectedParentCommit: recovered.newHead } as never); expect(spoke.report.errors).toEqual([]);
  expect(Object.keys((await engine.projections.project(head, { fresh: true, useCheckpoints: false })).processes.instances)).toEqual([]);
  const saved = (await canon.listProcessTemplates())[0]!;
  if (!scene.known) expect(processTemplateSchema.safeParse({ ...saved, cadence: { kind: "elapsed-days", intervalDays: 1 } }).success).toBe(false);
  const { evidence: _savedEvidence, ...templatePayload } = saved;
  const missingProof = createCompilerProposalToolset(root); await missingProof.beginBatch([], "missing-capacity-proof", source.source.id);
  await expect(missingProof.tools.find(tool => tool.name === "propose_process_template")!.execute("missing", { proposal_id: "missing", payload: { ...templatePayload, id: "missing" }, evidence_segment_ids: [source.segmentId] } as never, undefined, undefined, {} as never)).rejects.toThrow("INCAPACITY_EVIDENCE_MISSING");
  await new EvidenceAssertionStore(root).replaceForArtifact("process-template", saved.id, contentHash(saved), []);
  await expect(cache.candidateSnapshot(source.source)).rejects.toThrow("Incapacity process evidence");
});
