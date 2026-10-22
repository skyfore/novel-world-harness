import { textAnchorForByteRange } from "../../src/compiler/text-anchors.js";
import { contentHash as h } from "../../src/world/canonical.js";
import { identityIntentSchema, identityRequirementId, identityStages, type IdentityRecord } from "../../src/compiler/identity-requirements.js";

export function identityFixture() {
  const taskId = h("original-prerequisite"), evidence = [{ segment_id: "seg", exact: "Ada waits." }], questionIds = [h("critical-1"), h("critical-2"), h("critical-3")];
  const targets = [1, 2, 3].map(slot => ({ slot, requirementId: identityRequirementId(taskId, slot), mentionId: `mention-${slot}`, mentionHash: h(slot), predecessor: null, questionIds: [questionIds[0]!] }));
  const operations = targets.map(t => {
    const payload = { version: 1, id: `rs-${taskId.slice(0, 32)}-${t.slot}`, sourceId: "src", mentionId: t.mentionId, status: "unresolved", candidates: [], rationale: "Independent source uncertainty", derivation: { runId: "old", worker: "old", ontologyVersion: "entity-resolution-v1" } };
    return { slot: t.slot, id: payload.id, kind: "entity-resolution", mode: "create", baseline: null, pointers: [], payloadJson: JSON.stringify(payload), readableRefs: [{ kind: "entity-mention", id: t.mentionId, revisionHash: t.mentionHash }], findingIds: [], questionIds: t.questionIds, rationale: "Frozen scope", evidence };
  });
  const semantic: any[] = [{ output: { phase: "semantic-scope-plan", operations, questions: questionIds.map(questionId => ({ questionId, missingCondition: "Original critical evidence missing", boundaries: [{ status: "unresolved" }] })), consumer: { activationConditions: ["Original audit remains blocked"] } } }, { output: { phase: "semantic-scope-check" } }];
  const inventory = { graphHash: h("graph"), roots: ["entity-resolution/old"], closureIssues: [], sourcePages: [0, 2], candidateIds: ["role-old", "role-new"], originalQuestionIds: questionIds,
    consumers: ["event/consumer", "staged-role/role-old"].map(ref => ({ ref, revisionHash: h(ref), payload: { id: ref }, reason: "typed-consumer" as const, dependencies: [] })) };
  const intent = identityIntentSchema.parse({ version: 1, policy: "independent-identity-requirements/v1", taskId, revisionHash: h("76-to-78"), sourceId: "src", sourceHash: h("source"), parentStateHash: h("BREAK"), originalPlanHash: h("original-plan"), originalBudgetHash: h("original-budget"), authorizationRef: "User authorized new independent identity requirements, not old retries",
    semanticRecordHashes: semantic.map(h), retainedConditionsHash: h({ questions: semantic[0].output.questions, consumer: semantic[0].output.consumer }), catalogHash: h("catalog"), inventoryHash: h(inventory), requiredSourceSegmentIds: ["seg"], targets,
    consumerShards: inventory.consumers.map((c, index) => ({ index, refs: [c.ref] })), requirementPrefix: { length: 3111, head: h("requirements") }, upstreamPrefix: { length: 125, head: h("upstream") }, priorUsage: { modelCalls: 143, totalPayloadBytes: 12000, budgetFilesHash: h("143 prior calls with correction inherited once") } });
  const records: IdentityRecord[] = [];
  const common = { intentHash: h(intent), retainedConditionsHash: intent.retainedConditionsHash };
  for (const { stage, phase, shard } of identityStages(intent)) {
    const reqs = targets.map(t => ({ id: t.requirementId, mentionId: t.mentionId, questionIds: t.questionIds, requirement: "Represent only source-supported uncertainty", acceptanceCriteria: ["No unsupported stable identity"], disposition: "uncertainty-preservation", requiredStatus: "unresolved", missingCondition: "", evidence }));
    const judgments = reqs.map(r => ({ id: r.id, verdict: "supported", rationale: "Fresh independent evidence check", evidence }));
    const consumers = inventory.consumers.filter(c => intent.consumerShards[shard ?? -1]?.refs.includes(c.ref));
    const output: any = phase === "identity-definition" ? { ...common, phase, requirements: reqs }
      : phase === "identity-definition-check" ? { ...common, phase, proposalHash: h(records.at(-1)!.output), judgments }
        : phase === "identity-consumers" ? { ...common, phase, shard, definitionHash: h(records[0]!.output), inventoryHash: h(inventory), bindings: targets.map((t, i) => ({ requirementId: t.requirementId, slot: t.slot, payloadHash: h(JSON.parse(operations[i]!.payloadJson)), dependencyRefs: [`entity-mention:${t.mentionId}`], verdict: "supported", rationale: "Exact typed dependency", missingCondition: "", evidence })),
          consumers: consumers.map(c => ({ ref: c.ref, revisionHash: c.revisionHash, disposition: "revalidate-required", rationale: "Transitive identity consumer", requiredAction: "Keep blocked pending independent revalidation" })), candidateIds: inventory.candidateIds, sourcePages: inventory.sourcePages, originalQuestionIds: questionIds, activationConditions: ["Keep original budget and unresolved questions"], parentResumeAllowed: false, renewConsumedGrant: false, evidence }
          : { ...common, phase, shard, proposalHash: h(records.at(-1)!.output), inventoryHash: h(inventory), judgments, consumers: consumers.map(c => ({ ref: c.ref, verdict: "supported", rationale: "Independent consumer review" })), denominatorVerdict: "supported", denominatorRationale: "Entire frozen shard and denominator retained" };
    records.push({ intent, phase, stage, output, inputHash: h(stage), evidence: [{ selector: evidence[0]!, anchor: textAnchorForByteRange("src", Buffer.from("Ada waits."), 0, 10) }], traceRunId: `run-${stage}`, sessionId: `session-${stage}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, predecessorRecordHash: records.length ? h(records.at(-1)) : null } as IdentityRecord);
  }
  const p: any = { intent, inventory, semantic, review: { upstream: { receiptFingerprint: h("source receipt") } }, manifest: { segments: [{ id: "seg" }] }, prerequisites: [{ output: { phase: "specification", requirements: [{ requirement: "Independent original source requirement" }] } }], representations: [{ output: { phase: "representation-plan", boundaries: [{ status: "unresolved" }] } }],
    catalog: [...targets.map(t => ({ kind: "entity-mention", id: t.mentionId, revisionHash: t.mentionHash, payload: { id: t.mentionId } })), { kind: "canonical-event", id: "hidden-outcome", revisionHash: h("outcome"), payload: { text: "SECRET_CANDIDATE_OUTCOME" } }] };
  return { p, records, intent, semantic, inventory };
}
