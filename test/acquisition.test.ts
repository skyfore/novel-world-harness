import { entryAgencyIssues } from "../src/world/entry-agency.js";
import { processTemplateSchema, materializeProcessProposal } from "../src/world/process-ontology.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { repairForEvent } from "./helpers/upstream-repair.js";
import { executeSceneEvent } from "../src/compiler/scene-state.js";
import { deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { acquisitionCatalog, acquisitionSchema, validateAcquisition, validateAcquisitionOperation, hydrateAcquisition } from "../src/world/acquisition.js";
import { KnowledgeProjector, applyKnowledgeDelta, emptyKnowledgeState } from "../src/world/knowledge.js";
import { emptyBranchSemanticState } from "../src/world/semantic-effects.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema, propositionSchema, type EvidenceAssertion } from "../src/world/model.js";
import { contentHash } from "../src/world/canonical.js";
import { utteranceExpressionSchema, validateUtteranceExpression, validateUtteranceExpressionEvidence, validateExpressionAcquisition } from "../src/world/utterance-expression.js";
import { SourceAnnotationStore, quotationSchema, entityMentionSchema } from "../src/compiler/annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "../src/compiler/entity-resolution.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createCompilerProposalToolset, compilerToolAllowedInSemanticStage } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { loadCompilerArtifactRecords } from "../src/compiler/artifact-retrieval.js";
import { validateUtteranceExpressionTrace } from "../src/compiler/utterance-expression-trace.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const scenes = [
  { speaker: "Ada", listener: "Bo", subject: "gate", quote: "the gate is shut", receipt: 'Ada tells Bo: "the gate is shut". Bo understands and believes her.', memory: "Later Bo recalls her warning and still believes the gate is shut.", inference: "From the warning, Bo infers that passage is unavailable.", text: 'Ada tells Bo: "the gate is shut". Bo understands and believes her. Later Bo recalls her warning and still believes the gate is shut. From the warning, Bo infers that passage is unavailable.' },
  { speaker: "宁", listener: "维", subject: "码头", quote: "码头已经关闭", receipt: "宁对维说：“码头已经关闭”。维听懂并相信了她。", memory: "后来维回想起她的话，仍相信码头已经关闭。", inference: "维据此推断无法通行。", text: "宁对维说：“码头已经关闭”。维听懂并相信了她。后来维回想起她的话，仍相信码头已经关闭。维据此推断无法通行。" },
];
async function setup(scene: typeof scenes[number]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-acquisition-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), canon = new CanonicalModelStore(root);
  const bytes = Buffer.from(scene.text);
  const anchor = (text: string) => { const start = bytes.indexOf(Buffer.from(text)); return textAnchorForByteRange(source.source.id, bytes, start, start + Buffer.byteLength(text)); };
  for (const [id, canonicalName, kind] of [["speaker", scene.speaker, "character"], ["listener", scene.listener, "character"], ["place", scene.subject, "location"]] as const) await canon.putEntity({ id, kind, canonicalName, aliases: [], evidence: source.evidence(canonicalName) });
  const derivation = { runId: "test", worker: "test", ontologyVersion: "observation-v1" } as const;
  const mentions = [["speaker", scene.speaker], ["listener", scene.listener]].map(([id, text]) => entityMentionSchema.parse({ version: 1, id: `mention-${id}`, sourceId: source.source.id, derivation, annotationType: "entity-mention", anchor: anchor(text!), surface: text, form: "proper", kindCandidates: ["character"], confidence: 1 }));
  const quotation = quotationSchema.parse({ version: 1, id: "quotation", sourceId: source.source.id, derivation, annotationType: "quotation", anchor: anchor(scene.quote), mode: "direct", speakerMentionId: "mention-speaker", addresseeMentionIds: ["mention-listener"], attributionConfidence: 1 });
  await new SourceAnnotationStore(root).replaceCurrent(source.source.id, [...mentions, quotation]);
  await new EntityResolutionStore(root).replaceCurrent(source.source.id, mentions.map(mention => identityResolutionSchema.parse({ version: 1, id: `resolution-${mention.id}`, sourceId: source.source.id, mentionId: mention.id, status: "resolved", entityId: mention.id.slice(8), candidates: [{ entityId: mention.id.slice(8), confidence: 1, basisMentionIds: [mention.id], evidenceAssertionIds: [], rationale: "Explicit named speaker/addressee" }], rationale: "Explicit named speaker/addressee", derivation: { runId: "test", worker: "test", ontologyVersion: "entity-resolution-v1" } })));
  const proposition = propositionSchema.parse({ id: "content", subjectEntityId: "place", relationId: "is-shut", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted", evidence: source.evidence(scene.quote) });
  await canon.putProposition(proposition);
  const event = canonicalEventSchema.parse({ id: "utterance", title: "A warning", readerSummary: "A warning is heard", participants: ["speaker", "listener"], participantPresence: [{ entityId: "speaker", mode: "physical" }, { entityId: "listener", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "set", entityId: "speaker", field: "character.plan", value: "warned" }] }, causalParents: [], confidence: 1, evidence: source.evidence(scene.text) });
  await canon.putEvent(event);
  await canon.putClaim({ id: "claim", subject: "place", predicate: "is-shut", object: true, epistemicType: "character-claim", evidence: source.evidence(scene.quote) });
  await canon.putAttribution({ id: "report", propositionId: "content", holderKind: "character", holderEntityId: "speaker", attitude: "asserts", certainty: 1, quotationIds: [quotation.id], evidence: source.evidence(scene.text) });
  const expression = utteranceExpressionSchema.parse({ ontologyVersion: "utterance-expression-v1", id: "expression", canonicalEventId: event.id, speakerId: "speaker", addresseeIds: ["listener"], modality: "speech", quotation: { quotationId: quotation.id, revisionHash: contentHash(quotation), anchor: quotation.anchor }, fragments: [{ anchor: quotation.anchor, text: scene.quote }], propositionId: proposition.id, propositions: [{ propositionId: proposition.id, revisionHash: contentHash(proposition), snapshot: proposition }], evidence: source.evidence(scene.text) });
  const paths = ["/canonicalEventId", "/speakerId", "/addresseeIds/0", "/modality", "/quotation/quotationId", "/propositionId", ...["subjectEntityId", "relationId", "polarity", "modality", "object/value"].map(key => `/propositions/0/snapshot/${key}`)];
  const operation = { op: "learn", actorId: "listener", claimId: "claim", propositionId: "content", attributionId: "report", expressionId: "expression", acquisitionMode: "told", sourceActorId: "speaker", status: "heard", confidence: 1 } as const;
  return { root, source, canon, anchor, mentions, quotation, proposition, event, expression, paths, operation };
}

it.each(scenes.flatMap(scene => [false, true].map(repair => ({ ...scene, repair }))))("repair=$repair freezes recipient experience through compile, rebuild, memory, inference and replay: $speaker", async scene => {
  const { root, source, canon, event, expression, quotation, proposition, paths, operation } = await setup(scene);
  if (scene.repair) {
    const annotations = new SourceAnnotationStore(root), shortened = { ...quotation, anchor: textAnchorForByteRange(source.source.id, Buffer.from(scene.text), quotation.anchor.startByte, quotation.anchor.startByte + Buffer.byteLength([...scene.quote][0]!)) };
    await annotations.replaceCurrent(source.source.id, (await annotations.list(source.source.id)).map(item => item.id === quotation.id ? shortened : item));
    await repairForEvent({ root, sourceId: source.source.id, sourceSha256: source.source.contentSha256, segmentId: source.segmentId, bytes: Buffer.from(scene.text), event,
      diagnostic: { code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: quotation.id, revisionHash: contentHash(shortened), expectedAnchor: quotation.anchor },
      proposal: () => ({ proposal_id: "repair-quotation", annotation_id: quotation.id, selector: { segment_id: source.segmentId, exact: scene.quote, occurrence: 1 }, mode: "direct", speaker_mention_id: "mention-speaker", addressee_mention_ids: ["mention-listener"], attribution_confidence: 1 }) });
    expect(quotationSchema.parse(await annotations.read(source.source.id, quotation.id)).anchor).toEqual(quotation.anchor);
  }
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "acquisitions", source.source.id);
  const invoke = (name: string, input: unknown) => toolset.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  const { evidence: _canonicalEvidence, ...canonicalPayload } = event;
  await invoke("propose_canonical_event", { proposal_id: "acquiring-event", payload: { ...canonicalPayload, observedKnowledge: { version: 1, operations: [{ ...operation, acquisitionId: "heard-warning", status: "believes" }] } }, evidence_segment_ids: [source.segmentId] });
  const { evidence: _expressionEvidence, ...expressionPayload } = expression;
  await invoke("propose_utterance_expression", { proposal_id: "expression", payload: { ...expressionPayload, quotation: { quotationId: quotation.id }, propositions: [{ propositionId: proposition.id }], fragments: [{ segment_id: source.segmentId, exact: scene.quote, occurrence: 1 }] }, evidence_segment_ids: [source.segmentId], evidence_selectors: paths.map(target_path => ({ segment_id: source.segmentId, exact: scene.quote, occurrence: 1, target_path, relation: "supports", strength: "explicit" })) });
  const { evidence: _report, ...report } = await canon.getAttribution("report");
  await invoke("propose_attribution", { proposal_id: "bind-report", payload: { ...report, expressionIds: [expression.id] }, evidence_segment_ids: [source.segmentId] });
  for (const [id, text] of [["remember", scene.memory], ["infer", scene.inference]]) await canon.putEvent({ ...event, id: id!, title: text!, readerSummary: text!, evidence: source.evidence(text!), observedOutcome: { version: 1, operations: [] }, ...(id === "remember" ? { observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "listener", claimId: "claim", propositionId: "content", acquisitionId: "remember-warning", acquisitionMode: "remembered", status: "believes", confidence: 1 }] } } : {}), storyTime: { kind: "relative", relation: "after", anchorEventId: event.id } });
  await canon.putProposition({ ...proposition, id: "conclusion", relationId: "passage-unavailable", evidence: source.evidence(scene.inference) });
  await canon.putClaim({ id: "conclusion-claim", subject: "place", predicate: "passage-unavailable", object: true, epistemicType: "inference", evidence: source.evidence(scene.inference) });
  const reception = { received: true, understood: true, belief: "accepted" };
  const payload = { ontologyVersion: "acquisition-v1", id: "heard-warning", actorId: "listener", canonicalEventId: event.id, cut: "event-end", claimId: "claim", propositionId: "content", basis: { mode: "told", expressionId: "expression", attributionId: "report" }, reception };
  const acquire = async (value: typeof payload | Record<string, unknown>, exact: string, missing = false) => {
    const basis = value.basis as Record<string, unknown>;
    const fields = ["/actorId", "/canonicalEventId", "/cut", "/claimId", "/propositionId", "/reception/received", "/reception/understood", "/reception/belief", ...Object.keys(basis).map(key => `/basis/${key}`)];
    return invoke("propose_acquisition", { proposal_id: value.id, payload: value, evidence_segment_ids: [source.segmentId], evidence_selectors: fields.slice(missing ? 1 : 0).map(target_path => ({ segment_id: source.segmentId, exact, target_path, relation: "supports", strength: "explicit" })) });
  };
  await expect(acquire(payload, scene.receipt, true)).rejects.toThrow("ACQUISITION_EVIDENCE_MISSING");
  await acquire(payload, scene.receipt);
  await acquire({ ...payload, id: "remember-warning", canonicalEventId: "remember", basis: { mode: "remembered", priorAcquisitionId: payload.id } }, scene.memory);
  await acquire({ ...payload, id: "infer-passage", canonicalEventId: "infer", claimId: "conclusion-claim", propositionId: "conclusion", basis: { mode: "inferred", premiseAcquisitionIds: [payload.id], rationale: scene.inference } }, scene.inference);
  await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent receipt, recollection and inference evidence" });
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  expect(await canon.listAcquisitions()).toHaveLength(3);
  const initial = { version: 1 as const, operations: [{ op: "set" as const, entityId: "speaker", field: "character.plan", value: "warn" }, { op: "set" as const, entityId: "speaker", field: "character.alive", value: true }, { op: "set" as const, entityId: "listener", field: "character.alive", value: true }] };
  await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(scene.receipt), delta: initial, participantPresence: event.participantPresence });
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot), bundle = await cache.candidateSnapshot(source.source), archived = await cache.archiveCandidate(source.source);
  expect(buildPreparedClosure(bundle).issues).toEqual([]);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-acquisition-clone-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, scene.text);
  await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(cloneSource.source, archived.bundleHash!);
  const contexts = new WorldContextStore(cloneRoot), context = await contexts.captureCurrent(cloneSource.source.id), engine = new WorldEngine(cloneRoot, context);
  const head = await engine.createBranch("main", "Before receipt", initial, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
  await new WorldRuntime(engine, () => []).forkBranch("main", head, "silent", "No acquired experience");
  const received = { ...operation, acquisitionId: payload.id, status: "believes" };
  const proposal = { proposalId: "receive", branchId: "main", expectedParentCommit: head, source: "canon-candidate", title: "Receive warning", participants: event.participants, participantPresence: event.participantPresence, preconditions: [], proposedTime: { kind: "unknown" }, proposedDelta: event.observedOutcome, proposedKnowledge: { version: 1, operations: [received] }, possibilityId: "canon-utterance", causalParents: [], evidence: [] };
  const receipt = await engine.commitProposal(proposal as never); expect(receipt.report.errors).toEqual([]);
  const learned = await engine.projections.project(receipt.newHead, { fresh: true, useCheckpoints: false });
  expect(learned.knowledge.acquisitions?.[payload.id]).toMatchObject({ actorId: "listener", reception });
  const remembered = { op: "learn", actorId: "listener", claimId: "claim", propositionId: "content", acquisitionId: "remember-warning", acquisitionMode: "remembered", status: "believes", confidence: 1 };
  const recallProposal = { ...proposal, proposalId: "remember", expectedParentCommit: receipt.newHead, proposedDelta: { version: 1, operations: [] }, proposedKnowledge: { version: 1, operations: [remembered] }, possibilityId: "canon-remember" };
  const absent = await engine.commitProposal({ ...recallProposal, branchId: "silent", expectedParentCommit: head } as never);
  expect(absent.report.errors.some(item => item.code === "ACQUISITION_PRIOR_NOT_REALIZED" || item.message.includes("ACQUISITION_PRIOR_NOT_REALIZED"))).toBe(true);
  const inference = { ...remembered, claimId: "conclusion-claim", propositionId: "conclusion", acquisitionId: "infer-passage", acquisitionMode: "inferred" };
  const inferred = await engine.commitProposal({ ...recallProposal, proposalId: "infer", proposedKnowledge: { version: 1, operations: [inference] }, possibilityId: "canon-infer" } as never);
  expect(inferred.report.errors).toEqual([]);
  const forgotten = await engine.commitProposal({ ...recallProposal, proposalId: "forget", source: "actor", actorId: "listener", expectedParentCommit: inferred.newHead, possibilityId: undefined, proposedKnowledge: { version: 1, operations: [{ op: "forget", actorId: "listener", claimId: "claim", propositionId: "content" }] } } as never);
  expect(forgotten.report.errors).toEqual([]);
  const missingPremise = await engine.commitProposal({ ...recallProposal, proposalId: "infer-forgotten", expectedParentCommit: forgotten.newHead, proposedKnowledge: { version: 1, operations: [inference] }, possibilityId: "canon-infer" } as never);
  expect(missingPremise.report.errors.some(item => item.code === "ACQUISITION_PREMISE_UNAVAILABLE" || item.message.includes("ACQUISITION_PREMISE_UNAVAILABLE"))).toBe(true);
  const recalled = await engine.commitProposal({ ...recallProposal, expectedParentCommit: forgotten.newHead } as never); expect(recalled.report.errors).toEqual([]);
  expect((await engine.projections.project(recalled.newHead, { fresh: true, useCheckpoints: false })).knowledge.acquisitions?.["remember-warning"]).toMatchObject({ actorId: "listener", propositionId: "content" });
  expect((await engine.projections.project(head, { fresh: true, useCheckpoints: false })).knowledge.acquisitions).toBeUndefined();
  expect((await new KnowledgeProjector(engine).view("listener", recalled.newHead)).knowledge.map(entry => entry.fact.claimId)).toContain("conclusion-claim");
  const { acquisitionId: _removed, ...stripped } = received;
  expect((await engine.commitProposal({ ...proposal, branchId: "silent", proposedKnowledge: { version: 1, operations: [stripped] } } as never)).report.errors.some(item => item.code === "ACQUISITION_REQUIRED" || item.message.includes("ACQUISITION_REQUIRED"))).toBe(true);
  const lateBundle = structuredClone(bundle);
  const lateEvent = canonicalEventSchema.parse({ ...event, id: "entry", title: "Before recollection", readerSummary: "The listener considers the warning", evidence: source.evidence(scene.memory), observedOutcome: { version: 1, operations: [{ op: "set", entityId: "listener", field: "character.plan", value: "future-canon" }] }, characterEntryCheckpoints: [{ actorId: "listener", readerSetup: "The warning has already been heard", actorObservation: "I remember hearing the warning", participantPresence: [{ entityId: "listener", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "listener", field: "character.location", value: "place" }] } }] });
  lateBundle.canonical.events.push(lateEvent);
  lateBundle.canonical.initialWorld.checkpoint = { mode: "chronological", rationale: "Before the source warning", beforeCanonicalEventId: event.id, storyTime: event.storyTime };
  lateBundle.canonical.eventRelations = [["utterance", "entry"], ["entry", "remember"], ["entry", "infer"]].map(([fromEventId, toEventId], index) => ({ id: `entry-order-${index}`, fromEventId: fromEventId!, toEventId: toEventId!, type: "before", operationality: "non-operational", status: "explicit", confidence: 1, evidence: source.evidence(scene.text) }));
  const lateSeed = deriveCharacterEntrySeed(lateBundle, "listener");
  expect(lateSeed.projectionSeed?.knowledgeHistory).toMatchObject({ beforeCanonicalEventId: "entry", actorId: "listener", cutHash: lateSeed.cut.hash });
  const lateContext = await contexts.capturePrepared(source.source.id, contentHash(lateBundle), lateBundle.canonical);
  const lateEngine = new WorldEngine(cloneRoot, lateContext);
  const createLate = (id: string, seed = lateSeed) => lateEngine.createBranch(id, "Historical warning", seed.delta, seed.knowledge, undefined, undefined, seed.evidence, { storyTime: seed.storyTime }, { entryActorId: "listener", projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds });
  const lateHead = await createLate("late");
  const lateProjection = await lateEngine.projections.project(lateHead, { fresh: true, useCheckpoints: false });
  expect(lateProjection.knowledge.acquisitions?.["heard-warning"]).toMatchObject({ actorId: "listener", acquiredAtCommit: lateHead });
  expect(lateProjection.knowledge.acquisitions?.["remember-warning"]).toBeUndefined();
  expect(lateProjection.knowledge.acquisitions?.["infer-passage"]).toBeUndefined();
  expect(lateProjection.state.values.listener?.["character.plan"]).not.toBe("future-canon");
  expect((await new KnowledgeProjector(lateEngine).view("speaker", lateHead)).knowledge).toHaveLength(0);
  const entered = await lateEngine.commitProposal({ ...proposal, branchId: "late", expectedParentCommit: lateHead, proposalId: "enter", possibilityId: "canon-entry", proposedDelta: lateEvent.observedOutcome, proposedKnowledge: undefined } as never);
  expect(entered.report.errors).toEqual([]);
  const inferredLate = await lateEngine.commitProposal({ ...recallProposal, branchId: "late", expectedParentCommit: entered.newHead, proposalId: "late-infer", proposedKnowledge: { version: 1, operations: [inference] }, possibilityId: "canon-infer" } as never);
  expect(inferredLate.report.errors).toEqual([]);
  await new WorldRuntime(lateEngine, () => []).forkBranch("late", lateHead, "late-fork", "Only the earlier warning");
  expect((await lateEngine.projections.project(lateHead, { fresh: true, useCheckpoints: false })).knowledge.acquisitions?.["infer-passage"]).toBeUndefined();
  // Explicit host module tests composition with real historical receipts, not source induction of radio capability.
  const remoteBundle = structuredClone(lateBundle);
  const radio = processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "test-radio", name: "Test radio",
    ownerRoles: [{ id: "actor", label: "Actor", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
      { id: "peer", label: "Peer", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
      { id: "carrier", label: "Carrier", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 }],
    phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open", transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"],
    visibility: "knowledge", knownByClaimIds: ["claim"], induction: { kind: "domain-module", moduleId: "test-radio", moduleVersion: "1" }, evidence: [] });
  remoteBundle.canonical.processTemplates.push(radio);
  remoteBundle.canonical.entities.push({ id: "test-radio-device", kind: "artifact", canonicalName: "Test receiver", aliases: [], evidence: source.evidence(scene.text) });
  remoteBundle.canonical.entities.find(item => item.id === "listener")!.agencyProfile = {
    ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily", channels: [{ id: "radio", modality: "audio", processTemplateId: radio.id, actorRoleId: "actor", peerRoleId: "peer", carrierRoleId: "carrier", activePhaseIds: ["open"] }],
  };
  const remoteEvent = remoteBundle.canonical.events.find(item => item.id === "entry")!;
  remoteEvent.participantPresence = [{ entityId: "listener", mode: "remote" }, { entityId: "speaker", mode: "physical" }];
  const remoteCheckpoint = remoteEvent.characterEntryCheckpoints![0]!;
  remoteCheckpoint.participantPresence = [{ entityId: "listener", mode: "remote" }];
  remoteCheckpoint.delta = lateSeed.delta;
  remoteCheckpoint.knowledge = { version: 1, operations: [received as never] };
  remoteCheckpoint.projectionSeed = { version: 1, elapsedDays: 0, activeRuleIds: [], semantics: { version: 1, operations: [] }, norms: { version: 1, operations: [] },
    processes: materializeProcessProposal({ version: 1, operations: [{ op: "start-process", localRef: "local-radio", process: { templateId: radio.id, ownerBindings: [{ roleId: "actor", entityIds: ["listener"] }, { roleId: "peer", entityIds: ["speaker"] }, { roleId: "carrier", entityIds: ["test-radio-device"] }], progress: 0 } }] }, { branchId: "remote-late", parentCommitId: lateHead, templates: new Map([[radio.id, radio]]), elapsedDays: 0 }).delta };
  expect(entryAgencyIssues("listener", remoteCheckpoint, { sourceId: source.source.id, entities: new Map(remoteBundle.canonical.entities.map(item => [item.id, item])), processTemplates: new Map(remoteBundle.canonical.processTemplates.map(item => [item.id, item])), actionSchemas: new Map(remoteBundle.canonical.actionSchemas.map(item => [item.id, item])), acquisitions: new Map(remoteBundle.canonical.acquisitions.map(item => [item.id, item])) })).toEqual([]);
  const remoteSeed = deriveCharacterEntrySeed(remoteBundle, "listener");
  expect(remoteSeed.knowledge!.operations.filter(item => item.op === "learn" && item.acquisitionId === "heard-warning")).toHaveLength(1);
  const remoteContext = await contexts.capturePrepared(source.source.id, contentHash(remoteBundle), remoteBundle.canonical);
  const remoteEngine = new WorldEngine(cloneRoot, remoteContext);
  const remoteHead = await remoteEngine.createBranch("remote-late", "Historical radio entry", remoteSeed.delta, remoteSeed.knowledge, undefined, undefined, remoteSeed.evidence, { storyTime: remoteSeed.storyTime }, { entryActorId: "listener", participantPresence: remoteSeed.participantPresence, projectionSeed: remoteSeed.projectionSeed, realizesCanonicalEventIds: remoteSeed.realizesCanonicalEventIds });
  const remoteProjection = await remoteEngine.projections.project(remoteHead, { fresh: true, useCheckpoints: false });
  expect(remoteProjection.knowledge.acquisitions?.["heard-warning"]).toMatchObject({ actorId: "listener", acquiredAtCommit: remoteHead });
  expect(remoteProjection.knowledge.acquisitions?.["infer-passage"]).toBeUndefined();
  expect(remoteProjection.history[0]!.event.participantPresence).toEqual([{ entityId: "listener", mode: "remote" }]);
  const staleKnowledgeBundle = structuredClone(remoteBundle);
  staleKnowledgeBundle.canonical.events.find(item => item.id === "entry")!.characterEntryCheckpoints![0]!.knowledge!.operations[0] = { ...received, status: "disbelieves" } as never;
  expect(() => deriveCharacterEntrySeed(staleKnowledgeBundle, "listener")).toThrow();
  const badCut = structuredClone(lateSeed); badCut.projectionSeed!.knowledgeHistory!.cutHash = "0".repeat(64);
  await expect(createLate("bad-cut", badCut)).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
  const badKnowledge = structuredClone(lateSeed); badKnowledge.knowledge!.operations.push(inference as never);
  await expect(createLate("bad-knowledge", badKnowledge)).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
  const futureCut = structuredClone(lateSeed); futureCut.realizesCanonicalEventIds.push("infer");
  await expect(createLate("future-cut", futureCut)).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
  const afterMemoryBundle = structuredClone(lateBundle);
  const afterMemoryEvent = { ...lateEvent, id: "after-memory", evidence: source.evidence(scene.inference) };
  afterMemoryBundle.canonical.events = [...afterMemoryBundle.canonical.events.filter(item => item.id !== "entry"), afterMemoryEvent];
  afterMemoryBundle.canonical.eventRelations = [["utterance", "remember"], ["remember", "after-memory"], ["after-memory", "infer"]].map(([fromEventId, toEventId], index) => ({ id: `memory-order-${index}`, fromEventId: fromEventId!, toEventId: toEventId!, type: "before", operationality: "non-operational", status: "explicit", confidence: 1, evidence: source.evidence(scene.text) }));
  const memorySeed = deriveCharacterEntrySeed(afterMemoryBundle, "listener");
  const memoryContext = await contexts.capturePrepared(source.source.id, contentHash(afterMemoryBundle), afterMemoryBundle.canonical);
  const memoryEngine = new WorldEngine(cloneRoot, memoryContext);
  const memoryHead = await memoryEngine.createBranch("after-memory", "Two prior experiences", memorySeed.delta, memorySeed.knowledge, undefined, undefined, memorySeed.evidence, {}, { entryActorId: "listener", projectionSeed: memorySeed.projectionSeed, realizesCanonicalEventIds: memorySeed.realizesCanonicalEventIds });
  const memoryReplay = await memoryEngine.projections.project(memoryHead, { fresh: true, useCheckpoints: false });
  expect(Object.keys(memoryReplay.knowledge.acquisitions ?? {}).sort()).toEqual(["heard-warning", "remember-warning"]);
  expect(memoryReplay.knowledge.actors.listener?.claim?.acquisitionId).toBe("remember-warning");
  const checkpointBundle = structuredClone(afterMemoryBundle);
  const checkpointEvent = checkpointBundle.canonical.events.find(item => item.id === "after-memory")!;
  checkpointEvent.characterEntryCheckpoints![0] = { ...checkpointEvent.characterEntryCheckpoints![0]!, delta: memorySeed.delta, knowledge: memorySeed.knowledge, projectionSeed: memorySeed.projectionSeed };
  const checkpointReplay = executeSceneEvent(checkpointBundle, checkpointEvent, "listener", { beforeOnly: true });
  expect(Object.keys(checkpointReplay.beforeKnowledge.acquisitions ?? {}).sort()).toEqual(["heard-warning", "remember-warning"]);
  await new InitialWorldStore(cloneRoot).put({ ...lateBundle.canonical.initialWorld, delta: { version: 1, operations: [] } });

  expect((await contexts.load(lateContext.canonicalSnapshotHash!)).initialWorld).toEqual(lateBundle.canonical.initialWorld);
  const stored = (await canon.listAcquisitions()).find(item => item.id === payload.id)!;
  const frozenCatalog = acquisitionCatalog(context);
  const revisedPropositions = new Map(context.propositions); revisedPropositions.set(proposition.id, { ...proposition, object: { kind: "literal", value: false } });
  expect(validateAcquisition(stored, { ...frozenCatalog, propositions: revisedPropositions }).some(issue => issue.code === "ACQUISITION_REVISION_MISMATCH")).toBe(true);
  expect(validateAcquisition({ ...stored, basis: { mode: "remembered", priorAcquisitionId: stored.id } }, frozenCatalog).some(issue => issue.code === "ACQUISITION_DEPENDENCY_CYCLE")).toBe(true);
  const rememberedRecord = context.acquisitions!.get("remember-warning")!;
  expect(validateAcquisition({ ...rememberedRecord, actorId: "speaker" }, frozenCatalog).some(issue => issue.code === "ACQUISITION_PRIOR_MISMATCH")).toBe(true);
  const projectedEvents = new Map(context.events); projectedEvents.set(event.id, { ...context.events!.get(event.id)!, title: "Derived execution display" });
  expect(validateAcquisition(stored, { ...frozenCatalog, events: projectedEvents })).toEqual([]);
  const staleBundle = structuredClone(bundle); staleBundle.canonical.acquisitions.find(item => item.id === stored.id)!.revisions[0]!.hash = "0".repeat(64);
  expect(buildPreparedClosure(staleBundle).issues.some(issue => issue.code === "CLOSURE_REVISION_MISMATCH")).toBe(true);
  await new EvidenceAssertionStore(root).replaceForArtifact("acquisition", stored.id, contentHash(stored), []);
  await expect(cache.candidateSnapshot(source.source)).rejects.toThrow("Acquisition evidence");
  if (scene.repair) {
    const repair = (await new UpstreamRepairLedger(root, source.source.id).inspect()).plans[0]!;
    expect(repair.plan.requirementIds).toEqual(["occurrence:state-effect"]);
    expect(repair.evaluation).toBeUndefined(); // A source fix cannot certify an unfreezable downstream candidate.
  }
  expect((await contexts.load(context.canonicalSnapshotHash!)).acquisitions?.get(stored.id)).toEqual(stored);
  const unverified = createCompilerProposalToolset(root); await unverified.beginBatch([], "unverified-new", source.source.id);
  const { evidence: _eventEvidence, ...eventPayload } = event;
  await expect(unverified.tools.find(tool => tool.name === "propose_canonical_event")!.execute("new-legacy", { proposal_id: "new-unverified", payload: { ...eventPayload, id: "new-unverified", observedKnowledge: { version: 1, operations: [operation] } }, evidence_segment_ids: [source.segmentId] } as never, undefined, undefined, {} as never)).rejects.toThrow("ACQUISITION_REQUIRED");
  await expect(canon.getEvent("new-unverified")).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(scenes)("separates reading, uncomprehended receipt and mistaken sources: $speaker", async original => {
  for (const mode of ["read", "remote-read", "deceived-misattributed", "ununderstood"] as const) {
    const reading = mode === "read" || mode === "remote-read";
    const text = mode === "remote-read" ? `${original.speaker} writes a notice for ${original.listener}: "${original.quote}". ${original.listener} at the ${original.subject} reads it through an already-open terminal text session and understands and believes it; the document remains in the remote archive.`
      : mode === "read" ? `${original.speaker} writes a notice for ${original.listener}: "${original.quote}". ${original.listener} reads, understands and believes it. Both are at the ${original.subject}.`
      : mode === "deceived-misattributed" ? `${original.speaker}, impersonating Ivo, tells ${original.listener}: "${original.quote}". ${original.listener} understands, believes it, and mistakes the speaker for Ivo.`
      : `${original.speaker} tells ${original.listener} in an unfamiliar language: "${original.quote}". ${original.listener} hears the sounds but does not understand or form a belief.`;
    const scene = { ...original, text, receipt: text };
    const { root, source, canon, event, expression, quotation, proposition, paths } = await setup(scene);
    const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], mode, source.source.id);
    const invoke = (name: string, input: unknown) => toolset.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
    if (reading) {
      await canon.putEntity({ id: "notice", kind: "artifact", canonicalName: "notice", aliases: [], evidence: source.evidence("notice") });
      await canon.putEvent({ ...event, participants: [...event.participants, "notice"] });
    }
    if (mode === "remote-read") {
      for (const [id, kind] of [["terminal", "artifact"], ["archive", "location"]] as const) await canon.putEntity({ id, kind, canonicalName: id, aliases: [], evidence: source.evidence(text) });
      await canon.putProcessTemplate(processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "text-access", name: "Document terminal", ownerRoles: [
        { id: "reader", label: "Reader", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
        ...["document", "carrier"].map(id => ({ id, label: id, allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 })),
      ], phases: [{ id: "open", label: "Open", terminal: false }, { id: "closed", label: "Closed", terminal: true }], initialPhaseId: "open", transitions: [{ fromPhaseId: "open", toPhaseId: "closed", minimumProgress: 1 }], outcomeIds: ["closed"], visibility: "public", induction: { kind: "domain-module", moduleId: "test-text-access", moduleVersion: "1" }, evidence: [] }));
      const { evidence: _entityEvidence, ...reader } = await canon.getEntity("listener");
      const profile = { ontologyVersion: "agency-channel-v1", agency: "autonomous", embodiment: "bodily", channels: [{ id: "screen", modality: "text", processTemplateId: "text-access", actorRoleId: "reader", peerRoleId: "document", carrierRoleId: "carrier", activePhaseIds: ["open"] }] };
      const selectors = ["/agencyProfile/agency", "/agencyProfile/embodiment", ...["modality", "processTemplateId", "actorRoleId", "peerRoleId", "carrierRoleId", "activePhaseIds/0"].map(key => `/agencyProfile/channels/0/${key}`)];
      await invoke("propose_entity", { proposal_id: "reader-profile", payload: { ...reader, agencyProfile: profile }, evidence_segment_ids: [source.segmentId], evidence_selectors: selectors.map(target_path => ({ segment_id: source.segmentId, exact: text, target_path, relation: "supports", strength: "explicit" })) });
      await canon.putEvent({ ...event, participants: [...event.participants, "notice", "terminal"], participantPresence: [{ entityId: "speaker", mode: "physical" }, { entityId: "listener", mode: "remote" }], observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "listener", claimId: "claim", propositionId: "content", acquisitionId: "received", expressionId: expression.id, attributionId: "report", acquisitionMode: "read", status: "believes", confidence: 1 }] } });
    }
    if (mode === "deceived-misattributed") await canon.putEntity({ id: "ivo", kind: "character", canonicalName: "Ivo", aliases: [], evidence: source.evidence("Ivo") });
    const { evidence: _source, ...base } = expression;
    await invoke("propose_utterance_expression", { proposal_id: "expression", payload: { ...base, ...(reading ? { modality: "writing", documentId: "notice" } : {}), quotation: { quotationId: quotation.id }, propositions: [{ propositionId: proposition.id }], fragments: [{ segment_id: source.segmentId, exact: scene.quote }] }, evidence_segment_ids: [source.segmentId], evidence_selectors: [...paths, ...(reading ? ["/documentId"] : [])].map(target_path => ({ segment_id: source.segmentId, exact: target_path === "/documentId" ? "notice" : scene.quote, target_path, relation: "supports", strength: "explicit" })) });
    const { evidence: _report, ...report } = await canon.getAttribution("report");
    await invoke("propose_attribution", { proposal_id: "report", payload: { ...report, expressionIds: [expression.id], ...(reading ? { holderKind: "document", holderEntityId: "notice" } : {}) }, evidence_segment_ids: [source.segmentId] });
    const basis = reading ? { mode: "read", expressionId: expression.id, attributionId: "report", documentId: "notice", ...(mode === "remote-read" ? { textChannel: { channelId: "screen", processTemplateId: "text-access" } } : {}) }
      : mode === "deceived-misattributed" ? { mode, expressionId: expression.id, attributionId: "report", actualSourceActorId: "speaker", believedSourceActorId: "ivo" }
      : { mode: "told", expressionId: expression.id, attributionId: "report" };
    const reception = { received: true, understood: mode !== "ununderstood", belief: mode === "ununderstood" ? "undecided" : "accepted" };
    const payload = { ontologyVersion: "acquisition-v1", id: "received", actorId: "listener", canonicalEventId: event.id, cut: "event-end", claimId: "claim", propositionId: "content", basis, reception };
    const fields = ["/actorId", "/canonicalEventId", "/cut", "/claimId", "/propositionId", "/reception/received", "/reception/understood", "/reception/belief", ...Object.keys(basis).map(key => `/basis/${key}`), ...(mode === "remote-read" ? ["/basis/textChannel/channelId", "/basis/textChannel/processTemplateId"] : [])];
    if (mode === "remote-read") {
      await expect(invoke("propose_acquisition", { proposal_id: "received", payload, evidence_segment_ids: [source.segmentId], evidence_selectors: fields.filter(pointer => pointer !== "/basis/textChannel/channelId").map(target_path => ({ segment_id: source.segmentId, exact: text, target_path, relation: "supports", strength: "explicit" })) })).rejects.toThrow("ACQUISITION_EVIDENCE_MISSING");
      expect(await canon.listAcquisitions()).toEqual([]);
    }
    await invoke("propose_acquisition", { proposal_id: "received", payload, evidence_segment_ids: [source.segmentId], evidence_selectors: fields.map(target_path => ({ segment_id: source.segmentId, exact: text, target_path, relation: "supports", strength: "explicit" })) });
    await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent reception without truth promotion" });
    expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
    const context = await new WorldContextStore(root).captureCurrent(source.source.id), engine = new WorldEngine(root, context);
    const initial = { version: 1 as const, operations: [{ op: "set" as const, entityId: "speaker", field: "character.alive", value: true }, { op: "set" as const, entityId: "listener", field: "character.alive", value: true }] };
    const readingInitial = reading ? { version: 1 as const, operations: [...initial.operations,
      { op: "set" as const, entityId: "listener", field: "character.location", value: "place" },
      { op: "set" as const, entityId: "notice", field: "artifact.location", value: mode === "remote-read" ? "archive" : "place" },
    ] } : initial;
    let head = await engine.createBranch("main", "Before receipt", readingInitial, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [] });
    if (mode === "remote-read") {
      const started = await engine.commitProposal({ proposalId: "open-text", branchId: "main", expectedParentCommit: head, source: "background", title: "Open terminal", participants: ["listener", "notice", "terminal"], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [], proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-text", process: { templateId: "text-access", ownerBindings: [{ roleId: "reader", entityIds: ["listener"] }, { roleId: "document", entityIds: ["notice"] }, { roleId: "carrier", entityIds: ["terminal"] }], progress: 0 } }] } });
      expect(started.report.errors).toEqual([]); head = started.newHead;
    }
    const operation = { op: "learn", actorId: "listener", claimId: "claim", propositionId: "content", acquisitionId: payload.id, expressionId: expression.id, attributionId: "report", acquisitionMode: basis.mode, status: mode === "ununderstood" ? "heard" : "believes", confidence: 1, ...(reading ? {} : { sourceActorId: "speaker" }) };
    const proposal = { proposalId: "receive", branchId: "main", expectedParentCommit: head, source: "canon-candidate", title: "Receive content", participants: (await canon.getEvent(event.id)).participants, participantPresence: (await canon.getEvent(event.id)).participantPresence, preconditions: [], proposedTime: { kind: "unknown" }, proposedDelta: event.observedOutcome, proposedKnowledge: { version: 1, operations: [operation] }, possibilityId: "canon-utterance", causalParents: [], evidence: [] };
    const wrongProposal = { ...proposal, proposedKnowledge: { version: 1, operations: [{ ...operation, status: "knows" }] } };
    if (mode === "deceived-misattributed") await expect(engine.commitProposal(wrongProposal as never)).rejects.toThrow("knows");
    else expect((await engine.commitProposal(wrongProposal as never)).report.errors.some(item => item.code === "ACQUISITION_RECEPTION_MISMATCH")).toBe(true);
    const committed = await engine.commitProposal(proposal as never); expect(committed.report.errors).toEqual([]);
    const projection = await engine.projections.project(committed.newHead, { fresh: true, useCheckpoints: false });
    expect(projection.knowledge.actors.listener?.claim?.reception).toEqual(reception);
    const view = await new KnowledgeProjector(engine).view("listener", committed.newHead);
    if (mode === "ununderstood") expect(view.knowledge).toEqual([]);
    if (mode === "deceived-misattributed") {
      expect(projection.knowledge.actors.listener?.claim?.sourceActorId).toBe("speaker");
      expect(view.knowledge[0]?.fact.sourceActorId).toBe("ivo");
      expect(view.knowledge[0]?.attribution?.holderEntityId).toBe("ivo");
    }
    if (mode === "remote-read") {
      const stored = context.acquisitions!.get("received")!;
      const changedReader = { ...context.entities.get("listener")!, canonicalName: "Changed identity revision" };
      expect(validateAcquisition(stored, acquisitionCatalog({ ...context, entities: new Map(context.entities).set("listener", changedReader) })).some(issue => issue.code === "ACQUISITION_REVISION_MISMATCH")).toBe(true);
      const seedProcesses = materializeProcessProposal({ version: 1, operations: [{ op: "start-process", localRef: "local-opening-text", process: { templateId: "text-access", ownerBindings: [{ roleId: "reader", entityIds: ["listener"] }, { roleId: "document", entityIds: ["notice"] }, { roleId: "carrier", entityIds: ["terminal"] }], progress: 0 } }] }, { branchId: "opening", parentCommitId: "opening", proposalHash: contentHash(text), templates: context.processTemplates!, elapsedDays: 0 }).delta;
      const seed = { version: 1 as const, semantics: { version: 1 as const, operations: [] }, processes: seedProcesses, norms: { version: 1 as const, operations: [] }, activeRuleIds: [], elapsedDays: 0 };
      await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(text), delta: readingInitial, participantPresence: [{ entityId: "listener", mode: "physical" }], projectionSeed: seed });
      await new CompilerBatchStore(root).replaceCompleted(source.source.id, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
      const cacheRoot = path.join(root, "text-cache"), cache = new PreparedNovelCache(root, cacheRoot);
      const bundle = await cache.candidateSnapshot(source.source);
      expect(buildPreparedClosure(bundle).issues).toEqual([]);
      const archived = await cache.archiveCandidate(source.source);
      const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-text-acquisition-clone-")); roots.push(cloneRoot);
      const cloneSource = await createEvidenceFixture(cloneRoot, text);
      await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(cloneSource.source, archived.bundleHash!);
      const cloneContext = await new WorldContextStore(cloneRoot).captureCurrent(cloneSource.source.id), clone = new WorldEngine(cloneRoot, cloneContext);
      const cloneHead = await clone.createBranch("rebuilt", "Rebuilt", readingInitial, undefined, cloneSource.source.id, undefined, source.evidence(text), {}, { realizesCanonicalEventIds: [], participantPresence: [{ entityId: "listener", mode: "physical" }], projectionSeed: seed });
      const rebuiltReceipt = await clone.commitProposal({ ...proposal, branchId: "rebuilt", expectedParentCommit: cloneHead } as never);
      expect(rebuiltReceipt.report.errors).toEqual([]);
      const rebuiltReplay = await new WorldEngine(cloneRoot, cloneContext).projections.project(rebuiltReceipt.newHead, { fresh: true, useCheckpoints: false });
      expect(rebuiltReplay.knowledge.acquisitions?.received?.actorId).toBe("listener");
      expect(rebuiltReplay.state.values.notice?.["artifact.location"]).toBe("archive");
      await expect(clone.createBranch("bad-receipt-opening", "Missing session", readingInitial, { version: 1, operations: [operation] } as never, cloneSource.source.id, undefined, source.evidence(text), {}, { realizesCanonicalEventIds: [event.id], participantPresence: [{ entityId: "listener", mode: "remote" }] })).rejects.toThrow("ACQUISITION_TEXT_CHANNEL_UNPROVEN");
      const receivedOpening = await clone.createBranch("received-opening", "Received at opening", readingInitial, { version: 1, operations: [operation] } as never, cloneSource.source.id, undefined, source.evidence(text), {}, { realizesCanonicalEventIds: [event.id], participantPresence: [{ entityId: "listener", mode: "remote" }], projectionSeed: seed });
      const openingReplay = await new WorldEngine(cloneRoot, cloneContext).projections.project(receivedOpening, { fresh: true, useCheckpoints: false });
      expect(openingReplay.knowledge.acquisitions?.received?.actorId).toBe("listener");
      expect(openingReplay.history[0]!.event.participants).toContain("terminal");
      const lateBundle = structuredClone(bundle);
      lateBundle.canonical.initialWorld.participantPresence = [{ entityId: "speaker", mode: "physical" }];
      lateBundle.canonical.initialWorld.delta.operations = lateBundle.canonical.initialWorld.delta.operations.filter(op => !("entityId" in op && op.entityId === "listener" && "field" in op && op.field === "character.location"));
      lateBundle.canonical.initialWorld.checkpoint = { mode: "chronological", rationale: "Before the reading", beforeCanonicalEventId: event.id, storyTime: event.storyTime };
      const entry = canonicalEventSchema.parse({ id: "after-reading", title: "After the reading", readerSummary: "The reader considers the notice", participants: ["listener", "notice", "terminal"], participantPresence: [{ entityId: "listener", mode: "remote" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "set", entityId: "listener", field: "character.plan", value: "future-canon-plan" }] }, causalParents: [], confidence: 1, evidence: source.evidence(text),
        characterEntryCheckpoints: [{ actorId: "listener", readerSetup: "The notice was already read", actorObservation: "You consider the text you read", participantPresence: [{ entityId: "listener", mode: "remote" }], delta: readingInitial, projectionSeed: seed }] });
      lateBundle.canonical.events.push(entry);
      lateBundle.canonical.eventRelations = [{ id: "read-before-entry", fromEventId: event.id, toEventId: entry.id, type: "before", operationality: "non-operational", status: "explicit", confidence: 1, evidence: source.evidence(text) }];
      const lateSeed = deriveCharacterEntrySeed(lateBundle, "listener");
      expect(lateSeed.projectionSeed?.knowledgeHistory).toMatchObject({ beforeCanonicalEventId: entry.id, actorId: "listener" });
      const lateContext = await new WorldContextStore(cloneRoot).capturePrepared(cloneSource.source.id, contentHash(lateBundle), lateBundle.canonical);
      const late = new WorldEngine(cloneRoot, lateContext);
      const lateHead = await late.createBranch("late-text", "After reading", lateSeed.delta, lateSeed.knowledge, cloneSource.source.id, undefined, lateSeed.evidence, {}, { entryActorId: "listener", participantPresence: lateSeed.participantPresence, projectionSeed: lateSeed.projectionSeed, realizesCanonicalEventIds: lateSeed.realizesCanonicalEventIds });
      const historyReplay = await new WorldEngine(cloneRoot, lateContext).projections.project(lateHead, { fresh: true, useCheckpoints: false });
      expect(historyReplay.knowledge.acquisitions?.received).toMatchObject({ actorId: "listener", acquiredAtCommit: lateHead });
      expect(historyReplay.state.values.listener?.["character.plan"]).not.toBe("future-canon-plan");
      expect(historyReplay.knowledge.actors.speaker).toBeUndefined();
      expect(lateSeed.realizesCanonicalEventIds).not.toContain(entry.id);
      for (const historyCase of ["missing", "paused"] as const) {
      const missingHistoricalChannel = structuredClone(lateBundle);
      if (historyCase === "missing") missingHistoricalChannel.canonical.initialWorld.projectionSeed!.processes.operations = [];
      else {
        const start = seed.processes.operations.find(op => op.op === "start-process")!;
        if (start.op === "start-process") missingHistoricalChannel.canonical.initialWorld.projectionSeed!.processes.operations.push({ op: "pause-process", processId: start.process.id, reasonId: "closed" });
      }
      const missingSeed = deriveCharacterEntrySeed(missingHistoricalChannel, "listener");
      const missingContext = await new WorldContextStore(cloneRoot).capturePrepared(cloneSource.source.id, contentHash(missingHistoricalChannel), missingHistoricalChannel.canonical);
      const missingEngine = new WorldEngine(cloneRoot, missingContext);
      await expect(missingEngine.createBranch("missing-history-text", "Missing history", missingSeed.delta, missingSeed.knowledge, cloneSource.source.id, undefined, missingSeed.evidence, {}, { entryActorId: "listener", participantPresence: missingSeed.participantPresence, projectionSeed: missingSeed.projectionSeed, realizesCanonicalEventIds: missingSeed.realizesCanonicalEventIds })).rejects.toThrow("ACQUISITION_TEXT_CHANNEL_UNPROVEN");
      await expect(missingEngine.branches.read("missing-history-text")).rejects.toThrow();
      }
      const changedCut = structuredClone(lateSeed.projectionSeed!);
      changedCut.knowledgeHistory!.cutHash = "0".repeat(64);
      await expect(late.createBranch("bad-text-cut", "Bad cut", lateSeed.delta, lateSeed.knowledge, cloneSource.source.id, undefined, lateSeed.evidence, {}, { entryActorId: "listener", participantPresence: lateSeed.participantPresence, projectionSeed: changedCut, realizesCanonicalEventIds: lateSeed.realizesCanonicalEventIds })).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
      await expect(late.branches.read("bad-text-cut")).rejects.toThrow();
      await late.branches.create({ id: "late-text-fork", name: "Alternate after reading", parentBranchId: "late-text", forkCommitId: lateHead, headCommitId: lateHead });
      const alternate = await late.commitProposal({ proposalId: "choose-alternate", branchId: "late-text-fork", expectedParentCommit: lateHead, source: "player", actorId: "listener", title: "Choose a different plan", participants: ["listener"], participantPresence: [{ entityId: "listener", mode: "remote" }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "listener", field: "character.plan", value: "alternate-plan" }] }, causalParents: [], evidence: [] });
      expect(alternate.report.errors).toEqual([]);
      expect(await late.branches.readHead("late-text")).toBe(lateHead);
      const forkReplay = await new WorldEngine(cloneRoot, lateContext).projections.project(alternate.newHead, { fresh: true, useCheckpoints: false });
      expect(forkReplay.knowledge.acquisitions?.received?.actorId).toBe("listener");
      expect(forkReplay.state.values.listener?.["character.plan"]).toBe("alternate-plan");
      expect(forkReplay.history.flatMap(item => item.event.realizesCanonicalEventIds ?? [])).not.toContain(entry.id);

    }
    expect(projection.state.values.place).toBeUndefined();
  }
});
