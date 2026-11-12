import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { contentHash as h } from "../src/world/canonical.js";
import { artifactProposalSchema, canonicalEventSchema, eventParticipationSchema } from "../src/world/model.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { entryArtifactEvidenceIssues } from "../src/world/entry-agency.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { consumerRevalidationId, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";
import * as repair from "../src/compiler/entry-state-repair.js";
import * as retained from "../src/compiler/identity-consumer-repair.js";
import { ENTRY_STATE_REPAIR, ENTRY_WORDING_REPAIR, ENTRY_DELTA_BINDING_REPAIR, entryStateIntentSchema, entryStateRepairDirectory, entryStateCriteria, validateEntryStateHistory,
  lowerEntryStateRepair, type EntryStateRecord } from "../src/compiler/entry-state-repair-model.js";
import { runEntryStateRepair } from "../src/workflow/entry-state-repair.js";
import { originalIdentityCatalog } from "../src/compiler/upstream-repair-preflight.js";
import { lowerEntryDeltaBinding } from "../src/compiler/entry-delta-binding.js";
import { eventExecutionSchema } from "../src/world/event-execution.js";
import { lowerEntryWording } from "../src/compiler/entry-wording.js";
import { entryStateEditSchema, lowerEntryState } from "../src/compiler/entry-state.js";
import { assessEntryState } from "../src/world/entry-contract.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-state-")); roots.push(root);
  const text = "Traveler climbed onto the platform. Sitting there, he spoke to Guide. Then the gate opened.";
  const f = await createEvidenceFixture(root, text), evidence = f.evidence(text);
  const event = canonicalEventSchema.parse({ id: "encounter", title: "Gate opens", readerSummary: "The seated traveler and guide face the opening gate.", participants: ["traveler", "guide"],
    participantPresence: [{ entityId: "traveler", mode: "physical" }, { entityId: "guide", mode: "physical" }],
    storyTime: { kind: "ordinal", label: "after climbing", orderHint: 30 }, preconditions: [], observedOutcome: { version: 1, operations: [] },
    characterEntryCheckpoints: [{ actorId: "traveler", readerSetup: "The traveler is seated before the gate opens.", actorObservation: "You are seated on the platform.",
      participantPresence: [{ entityId: "traveler", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "traveler", field: "character.plan", value: "climb onto the platform" }] } }],
    evidence, causalParents: [], confidence: .96 });
  const participation = eventParticipationSchema.parse({ id: "boy-encounter", entityId: "traveler", eventId: event.id, role: "agent", presence: "physical", confidence: .96, evidence });
  const selector = { segment_id: f.segmentId, exact: text }, anchored = [{ selector, anchor: textAnchorForByteRange(f.source.id, Buffer.from(text), 0, Buffer.byteLength(text)) }];
  const scope: any = { sourceId: f.source.id, sourceHash: f.source.contentSha256, taskId: h("task"), ref: "entry/traveler/encounter", identityIntentHash: h("identity"),
    originalBudgetHash: h("budget"), receiptFingerprint: h("receipt"), upstreamPlanHash: h("plan"), requirementIds: ["identity"], currentRevisionHash: h(event.characterEntryCheckpoints![0]),
    reviewContract: { target: { kind: "character-entry", actorId: "traveler", beforeEventId: event.id, storyTime: event.storyTime, position: "before-event" }, requiredChecks: entryStateCriteria.slice(0, 6), ownerRefs: [{ ref: "canonical-event:encounter", revisionHash: h(event) }] } };
  const identityDirectory = identityRequirementDirectory(root, scope.sourceId, scope.taskId);
  await fs.mkdir(identityDirectory, { recursive: true });
  await fs.writeFile(path.join(identityDirectory, "context.json"), JSON.stringify({ manifest: await new SegmentStore(root).readManifest(f.source.id) }));
  const originalInput = { requiredSourceSegmentIds: [f.segmentId], evidencePacket: {
    sources: [{ id: f.segmentId, startByte: 0, endByte: Buffer.byteLength(text), text, textHash: h(text) }] } };
  const parents = [{ scope, inputHash: h(originalInput), sessionId: "parent-proposal", traceRunId: "parent-proposal-trace",
    output: { phase: "consumer-revalidation", disposition: "blocked", retainedQuestionIds: [h("question")] } },
    { scope, sessionId: "parent-check", traceRunId: "parent-check-trace", output: { phase: "consumer-revalidation-check", verdict: "supported" } }] as ConsumerRevalidationRecord[];
  const context = { originalInput, negativeJudgments: parents.map(p => p.output) };
  const budgetFile = path.join(root, "prior-budget.json"), priorBudget = { calls: 452, bytes: 116207306 };
  await fs.writeFile(budgetFile, JSON.stringify(priorBudget));
  const intent = entryStateIntentSchema.parse({ version: 1, policy: ENTRY_STATE_REPAIR, sourceId: f.source.id, sourceHash: f.source.contentSha256,
    taskId: scope.taskId, ref: scope.ref, actorId: "traveler", eventId: event.id, identityIntentHash: scope.identityIntentHash, originalBudgetHash: scope.originalBudgetHash,
    parentReviewId: consumerRevalidationId(scope), parentRecordHashes: parents.map(h), parentReceiptFingerprint: scope.receiptFingerprint, upstreamPlanHash: scope.upstreamPlanHash,
    authorizationRef: "user:repair-entry-state", createdAt: "2026-11-01T00:00:00Z", implementationHash: await repair.entryStateImplementationHash(), contextHash: h(context),
    requirementIds: scope.requirementIds, retainedQuestionIds: [h("question")], totalConsumers: 536, requirementPrefix: { length: 1, head: h("prefix") },
    priorUsage: { modelCalls: 452, totalPayloadBytes: 116207306 }, priorBudgetFiles: [{ path: budgetFile, hash: h(priorBudget) }],
    baselines: [{ kind: "canonical-event", id: event.id, payload: event, revisionHash: h(event), evidenceAssertions: [] }] });
  const output = { phase: "entry-state-proposal" as const, scopeHash: h(intent), evidence: [selector], retainedQuestionIds: intent.retainedQuestionIds,
    playable: false as const, parentResumeAllowed: false as const, disposition: "repaired" as const,
    edit: { remove: [{ index: 0, operationHash: h(event.characterEntryCheckpoints![0]!.delta.operations[0]) }],
      set: [{ field: "character.posture", value: "sitting", strength: "explicit" as const, evidence: [selector], rationale: "原文明确描述坐姿。" }] },
    rationale: "登台已完成；入口有明确坐姿，不推测下一步计划。" };
  const proposal: Extract<EntryStateRecord, { phase: "entry-state-proposal" }> = { intent, phase: output.phase, output, evidence: anchored, predecessorRecordHash: null,
    inputHash: h(repair.entryStateInput(intent, context, [])), sessionId: "new-proposal", traceRunId: "new-proposal-trace", sessionCheckpointHash: h("proposal-session") };
  const check: Extract<EntryStateRecord, { phase: "entry-state-check" }> = { ...proposal, phase: "entry-state-check", predecessorRecordHash: h(proposal),
    sessionId: "new-check", traceRunId: "new-check-trace", output: { phase: "entry-state-check", scopeHash: h(intent), proposalHash: h(output), evidence: [selector],
      retainedQuestionIds: intent.retainedQuestionIds, playable: false, parentResumeAllowed: false, verdict: "supported", rationale: "入口有原文支持的坐姿；不授予执行证明。",
      requirements: [{ id: "identity", verdict: "supported", rationale: "当前现场角色不建立匿名人物身份桥梁。" }],
      criteria: entryStateCriteria.map(id => ({ id, verdict: "supported", rationale: "原文及冻结范围支持这一有限修复。" })) } };
  const canon = new CanonicalModelStore(root);
  for (const id of ["traveler", "guide"]) await canon.putEntity({ id, kind: "character", canonicalName: id, aliases: [], evidence });
  await canon.putEvent(event); await canon.putEventParticipation(participation);
  await canon.putEventParticipation({ ...participation, id: "hero-encounter", entityId: "guide", role: "experiencer" });
  const initial = { version: 1 as const, participantPresence: [{ entityId: "guide", mode: "physical" as const }],
    delta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "guide", field: "character.plan", value: "listen" }, { op: "set" as const, entityId: "traveler", field: "character.alive", value: true }] }, evidence };
  await new InitialWorldStore(root).put(initial);
  return { root, f, event, participation, parents, context, intent, proposal, check, canon, initial, directory: entryStateRepairDirectory(root, intent) };
}

it("repairs only the exact actor delta, grounds context, and binds each new bodily operation", async () => {
  const f = await fixture(), before = h(f.event), envelopes = repair.stateEnvelopes(f.intent, f.proposal);
  const event = canonicalEventSchema.parse(envelopes[0]!.payload), entry = event.characterEntryCheckpoints![0]!;
  expect(h(f.event)).toBe(before);
  expect({ ...entry, delta: f.event.characterEntryCheckpoints![0]!.delta }).toEqual(f.event.characterEntryCheckpoints![0]);
  expect({ ...event, characterEntryCheckpoints: f.event.characterEntryCheckpoints }).toEqual(f.event);
  expect(entry.delta.operations).toEqual([{ op: "set", entityId: "traveler", field: "character.posture", value: "sitting" }]);
  expect(assessEntryState("traveler", entry, { entities: new Map((await f.canon.listEntities()).map(e => [e.id, e])) })).toMatchObject({ state: "grounded", actionProof: "required" });
  expect(entryArtifactEvidenceIssues("canonical-event", event, envelopes[0]!.evidenceAssertions)).toEqual([]);
  expect(entryArtifactEvidenceIssues("canonical-event", event, [])).toEqual(expect.arrayContaining([expect.objectContaining({ code: "BODILY_STATE_EVIDENCE_REQUIRED" })]));
  await new ProposalStore(f.root).writePending(artifactProposalSchema(canonicalEventSchema).parse(envelopes[0]!), canonicalEventSchema);
  const service = new CompilerCommitService(f.root);
  expect(await service.validatePendingStructure(f.f.source.id)).toEqual([]);
  expect((await service.acceptAllValid(f.f.source.id)).accepted).toHaveLength(1);
});

it("rejects scope drift, arbitrary fields, fake values, unbound removals and loss of context", async () => {
  const f = await fixture();
  for (const mutate of [
    (s: any, _e: any) => { s.actorId = "guide"; },
    (s: any, _e: any) => { s.baselines[0].payload.storyTime.orderHint++; },
    (_s: any, e: any) => { e.remove[0].operationHash = h("not-original"); },
    (_s: any, e: any) => { e.set[0].field = "character.location"; },
    (_s: any, e: any) => { e.set[0].value = "flying"; },
    (_s: any, e: any) => { e.set = []; },
    (_s: any, e: any) => { e.remove.push(e.remove[0]); },
  ]) { const s = structuredClone(f.intent), edit = structuredClone(f.proposal.output.edit); mutate(s, edit); expect(() => lowerEntryState(s, entryStateEditSchema.parse(edit))).toThrow(); }
});

it("retains negative lineage and rejects independent-session reuse, missing checks and changed scope", async () => {
  const f = await fixture();
  expect(() => validateEntryStateHistory([f.proposal, f.check], f.parents)).not.toThrow();
  for (const change of [
    (p: any, _c: any) => { p.intent.baselines[0].payload.storyTime.orderHint = 0; },
    (_p: any, c: any) => { c.sessionId = f.proposal.sessionId; },
    (_p: any, c: any) => { c.output.criteria[1] = c.output.criteria[0]; },
    (_p: any, c: any) => { c.output.retainedQuestionIds = []; },
    (_p: any, c: any) => { c.output.criteria[0].verdict = "blocked"; },
    (_p: any, c: any) => { c.output.requirements[0].verdict = "blocked"; },
    (_p: any, c: any) => { c.output.proposalHash = h("other"); },
  ]) { const p = structuredClone(f.proposal), c = structuredClone(f.check); change(p, c); expect(() => validateEntryStateHistory([p, c], f.parents)).toThrow(); }
  const blocked = { ...f.proposal, output: { ...f.proposal.output, disposition: "blocked" as const } };
  expect(() => repair.entryStateInput(f.intent, f.context, [blocked])).not.toThrow();
  expect(() => lowerEntryStateRepair(f.intent, blocked)).toThrow(/Blocked proposal/);
  const overlayParents = structuredClone(f.parents);
  overlayParents[0]!.scope.reviewContract!.ownerRefs.push({ ref: "event-execution:binding", revisionHash: h("overlay") });
  const overlay = structuredClone(f.proposal);
  overlay.intent.parentRecordHashes = overlayParents.map(h) as [string, string];
  expect(() => validateEntryStateHistory([overlay], overlayParents)).toThrow(/baseline changed/);
});

it.each([0, 1, 2])("bounds %i SDK-rejected previews, recovers sealed registration and commits only checked revisions", async invalidPreviews => {
  const f = await fixture(), history: any[] = [{ hash: f.intent.requirementPrefix.head, payload: { kind: "identity-consumer-repair", record: { intent: { taskId: f.intent.taskId } } } },
    ...f.parents.map(record => ({ payload: { kind: "identity-consumer-revalidation", record } }))];
  vi.spyOn(repair, "prepareEntryStateRepair").mockResolvedValue({ intent: f.intent, context: f.context, parents: f.parents, directory: f.directory });
  vi.spyOn(retained, "assertConsumerRepairRetainedState").mockResolvedValue();
  vi.spyOn(RequirementLedger.prototype, "history").mockImplementation(async () => history);
  let interrupt = true;
  vi.spyOn(RequirementLedger.prototype, "recordEntryStateRepair").mockImplementation(async record => {
    await repair.verifyEntryStateRecord(f.root, record, history);
    if (interrupt) { interrupt = false; throw Error("registration interrupted after original sealed result"); }
    history.push({ payload: { kind: "entry-state-repair", record } });
  });
  const runtime = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
    ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any : runtime(options));
  const create = PiAgentSession.create.bind(PiAgentSession), sessions: string[] = [];
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const check = path.basename(options.runtimeDir!) === "entry-state-check";
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(f.root, "pi") }); sessions.push(session.id);
    await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, i) => fauxAssistantMessage([
      fauxToolCall(i > (check ? 0 : invalidPreviews) ? "submit_entry_state_repair" : "preview_entry_state_repair",
        check ? f.check.output : i < invalidPreviews ? { ...f.proposal.output, edit: { invalidAttempt: i } } : f.proposal.output, { id: `tool-${sessions.length}-${i}` }),
    ], { stopReason: "toolUse" }) }); return session;
  });
  const args = { root: f.root, sourceId: f.f.source.id, taskId: f.intent.taskId, ref: f.intent.ref, authorizationRef: f.intent.authorizationRef };
  if (invalidPreviews > 1) {
    await expect(runEntryStateRepair(args)).rejects.toThrow(/correction allowance exhausted/);
    expect(sessions).toHaveLength(1);
    expect(history.filter(r => r.payload.kind === "entry-state-repair")).toHaveLength(0);
    expect(h(await f.canon.getEvent(f.event.id))).toBe(h(f.event));
    const budget = await repair.readStateFile(path.join(f.directory, "entry-state-proposal.budget.json"));
    expect(budget.state.usage.modelCalls).toBe(2);
    await expect(runEntryStateRepair(args)).rejects.toThrow(/consumed without a sealed result/);
    expect(sessions).toHaveLength(1);
    return;
  }
  await expect(runEntryStateRepair(args)).rejects.toThrow(/registration interrupted/);
  expect(sessions).toHaveLength(1); expect(h(await f.canon.getEvent(f.event.id))).toBe(h(f.event));
  vi.spyOn(repair, "entryStateImplementationHash").mockResolvedValueOnce(h("changed before completion"));
  await expect(runEntryStateRepair(args)).rejects.toThrow(/implementation changed/);
  expect(sessions).toHaveLength(1);
  const result = await runEntryStateRepair(args);
  expect(result.status).toBe("repaired"); expect(sessions).toHaveLength(2); expect(new Set(sessions).size).toBe(2);
  expect(result.cumulative.modelCalls).toBe(456 + invalidPreviews); expect(result.executableEntry).toBe(false); expect(result.obligationStatus).toBe("revalidated");
  expect(result.parentResumeAllowed).toBe(false); expect(history.filter(r => r.payload.kind === "entry-state-repair")).toHaveLength(4);
  const current = new Map<string, unknown>([["canonical-event:encounter", await f.canon.getEvent("encounter")]]);
  const baselines = await repair.entryStateCatalogBaselines(f.root, f.f.source.id, f.intent.taskId, f.intent.upstreamPlanHash, current);
  const envelopes = repair.stateEnvelopes(f.intent, history.find(r => r.payload.kind === "entry-state-repair").payload.record);
  const catalog: Map<string, unknown> = new Map(current);
  for (const e of envelopes) for (const a of e.evidenceAssertions) catalog.set(`evidence-assertion:${a.id}`, a);
  const restored = originalIdentityCatalog(catalog, f.intent.baselines, baselines);
  expect(h(restored.get("canonical-event:encounter"))).toBe(h(f.event));
  expect(await runEntryStateRepair(args)).toMatchObject({ status: "repaired" }); expect(sessions).toHaveLength(2);
  vi.spyOn(repair, "entryStateImplementationHash").mockResolvedValue(h("new implementation"));
  expect(await runEntryStateRepair({ ...args, inspect: true })).toMatchObject({ status: "repaired", modelDispatchAllowed: false });
  expect(sessions).toHaveLength(2);
  vi.mocked(repair.prepareEntryStateRepair).mockResolvedValue({ intent: { ...f.intent, upstreamPlanHash: h("different plan") }, context: f.context, parents: f.parents, directory: f.directory });
  await expect(runEntryStateRepair({ ...args, inspect: true })).rejects.toThrow(/intent differs from its retained ledger/);
  expect(sessions).toHaveLength(2);
  current.set("canonical-event:encounter", f.event);
  await expect(repair.entryStateCatalogBaselines(f.root, f.f.source.id, f.intent.taskId, f.intent.upstreamPlanHash, current)).rejects.toThrow(/outside its receipt/);
}, 30000);


it("repairs source-bound before-event wording without changing state or granting another repair surface", async () => {
  const f = await fixture(), intent = { ...f.intent, policy: ENTRY_WORDING_REPAIR };
  const field = { field: "readerSetup" as const, value: "The traveler sits and speaks to the guide before the gate opens.",
    evidence: f.proposal.output.evidence, strength: "explicit" as const, rationale: "Only pre-event actions are described." };
  const edit = { fields: [field] };
  const proposal = { ...f.proposal, intent, output: { ...f.proposal.output, scopeHash: h(intent), edit } };
  const event = canonicalEventSchema.parse(lowerEntryWording(intent, edit)[0]!.payload);
  const entry = event.characterEntryCheckpoints![0]!;
  expect({ ...entry, readerSetup: f.event.characterEntryCheckpoints![0]!.readerSetup }).toEqual(f.event.characterEntryCheckpoints![0]);
  expect({ ...event, characterEntryCheckpoints: f.event.characterEntryCheckpoints }).toEqual(f.event);
  expect(repair.entryStateInput(intent, f.context, [])).toMatchObject({ policy: ENTRY_WORDING_REPAIR, entryWordingFields: { readerSetup: f.event.characterEntryCheckpoints![0]!.readerSetup } });
  expect(repair.entryStateInput(intent, f.context, [])).not.toHaveProperty("stateOperations");
  expect(() => validateEntryStateHistory([proposal], f.parents)).not.toThrow();
  expect(() => validateEntryStateHistory([{ ...proposal, intent: f.intent, output: { ...proposal.output, scopeHash: h(f.intent) } }], f.parents)).toThrow();
  expect(() => lowerEntryStateRepair(f.intent, proposal)).toThrow();
  expect(() => lowerEntryStateRepair(intent, f.proposal)).toThrow();
  const envelope = repair.stateEnvelopes(intent, proposal)[0]!;
  expect(envelope.evidenceAssertions).toHaveLength(1);
  expect(envelope.evidenceAssertions[0]).toMatchObject({ target: { jsonPointer: "/characterEntryCheckpoints/0/readerSetup" }, anchors: [f.proposal.evidence[0]!.anchor], strength: "explicit" });
  for (const invalid of [ { fields: [] }, { fields: [field, field] }, { fields: [{ ...field, value: f.event.characterEntryCheckpoints![0]!.readerSetup }] },
    { fields: [{ ...field, field: "delta", value: "mutate truth" }] }, { fields: [{ ...field, field: "actorObservation", value: "x".repeat(1001) }] } ])
    expect(() => lowerEntryWording(intent, invalid as typeof edit)).toThrow();
  expect(() => lowerEntryWording({ ...intent, actorId: "unknown" }, edit)).toThrow();
  expect(() => lowerEntryWording({ ...intent, baselines: [{ ...intent.baselines[0]!, revisionHash: h("changed") }] }, edit)).toThrow();
});


it("binds only an execution entry delta to its reviewed canonical intention or bodily state", async () => {
  const f = await fixture(), sourceEnvelope = repair.stateEnvelopes(f.intent, f.proposal)[0]!;
  const event = canonicalEventSchema.parse(sourceEnvelope.payload), sourceEntry = event.characterEntryCheckpoints![0]!;
  const binding = eventExecutionSchema.parse({ id: "traveler-entry", canonicalEventId: event.id, actorId: "traveler", evidence: event.evidence,
    entryCheckpoint: { ...sourceEntry, delta: { version: 1, operations: [{ op: "set", entityId: "traveler", field: "character.momentum", value: 1 }] },
      knowledge: { version: 1, operations: [] }, projectionSeed: { version: 1, elapsedDays: 0, activeRuleIds: [], semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] } } } });
  const retainedAssertion = { ...sourceEnvelope.evidenceAssertions[0]!, id: "retained-entry-wording", target: { artifactKind: "event-execution", artifactId: binding.id, jsonPointer: "/entryCheckpoint/readerSetup" } };
  const parents = structuredClone(f.parents);
  for (const p of parents) { p.scope.currentRevisionHash = h(binding.entryCheckpoint); p.scope.reviewContract!.ownerRefs = [
    { ref: `canonical-event:${event.id}`, revisionHash: h(event) }, { ref: `event-execution:${binding.id}`, revisionHash: h(binding) } ]; }
  const intent = entryStateIntentSchema.parse({ ...f.intent, policy: ENTRY_DELTA_BINDING_REPAIR, parentReviewId: consumerRevalidationId(parents[0]!.scope), parentRecordHashes: parents.map(h),
    baselines: [{ kind: "canonical-event", id: event.id, payload: event, revisionHash: h(event), evidenceAssertions: sourceEnvelope.evidenceAssertions },
      { kind: "event-execution", id: binding.id, payload: binding, revisionHash: h(binding), evidenceAssertions: [retainedAssertion] }] });
  const edit = { canonicalDeltaHash: h(sourceEntry.delta), executionDeltaHash: h(binding.entryCheckpoint!.delta),
    bindings: [{ index: 0, evidence: f.proposal.output.evidence, strength: "explicit" as const, rationale: "The actor is seated before the event." }] };
  const proposal = { ...f.proposal, intent, output: { ...f.proposal.output, scopeHash: h(intent), edit } };
  expect(() => validateEntryStateHistory([proposal], parents)).not.toThrow();
  const lowered = lowerEntryDeltaBinding(intent, edit)[0]!, before = h(intent.baselines);
  expect({ ...lowered.payload, entryCheckpoint: { ...lowered.payload.entryCheckpoint!, delta: binding.entryCheckpoint!.delta } }).toEqual(binding);
  expect(lowered.payload.entryCheckpoint!.delta).toEqual(sourceEntry.delta);
  expect(h(intent.baselines)).toBe(before);
  const envelope = repair.stateEnvelopes(intent, proposal)[0]!;
  expect(envelope.kind).toBe("event-execution");
  expect(envelope.evidenceAssertions).toContainEqual(retainedAssertion);
  expect(entryArtifactEvidenceIssues("event-execution", envelope.payload, envelope.evidenceAssertions)).toEqual([]);
  const store = new ProposalStore(f.root), service = new CompilerCommitService(f.root);
  await store.writePending(artifactProposalSchema(canonicalEventSchema).parse(sourceEnvelope), canonicalEventSchema); expect((await service.acceptAllValid(f.f.source.id)).accepted).toHaveLength(1);
  await f.canon.putEventExecution(binding);
  await store.writePending(artifactProposalSchema(eventExecutionSchema).parse(envelope), eventExecutionSchema);
  expect(await service.validatePendingStructure(f.f.source.id)).toEqual([]);
  expect((await service.acceptAllValid(f.f.source.id)).accepted).toHaveLength(1);
  expect(await f.canon.getEvent(event.id)).toEqual(event);
  expect((await f.canon.getEventExecution(binding.id)).entryCheckpoint).toEqual(lowered.payload.entryCheckpoint);
  for (const change of [
    (s: any, _e: any) => { s.baselines.pop(); },
    (s: any, _e: any) => { s.actorId = "guide"; },
    (s: any, _e: any) => { s.baselines[0].payload.storyTime.orderHint++; },
    (_s: any, e: any) => { e.canonicalDeltaHash = h("other"); },
    (_s: any, e: any) => { e.executionDeltaHash = h("other"); },
    (_s: any, e: any) => { e.bindings = []; },
    (_s: any, e: any) => { e.bindings.push(e.bindings[0]); },
    (s: any, e: any) => { const b = s.baselines[0]; b.payload.characterEntryCheckpoints[0].delta.operations[0].field = "character.health"; b.payload.characterEntryCheckpoints[0].delta.operations[0].value = 100; b.revisionHash = h(b.payload); e.canonicalDeltaHash = h(b.payload.characterEntryCheckpoints[0].delta); },
  ]) { const s = structuredClone(intent), e = structuredClone(edit); change(s, e); expect(() => lowerEntryDeltaBinding(s, e)).toThrow(); }
  expect(() => lowerEntryStateRepair({ ...intent, policy: ENTRY_STATE_REPAIR }, proposal)).toThrow();
  const wrongOwner = structuredClone(parents); wrongOwner[0]!.scope.reviewContract!.ownerRefs.pop();
  expect(() => validateEntryStateHistory([proposal], wrongOwner)).toThrow();
});
