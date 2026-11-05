import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { contentHash as h } from "../src/world/canonical.js";
import { canonicalEventSchema, characterEntryCheckpointSchema, eventParticipationSchema } from "../src/world/model.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { entryAgencyIssues, entryArtifactEvidenceIssues } from "../src/world/entry-agency.js";
import { deriveCharacterEntryOptions, deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { compilerPayloadEvidence } from "../src/compiler/proposals.js";
import { consumerRevalidationId, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";
import * as repair from "../src/compiler/entry-presence-repair.js";
import * as retained from "../src/compiler/identity-consumer-repair.js";
import { ENTRY_PRESENCE_REPAIR, entryPresenceIntentSchema, entryPresenceRepairDirectory, entryPresenceCriteria, validateEntryPresenceHistory,
  lowerEntryPresenceRepair, type EntryPresenceRecord } from "../src/compiler/entry-presence-repair-model.js";
import { runEntryPresenceRepair } from "../src/workflow/entry-presence-repair.js";
import { originalIdentityCatalog } from "../src/compiler/upstream-repair-preflight.js";
import { lowerUnresolvedEntryPresence } from "../src/compiler/entry-presence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-presence-")); roots.push(root);
  const text = 'Boy appears by the window. Hero asks, "Am I dreaming?" Boy says, "I only came to remind you."';
  const f = await createEvidenceFixture(root, text), evidence = f.evidence(text);
  const event = canonicalEventSchema.parse({ id: "encounter", title: "Boy arrives", readerSummary: "Boy meets Hero.", participants: ["boy", "hero"],
    participantPresence: [{ entityId: "boy", mode: "physical" }, { entityId: "hero", mode: "physical" }],
    storyTime: { kind: "ordinal", label: "after nap", orderHint: 30 }, preconditions: [], observedOutcome: { version: 1, operations: [] },
    characterEntryCheckpoints: [{ actorId: "boy", readerSetup: "Boy will remind Hero.", actorObservation: "You plan to remind Hero.",
      participantPresence: [{ entityId: "boy", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "boy", field: "character.plan", value: "remind" }] } }],
    evidence, causalParents: [], confidence: .96 });
  const participation = eventParticipationSchema.parse({ id: "boy-encounter", entityId: "boy", eventId: event.id, role: "agent", presence: "physical", confidence: .96, evidence });
  const selector = { segment_id: f.segmentId, exact: text }, anchored = [{ selector, anchor: textAnchorForByteRange(f.source.id, Buffer.from(text), 0, Buffer.byteLength(text)) }];
  const scope: any = { sourceId: f.source.id, sourceHash: f.source.contentSha256, taskId: h("task"), ref: "entry/boy/encounter", identityIntentHash: h("identity"),
    originalBudgetHash: h("budget"), receiptFingerprint: h("receipt"), upstreamPlanHash: h("plan"), requirementIds: ["identity"], currentRevisionHash: h(event.characterEntryCheckpoints![0]),
    reviewContract: { target: { kind: "character-entry" }, ownerRefs: [{ ref: "canonical-event:encounter", revisionHash: h(event) }] } };
  const originalInput = { requiredSourceSegmentIds: [f.segmentId], evidencePacket: { sources: [{ id: f.segmentId, text }] } };
  const parents = [{ scope, inputHash: h(originalInput), sessionId: "parent-proposal", traceRunId: "parent-proposal-trace",
    output: { phase: "consumer-revalidation", disposition: "blocked", retainedQuestionIds: [h("question")] } },
    { scope, sessionId: "parent-check", traceRunId: "parent-check-trace", output: { phase: "consumer-revalidation-check", verdict: "supported" } }] as ConsumerRevalidationRecord[];
  const context = { originalInput, negativeJudgments: parents.map(p => p.output) };
  const budgetFile = path.join(root, "prior-budget.json"), priorBudget = { calls: 452, bytes: 116207306 };
  await fs.writeFile(budgetFile, JSON.stringify(priorBudget));
  const intent = entryPresenceIntentSchema.parse({ version: 1, policy: ENTRY_PRESENCE_REPAIR, sourceId: f.source.id, sourceHash: f.source.contentSha256,
    taskId: scope.taskId, ref: scope.ref, actorId: "boy", eventId: event.id, identityIntentHash: scope.identityIntentHash, originalBudgetHash: scope.originalBudgetHash,
    parentReviewId: consumerRevalidationId(scope), parentRecordHashes: parents.map(h), parentReceiptFingerprint: scope.receiptFingerprint, upstreamPlanHash: scope.upstreamPlanHash,
    authorizationRef: "user:preserve-source-uncertainty", createdAt: "2026-11-01T00:00:00Z", implementationHash: await repair.entryPresenceImplementationHash(), contextHash: h(context),
    requirementIds: scope.requirementIds, retainedQuestionIds: [h("question")], totalConsumers: 536, requirementPrefix: { length: 1, head: h("prefix") },
    priorUsage: { modelCalls: 452, totalPayloadBytes: 116207306 }, priorBudgetFiles: [{ path: budgetFile, hash: h(priorBudget) }],
    baselines: [{ kind: "canonical-event", id: event.id, payload: event, revisionHash: h(event), evidenceAssertions: [] },
      { kind: "event-participation", id: participation.id, payload: participation, revisionHash: h(participation), evidenceAssertions: [] }] });
  const output = { phase: "entry-presence-proposal" as const, scopeHash: h(intent), evidence: [selector], retainedQuestionIds: intent.retainedQuestionIds,
    playable: false as const, parentResumeAllowed: false as const, disposition: "uncertainty-preserved" as const, title: "窗边相遇，在场方式未决",
    readerSummary: "男孩在窗边出现；观察者质疑是否在梦中。男孩自称前来提醒。身体在场未获证实。",
    readerSetup: "此处停在相遇对话前；在场方式未决。", actorObservation: "此刻能确认的第一人称观察未充分建立。", rationale: "相遇含有对真实性的质疑，不能据此断言身体在场或确定梦境。" };
  const proposal: Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }> = { intent, phase: output.phase, output, evidence: anchored, predecessorRecordHash: null,
    inputHash: h(repair.entryPresenceInput(intent, context, [])), sessionId: "new-proposal", traceRunId: "new-proposal-trace", sessionCheckpointHash: h("proposal-session") };
  const check: Extract<EntryPresenceRecord, { phase: "entry-presence-check" }> = { ...proposal, phase: "entry-presence-check", predecessorRecordHash: h(proposal),
    sessionId: "new-check", traceRunId: "new-check-trace", output: { phase: "entry-presence-check", scopeHash: h(intent), proposalHash: h(output), evidence: [selector],
      retainedQuestionIds: intent.retainedQuestionIds, playable: false, parentResumeAllowed: false, verdict: "supported", rationale: "保留不确定性和阻塞，不授予可执行入口。",
      criteria: entryPresenceCriteria.map(id => ({ id, verdict: "supported", rationale: "原文及冻结范围支持这一有限修复。" })) } };
  const canon = new CanonicalModelStore(root);
  for (const id of ["boy", "hero"]) await canon.putEntity({ id, kind: "character", canonicalName: id, aliases: [], evidence });
  await canon.putEvent(event); await canon.putEventParticipation(participation);
  await canon.putEventParticipation({ ...participation, id: "hero-encounter", entityId: "hero", role: "experiencer" });
  const initial = { version: 1 as const, participantPresence: [{ entityId: "hero", mode: "physical" as const }],
    delta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "hero", field: "character.plan", value: "listen" }, { op: "set" as const, entityId: "boy", field: "character.alive", value: true }] }, evidence };
  await new InitialWorldStore(root).put(initial);
  return { root, f, event, participation, parents, context, intent, proposal, check, canon, initial, directory: entryPresenceRepairDirectory(root, intent) };
}

it("retains a source gap without inventing presence or granting state, knowledge, or runtime entry", async () => {
  const f = await fixture(), before = h(f.intent.baselines), lowered = lowerEntryPresenceRepair(f.intent, f.proposal);
  const event = canonicalEventSchema.parse(lowered[0]!.payload), entry = event.characterEntryCheckpoints![0]!;
  expect(h(f.intent.baselines)).toBe(before);
  expect(event.participantPresence).toEqual([{ entityId: "boy", mode: "unresolved" }, { entityId: "hero", mode: "physical" }]);
  expect(event.storyTime).toEqual(f.event.storyTime); expect(event.observedKnowledge).toEqual(f.event.observedKnowledge);
  expect(event.observedOutcome).toEqual(f.event.observedOutcome); expect(event.evidence).toEqual(f.event.evidence);
  expect(lowered[1]!.payload).toEqual({ ...f.participation, presence: "unresolved" });
  expect(entry.delta.operations).toEqual([]); expect(entry.knowledge).toBeUndefined(); expect(entry.projectionSeed).toBeUndefined();
  const entities = new Map((await f.canon.listEntities()).map(e => [e.id, e]));
  expect(entryAgencyIssues("boy", entry, { entities })[0]?.code).toBe("ENTRY_AGENCY_UNPROVEN");
  const bundle: any = { source: f.f.source, canonical: { entities: [...entities.values()], events: [event], eventParticipations: [lowered[1]!.payload], initialWorld: f.initial } };
  expect(deriveCharacterEntryOptions(bundle).map(e => e.actorId)).not.toContain("boy");
  expect(() => deriveCharacterEntrySeed(bundle, "boy")).toThrow();
  for (const change of [
    (e: any) => { delete e.admission; }, (e: any) => { e.participantPresence[0].mode = "physical"; },
    (e: any) => { e.delta.operations = f.event.characterEntryCheckpoints![0]!.delta.operations; },
    (e: any) => { e.knowledge = { version: 1, operations: [{ op: "forget", actorId: "boy", claimId: "future" }] }; },
    (e: any) => { e.projectionSeed = {}; },
  ]) { const copy = structuredClone(entry); change(copy); expect(characterEntryCheckpointSchema.safeParse(copy).success).toBe(false); }
  expect(compilerPayloadEvidence(event)).toHaveLength(f.event.evidence.length + f.proposal.evidence.length);
});

it("proposes source uncertainty using only domain artifacts and evidence, without identity recovery authority", async () => {
  const f = await fixture();
  const sourceId = "independent-source";
  const baselines = JSON.parse(JSON.stringify(f.intent.baselines).replaceAll(f.f.source.id, sourceId)) as typeof f.intent.baselines;
  for (const b of baselines) b.revisionHash = h(b.payload);
  const evidence = f.event.evidence.map(e => ({ ...e, span: { ...e.span, sourceId } }));
  const result = lowerUnresolvedEntryPresence({ actorId: "boy", eventId: "encounter", baselines }, f.proposal.output, evidence);
  expect(canonicalEventSchema.parse(result[0]!.payload).characterEntryCheckpoints![0]!.admission?.evidence).toEqual(evidence);
  expect(result[1]!.payload).toMatchObject({ presence: "unresolved" });
});

it("requires exact evidence for blocked presence and keeps that actor in the incomplete-entry denominator", async () => {
  const f = await fixture(), envelopes = repair.presenceEnvelopes(f.intent, f.proposal);
  const event = canonicalEventSchema.parse(envelopes[0]!.payload);
  expect(entryArtifactEvidenceIssues("canonical-event", event, [])).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ENTRY_UNCERTAINTY_EVIDENCE_REQUIRED" })]));
  expect(entryArtifactEvidenceIssues("canonical-event", event, envelopes[0]!.evidenceAssertions)).toEqual([]);
  for (const e of envelopes) await new ProposalStore(f.root).writePending(e, e.kind === "canonical-event" ? canonicalEventSchema : eventParticipationSchema);
  const service = new CompilerCommitService(f.root);
  expect(await service.validatePendingStructure(f.f.source.id)).toEqual([]);
  const committed = await service.acceptAllValid(f.f.source.id);
  expect(committed.blocked).toEqual([]); expect(committed.accepted).toHaveLength(2);
  const audit = await auditCompiler(f.root, { sourceId: f.f.source.id });
  expect(audit.coverage.characterEntryCheckpointCoverage).toBe(0);
  const malformed = { ...event, participantPresence: f.event.participantPresence };
  expect((await service.validator.validate("canonical-event", malformed)).errors.map(e => e.code)).toContain("ENTRY_UNCERTAINTY_CONFLICT");
});

it("retains negative lineage and rejects independent-session reuse, missing checks and changed scope", async () => {
  const f = await fixture();
  expect(() => validateEntryPresenceHistory([f.proposal, f.check], f.parents)).not.toThrow();
  for (const change of [
    (p: any, _c: any) => { p.intent.baselines[0].payload.storyTime.orderHint = 0; },
    (_p: any, c: any) => { c.sessionId = f.proposal.sessionId; },
    (_p: any, c: any) => { c.output.criteria[1] = c.output.criteria[0]; },
    (_p: any, c: any) => { c.output.retainedQuestionIds = []; },
    (_p: any, c: any) => { c.output.criteria[0].verdict = "blocked"; },
    (_p: any, c: any) => { c.output.proposalHash = h("other"); },
  ]) { const p = structuredClone(f.proposal), c = structuredClone(f.check); change(p, c); expect(() => validateEntryPresenceHistory([p, c], f.parents)).toThrow(); }
  const blocked = { ...f.proposal, output: { ...f.proposal.output, disposition: "blocked" as const } };
  expect(() => repair.entryPresenceInput(f.intent, f.context, [blocked])).not.toThrow();
  expect(() => lowerEntryPresenceRepair(f.intent, blocked)).toThrow(/Blocked proposal/);
  const overlayParents = structuredClone(f.parents);
  overlayParents[0]!.scope.reviewContract!.ownerRefs.push({ ref: "event-execution:binding", revisionHash: h("overlay") });
  const overlay = structuredClone(f.proposal);
  overlay.intent.parentRecordHashes = overlayParents.map(h) as [string, string];
  expect(() => validateEntryPresenceHistory([overlay], overlayParents)).toThrow(/baseline changed/);
});

it.each([0, 1, 2])("bounds %i SDK-rejected previews, recovers sealed registration and commits only checked revisions", async invalidPreviews => {
  const f = await fixture(), history: any[] = [{ hash: f.intent.requirementPrefix.head, payload: { kind: "identity-consumer-repair", record: { intent: { taskId: f.intent.taskId } } } },
    ...f.parents.map(record => ({ payload: { kind: "identity-consumer-revalidation", record } }))];
  vi.spyOn(repair, "prepareEntryPresenceRepair").mockResolvedValue({ intent: f.intent, context: f.context, parents: f.parents, directory: f.directory });
  vi.spyOn(retained, "assertConsumerRepairRetainedState").mockResolvedValue();
  vi.spyOn(RequirementLedger.prototype, "history").mockImplementation(async () => history);
  let interrupt = true;
  vi.spyOn(RequirementLedger.prototype, "recordEntryPresenceRepair").mockImplementation(async record => {
    await repair.verifyEntryPresenceRecord(f.root, record, history);
    if (interrupt) { interrupt = false; throw Error("registration interrupted after original sealed result"); }
    history.push({ payload: { kind: "entry-presence-repair", record } });
  });
  const runtime = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
    ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any : runtime(options));
  const create = PiAgentSession.create.bind(PiAgentSession), sessions: string[] = [];
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const check = path.basename(options.runtimeDir!) === "entry-presence-check";
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(f.root, "pi") }); sessions.push(session.id);
    await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, i) => fauxAssistantMessage([
      fauxToolCall(i > (check ? 0 : invalidPreviews) ? "submit_entry_presence_repair" : "preview_entry_presence_repair",
        check ? f.check.output : i < invalidPreviews ? { ...f.proposal.output, title: { invalidAttempt: i } } : f.proposal.output, { id: `tool-${sessions.length}-${i}` }),
    ], { stopReason: "toolUse" }) }); return session;
  });
  const args = { root: f.root, sourceId: f.f.source.id, taskId: f.intent.taskId, ref: f.intent.ref, authorizationRef: f.intent.authorizationRef };
  if (invalidPreviews > 1) {
    await expect(runEntryPresenceRepair(args)).rejects.toThrow(/correction allowance exhausted/);
    expect(sessions).toHaveLength(1);
    expect(history.filter(r => r.payload.kind === "entry-presence-repair")).toHaveLength(0);
    expect(h(await f.canon.getEvent(f.event.id))).toBe(h(f.event));
    const budget = await repair.readPresenceFile(path.join(f.directory, "entry-presence-proposal.budget.json"));
    expect(budget.state.usage.modelCalls).toBe(2);
    await expect(runEntryPresenceRepair(args)).rejects.toThrow(/consumed without a sealed result/);
    expect(sessions).toHaveLength(1);
    return;
  }
  await expect(runEntryPresenceRepair(args)).rejects.toThrow(/registration interrupted/);
  expect(sessions).toHaveLength(1); expect(h(await f.canon.getEvent(f.event.id))).toBe(h(f.event));
  const result = await runEntryPresenceRepair(args);
  expect(result.status).toBe("uncertainty-preserved"); expect(sessions).toHaveLength(2); expect(new Set(sessions).size).toBe(2);
  expect(result.cumulative.modelCalls).toBe(456 + invalidPreviews); expect(result.executableEntry).toBe(false); expect(result.obligationStatus).toBe("blocked");
  expect(result.parentResumeAllowed).toBe(false); expect(history.filter(r => r.payload.kind === "entry-presence-repair")).toHaveLength(4);
  const current = new Map<string, unknown>([["canonical-event:encounter", await f.canon.getEvent("encounter")], ["event-participation:boy-encounter", await f.canon.getEventParticipation("boy-encounter")]]);
  const baselines = await repair.entryPresenceCatalogBaselines(f.root, f.f.source.id, f.intent.taskId, f.intent.upstreamPlanHash, current);
  const envelopes = repair.presenceEnvelopes(f.intent, history.find(r => r.payload.kind === "entry-presence-repair").payload.record);
  const catalog: Map<string, unknown> = new Map(current);
  for (const e of envelopes) for (const a of e.evidenceAssertions) catalog.set(`evidence-assertion:${a.id}`, a);
  const restored = originalIdentityCatalog(catalog, f.intent.baselines, baselines);
  expect(h(restored.get("canonical-event:encounter"))).toBe(h(f.event));
  expect(await runEntryPresenceRepair(args)).toMatchObject({ status: "uncertainty-preserved" }); expect(sessions).toHaveLength(2);
  current.set("canonical-event:encounter", f.event);
  await expect(repair.entryPresenceCatalogBaselines(f.root, f.f.source.id, f.intent.taskId, f.intent.upstreamPlanHash, current)).rejects.toThrow(/outside its receipt/);
}, 30000);
