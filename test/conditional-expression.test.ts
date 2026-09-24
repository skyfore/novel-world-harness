import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { contentHash } from "../src/world/canonical.js";
import { utteranceExpressionSchema } from "../src/world/utterance-expression.js";
import { ActorModelStore, characterGoalSchema, deterministicActorProposalSource } from "../src/world/actors.js";
import { conditionalExpressionUtterances, validateGoalExpressionEvidence, validateGoalExpressions } from "../src/world/conditional-expression.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { canonicalEventSchema, propositionSchema, type Entity, type EventProposal, type KnowledgeDelta, type StateDelta } from "../src/world/model.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import { modelActorProposalSource } from "../src/world/model-actor-policy.js";
import { WorldContextStore } from "../src/world/context.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { SourceAnnotationStore, quotationSchema, entityMentionSchema } from "../src/compiler/annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "../src/compiler/entity-resolution.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { committedUtteranceId, renderNarrationBlocks } from "../src/world/utterance-rendering.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scenes = [
  { speaker: "Ada", listener: "Bo", place: "gate", quote: "the gate is shut", text: 'Ada knows the gate is shut. Ada wants to warn her ally Bo. At the gate Ada tells Bo: "the gate is shut".' },
  { speaker: "宁", listener: "维", place: "码头", quote: "码头已经关闭", text: "宁知道码头已经关闭，宁想提醒盟友维。在码头，宁对维说：“码头已经关闭”。" },
];

it("gives bounded same-source compiler recovery and stops runtime binding retries", () => {
  const missing = buildNwhToolRecoveryAdvice("propose_character_goal", "GOAL_EXPRESSION_MISSING");
  expect(missing.suggestedCall).toMatchObject({ tool: "find_compiler_artifacts", arguments: { kind: "utterance-expression" } });
  expect(missing.steps.join(" ")).toContain("results[].readArguments.ref");
  expect(missing.steps.join(" ")).toContain("payload.id");
  expect(buildNwhToolRecoveryAdvice("propose_character_goal", "GOAL_EXPRESSION_KNOWLEDGE").suggestedCall).toMatchObject({ arguments: { kind: "claim" } });
  expect(buildNwhToolRecoveryAdvice("play", "CONDITIONAL_EXPRESSION_INELIGIBLE")).toMatchObject({ retryable: false, category: "host-repair-required" });
});

async function fixture(scene = scenes[0]!, knows = true, relation: boolean | null = true, remote = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-conditional-expression-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text);
  const evidence = source.evidence(scene.text);
  const bytes = Buffer.from(scene.text), start = bytes.lastIndexOf(Buffer.from(scene.quote));
  const anchor = textAnchorForByteRange(source.source.id, bytes, start, start + Buffer.byteLength(scene.quote));
  const derivation = { runId: "test", worker: "test", ontologyVersion: "observation-v1" };
  const mentions = [["speaker", scene.speaker], ["listener", scene.listener]].map(([id, text]) => {
    const offset = bytes.indexOf(Buffer.from(text!));
    return entityMentionSchema.parse({ version: 1, id: `mention-${id}`, sourceId: source.source.id, derivation, annotationType: "entity-mention", anchor: textAnchorForByteRange(source.source.id, bytes, offset, offset + Buffer.byteLength(text!)), surface: text, form: "proper", kindCandidates: ["character"], confidence: 1 });
  });
  const quotation = quotationSchema.parse({ version: 1, id: "quotation", sourceId: source.source.id, derivation, annotationType: "quotation", anchor, mode: "direct", speakerMentionId: "mention-speaker", addresseeMentionIds: ["mention-listener"], attributionConfidence: 1 });
  await new SourceAnnotationStore(root).replaceCurrent(source.source.id, [...mentions, quotation]);
  await new EntityResolutionStore(root).replaceCurrent(source.source.id, mentions.map(mention => identityResolutionSchema.parse({ version: 1, id: `resolution-${mention.id}`, sourceId: source.source.id, mentionId: mention.id, status: "resolved", entityId: mention.id.slice(8), candidates: [{ entityId: mention.id.slice(8), confidence: 1, basisMentionIds: [mention.id], evidenceAssertionIds: [], rationale: "Named speaker or addressee" }], rationale: "Named speaker or addressee", derivation: { ...derivation, ontologyVersion: "entity-resolution-v1" } })));
  const proposition = propositionSchema.parse({ id: "content", subjectEntityId: "place", relationId: "is-shut", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted", evidence });
  const expression = utteranceExpressionSchema.parse({ ontologyVersion: "utterance-expression-v1", id: "warning", canonicalEventId: "future-warning", speakerId: "speaker", addresseeIds: ["listener"], modality: "speech", quotation: { quotationId: quotation.id, revisionHash: contentHash(quotation), anchor }, fragments: [{ anchor, text: scene.quote }], propositionId: proposition.id, propositions: [{ propositionId: proposition.id, revisionHash: contentHash(proposition), snapshot: proposition }], evidence });
  const goal = characterGoalSchema.parse({
    id: "warn-ally", actorId: "speaker", description: "Warn the ally", priority: 1, requiresKnowledge: [], evidence,
    activation: { preconditions: [{ op: "fact-equals", entityId: "speaker", field: "character.plan", value: "warn" }], afterCanonicalEventIds: [] },
    candidateAction: {
      title: "Warn the ally", participants: ["speaker", "listener"],
      preconditions: [{ op: "fact-equals", entityId: "speaker", field: "character.location", value: "place" }],
      proposedDelta: { version: 1, operations: [] },
      expressionCandidates: [{ expressionId: expression.id, requiredKnowledgeClaimIds: ["warning-claim"], relationshipConditions: [{ op: "fact-equals", entityId: "alliance", field: "relationship.active", value: true }] }],
    },
  });
  const entities: Entity[] = [
    { id: "speaker", kind: "character", canonicalName: scene.speaker, aliases: [], evidence },
    { id: "listener", kind: "character", canonicalName: scene.listener, aliases: [], evidence },
    { id: "place", kind: "location", canonicalName: scene.place, aliases: [], evidence },
    { id: "alliance", kind: "relationship", canonicalName: "alliance", aliases: [], evidence },
  ];
  const context: WorldModelContext = {
    sourceId: source.source.id, entities: new Map(entities.map(entity => [entity.id, entity])), rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), actorGoals: [goal],
    propositions: new Map([[proposition.id, proposition]]), utteranceExpressions: new Map([[expression.id, expression]]),
    events: new Map([["future-warning", canonicalEventSchema.parse({ id: "future-warning", title: "Warning", readerSummary: "Warning", participants: ["speaker", "listener"], participantPresence: [{ entityId: "speaker", mode: "physical" }, { entityId: "listener", mode: "physical" }], storyTime: { kind: "unknown" }, observedOutcome: { version: 1, operations: [] }, preconditions: [], causalParents: [], confidence: 1, evidence })]]),
    claims: new Map([["warning-claim", { id: "warning-claim", subject: "place", predicate: "is-shut", object: true, epistemicType: "explicit-fact", evidence }]]),
  };
  const initial: StateDelta = { version: 1, operations: [
    { op: "set", entityId: "speaker", field: "character.alive", value: true },
    { op: "set", entityId: "listener", field: "character.alive", value: true },
    { op: "set", entityId: "speaker", field: "character.location", value: "place" },
    { op: "set", entityId: "listener", field: "character.location", value: "place" },
    { op: "set", entityId: "speaker", field: "character.plan", value: "warn" },
    { op: "set", entityId: "alliance", field: "relationship.from", value: "speaker" },
    { op: "set", entityId: "alliance", field: "relationship.to", value: "listener" },
    ...(relation === null ? [] : [{ op: "set" as const, entityId: "alliance", field: "relationship.active", value: relation }]),
  ] };
  const learned: KnowledgeDelta = { version: 1, operations: [{ op: "learn", actorId: "speaker", claimId: "warning-claim", propositionId: proposition.id, acquisitionMode: "observed", status: "knows", confidence: 1 }] };
  if (remote) {
    goal.candidateAction!.preconditions = [{ op: "fact-equals", entityId: "speaker", field: "character.plan", value: "warn" }];
    context.entities.set("carrier", { id: "carrier", kind: "artifact", canonicalName: "Console", aliases: [], evidence });
    context.entities.get("speaker")!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "mediated", channels: [{
      id: "audio", modality: "audio", processTemplateId: "call", actorRoleId: "speaker", peerRoleId: "listener", carrierRoleId: "carrier", activePhaseIds: ["open"],
    }] };
    context.entities.get("listener")!.agencyProfile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily", channels: [{
      id: "reply", modality: "audio", processTemplateId: "call", actorRoleId: "listener", peerRoleId: "speaker", carrierRoleId: "carrier", activePhaseIds: ["open"],
    }] };
    context.processTemplates = new Map([["call", processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "call", name: "Audio call",
      ownerRoles: ["speaker", "listener", "carrier"].map(id => ({ id, label: id, allowedEntityKinds: [id === "carrier" ? "artifact" : "character"], minCardinality: 1, maxCardinality: 1 })),
      phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open",
      transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"], visibility: "public",
      induction: { kind: "domain-module", moduleId: "test-audio-call", moduleVersion: "1" }, evidence: [],
    })]]);
    initial.operations = initial.operations.filter(op => !("entityId" in op && op.entityId === "speaker" && op.field === "character.location"));
  }
  const engine = new WorldEngine(root, context);
  let head = await engine.createBranch("main", "Main", initial, knows ? learned : undefined);
  if (remote) {
    const connected = await engine.commitProposal({ proposalId: "connect", branchId: "main", expectedParentCommit: head, source: "background", title: "Connect",
      participants: ["speaker", "listener", "carrier"], participantPresence: [{ entityId: "speaker", mode: "remote" }, { entityId: "listener", mode: "physical" }],
      proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence,
      proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-call", process: { templateId: "call", progress: 0,
        ownerBindings: ["speaker", "listener", "carrier"].map(id => ({ roleId: id, entityIds: [id] })) } }] } });
    expect(connected.report.errors).toEqual([]);
    head = connected.newHead;
  }
  const sourceActor = deterministicActorProposalSource(engine, new ActorModelStore(root));
  return { root, source, scene, context, expression, goal, initial, learned, engine, head, sourceActor };
}

it.each(scenes)("commits exact conditional source speech without realizing future canon: $speaker", async scene => {
  const f = await fixture(scene);
  const before = await f.engine.projections.project(f.head);
  const candidates = await f.sourceActor({ branchId: "main", commitId: f.head });
  expect(candidates).toHaveLength(1);
  const utterances = candidates[0]!.proposal.spokenUtterances!;
  expect(utterances.map(item => item.content)).toEqual([scene.quote]);
  expect(utterances[0]!.expressionBinding).toMatchObject({ expressionId: f.expression.id, expressionRevision: contentHash(f.expression), goalRevision: contentHash(f.goal) });
  expect((await f.engine.branches.read("main")).headCommitId).toBe(f.head);
  const result = await f.engine.commitProposal(candidates[0]!.proposal);
  expect(result.report.errors).toEqual([]);
  const after = await new WorldEngine(f.root, f.context).projections.project(result.newHead, { fresh: true, useCheckpoints: false });
  expect(after.state.values).toEqual(before.state.values);
  expect(after.knowledge.actors).toEqual(before.knowledge.actors);
  expect(after.history.at(-1)!.event.spokenUtterances).toEqual(utterances);
  expect(after.history.at(-1)!.event.realizesCanonicalEventIds).toBeUndefined();
  const event = after.history.at(-1)!.event;
  const locked = event.spokenUtterances!.map((item, index) => ({ utteranceId: committedUtteranceId(event.eventId, index), speaker: scene.speaker, addressees: [scene.listener], text: item.content, mode: "verbatim" as const }));
  expect(renderNarrationBlocks({ version: "narration-blocks-v1", blocks: locked.map(item => ({ kind: "committed-utterance", utteranceId: item.utteranceId })) }, locked)).toBe(scene.quote);
  const badEventHash = await f.engine.objects.putEvent({ ...event, spokenUtterances: [{ ...event.spokenUtterances![0]!, content: "forged source words" }] });
  const badCommit = await f.engine.objects.putCommit({ ...await f.engine.objects.getCommit(result.newHead), eventHashes: [badEventHash] });
  await expect(f.engine.projections.project(badCommit, { fresh: true, useCheckpoints: false })).rejects.toThrow("CONDITIONAL_EXPRESSION_BINDING");
});

it.each([{ knows: false, relation: true }, { knows: true, relation: false }, { knows: true, relation: null }])("suppresses unsupported knowledge or relationship conditions: %j", async ({ knows, relation }) => {
  const f = await fixture(scenes[0], knows, relation);
  expect(await f.sourceActor({ branchId: "main", commitId: f.head })).toEqual([]);
  expect((await f.engine.branches.read("main")).headCommitId).toBe(f.head);
});

it("rechecks forks, current knowledge, exact wording and revision at commit", async () => {
  const f = await fixture();
  const candidate = (await f.sourceActor({ branchId: "main", commitId: f.head }))[0]!.proposal;
  for (const mutation of [
    (p: EventProposal) => { p.spokenUtterances![0]!.content += " and I have the key"; },
    (p: EventProposal) => { p.spokenUtterances![0]!.expressionBinding!.expressionRevision = "0".repeat(64); },
    (p: EventProposal) => { p.spokenUtterances!.push(structuredClone(p.spokenUtterances![0]!)); },
    (p: EventProposal) => { p.spokenUtterances![0]!.expressionBinding!.goalRevision = "0".repeat(64); },
  ]) {
    const changed = structuredClone(candidate); mutation(changed);
    const result = await f.engine.commitProposal(changed);
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some(issue => issue.code.startsWith("CONDITIONAL_EXPRESSION_"))).toBe(true);
    expect(result.newHead).toBe(f.head);
  }
  await new WorldRuntime(f.engine, () => []).forkBranch("main", f.head, "changed", "Changed motivation");
  const changed = await f.engine.commitProposal({ ...candidate, proposalId: "abandon", branchId: "changed", spokenUtterances: undefined, proposedDelta: { version: 1, operations: [{ op: "set", entityId: "speaker", field: "character.plan", value: "leave" }] }, progress: undefined });
  expect(changed.report.errors).toEqual([]);
  expect((await f.engine.commitProposal({ ...candidate, branchId: "changed", expectedParentCommit: changed.newHead })).report.errors.some(issue => issue.code === "CONDITIONAL_EXPRESSION_INELIGIBLE")).toBe(true);
  const forgot = await f.engine.commitProposal({ ...candidate, proposalId: "forget", spokenUtterances: undefined, progress: undefined, proposedKnowledge: { version: 1, operations: [{ op: "forget", actorId: "speaker", claimId: "warning-claim" }] } });
  expect(forgot.report.errors).toEqual([]);
  const attempt = await f.engine.commitProposal({ ...candidate, expectedParentCommit: forgot.newHead, proposedKnowledge: f.learned });
  expect(attempt.report.errors.some(issue => issue.code === "CONDITIONAL_EXPRESSION_INELIGIBLE")).toBe(true);
  expect(attempt.newHead).toBe(forgot.newHead);
});

it("uses the compiled candidate in hybrid policy without exposing source text to a reasoner", async () => {
  const f = await fixture();
  let calls = 0;
  const source = modelActorProposalSource(f.engine, { goals: async () => [f.goal], modelFor: async () => null, reasoner: () => { calls++; return null; } });
  const candidates = await source({ branchId: "main", commitId: f.head });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.proposal.spokenUtterances?.[0]?.content).toBe(f.scene.quote);
  expect(calls).toBe(0);
  expect((await f.engine.commitProposal(candidates[0]!.proposal)).report.errors).toEqual([]);
});

it("permits expressing understood but disbelieved content without turning it into belief or world truth", async () => {
  const f = await fixture();
  const candidate = (await f.sourceActor({ branchId: "main", commitId: f.head }))[0]!.proposal;
  const learns = f.learned.operations[0]!;
  if (learns.op !== "learn") throw new Error("Expected fixture acquisition");
  const update = await f.engine.commitProposal({ ...candidate, proposalId: "disbelieve", progress: undefined, spokenUtterances: undefined,
    proposedKnowledge: { version: 1, operations: [{ ...learns, status: "disbelieves" }] } });
  expect(update.report.errors).toEqual([]);
  const spoke = await f.engine.commitProposal({ ...candidate, expectedParentCommit: update.newHead, progress: undefined });
  expect(spoke.report.errors).toEqual([]);
  const state = await f.engine.projections.project(spoke.newHead);
  expect(state.knowledge.actors.speaker?.["warning-claim"]?.status).toBe("disbelieves");
  expect(state.knowledge.actors.listener?.["warning-claim"]).toBeUndefined();
  expect(state.state.values.place?.["location.is-shut"]).toBeUndefined();
});

it.each(scenes)("validates compiler selectors, closure and frozen goal storage: $speaker", async scene => {
  const f = await fixture(scene);
  const canon = new CanonicalModelStore(f.root);
  for (const entity of f.context.entities.values()) await canon.putEntity(entity);
  for (const proposition of f.context.propositions!.values()) await canon.putProposition(proposition);
  for (const claim of f.context.claims!.values()) await canon.putClaim(claim);
  for (const event of f.context.events!.values()) await canon.putEvent(event);
  await canon.putUtteranceExpression(f.expression);
  const tools = createCompilerProposalToolset(f.root); await tools.beginBatch([], "goals", f.source.source.id);
  const invoke = (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  const { evidence: _, ...payload } = f.goal;
  const input = { proposal_id: "conditional-goal", payload, evidence_segment_ids: [f.source.segmentId] };
  await expect(invoke("propose_character_goal", input)).rejects.toThrow("GOAL_EXPRESSION_EVIDENCE_REQUIRED");
  const paths = ["/candidateAction/expressionCandidates/0/expressionId", "/candidateAction/expressionCandidates/0/requiredKnowledgeClaimIds/0", "/candidateAction/expressionCandidates/0/relationshipConditions/0"];
  await invoke("propose_character_goal", { ...input, evidence_selectors: paths.map(target_path => ({ segment_id: f.source.segmentId, exact: scene.text, target_path, relation: "supports", strength: "explicit" })) });
  const expressionPaths = ["/canonicalEventId", "/speakerId", "/addresseeIds/0", "/modality", "/quotation/quotationId", "/propositionId", ...["subjectEntityId", "relationId", "polarity", "modality", "object/value"].map(key => `/propositions/0/snapshot/${key}`)];
  const { evidence: _expressionEvidence, ...expressionPayload } = f.expression;
  await invoke("propose_utterance_expression", { proposal_id: "source-expression", payload: { ...expressionPayload, quotation: { quotationId: "quotation" }, propositions: [{ propositionId: "content" }], fragments: [{ segment_id: f.source.segmentId, exact: scene.quote, occurrence: 2 }] }, evidence_segment_ids: [f.source.segmentId], evidence_selectors: expressionPaths.map(target_path => ({ segment_id: f.source.segmentId, exact: scene.quote, occurrence: 2, target_path, relation: "supports", strength: "explicit" })) });
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Source-backed conditional expression" });
  expect((await convergeWorldProposals(f.root, f.source.source.id)).canonical.blocked).toEqual([]);
  const frozen = await new WorldContextStore(f.root).captureCurrent(f.source.source.id);
  expect(frozen.actorGoals?.[0]?.candidateAction?.expressionCandidates).toEqual(f.goal.candidateAction!.expressionCandidates);
  expect((await new WorldContextStore(f.root).load(frozen.canonicalSnapshotHash!)).actorGoals).toEqual(frozen.actorGoals);
  await new InitialWorldStore(f.root).put({ version: 1, delta: f.initial, knowledge: f.learned, participantPresence: [{ entityId: "speaker", mode: "physical" }, { entityId: "listener", mode: "physical" }], evidence: f.source.evidence(scene.text) });
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, (await prepareCompilerBatches(f.root, f.source.source)).map(item => item.id));
  const cacheRoot = path.join(f.root, "cache"), cache = new PreparedNovelCache(f.root, cacheRoot);
  const bundle = await cache.candidateSnapshot(f.source.source);
  const audit = await auditCompiler(f.root, { sourceId: f.source.source.id });
  expect(audit.canonical.autonomousWorldDrivers).toBe(1);
  expect(audit.canonical.openingActiveWorldDrivers).toBe(1);
  const closure = buildPreparedClosure(bundle);
  expect(closure.issues).toEqual([]);
  expect(closure.nodes.find(node => node.kind === "goal" && node.id === f.goal.id)!.dependsOn).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "utterance-expression", id: f.expression.id }), expect.objectContaining({ kind: "claim", id: "warning-claim" }),
  ]));
  const archived = await cache.archiveCandidate(f.source.source);
  const rebuiltRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-conditional-rebuild-")); roots.push(rebuiltRoot);
  const rebuiltSource = await createEvidenceFixture(rebuiltRoot, scene.text);
  await new PreparedNovelCache(rebuiltRoot, cacheRoot).restoreCompilerCheckpoint(rebuiltSource.source, archived.bundleHash!);
  const rebuiltContext = await new WorldContextStore(rebuiltRoot).captureCurrent(rebuiltSource.source.id);
  const rebuilt = new WorldEngine(rebuiltRoot, rebuiltContext);
  const rebuiltHead = await rebuilt.createBranch("rebuilt", "Rebuilt", f.initial, f.learned);
  const rebuiltCandidates = await deterministicActorProposalSource(rebuilt, new ActorModelStore(rebuiltRoot))({ branchId: "rebuilt", commitId: rebuiltHead });
  expect(rebuiltCandidates[0]!.proposal.spokenUtterances?.[0]?.content).toBe(scene.quote);
  expect((await rebuilt.commitProposal(rebuiltCandidates[0]!.proposal)).report.errors).toEqual([]);
  expect(validateGoalExpressions(f.goal, frozen)).toEqual([]);
  expect(validateGoalExpressionEvidence(f.goal, [])).toHaveLength(3);
  const bad = structuredClone(f.goal); bad.candidateAction!.expressionCandidates![0]!.expressionId = "missing";
  expect(validateGoalExpressions(bad, frozen)[0]!.code).toBe("GOAL_EXPRESSION_MISSING");
  expect(conditionalExpressionUtterances(bad, 0, frozen, await f.engine.projections.project(f.head))).toBeUndefined();
  await new EvidenceAssertionStore(f.root).replaceForArtifact("character-goal", f.goal.id, contentHash(frozen.actorGoals![0]), []);
  await expect(cache.candidateSnapshot(f.source.source)).rejects.toThrow("Conditional expression goal evidence");
});

it.each(scenes)("routes conditional source speech through one current session and stops ambiguity: $speaker", async scene => {
  const remoteScene = { ...scene, text: scene.text + (scene.speaker === "Ada"
    ? " Ada is an autonomous voice without a body; Console carries her audio to Bo during an open call, and Bo can speak back through it."
    : " 宁是自主的无身体声音；通话开启时，终端把宁的语音传给维，维也能通过通话回复。") };
  const f = await fixture(remoteScene, true, true, true);
  const direct = conditionalExpressionUtterances(f.goal, 0, await f.engine.contextForCommit(f.head), await f.engine.projections.project(f.head));
  expect(direct).toHaveLength(1);
  const preview = await f.engine.previewProposal({ proposalId: "probe", branchId: "main", expectedParentCommit: f.head, source: "actor", actorId: "speaker", title: f.goal.candidateAction!.title,
    participants: ["speaker", "listener", "carrier"], participantPresence: [{ entityId: "speaker", mode: "remote" }, { entityId: "listener", mode: "remote" }],
    spokenUtterances: direct, proposedTime: { kind: "unknown" }, preconditions: f.goal.candidateAction!.preconditions, proposedDelta: f.goal.candidateAction!.proposedDelta, causalParents: [], evidence: f.goal.evidence });
  expect(preview.report.errors).toEqual([]);
  const candidates = await f.sourceActor({ branchId: "main", commitId: f.head });
  expect(candidates).toHaveLength(1);
  const utterance = candidates[0]!.proposal.spokenUtterances![0]!;
  expect(utterance.channelBinding?.channelId).toBe("audio");
  expect(candidates[0]!.proposal.participants).toContain("carrier");
  expect(candidates[0]!.proposal.participantPresence).toContainEqual({ entityId: "speaker", mode: "remote" });
  const modelSource = modelActorProposalSource(f.engine, { goals: async () => [f.goal], modelFor: async () => null,
    reasoner: () => { throw new Error("Compiled exact words must not invoke a model"); } });
  const hybrid = await modelSource({ branchId: "main", commitId: f.head });
  expect(hybrid).toHaveLength(1);
  expect(hybrid[0]!.candidateSource).toBe("compiled-action");
  expect(hybrid[0]!.proposal.spokenUtterances).toEqual(candidates[0]!.proposal.spokenUtterances);
  const committed = await f.engine.commitProposal(hybrid[0]!.proposal);
  expect(committed.report.errors).toEqual([]);
  const replay = await new WorldEngine(f.root, f.context).projections.project(committed.newHead, { fresh: true, useCheckpoints: false });
  expect(replay.history.at(-1)!.event.spokenUtterances![0]).toEqual(utterance);
  expect(replay.knowledge.actors.listener).toBeUndefined();
  const request = await f.engine.commitProposal({ proposalId: "ask-remote", branchId: "main", expectedParentCommit: committed.newHead, source: "player", actorId: "listener", title: "Ask through the call",
    participants: ["speaker", "listener", "carrier"], participantPresence: [{ entityId: "speaker", mode: "remote" }, { entityId: "listener", mode: "remote" }],
    spokenUtterances: [{ speakerId: "listener", addresseeIds: ["speaker"], content: "Please repeat the warning.", channel: "audible", channelBinding: { channelId: "reply", processId: utterance.channelBinding!.processId } }],
    proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [] });
  expect(request.report.errors).toEqual([]);
  const response = await f.sourceActor({ branchId: "main", commitId: request.newHead });
  expect(response).toHaveLength(1);
  expect(response[0]!.proposal.participantPresence).toContainEqual({ entityId: "speaker", mode: "remote" });
  const responded = await f.engine.commitProposal(response[0]!.proposal);
  expect(responded.report.errors).toEqual([]);
  const replayResponse = await new WorldEngine(f.root, f.context).projections.project(responded.newHead, { fresh: true, useCheckpoints: false });
  expect(replayResponse.history.at(-1)!.event.spokenUtterances).toEqual([utterance]);
  const event = replay.history.at(-1)!.event;
  const tampered = await f.engine.objects.putEvent({ ...event, spokenUtterances: [{ ...utterance, channelBinding: undefined }] });
  const commit = await f.engine.objects.putCommit({ ...await f.engine.objects.getCommit(committed.newHead), eventHashes: [tampered] });
  await expect(new WorldEngine(f.root, f.context).projections.project(commit, { fresh: true, useCheckpoints: false })).rejects.toThrow("CONDITIONAL_EXPRESSION_BINDING");
  await new WorldRuntime(f.engine, () => []).forkBranch("main", f.head, "ambiguous", "Ambiguous");
  const duplicate = await f.engine.commitProposal({ proposalId: "duplicate", branchId: "ambiguous", expectedParentCommit: f.head, source: "background", title: "Second call",
    participants: ["speaker", "listener", "carrier"], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
    proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-second", process: { templateId: "call", progress: 0,
      ownerBindings: ["speaker", "listener", "carrier"].map(id => ({ roleId: id, entityIds: [id] })) } }] } });
  expect(duplicate.report.errors).toEqual([]);
  expect(await f.sourceActor({ branchId: "ambiguous", commitId: duplicate.newHead })).toEqual([]);
  expect(await modelSource({ branchId: "ambiguous", commitId: duplicate.newHead, maxModelCalls: 0 })).toEqual([]);
  const paused = await f.engine.commitProposal({ proposalId: "pause", branchId: "main", expectedParentCommit: responded.newHead, source: "background", title: "Pause",
    participants: ["speaker", "listener", "carrier"], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
    proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: utterance.channelBinding!.processId, reasonId: "closed" }] } });
  expect(paused.report.errors).toEqual([]);
  const rejected = await f.engine.commitProposal({ ...hybrid[0]!.proposal, expectedParentCommit: paused.newHead });
  expect(rejected.report.accepted).toBe(false);
  expect(rejected.newHead).toBe(paused.newHead);
});
