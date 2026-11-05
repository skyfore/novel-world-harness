import { expect, it } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { canonicalEventSchema, characterEntryCheckpointSchema } from "../src/world/model.js";
import { deriveEntryCut } from "../src/world/entry-cut.js";
import { deriveConsumerReviewContract, consumerReviewCapability, validateConsumerReviewAssessment,
  CONSUMER_REVIEW_CORRECTION } from "../src/compiler/consumer-review-contract.js";
import { consumerReviewSystemPrompt, consumerWorkPrompt } from "../src/workflow/identity-consumer-revalidation.js";
import type { ConsumerRevalidationScope } from "../src/compiler/identity-consumer-revalidation-model.js";
import { remainingConsumerReviewLimits } from "../src/compiler/identity-consumer-correction.js";
import { consumerRevalidationInput } from "../src/compiler/identity-consumer-revalidation.js";

function fixture() {
  const payload = characterEntryCheckpointSchema.parse({ actorId: "ada", readerSetup: "Ada's later arrival.",
    actorObservation: "You wait before the meeting.", participantPresence: [{ entityId: "ada", mode: "physical" }],
    delta: { version: 1, operations: [] } });
  const event = canonicalEventSchema.parse({ id: "later-meeting", title: "Later meeting", participants: ["ada"],
    characterEntryCheckpoints: [payload], storyTime: { kind: "ordinal", label: "later afternoon", orderHint: 30 },
    preconditions: [], observedOutcome: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: false }] },
    evidence: [{ span: { sourceId: "src", startByte: 20, endByte: 30, startLine: 2, endLine: 2, quoteHash: h("Ada waits.") }, strength: "explicit" }],
    causalParents: [], confidence: 1 });
  const catalog = [{ kind: "canonical-event", id: event.id, payload: event, revisionHash: h(event), current: true }];
  const args = { sourceId: "src", ref: "entry/ada/later-meeting", current: { payload, revisionHash: h(payload) }, catalog };
  const contract = deriveConsumerReviewContract(args);
  const scope = { sourceId: "src", ref: args.ref, reviewContract: contract } as ConsumerRevalidationScope;
  const output = { phase: "consumer-revalidation", disposition: "revalidated", review: { contractHash: h(contract),
    checks: contract.requiredChecks.map(id => ({ id, verdict: "supported" as "supported" | "blocked", rationale: "Source support at this entry; global identity remains unresolved." })),
    globalIdentityQuestions: "retained" as const } };
  return { args, event, contract, scope, output };
}

it("binds a later character entry to its owning pre-event cut without moving the opening or importing outcomes", () => {
  const f = fixture(), before = h(f.args);
  expect(f.contract.target).toEqual({ kind: "character-entry", actorId: "ada", beforeEventId: "later-meeting",
    storyTime: f.event.storyTime, position: "before-event" });
  const opening = { ...f.event, id: "opening", participants: ["anonymous"], characterEntryCheckpoints: [],
    storyTime: { kind: "ordinal" as const, label: "opening", orderHint: 2 } };
  const future = { ...f.event, id: "future", storyTime: { kind: "ordinal" as const, label: "future", orderHint: 40 } };
  const cut = deriveEntryCut({ events: [future, f.event, opening], relations: [], beforeEventId: "later-meeting", baselineEventId: "opening" });
  expect(cut.issues).toEqual([]); expect(cut.replayEventIds).toEqual(["opening"]);
  expect(cut.excludedEventIds).toEqual(["future", "later-meeting"]);
  expect(consumerReviewCapability(f.scope)).toEqual({ kind: "read-only-consumer", ref: f.scope.ref, writableFields: [], createsEntity: false });
  expect(() => validateConsumerReviewAssessment(f.contract, f.output)).not.toThrow();
  expect(f.contract.globalIdentityQuestions).toBe("retained"); expect(h(f.args)).toBe(before);
});

it.each(["knowledge-isolation", "presence-and-agency", "entry-state", "temporal-boundary"] as const)(
  "keeps an unsupported %s blocked even when the entry cut is correct", id => {
    const { contract, output } = fixture(); output.review.checks.find(c => c.id === id)!.verdict = "blocked";
    expect(() => validateConsumerReviewAssessment(contract, output)).toThrow(/unresolved consumer check/);
    output.disposition = "blocked";
    expect(() => validateConsumerReviewAssessment(contract, output)).not.toThrow();
    expect(() => validateConsumerReviewAssessment(contract, { phase: "consumer-revalidation-check", reviewContractHash: h(contract) })).not.toThrow();
  });

it("rejects omitted checks, changed targets and an independent check using the opening contract", () => {
  const f = fixture(), incomplete = structuredClone(f.output); incomplete.review.checks.pop();
  expect(() => validateConsumerReviewAssessment(f.contract, incomplete)).toThrow(/omitted or changed/);
  const duplicated = structuredClone(f.output); duplicated.review.checks[0] = duplicated.review.checks[1]!;
  expect(() => validateConsumerReviewAssessment(f.contract, duplicated)).toThrow(/omitted or changed/);
  const opening = deriveConsumerReviewContract({ ...f.args, ref: "initial/src", current: { payload: {}, revisionHash: h({}) } });
  expect(() => validateConsumerReviewAssessment(f.contract, { phase: "consumer-revalidation-check", reviewContractHash: h(opening) })).toThrow(/Independent check/);
  expect(() => validateConsumerReviewAssessment(f.contract, { phase: "consumer-revalidation-check" })).toThrow(/Independent check/);
  expect(consumerReviewCapability({ ...f.scope, ref: "initial/src", reviewContract: opening }).kind).toBe("initial-world");
  expect(consumerReviewCapability({ sourceId: "src", ref: f.args.ref }).kind).toBe("initial-world");
  expect(() => validateConsumerReviewAssessment(undefined, f.output)).toThrow(/Legacy scope/);
});

it("does not guess time from reader order or accept a missing or stale owning revision", () => {
  const { args, event } = fixture();
  expect(() => deriveConsumerReviewContract({ ...args, catalog: [] })).toThrow(/no exact active owning event/);
  expect(() => deriveConsumerReviewContract({ ...args, ref: "entry/bob/later-meeting" })).toThrow(/actor differs/);
  expect(() => deriveConsumerReviewContract({ ...args, catalog: [{ ...args.catalog[0]!, revisionHash: h("stale") }] })).toThrow(/no exact active owning event/);
  const unknown = { ...event, storyTime: { kind: "unknown" as const } };
  expect(deriveConsumerReviewContract({ ...args, catalog: [{ ...args.catalog[0]!, payload: unknown, revisionHash: h(unknown) }] }).target)
    .toMatchObject({ storyTime: { kind: "unknown" }, position: "before-event" });
});

it("delivers the exact owner and its full source segment while retaining original criteria and denominator", () => {
  const f = fixture(), prepared: any = { scope: f.scope, catalog: f.args.catalog, original: [{ output: { original: true } }, { output: { checked: true } }],
    consumer: { ref: f.scope.ref }, current: f.args.current, acceptance: { output: {} }, prepared: { intent: { requiredSourceSegmentIds: ["opening-source"], targets: [] },
      review: { scope: { questions: ["unresolved global identity"] } }, semantic: [{ output: { retained: true } }],
      inventory: { consumers: [{ ref: f.scope.ref }], candidateIds: ["ada"], sourcePages: [0, 1], originalQuestionIds: [h("global")] },
      manifest: { segments: [{ id: "opening-source", startByte: 0, endByte: 10 }, { id: "later-source", startByte: 10, endByte: 40 }] } } };
  const input = consumerRevalidationInput(prepared, [], false);
  expect(input.requiredSourceSegmentIds).toEqual(["opening-source", "later-source"]);
  expect(input.artifactReadRefs.map(r => r.ref)).toEqual(["canonical-event:later-meeting"]);
  expect(input.reviewContractHash).toBe(h(f.contract)); expect(input.originalQuestions).toEqual(["unresolved global identity"]);
  expect(input.denominator).toEqual({ total: 1, refs: [f.scope.ref], candidateIds: ["ada"], sourcePages: [0, 1], originalQuestionIds: [h("global")] });
});

it("keeps legacy prompts reconstructible and removes singleton repair authority from scoped entry reviews", () => {
  const { scope } = fixture();
  expect(consumerReviewSystemPrompt({ ...scope, reviewContract: undefined }, true)).toBe(consumerWorkPrompt);
  const prompt = consumerReviewSystemPrompt(scope, true);
  expect(prompt).toContain("immediately BEFORE beforeEventId"); expect(prompt).toContain("initialWorldRepair=null");
  expect(prompt).not.toContain("under the existing initial-world validation");
  scope.compilerCorrection = { policy: CONSUMER_REVIEW_CORRECTION } as ConsumerRevalidationScope["compilerCorrection"];
  expect(consumerReviewSystemPrompt(scope, true)).toContain("Previews never renew it");
});

it("subtracts old calls and bytes and refuses an exhausted or invalid correction allowance", () => {
  const budget = { limits: { maxModelCalls: 12, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 },
    state: { usage: { modelCalls: 3, totalPayloadBytes: 300000 } } };
  expect(remainingConsumerReviewLimits(budget)).toEqual({ maxModelCalls: 9, maxRequestBytes: 512000, maxTotalPayloadBytes: 11988000 });
  for (const calls of [-1, 1.5, 11, 12, 13]) {
    expect(() => remainingConsumerReviewLimits({ ...budget, state: { usage: { ...budget.state.usage, modelCalls: calls } } })).toThrow(/allowance|insufficient/);
  }
  expect(() => remainingConsumerReviewLimits({ ...budget, state: { usage: { modelCalls: 1, totalPayloadBytes: 12288001 } } })).toThrow(/insufficient/);
});
