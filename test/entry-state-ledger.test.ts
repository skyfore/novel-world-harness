import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { contentHash as h } from "../src/world/canonical.js";
import { canonicalEventSchema, eventParticipationSchema } from "../src/world/model.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { RequirementLedger, type LedgerRecord } from "../src/compiler/requirement-ledger.js";
import { identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { consumerRepairIntentSchema, type ConsumerRepairRecord } from "../src/compiler/identity-consumer-repair-model.js";
import { consumerRevalidationId, consumerRevalidationScopeSchema, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";
import { deriveConsumerReviewContract } from "../src/compiler/consumer-review-contract.js";
import { loadCompilerArtifactRecords } from "../src/compiler/artifact-retrieval.js";
import { originalIdentityCatalog } from "../src/compiler/upstream-repair-preflight.js";
import { ENTRY_STATE_REPAIR, ENTRY_WORDING_REPAIR, entryStateIntentSchema, entryStateRepairDirectory, entryStateCriteria, type EntryStateRecord } from "../src/compiler/entry-state-repair-model.js";
import * as stateRepair from "../src/compiler/entry-state-repair.js";
import { runEntryStateRepair } from "../src/workflow/entry-state-repair.js";
import { consumerRevalidationStatus } from "../src/compiler/identity-review-status.js";
import { realIdentityFixture } from "./helpers/identity-real-fixture.js";
import { mockPiProvider } from "./helpers/pi-provider.js";

it.each([ENTRY_STATE_REPAIR, ENTRY_WORDING_REPAIR])("rewinds consecutive entry repairs including %s without invalidating historical receipts", async secondPolicy => {
  const refs = ["entity/ada", "entry/ada/encounter", "entry/bea/encounter"];
  const f = await realIdentityFixture(false, false, 3, { consumerRefs: refs,
    additionalSource: "Ada and Bea climbed to the platform. Both are sitting beside their observer before the bell rings.\n" });
  const { root, p } = f;
  try {
    f.outputs[2].consumers[0].disposition = "additional-repair-required";
    f.outputs[3].proposalHash = h(f.outputs[2]);
    await expect(f.run()).rejects.toThrow(/Consumer shard retains a repair prerequisite/);
    vi.mocked(PiAgentSession.create).mockRestore();
    const ledger = new RequirementLedger(root, p.intent.sourceId), identity = await ledger.identityRequirements(p.intent.taskId);
    const definition = identity[0]!.output;
    if (definition.phase !== "identity-definition") throw Error("definition fixture");
    const requirementIds = definition.requirements.map(r => r.id), evidence = identity[0]!.evidence;
    const refsEvidence = evidence.map(e => ({ span: { sourceId: e.anchor.sourceId, startByte: e.anchor.startByte, endByte: e.anchor.endByte,
      startLine: e.anchor.startLine, endLine: e.anchor.endLine, quoteHash: e.anchor.exactHash }, strength: "explicit" as const }));
    const selector = evidence[0]!.selector;
    const appendImportedHistory = async (payloads: LedgerRecord["payload"][]) => {
      const history = await ledger.history();
      for (const payload of payloads) {
        const record = { version: 1 as const, sourceId: p.intent.sourceId, sequence: history.length,
          predecessorHash: history.at(-1)!.hash, payload };
        history.push({ ...record, hash: h(record) });
      }
      await ledger.restoreJournal(history, p.bytes);
    };
    // Import the prior upstream authority as a fixture. The repair's ledger,
    // prefix guard, sessions, validation, commit and successor verification are real.
    const directory = identityRequirementDirectory(root, p.intent.sourceId, p.intent.taskId);
    const retainedText = JSON.stringify({ original: "retained upstream authority" });
    await fs.writeFile(path.join(directory, "retained-upstream.json"), retainedText);
    const old = identity[2]!, oldOutput = old.output;
    if (oldOutput.phase !== "identity-consumers") throw Error("consumer fixture");
    const history = await ledger.history();
    const repairIntent = consumerRepairIntentSchema.parse({ version: 1, policy: "identity-consumer-repair/v1",
      sourceId: p.intent.sourceId, sourceHash: p.intent.sourceHash, taskId: p.intent.taskId, identityIntentHash: h(p.intent),
      findingId: h({ taskId: p.intent.taskId, recordHash: h(old), pointer: "/output/consumers/0" }),
      proposalRecordHash: h(old), checkRecordHash: h(identity[3]), ref: refs[0], revisionHash: oldOutput.consumers[0]!.revisionHash,
      definitionHash: h(definition), requirementIds, inventoryHash: p.intent.inventoryHash, graphHash: p.inventory.graphHash,
      baselineManifestHash: h("prior catalog"), conditionHash: h(oldOutput.consumers[0]!.requiredAction),
      requirementPrefix: { length: history.length, head: history.at(-1)!.hash }, authorizationRef: "prior typed repair",
      originalBudgetHash: p.intent.originalBudgetHash, priorUsage: p.intent.priorUsage,
      retainedFiles: [{ path: "retained-upstream.json", hash: createHash("sha256").update(retainedText).digest("hex") }] });
    const retained: ConsumerRepairRecord = { intent: repairIntent, inputHash: h("prior repair input"),
      output: { phase: "consumer-repair-plan", intentHash: h(repairIntent), requirementIds, ref: refs[0]!, baselineHash: repairIntent.revisionHash,
        operation: { mode: "capability-gap", requiredCapability: "Source-bound uncertainty", rationale: "Preserve unresolved identity" },
        consumerRevalidation: "Review all original consumers", retainedBoundaries: "Keep source gaps", evidence: [selector] },
      predecessorRecordHash: null, sessionId: "prior-repair-session", traceRunId: "prior-repair-trace", provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, evidence };
    await appendImportedHistory([{ kind: "identity-consumer-repair", record: retained }]);
    const canon = new CanonicalModelStore(root);
    for (const id of ["ada", "bea", "observer"]) await canon.putEntity({ id, kind: "character", canonicalName: id, aliases: [], evidence: refsEvidence });
    const originalEvent = canonicalEventSchema.parse({ id: "encounter", title: "Visitors appear", readerSummary: "Two visitors appear before an observer.",
      participants: ["ada", "bea", "observer"], participantPresence: ["ada", "bea", "observer"].map(entityId => ({ entityId, mode: "physical" })),
      storyTime: { kind: "ordinal", label: "later", orderHint: 3 }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [],
      characterEntryCheckpoints: ["ada", "bea"].map(actorId => ({ actorId, readerSetup: "Before the encounter", actorObservation: "You wait.",
        participantPresence: [{ entityId: actorId, mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: actorId, field: "character.plan", value: actorId === "bea" && secondPolicy === ENTRY_WORDING_REPAIR ? "wait for the bell" : "climb onto the platform" }] } })),
      evidence: refsEvidence, confidence: 1 });
    await canon.putEvent(originalEvent);
    for (const entityId of originalEvent.participants) await canon.putEventParticipation(eventParticipationSchema.parse({
      id: `${entityId}-encounter`, eventId: "encounter", entityId, role: "experiencer", presence: "physical", confidence: 1, evidence: refsEvidence }));
    await new InitialWorldStore(root).put({ version: 1, participantPresence: [{ entityId: "observer", mode: "physical" }],
      delta: { version: 1, operations: [{ op: "set", entityId: "observer", field: "character.plan", value: "climb onto the platform" }] }, evidence: refsEvidence });
    let prepared: Awaited<ReturnType<typeof stateRepair.prepareEntryStateRepair>>;
    vi.spyOn(stateRepair, "prepareEntryStateRepair").mockImplementation(async () => prepared);
    const create = PiAgentSession.create.bind(PiAgentSession), sessions: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      const check = path.basename(options.runtimeDir!) === "entry-state-check";
      const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, "pi-entry-state") }); sessions.push(session.id);
      const { intent } = prepared;
      const output: Extract<EntryStateRecord, { phase: "entry-state-proposal" }>["output"] = { phase: "entry-state-proposal" as const, scopeHash: h(intent), evidence: [selector], retainedQuestionIds: intent.retainedQuestionIds,
        playable: false as const, parentResumeAllowed: false as const, disposition: "repaired" as const,
        edit: intent.policy === ENTRY_WORDING_REPAIR ? { fields: [{ field: "readerSetup" as const, value: "Bea sits beside the observer before the bell rings.",
          strength: "explicit" as const, evidence: [selector], rationale: "Keep the entry description before the bell." }] } : { remove: [{ index: 0, operationHash: h(canonicalEventSchema.parse(intent.baselines[0]!.payload).characterEntryCheckpoints!.find(e => e.actorId === intent.actorId)!.delta.operations[0]) }],
          set: [{ field: "character.posture", value: "sitting", strength: "explicit" as const, evidence: [selector], rationale: "Both actors are seated before the event." }] },
        rationale: "Completed climbing is not a current plan; retain evidenced bodily context." };
      const checked = { phase: "entry-state-check", scopeHash: h(intent), evidence: [selector], retainedQuestionIds: intent.retainedQuestionIds,
        playable: false, parentResumeAllowed: false, proposalHash: h(output), verdict: "supported", rationale: "Grounded posture replaces the unsupported plan.",
        requirements: requirementIds.map(id => ({ id, verdict: "supported", rationale: "The entry retains the original identity boundaries." })),
        criteria: entryStateCriteria.map(id => ({ id, verdict: "supported", rationale: "Limited revision retains the original obligations." })) };
      await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, i) => fauxAssistantMessage([
        fauxToolCall(i ? "submit_entry_state_repair" : "preview_entry_state_repair", check ? checked : output, { id: `${sessions.length}-${i}` }),
      ], { stopReason: "toolUse" }) });
      return session;
    });
    const publish = RequirementLedger.prototype.recordEntryStateRepair;
    let interrupt = true;
    vi.spyOn(RequirementLedger.prototype, "recordEntryStateRepair").mockImplementation(async function (this: RequirementLedger, record) {
      await publish.call(this, record);
      if (interrupt) { interrupt = false; throw Error("interrupted after durable journal publication"); }
    });
    const preparations: typeof prepared[] = [];
    for (const actorId of ["ada", "bea"]) {
      const catalog = (await loadCompilerArtifactRecords(root, p.intent.sourceId)).filter(r => r.status === "canonical");
      const event = canonicalEventSchema.parse(catalog.find(r => r.kind === "canonical-event" && r.logicalId === "encounter")!.payload);
      const entry = event.characterEntryCheckpoints!.find(c => c.actorId === actorId)!, ref = `entry/${actorId}/encounter`;
      const prefix = await ledger.history();
      const scope = consumerRevalidationScopeSchema.parse({ version: 1, sourceId: p.intent.sourceId, sourceHash: p.intent.sourceHash,
        taskId: p.intent.taskId, identityIntentHash: h(p.intent), inventoryHash: p.intent.inventoryHash, definitionHash: h(definition), requirementIds, ref,
        originalRevisionHash: h(entry), currentRevisionHash: h(entry), upstreamPlanHash: h("upstream-plan"), receiptFingerprint: h("upstream-receipt"), acceptanceHash: h("acceptance"),
        parentStateHash: p.intent.parentStateHash, originalBudgetHash: p.intent.originalBudgetHash, authorizationRef: "original review", priorUsage: { modelCalls: 0, totalPayloadBytes: 0 },
        priorBudgetFiles: [{ path: f.priorBudgetFile, hash: h(JSON.parse(await fs.readFile(f.priorBudgetFile, "utf8"))) }],
        requirementPrefix: { length: prefix.length, head: prefix.at(-1)!.hash }, reviewContract: deriveConsumerReviewContract({ sourceId: p.intent.sourceId, ref,
          current: { payload: entry, revisionHash: h(entry) }, catalog: [{ kind: "canonical-event", id: event.id, payload: event, revisionHash: h(event), current: true }] }) });
      const originalInput = { requiredSourceSegmentIds: p.intent.requiredSourceSegmentIds,
        evidencePacket: { sources: p.manifest.segments.map((s: { id: string; startByte: number; endByte: number }) => ({ id: s.id, text: Buffer.from(p.bytes).subarray(s.startByte, s.endByte).toString() })) } };
      const proposal: ConsumerRevalidationRecord = { scope, inputHash: h(originalInput), predecessorRecordHash: null, sessionId: `prior-${actorId}-proposal`, traceRunId: `prior-${actorId}-proposal-trace`,
        sessionCheckpointHash: h(`prior-${actorId}-checkpoint`), evidence, output: { phase: "consumer-revalidation", scopeHash: h(scope), requirementIds, evidence: [selector],
          ref, currentRevisionHash: h(entry), disposition: "blocked", rationale: "The entry still contains a completed climbing plan.", requirements: requirementIds.map(id => ({ id, verdict: "blocked", rationale: "Retain uncertainty." })),
          initialWorldRepair: null, retainedQuestionIds: p.inventory.originalQuestionIds, parentResumeAllowed: false,
          review: { contractHash: h(scope.reviewContract), checks: scope.reviewContract!.requiredChecks.map(id => ({ id, verdict: "blocked", rationale: "Preserve source gap." })), globalIdentityQuestions: "retained" } } };
      const checked: ConsumerRevalidationRecord = { ...proposal, predecessorRecordHash: h(proposal), sessionId: `prior-${actorId}-check`, traceRunId: `prior-${actorId}-check-trace`,
        output: { phase: "consumer-revalidation-check", scopeHash: h(scope), requirementIds, evidence: [selector], proposalHash: h(proposal.output), reviewContractHash: h(scope.reviewContract), verdict: "supported", rationale: "The entry remains blocked." } };
      await appendImportedHistory([proposal, checked].map(record => ({ kind: "identity-consumer-revalidation", record })));
      const journal = await ledger.history(), context = { originalInput, negativeJudgments: [proposal.output, checked.output] };
      const intent = entryStateIntentSchema.parse({ version: 1, policy: actorId === "bea" ? secondPolicy : ENTRY_STATE_REPAIR, sourceId: scope.sourceId, sourceHash: scope.sourceHash,
        taskId: scope.taskId, identityIntentHash: scope.identityIntentHash, originalBudgetHash: scope.originalBudgetHash, ref, actorId, eventId: "encounter",
        parentReviewId: consumerRevalidationId(scope), parentRecordHashes: [h(proposal), h(checked)], parentReceiptFingerprint: scope.receiptFingerprint, upstreamPlanHash: scope.upstreamPlanHash,
        authorizationRef: "repair exact source-supported state", createdAt: new Date().toISOString(), implementationHash: await stateRepair.entryStateImplementationHash(), contextHash: h(context),
        requirementIds, retainedQuestionIds: p.inventory.originalQuestionIds, totalConsumers: refs.length,
        requirementPrefix: { length: journal.length, head: journal.at(-1)!.hash }, priorUsage: scope.priorUsage, priorBudgetFiles: scope.priorBudgetFiles,
        baselines: catalog.filter(r => r.kind === "canonical-event" && r.logicalId === "encounter")
          .map(r => ({ kind: r.kind, id: r.logicalId, payload: r.payload, revisionHash: h(r.payload), evidenceAssertions: r.evidenceAssertions })) });
      prepared = { intent, context, parents: [proposal, checked], directory: entryStateRepairDirectory(root, intent) }; preparations.push(prepared);
      const args = { root, sourceId: scope.sourceId, taskId: scope.taskId, ref, policy: intent.policy, authorizationRef: intent.authorizationRef };
      if (actorId === "ada") await expect(runEntryStateRepair(args)).rejects.toThrow(/after durable journal/);
      expect(await runEntryStateRepair(args)).toMatchObject({ status: "repaired", obligationStatus: "revalidated" });
    }
    expect(sessions).toHaveLength(4);
    const journal = await ledger.history(), repairRecords = stateRepair.entryStateRecords(journal, p.intent.taskId);
    const reviewRecords = journal.flatMap(r => r.payload.kind === "identity-consumer-revalidation" ? [r.payload.record] : []);
    const status = consumerRevalidationStatus(identity, reviewRecords, repairRecords);
    expect(status).toMatchObject({ totalConsumers: 3, recordedClearedConsumers: 2, unrecordedConsumers: 1, sourceAuditResumeAllowed: false });
    expect(status.reviews.every(r => r.status === "blocked")).toBe(true);
    expect(status.currentReviews.every(r => r.status === "revalidated" && r.entryStateRepair)).toBe(true);
    expect(() => consumerRevalidationStatus(identity, reviewRecords, repairRecords.map(r => r.phase === "entry-state-applied" ? { ...r, artifacts: r.artifacts.map(a => ({ ...a, afterHash: h("forged") })) } : r))).toThrow();
    expect(repairRecords).toHaveLength(8);
    for (const record of repairRecords) await stateRepair.verifyEntryStateRecord(root, record);
    const active = (await loadCompilerArtifactRecords(root, p.intent.sourceId)).filter(r => r.status === "canonical");
    const current = new Map(active.map(r => [`${r.kind}:${r.logicalId}`, r.payload]));
    for (const r of active) for (const a of r.evidenceAssertions) current.set(`evidence-assertion:${a.id}`, a);
    const baselines = await stateRepair.entryStateCatalogBaselines(root, p.intent.sourceId, p.intent.taskId, h("upstream-plan"), current);
    const originals = baselines.flatMap(r => [{ kind: r.kind, id: r.id, payload: r.payload }, ...r.originalAssertions.map(a => ({ kind: "evidence-assertion", id: a.id, payload: a }))]);
    expect(originalIdentityCatalog(current, originals, baselines).get("canonical-event:encounter")).toEqual(originalEvent);
    vi.spyOn(stateRepair, "entryStateImplementationHash").mockResolvedValue(h("later compiler implementation"));
    prepared = preparations[0]!;
    expect(await runEntryStateRepair({ root, sourceId: p.intent.sourceId, taskId: p.intent.taskId, ref: prepared.intent.ref, authorizationRef: prepared.intent.authorizationRef, inspect: true }))
      .toMatchObject({ status: "repaired", modelDispatchAllowed: false });
    const drift = new Map(current); drift.set("canonical-event:encounter", originalEvent);
    await expect(stateRepair.entryStateCatalogBaselines(root, p.intent.sourceId, p.intent.taskId, h("upstream-plan"), drift)).rejects.toThrow(/outside its receipt chain/);
    expect(sessions).toHaveLength(4);
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
}, 60000);
