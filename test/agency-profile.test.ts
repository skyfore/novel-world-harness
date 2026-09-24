import { worldValidateCommand } from "../src/commands/world.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { canonicalEventSchema, characterEntryCheckpointSchema, entitySchema, type EventProposal, type StateDelta } from "../src/world/model.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import { projectAgencyChannels, validateAgencyProfile, validateAgencyUse } from "../src/world/agency-profile.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { buildActorDecisionView, decisionReferenceIds, mapActorDecisionView } from "../src/world/actor-decision-view.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { WorldContextStore } from "../src/world/context.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { contentHash } from "../src/world/canonical.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { PlayerTurnService, buildActorScopedActionContext, createPlayerActionModelBoundary, playerActionTranslationContext, playerActionCandidateSchema, playerActionToKnowledgeAwareAction, validatePlayerActionScope, validatePlayerActionSpatialScope } from "../src/world/player-action.js";
import { respondToNpcInteractions } from "../src/world/npc-reaction.js";
import { decisionContextRequirements } from "../src/agent/decision-context.js";
import { modelActorProposalSource } from "../src/world/model-actor-policy.js";
import { deriveCharacterEntryOptions, deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { buildPlayOpeningFrame, playerSceneModelFrame } from "../src/world/play-opening.js";
import { CompilerValidator } from "../src/compiler/validator.js";
import { executeSceneEvent } from "../src/world/source-history.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { WorldRuntime } from "../src/world/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scenes = [
  { voice: "Vera", peer: "Bo", carrier: "Console", photo: "Portrait", crate: "Crate", quote: "I can hear you.", text: "Bo stands beside Console and plans to listen. Bo can answer through the same live connection. Vera is an autonomous voice without a body. The connection is already open; Vera plans to speak through it. Console carries Vera's live audio to Bo while the connection is open. Console also operates an arm that can deliver Vera's Crate to Bo. Portrait is a passive picture, with no live agency or communication channel." },
  { voice: "灵音", peer: "阿维", carrier: "终端", photo: "照片", crate: "箱子", quote: "我能听见你。", text: "阿维站在终端旁，打算倾听，也能通过同一实时连接回答。灵音是自主行动的无身体声音。连接已经开启，灵音打算通过连接发言。连接开启时，终端把灵音的实时语音传给阿维。终端还控制机械臂，能把灵音的箱子交给阿维。照片只是静态图像，没有当前能动性或通信渠道。" },
];

async function fixture(scene = scenes[0]!, duplex = false, autonomousGoal = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-agency-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), evidence = source.evidence(scene.text);
  const roles = [
    { id: "actor", label: "Initiator", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "peer", label: "Peer", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "carrier", label: "Carrier", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 },
  ];
  const template = processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "connection", name: "Connection", ownerRoles: roles,
    phases: [{ id: "connected", label: "Connected", terminal: false }, { id: "closed", label: "Closed", terminal: true }],
    initialPhaseId: "connected", transitions: [{ fromPhaseId: "connected", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["disconnected"],
    visibility: "public", induction: { kind: "domain-module", moduleId: "test-communication", moduleVersion: "1" }, evidence: [] });
  const control = actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id: "arm-transfer", name: "Arm transfer", roles,
    initiatorRoleId: "actor", parameters: [], preconditions: [],
    stateEffects: [{ op: "set", entity: { kind: "entity", entityId: "crate" }, field: "artifact.owner", value: { source: "role", roleId: "peer" }, required: true }],
    effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["artifact.owner"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
    visibility: "public", induction: { kind: "domain-module", moduleId: "test-arm", moduleVersion: "1" }, evidence: [] });
  const channel = { id: "voice", modality: "audio", processTemplateId: template.id, actorRoleId: "actor", peerRoleId: "peer", carrierRoleId: "carrier", activePhaseIds: ["connected"] };
  const voice = entitySchema.parse({ id: "voice", kind: "character", canonicalName: scene.voice, aliases: [], evidence,
    agencyProfile: { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "mediated", channels: [channel, { ...channel, id: "arm", modality: "physical-control", actionSchemaId: control.id }] } });
  const photo = entitySchema.parse({ id: "photo", kind: "artifact", canonicalName: scene.photo, aliases: [], evidence,
    agencyProfile: { ontologyVersion: "agency-channel-v1", agency: "none", embodiment: "bodily", channels: [] } });
  const entities = [voice, photo, ...[["peer", scene.peer, "character"], ["console", scene.carrier, "artifact"], ["crate", scene.crate, "artifact"]].map(([id, name, kind]) => entitySchema.parse({ id, kind, canonicalName: name, aliases: [], evidence }))];
  if (duplex) entities.find(entity => entity.id === "peer")!.agencyProfile = {
    ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily",
    channels: [{ ...voice.agencyProfile!.channels[0]!, id: "reply", actorRoleId: "peer", peerRoleId: "actor" }],
  };
  const context: WorldModelContext = { sourceId: source.source.id, entities: new Map(entities.map(entity => [entity.id, entity])),
    rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), processTemplates: new Map([[template.id, template]]), actionSchemas: new Map([[control.id, control]]) };
  if (autonomousGoal) context.actorGoals = [{ id: "confirm", actorId: "voice", description: "Confirm the connection", priority: 1, requiresKnowledge: [], targetIds: ["peer"], evidence }];
  const initial: StateDelta = { version: 1, operations: [
    { op: "set", entityId: "voice", field: "character.alive", value: true }, { op: "set", entityId: "peer", field: "character.alive", value: true },
    { op: "set", entityId: "peer", field: "character.plan", value: "listen" },
    { op: "set", entityId: "crate", field: "artifact.owner", value: "voice" }, { op: "set", entityId: "console", field: "artifact.owner", value: "peer" },
  ] };
  const engine = new WorldEngine(root, context), head = await engine.createBranch("main", "Main", initial);
  const rolesBound = [{ roleId: "actor", entityIds: ["voice"] }, { roleId: "peer", entityIds: ["peer"] }, { roleId: "carrier", entityIds: ["console"] }];
  const base: EventProposal = { proposalId: "connect", branchId: "main", expectedParentCommit: head, source: "background", title: "Connection", participants: ["voice", "peer", "console", "crate"],
    participantPresence: [{ entityId: "voice", mode: "remote" }, { entityId: "peer", mode: "physical" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence };
  const started = await engine.commitProposal({ ...base, proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-call", process: { templateId: template.id, ownerBindings: rolesBound, progress: 0 } }] } });
  expect(started.report.errors).toEqual([]);
  const session = Object.keys((await engine.projections.project(started.newHead)).processes.instances)[0]!;
  const speech: EventProposal = { ...base, proposalId: "speak", expectedParentCommit: started.newHead, source: "actor", actorId: "voice",
    spokenUtterances: [{ speakerId: "voice", addresseeIds: ["peer"], content: scene.quote, channel: "audible", channelBinding: { channelId: "voice", processId: session } }] };
  return { root, source, scene, voice, photo, template, control, context, initial, engine, head, started, session, speech, rolesBound, base };
}

it.each(scenes)("allows session-bound remote audio and only mechanism-bound physical control: $voice", async scene => {
  const f = await fixture(scene);
  const invalid = await f.engine.commitProposal({ ...f.speech, spokenUtterances: undefined, proposedDelta: { version: 1, operations: [{ op: "set", entityId: "crate", field: "artifact.owner", value: "peer" }] } });
  expect(invalid.report.errors.some(error => error.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(invalid.newHead).toBe(f.started.newHead);
  const spoken = await f.engine.commitProposal(f.speech); expect(spoken.report.errors).toEqual([]);
  const control = await f.engine.commitProposal({ ...f.speech, proposalId: "control", expectedParentCommit: spoken.newHead, spokenUtterances: undefined,
    action: { lane: "schema-bound", schemaId: f.control.id, roleBindings: f.rolesBound, parameters: {}, channelBinding: { channelId: "arm", processId: f.session } },
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: "crate", field: "artifact.owner", value: "peer" }] } });
  expect(control.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(control.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.state.values.crate?.["artifact.owner"]).toBe("peer");
  expect(replay.knowledge.actors.peer).toBeUndefined();
  expect(replay.history.at(-2)!.event.spokenUtterances?.[0]?.content).toBe(scene.quote);
});

it("keeps photos, unknown/paused sessions, other actors and same-event starts from granting agency", async () => {
  const f = await fixture();
  for (const proposal of [
    { ...f.speech, participantPresence: [{ entityId: "voice", mode: "represented" as const }] },
    { ...f.speech, participantPresence: [{ entityId: "voice", mode: "physical" as const }] },
    { ...f.speech, actorId: "photo", participants: [...f.speech.participants, "photo"], spokenUtterances: undefined, proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "crate", field: "artifact.owner", value: "peer" }] } },
    { ...f.speech, spokenUtterances: [{ ...f.speech.spokenUtterances![0]!, channelBinding: undefined }] },
  ]) {
    const result = await f.engine.commitProposal(proposal);
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some(error => error.code.startsWith("AGENCY_"))).toBe(true);
    expect(result.newHead).toBe(f.started.newHead);
  }
  await new WorldRuntime(f.engine, () => []).forkBranch("main", f.head, "before", "Before connection");
  expect((await f.engine.commitProposal({ ...f.speech, branchId: "before", expectedParentCommit: f.head,
    proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-call", process: { templateId: f.template.id, ownerBindings: f.rolesBound, progress: 0 } }] } })).report.accepted).toBe(false);
  const paused = await f.engine.commitProposal({ ...f.base, proposalId: "pause", expectedParentCommit: f.started.newHead,
    proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "disconnected" }] } });
  expect(paused.report.errors).toEqual([]);
  const denied = await f.engine.commitProposal({ ...f.speech, expectedParentCommit: paused.newHead });
  expect(denied.report.errors.some(error => error.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(denied.newHead).toBe(paused.newHead);
});

it("projects only visible running channels and maps their handles at the actor boundary", async () => {
  const f = await fixture();
  const scope = { sourceId: f.source.source.id, visibleEntityIds: new Set(f.context.entities.keys()), knownClaimIds: new Set<string>() };
  const view = await buildActorDecisionView(f.engine, "voice", f.started.newHead, scope);
  expect(view.agency?.channels).toHaveLength(2);
  expect(decisionReferenceIds(view)).toEqual(expect.arrayContaining([f.session, f.control.id, "arm", "voice"]));
  const mapped = mapActorDecisionView(view, id => `entity-${id}`, id => `ref-${id}`);
  expect(mapped.agency?.channels[0]).toMatchObject({ processId: `ref-${f.session}`, peerEntityIds: ["entity-peer"], carrierEntityIds: ["entity-console"] });
  const hidden = await buildActorDecisionView(f.engine, "voice", f.started.newHead, { ...scope, visibleEntityIds: new Set(["voice", "peer"]) });
  expect(hidden.agency?.channels).toEqual([]);
  const before = await f.engine.projections.project(f.head);
  expect(projectAgencyChannels(f.voice, before.processes, f.context, scope)?.channels).toEqual([]);
  expect(projectAgencyChannels(f.photo, before.processes, f.context, scope)).toMatchObject({ agency: "none", channels: [] });
  expect(projectAgencyChannels(f.context.entities.get("peer")!, before.processes, f.context, scope)).toBeUndefined();
  const current = await f.engine.projections.project(f.started.newHead);
  const hiddenContext = { ...f.context, processTemplates: new Map([[f.template.id, { ...f.template, visibility: "engine" as const }]]) };
  expect(validateAgencyUse(f.speech, f.speech.proposedDelta, hiddenContext, current.processes, current.knowledge).some(error => error.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  const unknownContext = { ...f.context, processTemplates: new Map([[f.template.id, { ...f.template, visibility: "knowledge" as const, knownByClaimIds: ["unknown-protocol"] }]]) };
  expect(validateAgencyUse(f.speech, f.speech.proposedDelta, unknownContext, current.processes, current.knowledge).some(error => error.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);

});

it.each(scenes.flatMap(scene => [false, true].map(later => ({ ...scene, later, text: scene.text + (later ? (scene.voice === "Vera" ? "\nA moment later Vera prepares to reply through the still-open connection." : "\n片刻后，灵音准备通过仍开启的连接回答。") : "") }))))("compiles, archives and rebuilds agency profiles with exact evidence: $voice later=$later", async scene => {
  const f = await fixture(scene), canon = new CanonicalModelStore(f.root);
  for (const entity of f.context.entities.values()) { const { agencyProfile: _, ...identity } = entity; await canon.putEntity(identity); }
  await canon.putProcessTemplate(f.template); await canon.putActionSchema(f.control);
  const tools = createCompilerProposalToolset(f.root); await tools.beginBatch([], "agency", f.source.source.id);
  const invoke = (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  for (const entity of [f.voice, f.photo]) {
    const { evidence: _, ...payload } = entity;
    const input = { proposal_id: `profile-${entity.id}`, payload, evidence_segment_ids: [f.source.segmentId] };
    await expect(invoke("propose_entity", input)).rejects.toThrow("AGENCY_EVIDENCE_REQUIRED");
    const paths = ["/agencyProfile/agency", "/agencyProfile/embodiment", ...entity.agencyProfile!.channels.flatMap((channel, i) => [
      ...["modality", "processTemplateId", "actorRoleId", "peerRoleId", "carrierRoleId", ...(channel.actionSchemaId ? ["actionSchemaId"] : [])].map(key => `/agencyProfile/channels/${i}/${key}`),
      ...channel.activePhaseIds.map((_, n) => `/agencyProfile/channels/${i}/activePhaseIds/${n}`),
    ])];
    await invoke("propose_entity", { ...input, evidence_selectors: paths.map(target_path => ({ segment_id: f.source.segmentId, exact: scene.text, target_path, relation: "supports", strength: "explicit" })) });
  }
  const connectionEvent = (await f.engine.projections.project(f.started.newHead)).history.at(-1)!.event;
  const processes = await f.engine.objects.getProcessDelta(connectionEvent.effects.processDeltaHash!);
  const initialPayload = { version: 1, delta: { version: 1, operations: [...f.initial.operations, { op: "set", entityId: "voice", field: "character.plan", value: "speak" }] },
    participantPresence: [{ entityId: "voice", mode: "remote" }], actorObservations: [{ actorId: "voice", summary: "你准备通过已开启的连接发言。" }],
    projectionSeed: { version: 1, processes, semantics: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 } };
  if (scene.later) {
    initialPayload.participantPresence = [{ entityId: "peer", mode: "physical" }];
    initialPayload.actorObservations = [{ actorId: "peer", summary: "你在终端旁准备倾听。" }];
  }
  const initialInput = { proposal_id: "remote-opening", payload: { ...initialPayload, checkpoint: { mode: "chronological", rationale: "Before the later exchange", storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } } }, evidence_segment_ids: [f.source.segmentId] };
  if (!scene.later) await expect(invoke("propose_initial_world", initialInput)).rejects.toThrow("ENTRY_AGENCY_EVIDENCE_REQUIRED");
  await invoke("propose_initial_world", { ...initialInput, evidence_selectors: ["/participantPresence/0/mode", "/actorObservations/0/summary",
    ...processes.operations.map((_, index) => `/projectionSeed/processes/operations/${index}`)].map(target_path => ({ segment_id: f.source.segmentId, exact: scene.text, target_path, relation: "supports", strength: "explicit" })) });
  if (scene.later) {
    await invoke("propose_canonical_event", { proposal_id: "later-event", evidence_segment_ids: [f.source.segmentId], payload: {
      id: "later", title: "The voice prepares to speak", readerSummary: "The live connection is ready for the voice's reply.",
      participants: ["voice", "peer", "console"], participantPresence: [{ entityId: "voice", mode: "remote" }, { entityId: "peer", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "later", orderHint: 1 }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1,
    } });
    const payload = { id: "later-entry", canonicalEventId: "later", actorId: "voice", entryCheckpoint: {
      actorId: "voice", readerSetup: "A live channel is already open before the voice replies.", actorObservation: "你准备通过已开启的连接发言。",
      participantPresence: [{ entityId: "voice", mode: "remote" }], delta: initialPayload.delta, projectionSeed: initialPayload.projectionSeed,
    } };
    const input = { proposal_id: "later-binding", payload, evidence_segment_ids: [f.source.segmentId] };
    await expect(invoke("propose_event_execution", input)).rejects.toThrow("ENTRY_AGENCY_EVIDENCE_REQUIRED");
    await invoke("propose_event_execution", { ...input, evidence_selectors: ["/actorId", "/canonicalEventId", "/entryCheckpoint/actorId", "/entryCheckpoint/participantPresence/0/mode",
      ...processes.operations.map((_, index) => `/entryCheckpoint/projectionSeed/processes/operations/${index}`)].map(target_path => ({ segment_id: f.source.segmentId, exact: scene.text, target_path, relation: "supports", strength: "explicit" })) });
  }
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent agency and channels" });
  expect((await convergeWorldProposals(f.root, f.source.source.id)).canonical.blocked).toEqual([]);

  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, (await prepareCompilerBatches(f.root, f.source.source)).map(item => item.id));
  const cacheRoot = path.join(f.root, "cache"), cache = new PreparedNovelCache(f.root, cacheRoot);
  const bundle = await cache.candidateSnapshot(f.source.source), archived = await cache.archiveCandidate(f.source.source);
  expect(deriveCharacterEntryOptions(bundle).map(option => option.actorId)).toContain("voice");
  expect(deriveCharacterEntryOptions(bundle).map(option => option.actorId)).not.toContain("photo");
  const audit = await auditCompiler(f.root, { sourceId: f.source.source.id });
  expect(audit.coverage.openingLivePresence).toBe(1);
  expect(audit.coverage.openingPhysicalPresence).toBe(scene.later ? 1 : 0);
  if (scene.later) expect(audit.coverage.characterEntryCheckpointCoverage).toBe(1);
  const closure = buildPreparedClosure(bundle); expect(closure.issues).toEqual([]);
  expect(closure.nodes.find(node => node.kind === "entity" && node.id === "voice")!.dependsOn).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "process", id: f.template.id }), expect.objectContaining({ kind: "action", id: f.control.id })]));
  const rebuiltRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-agency-rebuilt-")); roots.push(rebuiltRoot);
  const rebuiltSource = await createEvidenceFixture(rebuiltRoot, scene.text);
  await new PreparedNovelCache(rebuiltRoot, cacheRoot).restoreCompilerCheckpoint(rebuiltSource.source, archived.bundleHash!);
  const context = await new WorldContextStore(rebuiltRoot).captureCurrent(rebuiltSource.source.id);
  expect(context.entities.get("voice")?.agencyProfile).toEqual(f.voice.agencyProfile);
  expect(context.entities.get("photo")?.agencyProfile).toEqual(f.photo.agencyProfile);
  expect(validateAgencyProfile(context.entities.get("voice")!, context)).toEqual([]);
  const rebuiltEngine = new WorldEngine(rebuiltRoot, context);
  const entry = deriveCharacterEntrySeed(bundle, "voice");
  expect(deriveCharacterEntryOptions(bundle).find(option => option.actorId === "voice")?.entry.kind).toBe(scene.later ? "canonical-scene" : "opening");
  if (scene.later) expect(entry.projectionSeed?.knowledgeHistory?.beforeCanonicalEventId).toBe("later");
  const options = { entryActorId: "voice", projectionSeed: entry.projectionSeed, participantPresence: entry.participantPresence, actorObservations: entry.actorObservations, realizesCanonicalEventIds: entry.realizesCanonicalEventIds };
  if (scene.later) {
    const binding = bundle.canonical.eventExecutions!.find(item => item.id === "later-entry")!;
    expect(characterEntryCheckpointSchema.safeParse({ ...binding.entryCheckpoint, projectionSeed: undefined }).success).toBe(false);
    const paused = structuredClone(binding);
    paused.entryCheckpoint!.projectionSeed.processes.operations.push({ op: "pause-process", processId: f.session, reasonId: "disconnected" });
    expect((await new CompilerValidator(canon).validate("event-execution", paused)).errors.some(issue => issue.code === "ENTRY_AGENCY_UNPROVEN")).toBe(true);
    const representedBundle = structuredClone(bundle);
    representedBundle.canonical.events.find(item => item.id === "later")!.participantPresence![0]!.mode = "represented";
    expect(deriveCharacterEntryOptions(representedBundle).map(option => option.actorId)).not.toContain("voice");
    const pausedBundle = structuredClone(bundle);
    pausedBundle.canonical.eventExecutions = [paused];
    expect(() => executeSceneEvent(pausedBundle, pausedBundle.canonical.events.find(item => item.id === "later")!, "voice", { beforeOnly: true })).toThrow("ENTRY_AGENCY_UNPROVEN");
    const badHistory = structuredClone(entry.projectionSeed!);
    badHistory.knowledgeHistory!.cutHash = "0".repeat(64);
    await expect(rebuiltEngine.createBranch("bad-history", "Bad", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, { ...options, projectionSeed: badHistory })).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
    await expect(rebuiltEngine.createBranch("future-entry", "Future", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, { ...options, realizesCanonicalEventIds: [...entry.realizesCanonicalEventIds, "later"] })).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
    await expect(rebuiltEngine.branches.read("bad-history")).rejects.toThrow();
    await expect(rebuiltEngine.branches.read("future-entry")).rejects.toThrow();
  }
  const rebuiltHead = await rebuiltEngine.createBranch("rebuilt", "Rebuilt", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, options);
  const genesis = await rebuiltEngine.projections.project(rebuiltHead, { fresh: true, useCheckpoints: false });
  expect(genesis.history[0]!.event.entryActorId).toBe("voice");
  expect(genesis.history[0]!.event.participantPresence).toEqual([{ entityId: "voice", mode: "remote" }]);
  const sessionId = Object.keys(genesis.processes.instances)[0]!;
  expect(sessionId).toBe(f.session);
  const frame = playerSceneModelFrame(await buildPlayOpeningFrame(rebuiltRoot, "rebuilt", "voice", rebuiltSource.source.id));
  expect(frame.agency).toMatchObject({ agency: "autonomous", embodiment: "mediated" });
  expect(frame.agency?.channels[0]?.peers[0]).not.toBe(scene.peer);
  expect(JSON.stringify(frame.agency)).not.toContain(sessionId);
  expect(JSON.stringify(frame.agency)).not.toContain(f.template.id);

  await expect(rebuiltEngine.createBranch("bad-entry", "Bad", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, { ...options, projectionSeed: undefined })).rejects.toThrow("ENTRY_AGENCY_UNPROVEN");
  await expect(rebuiltEngine.branches.read("bad-entry")).rejects.toThrow();
  await expect(rebuiltEngine.createBranch("bad-observer", "Bad observer", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, { ...options, entryActorId: undefined, projectionSeed: undefined })).rejects.toThrow("ENTRY_AGENCY_UNPROVEN");
  await expect(rebuiltEngine.branches.read("bad-observer")).rejects.toThrow();
  const pausedSeed = structuredClone(entry.projectionSeed!);
  pausedSeed.processes.operations.push({ op: "pause-process", processId: sessionId, reasonId: "disconnected" });
  await expect(rebuiltEngine.createBranch("paused-entry", "Paused", entry.delta, entry.knowledge, rebuiltSource.source.id, undefined, entry.evidence, {}, { ...options, projectionSeed: pausedSeed })).rejects.toThrow("ENTRY_AGENCY_UNPROVEN");
  await expect(rebuiltEngine.branches.read("paused-entry")).rejects.toThrow();
  const withoutSession = structuredClone(bundle);
  if (scene.later) withoutSession.canonical.eventExecutions!.find(item => item.id === "later-entry")!.entryCheckpoint!.projectionSeed.processes.operations = [];
  else withoutSession.canonical.initialWorld.projectionSeed!.processes.operations = [];
  expect(deriveCharacterEntryOptions(withoutSession).map(option => option.actorId)).not.toContain("voice");

  const event = genesis.history[0]!.event;
  const tampered = await rebuiltEngine.objects.putEvent({ ...event, effects: { ...event.effects, processDeltaHash: undefined } });
  const badCommit = await rebuiltEngine.objects.putCommit({ ...await rebuiltEngine.objects.getCommit(rebuiltHead), eventHashes: [tampered] });
  await expect(new WorldEngine(rebuiltRoot, context).projections.project(badCommit, { fresh: true, useCheckpoints: false })).rejects.toThrow("ENTRY_AGENCY_UNPROVEN");
  const observerTampered = await rebuiltEngine.objects.putEvent({ ...event, entryActorId: undefined, effects: { ...event.effects, processDeltaHash: undefined } });
  const observerBadCommit = await rebuiltEngine.objects.putCommit({ ...await rebuiltEngine.objects.getCommit(rebuiltHead), eventHashes: [observerTampered] });
  await expect(new WorldEngine(rebuiltRoot, context).projections.project(observerBadCommit, { fresh: true, useCheckpoints: false })).rejects.toThrow("ENTRY_AGENCY_UNPROVEN");
  const receiptProposal: EventProposal = { ...f.speech, source: "background", actorId: undefined, branchId: "rebuilt", expectedParentCommit: rebuiltHead,
    proposedSemantics: { version: 1, operations: [
      { op: "record-proposition", localRef: "local-hearing", proposition: { subjectEntityId: "voice", relationId: "can-hear", object: { kind: "entity", entityId: "peer" }, polarity: "positive", modality: "asserted" } },
      { op: "record-attribution", localRef: "local-report", attribution: { propositionId: "local-hearing", holderKind: "character", holderEntityId: "voice", attitude: "asserts", certainty: 1 } },
      { op: "record-claim", localRef: "local-claim", claim: { propositionId: "local-hearing", status: "asserted" } },
      { op: "record-acquisition", localRef: "local-receipt", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId: "peer", claimId: "local-claim", propositionId: "local-hearing", basis: { mode: "told", utteranceIndex: 0, attributionId: "local-report" }, reception: { received: true, understood: true, belief: "accepted" } } },
    ] },
    proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "peer", claimId: "local-claim", propositionId: "local-hearing", attributionId: "local-report", acquisitionId: "local-receipt", acquisitionMode: "told", sourceActorId: "voice", status: "believes", confidence: 1 }] },
    spokenUtterances: [{ ...f.speech.spokenUtterances![0]!, channelBinding: { channelId: "voice", processId: sessionId } }] };
  const { branchId: _branch, expectedParentCommit: _parent, ...proposalFile } = receiptProposal;
  const proposalPath = path.join(rebuiltRoot, "remote-receipt.json");
  await fs.writeFile(proposalPath, JSON.stringify(proposalFile));
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
  try { await worldValidateCommand(rebuiltRoot, "rebuilt", proposalPath); } finally { write.mockRestore(); }
  expect(JSON.parse(output.join("")).accepted).toBe(true);
  expect(await rebuiltEngine.branches.readHead("rebuilt")).toBe(rebuiltHead);
  const spoken = await rebuiltEngine.commitProposal(receiptProposal);
  expect(spoken.report.errors).toEqual([]);
  const replay = await rebuiltEngine.projections.project(spoken.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.spokenUtterances![0]!.content).toBe(scene.quote);
  expect(Object.values(replay.knowledge.acquisitions!)).toEqual([expect.objectContaining({ actorId: "peer", reception: { received: true, understood: true, belief: "accepted" } })]);
  expect(replay.knowledge.actors.voice).toBeUndefined();
  await rebuiltEngine.branches.create({ id: "opening-fork", name: "Before receipt", parentBranchId: "rebuilt", forkCommitId: rebuiltHead, headCommitId: rebuiltHead });
  expect((await buildPlayOpeningFrame(rebuiltRoot, "opening-fork", "voice", rebuiltSource.source.id)).actor.id).toBe("voice");
  expect(await rebuiltEngine.branches.readHead("opening-fork")).toBe(rebuiltHead);
  expect(await rebuiltEngine.branches.readHead("rebuilt")).toBe(spoken.newHead);
  expect((await rebuiltEngine.previewProposalAtCommit(receiptProposal)).report.accepted).toBe(true);
  expect((await rebuiltEngine.commitProposal(receiptProposal)).report.errors.some(issue => issue.code === "STALE_PARENT")).toBe(true);
  expect(await rebuiltEngine.branches.readHead("rebuilt")).toBe(spoken.newHead);
  // Rebuilt source authority also supports receiving in a subsequent event.
  await rebuiltEngine.branches.create({ id: "delayed-receipt", name: "Delayed receipt", parentBranchId: "rebuilt", forkCommitId: rebuiltHead, headCommitId: rebuiltHead });
  const delivered = await rebuiltEngine.commitProposal({ ...receiptProposal, branchId: "delayed-receipt", proposedSemantics: undefined, proposedKnowledge: undefined });
  expect(delivered.report.errors).toEqual([]);
  const delivery = (await buildActorScopedActionContext(rebuiltEngine, "peer", delivered.newHead)).decision!.pendingSpeech![0]!;
  expect(delivery.content).toBe(scene.quote);
  const delayed = structuredClone(receiptProposal);
  delayed.branchId = "delayed-receipt";
  delayed.expectedParentCommit = delivered.newHead;
  delayed.spokenUtterances = undefined;
  const delayedRecord = delayed.proposedSemantics!.operations.find(op => op.op === "record-acquisition")!;
  if (delayedRecord.op === "record-acquisition" && delayedRecord.acquisition.basis.mode === "told") delayedRecord.acquisition.basis.utteranceEventId = delivery.eventId;
  const receivedLater = await rebuiltEngine.commitProposal(delayed);
  expect(receivedLater.report.errors).toEqual([]);
  const delayedReplay = await new WorldEngine(rebuiltRoot, context).projections.project(receivedLater.newHead, { fresh: true, useCheckpoints: false });
  expect(delayedReplay.history.at(-1)!.event.spokenUtterances).toBeUndefined();
  expect(Object.values(delayedReplay.knowledge.acquisitions!)).toHaveLength(1);
  const evidenceStore = new EvidenceAssertionStore(f.root);
  if (scene.later) {
    const binding = (await evidenceStore.bindingForArtifact("event-execution", "later-entry"))!;
    await evidenceStore.replaceForArtifact("event-execution", "later-entry", binding.artifactHash, []);
    expect((await auditCompiler(f.root, { sourceId: f.source.source.id })).evidence.errors.some(item => item.code === "ENTRY_AGENCY_EVIDENCE_REQUIRED")).toBe(true);
    await expect(cache.candidateSnapshot(f.source.source)).rejects.toThrow("Remote entry exact evidence");
    await evidenceStore.replaceForArtifact("event-execution", "later-entry", binding.artifactHash, binding.assertions);
  }
  const initialBinding = (await evidenceStore.bindingForArtifact("initial-world", "initial-world"))!;
  await evidenceStore.replaceForArtifact("initial-world", "initial-world", initialBinding.artifactHash, []);
  await expect(cache.candidateSnapshot(f.source.source)).rejects.toThrow("exact evidence binding");
  await evidenceStore.replaceForArtifact("initial-world", "initial-world", initialBinding.artifactHash, initialBinding.assertions);
  await new EvidenceAssertionStore(f.root).replaceForArtifact("entity", f.voice.id, contentHash(await canon.getEntity(f.voice.id)), []);
  await expect(cache.candidateSnapshot(f.source.source)).rejects.toThrow("Agency profile exact evidence");
});

it("bounds agency discovery retries and stops runtime/scope violations", () => {
  expect(buildNwhToolRecoveryAdvice("propose_entity", "AGENCY_PROCESS_MISSING").suggestedCall).toMatchObject({ arguments: { kind: "process-template" } });
  expect(buildNwhToolRecoveryAdvice("propose_entity", "AGENCY_ACTION_MISSING").steps.join(" ")).toContain("payload.id");
  expect(buildNwhToolRecoveryAdvice("propose_initial_world", "ENTRY_AGENCY_EVIDENCE_REQUIRED").steps.join(" ")).toContain("/projectionSeed/processes/operations/i");
  expect(buildNwhToolRecoveryAdvice("propose_event_execution", "ENTRY_AGENCY_EVIDENCE_REQUIRED tool-call budget exhausted")).toMatchObject({ retryable: false, category: "budget-or-circuit-breaker" });
  expect(buildNwhToolRecoveryAdvice("propose_event_execution", "EVENT_ENTRY_PRESENCE_UNPROVEN")).toMatchObject({ retryable: false, category: "host-repair-required" });
  expect(buildNwhToolRecoveryAdvice("play", "ENTRY_AGENCY_UNPROVEN")).toMatchObject({ retryable: false, category: "host-repair-required" });
  expect(buildNwhToolRecoveryAdvice("play", "AGENCY_CHANNEL_UNAVAILABLE")).toMatchObject({ retryable: false, category: "host-repair-required" });
  expect(buildNwhToolRecoveryAdvice("propose_entity", "AGENCY_PROCESS_MISSING", { activeToolNames: ["propose_entity"] })).toMatchObject({ retryable: false, category: "scope-or-lifecycle" });
});

it.each(scenes.flatMap(scene => [false, true].map(silent => ({ ...scene, silent }))))("carries a remote player/NPC exchange through scoped handles without inventing copresence: $voice silent=$silent", async scene => {
  const f = await fixture(scene, true);
  const scoped = await buildActorScopedActionContext(f.engine, "voice", f.started.newHead);
  expect(scoped.referenceableEntities.map(entity => entity.id)).toEqual(expect.arrayContaining(["peer", "console"]));
  expect(scoped.referenceableEntities.find(entity => entity.id === "peer")?.name).not.toBe(scene.peer);
  expect(scoped.presentEntities.map(entity => entity.id)).not.toContain("peer");
  const candidate = playerActionCandidateSchema.parse({ title: "Speak through connection", participants: ["peer"],
    intent: { kind: "act", summary: "Speak through connection", targets: [{ kind: "entity", entityId: "peer" }],
      controlledAct: { eventTitle: "Speak", actorObservation: "You speak through the connection.", interaction: {
        kind: "speech", content: scene.quote, addresseeIds: ["peer"], channel: "audible", channelBinding: { channelId: "voice", processId: f.session },
      } } }, preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [] });
  expect(validatePlayerActionScope(candidate, scoped)).toEqual([]);
  expect(await validatePlayerActionSpatialScope(f.engine, candidate, "voice", f.started.newHead)).toEqual([]);
  const boundary = createPlayerActionModelBoundary(playerActionTranslationContext(scoped));
  const encoded = boundary.encodeCandidate(candidate);
  expect(JSON.stringify(encoded)).not.toContain(f.session);
  expect(boundary.decodeCandidate(encoded)).toEqual(candidate);
  const requirements = decisionContextRequirements({ ...boundary.context, intendedCandidate: encoded });
  expect(requirements?.dependencyEdges.some(edge => edge.reason === "candidate-channel")).toBe(true);
  expect(() => decisionContextRequirements({ ...boundary.context, decision: { ...(boundary.context.decision as object), agency: undefined }, intendedCandidate: encoded })).toThrow("dependency");
  const unavailable = structuredClone(candidate);
  unavailable.intent!.controlledAct!.interaction = { ...candidate.intent!.controlledAct!.interaction!, channelBinding: { channelId: "voice", processId: "unknown-session" } } as never;
  expect(validatePlayerActionScope(unavailable, scoped).some(issue => issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  const transfer = { ...candidate, proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "crate", field: "artifact.owner", value: "peer" }] } };
  expect((await validatePlayerActionSpatialScope(f.engine, transfer, "voice", f.started.newHead)).length).toBeGreaterThan(0);
  const action = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "voice", expectedParentCommit: f.started.newHead, utterance: scene.quote, candidate, agency: scoped.decision?.agency });
  expect(action.proposal.participants).toContain("console");
  expect(action.proposal.participantPresence).toContainEqual({ entityId: "voice", mode: "remote" });
  expect(action.proposal.actorObservations?.find(item => item.actorId === "peer")?.summary).not.toContain("面前");
  const spoken = await new PlayerTurnService(f.engine, () => candidate, () => "Committed speech").turn({ branchId: "main", actorId: "voice", utterance: scene.quote });
  expect(spoken.issues).toEqual([]);
  expect(spoken.accepted).toBe(true);
  const trigger = (await f.engine.projections.project(spoken.newHead)).history.at(-1)!.event;
  const forged = structuredClone(candidate);
  if (forged.intent?.controlledAct?.interaction?.kind === "speech") forged.intent.controlledAct.interaction.content = "Not committed";
  const rejectedTrigger = await respondToNpcInteractions({ engine: f.engine, branchId: "main", playerId: "voice", playerCandidate: forged, triggerEvent: trigger,
    reasoner: () => { throw new Error("Must reject before invoking the reasoner"); } });
  expect(rejectedTrigger.responses).toEqual([]);
  expect(rejectedTrigger.failures[0]?.error).toContain("Remote trigger does not match committed speech");
  expect(rejectedTrigger.newHead).toBe(spoken.newHead);
  const result = await respondToNpcInteractions({ engine: f.engine, branchId: "main", playerId: "voice", playerCandidate: candidate, triggerEvent: trigger,
    reasoner: async input => {
      expect(input.actorContext.presentEntities.map(entity => entity.id)).not.toContain("voice");
      const delivery = input.actorContext.decision?.pendingSpeech?.find(item => item.eventId === trigger.eventId)!;
      expect(delivery).toMatchObject({ utteranceIndex: 0, speakerId: "voice", content: scene.quote, delivery: "remote" });
      const receipt = { proposedSemantics: { version: 1, operations: [
        { op: "record-proposition", localRef: "local-p", proposition: { subjectEntityId: "voice", relationId: "can-hear", object: { kind: "entity", entityId: "peer" }, polarity: "positive", modality: "asserted" } },
        { op: "record-attribution", localRef: "local-a", attribution: { propositionId: "local-p", holderKind: "character", holderEntityId: "voice", attitude: "asserts", certainty: 1 } },
        { op: "record-claim", localRef: "local-c", claim: { propositionId: "local-p", status: "asserted" } },
        { op: "record-acquisition", localRef: "local-x", acquisition: { ontologyVersion: "branch-acquisition-v1", actorId: "peer", claimId: "local-c", propositionId: "local-p", basis: { mode: "told", utteranceEventId: delivery.eventId, utteranceIndex: delivery.utteranceIndex, attributionId: "local-a" }, reception: { received: true, understood: true, belief: "accepted" } } },
      ] }, proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "peer", claimId: "local-c", propositionId: "local-p", attributionId: "local-a", acquisitionId: "local-x", acquisitionMode: "told", sourceActorId: "voice", status: "believes", confidence: 1 }] } };
      const receiptCandidate = playerActionCandidateSchema.parse({ title: "Understand", participants: ["voice", "peer"], intent: { kind: "reflect", summary: "Understand the delivered message" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [], ...receipt });
      const npcBoundary = createPlayerActionModelBoundary(input.actorContext);
      const encodedReceipt = npcBoundary.encodeCandidate(receiptCandidate);
      expect(JSON.stringify(encodedReceipt)).not.toContain(trigger.eventId);
      expect(npcBoundary.decodeCandidate(encodedReceipt)).toEqual(receiptCandidate);
      expect(decisionContextRequirements({ ...npcBoundary.context, intendedCandidate: encodedReceipt })?.dependencyEdges.some(edge => edge.reason === "candidate-speech-receipt")).toBe(true);
      expect(() => decisionContextRequirements({ ...npcBoundary.context, decision: { ...(npcBoundary.context.decision as object), pendingSpeech: undefined }, intendedCandidate: encodedReceipt })).toThrow("dependency");
      return { ...receipt, responseKind: scene.silent ? "ignore" : "speak", eventTitle: "Answer", npcObservation: "You answer through the connection.", playerObservation: "Answer",
        emotion: { label: "calm", intensity: 0.2, expression: "Secret visual expression" },
        interaction: scene.silent ? undefined : { kind: "speech", content: "Received.", addresseeIds: ["voice"], channel: "audible", channelBinding: { channelId: "reply", processId: f.session } },
        preconditions: [], proposedDelta: { version: 1, operations: [] }, communicatedClaimIds: [], requiresKnowledge: [], forbidsKnowledge: [] };
    } });
  expect(result.failures).toEqual([]);
  expect(result.responses).toHaveLength(1);
  const reply = await f.engine.objects.getEvent(result.responses[0]!.eventHash);
  if (!scene.silent) expect(reply.participants).toContain("console");
  expect(reply.participantPresence).toEqual([{ entityId: "peer", mode: "remote" }, { entityId: "voice", mode: "remote" }]);
  expect(reply.actorObservations?.find(item => item.actorId === "voice")?.summary).toBe(scene.silent ? "通信渠道暂未传来回应。" : "通信渠道中的声音回答：“Received.”");
  const replay = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.spokenUtterances?.[0]?.channelBinding).toEqual(scene.silent ? undefined : { channelId: "reply", processId: f.session });
  expect(replay.history.at(-1)!.event.spokenUtterances ?? []).toHaveLength(scene.silent ? 0 : 1);
  expect(Object.values(replay.semantics.acquisitions!)[0]!.basis).toMatchObject({ mode: "told", utteranceEventId: trigger.eventId, utteranceIndex: 0 });
  expect(Object.values(replay.knowledge.acquisitions!)[0]!.actorId).toBe("peer");
  expect((await buildActorScopedActionContext(f.engine, "peer", result.newHead)).decision?.pendingSpeech).toBeUndefined();
  expect((await buildActorScopedActionContext(f.engine, "voice", result.newHead)).presentEntities.map(entity => entity.id)).not.toContain("peer");
  const paused = await f.engine.commitProposal({ ...f.base, proposalId: "pause-after-reply", expectedParentCommit: result.newHead,
    proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "disconnected" }] } });
  expect(paused.report.errors).toEqual([]);
  const denied = await new PlayerTurnService(f.engine, () => candidate, () => "Rejected").turn({ branchId: "main", actorId: "voice", utterance: "Again" });
  expect(denied.accepted).toBe(false);
  expect(denied.issues.some(issue => issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(await f.engine.branches.readHead("main")).toBe(paused.newHead);
});

it.each(scenes)("schedules exact autonomous remote speech and rejects stale session proposals: $voice", async scene => {
  const f = await fixture(scene, false, true);
  let calls = 0;
  const source = modelActorProposalSource(f.engine, { goals: async () => [], modelFor: async () => null,
    reasoner: input => {
      calls += 1;
      expect(JSON.stringify(input)).not.toContain(f.session);
      expect(input.actor.presentEntities.map(entity => entity.id)).toEqual([input.actor.actorId]);
      const channel = input.actor.decision?.agency?.channels.find(channel => channel.modality === "audio");
      if (!channel) return null;
      return { title: "Confirm connection", participants: channel.peerEntityIds, preconditions: [], proposedDelta: { version: 1, operations: [] },
        intent: { kind: "act", summary: "Confirm connection", targets: channel.peerEntityIds.map(entityId => ({ kind: "entity", entityId })),
          controlledAct: { eventTitle: "Confirm", actorObservation: "You speak through the connection.", interaction: {
            kind: "speech", content: scene.quote, addresseeIds: channel.peerEntityIds, channel: "audible", channelBinding: { channelId: channel.id, processId: channel.processId },
          } } } };
    } });
  const candidates = await source({ branchId: "main", commitId: f.started.newHead });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.proposal.spokenUtterances?.[0]).toMatchObject({ content: scene.quote, speakerId: "voice", channelBinding: { channelId: "voice", processId: f.session } });
  expect(candidates[0]!.proposal.participants).toContain("console");
  expect(candidates[0]!.proposal.participantPresence).toContainEqual({ entityId: "voice", mode: "remote" });
  const runtime = new WorldRuntime(f.engine, () => [], () => "Committed", source);
  const moved = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(moved.rejectedProposals).toEqual([]);
  expect(moved.committedEvents).toHaveLength(1);
  const replay = await new WorldEngine(f.root, f.context).projections.project(moved.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.spokenUtterances?.[0]?.content).toBe(scene.quote);
  expect(replay.knowledge.actors.peer).toBeUndefined();
  expect(calls).toBe(2);
  const paused = await f.engine.commitProposal({ ...f.base, proposalId: "pause-autonomous", expectedParentCommit: moved.newHead,
    proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: f.session, reasonId: "disconnected" }] } });
  expect(paused.report.errors).toEqual([]);
  const stale = await f.engine.commitProposal({ ...candidates[0]!.proposal, expectedParentCommit: paused.newHead });
  expect(stale.report.accepted).toBe(false);
  expect(stale.report.errors.some(issue => issue.code === "AGENCY_CHANNEL_UNAVAILABLE")).toBe(true);
  expect(stale.newHead).toBe(paused.newHead);
  expect(await source({ branchId: "main", commitId: paused.newHead })).toEqual([]);
});
