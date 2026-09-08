import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { contentHash } from "../world/canonical.js";
import { idSchema, textAnchorSchema, stateDeltaSchema, predicateSchema, schemaBoundActionInvocationSchema,
  type StateDelta, type WorldState } from "../world/model.js";
import { resolveActionInvocation } from "../world/action-ontology.js";
import { validateEventExecutions } from "../world/event-execution.js";
import { resolveEffectiveNormTemplates } from "../world/norm-ontology.js";
import { applyKnowledgeDelta, emptyKnowledgeState } from "../world/knowledge.js";
import { emptyBranchSemanticState } from "../world/semantic-effects.js";
import { applyStateDelta, emptyWorldState, DEFAULT_STATE_FIELDS, StateSchemaRegistry, evaluatePredicateTruth } from "../world/state.js";
import { textAnchorForByteRange } from "../compiler/text-anchors.js";
import type { CompilerValidationCatalog } from "../compiler/validator.js";
import crypto from "node:crypto";

const basis = { id: idSchema, scene: z.string().trim().min(1), rationale: z.string().trim().min(1), evidence: z.array(textAnchorSchema).min(1) };
const seedSchema = z.object({ delta: stateDeltaSchema, elapsedDays: z.number().finite().nonnegative() }).strict();
const effectExpectation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delta"), delta: stateDeltaSchema.refine((delta) => delta.operations.length > 0, "state expectations must be nonempty") }).strict(),
  z.object({ kind: z.literal("no-change"), justification: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("unmapped"), concept: z.string().trim().min(1), affectedEntityIds: z.array(idSchema).min(1) }).strict(),
]);
export const sceneCapabilityCaseSchema = z.discriminatedUnion("kind", [
  z.object({ ...basis, kind: z.literal("event-effects"), eventId: idSchema, initiatorId: idSchema.optional(),
    requiresMechanism: z.boolean(), expectation: effectExpectation }).strict(),
  z.object({ ...basis, kind: z.literal("knowledge-cut"), actorId: idSchema, acquisitionEventId: idSchema,
    claimId: idSchema.optional(), contentExpectation: z.string().trim().min(1),
    beforeEventIds: z.array(idSchema), afterEventIds: z.array(idSchema).min(1),
    expectedBefore: z.boolean(), expectedAfter: z.boolean() }).strict(),
  z.object({ ...basis, kind: z.literal("norm-scope"), normId: idSchema, scenarios: z.array(z.object({
    label: z.string().min(1), actorId: idSchema, seed: seedSchema, expectedEffective: z.boolean(),
  }).strict()).min(2) }).strict(),
  z.object({ ...basis, kind: z.literal("action-probe"), actorId: idSchema, participants: z.array(idSchema).min(1),
    action: schemaBoundActionInvocationSchema, seed: seedSchema, expectedAllowed: z.enum(["true", "false", "unknown"]),
    expectedAfter: z.array(predicateSchema) }).strict(),
]);
export const sceneCapabilitySpecSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  review: z.object({ method: z.literal("independent-source-review"), reviewer: z.string().trim().min(1),
    reviewedAt: z.string().datetime(), auditRef: z.string().trim().min(1) }).strict(),
  cases: z.array(sceneCapabilityCaseSchema).min(1).max(128).refine((cases) => new Set(cases.map((item) => item.id)).size === cases.length, "case IDs must be unique"),
}).strict();
export type SceneCapabilitySpec = z.infer<typeof sceneCapabilitySpecSchema>;
export type SceneReviewCatalog = Pick<CompilerValidationCatalog, "entities" | "events" | "eventParticipations" | "actionSchemas" | "eventExecutions" | "normTemplates" | "rules" | "claims" | "propositions" | "attributions">;
export type SceneCapabilityIssue = { code: string; message: string; stage: "semantic" | "executable" | "source-review" | "ontology"; artifactIds: string[] };

/** Expectations come from a separate source review file, never from the candidate schema under test. */
export function evaluateSceneCapabilities(specInput: unknown, sourceBytes: Uint8Array, catalog: SceneReviewCatalog) {
  const spec = sceneCapabilitySpecSchema.parse(specInput);
  if (crypto.createHash("sha256").update(sourceBytes).digest("hex") !== spec.sourceSha256) throw new Error("SCENE_REVIEW_SOURCE_MISMATCH: immutable source hash differs from the independent review.");
  for (const test of spec.cases) for (const anchor of test.evidence) {
    if (anchor.sourceId !== spec.sourceId || !isDeepStrictEqual(anchor, textAnchorForByteRange(spec.sourceId, sourceBytes, anchor.startByte, anchor.endByte))) {
      throw new Error(`SCENE_REVIEW_EVIDENCE_INVALID: ${test.id} has an invalid exact source anchor.`);
    }
  }
  const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
  const makeState = (seed: z.infer<typeof seedSchema>) => {
    const state = emptyWorldState(contentHash(seed)); state.logicalTime.elapsedDays = seed.elapsedDays;
    return applyStateDelta(state, seed.delta, registry, catalog.entities, catalog.rules);
  };
  const cases = spec.cases.map((test) => {
    const issues: SceneCapabilityIssue[] = [];
    const fail = (code: string, message: string, stage: SceneCapabilityIssue["stage"], artifactIds: string[]) => issues.push({ code, message, stage, artifactIds });
    let status: "verified" | "blocked" | "unknown" | "unsupported" = "verified";
    const observations: Record<string, unknown> = {};
    try {
      if (test.kind === "event-effects") {
        const event = catalog.events.get(test.eventId);
        if (!event) fail("SCENE_EVENT_MISSING", "Discover the exact source-scoped event identity before repair.", "source-review", [test.eventId]);
        else {
          if (!event.evidence.some((ref) => ref.span.sourceId === spec.sourceId)) throw new Error("Occurrence belongs to another source.");
          const bindings = [...(catalog.eventExecutions?.values() ?? [])].filter((binding) => binding.canonicalEventId === event.id && binding.action);
          const agency = [...catalog.eventParticipations.values()].filter((part) => part.eventId === event.id && part.entityId === test.initiatorId);
          if (test.initiatorId && !agency.some((part) => part.role === "agent")) fail("SCENE_INITIATOR_ROLE_UNPROVEN", `${test.initiatorId} requires evidence-backed agent participation before an execution binding.`, "semantic", [event.id, ...agency.map((part) => part.id)]);
          const action = bindings[0]?.action ?? (event.action?.lane === "schema-bound" ? event.action : undefined);
          if (test.requiresMechanism && !action) fail("SCENE_MECHANISM_MISSING", "Create a supported mechanism/binding after repairing semantic dependencies.", "executable", [event.id]);
          const formal = validateEventExecutions(bindings, { events: catalog.events, entities: catalog.entities, actionSchemas: catalog.actionSchemas, participations: [...catalog.eventParticipations.values()] });
          observations.formalBindingIssues = formal;
          for (const issue of formal) fail(issue.code, issue.message, issue.code === "EVENT_EXECUTION_AGENCY_UNPROVEN" ? "semantic" : "executable", [event.id, ...bindings.map((binding) => binding.id)]);
          const resolved = action ? resolveActionInvocation(action, catalog.actionSchemas, catalog.entities, { actorId: test.initiatorId,
            participants: event.participants, proposedDelta: event.observedOutcome, hasKnowledge: Boolean(event.observedKnowledge?.operations.length), hasTimeAdvance: Boolean(event.timeAdvance), hasSceneTransition: false }) : undefined;
          for (const issue of resolved?.issues ?? []) fail(issue.code, issue.message, "executable", [event.id]);
          observations.observedDelta = event.observedOutcome;
          observations.resolvedEffects = resolved?.stateEffects ?? null;
          if (test.expectation.kind === "delta") {
            for (const expected of test.expectation.delta.operations) {
              if (!event.observedOutcome.operations.some((actual) => isDeepStrictEqual(actual, expected))) fail("SCENE_SOURCE_OUTCOME_MISSING", `Independent source expectation is absent from the occurrence: ${JSON.stringify(expected)}`, "semantic", [event.id]);
              if (test.requiresMechanism && !resolved?.stateEffects.some((effect) => isDeepStrictEqual(effect.operation, expected))) fail("SCENE_SOURCE_EFFECT_UNBOUND", "The mechanism does not produce the independently expected state operation.", "executable", [event.id, ...(action ? [action.schemaId] : [])]);
            }
          } else if (test.expectation.kind === "no-change") {
            if (event.observedOutcome.operations.length || event.observedKnowledge?.operations.length || resolved?.stateEffects.length) fail("SCENE_UNEXPECTED_CHANGE", "Source-reviewed no-change event contains a state or knowledge effect.", "semantic", [event.id]);
          } else {
            status = "unsupported";
            fail("SCENE_EFFECT_REPRESENTATION_REQUIRED", `Map the source concept explicitly before certification: ${test.expectation.concept}. Do not substitute an unrelated registered field.`, "ontology", [event.id, ...test.expectation.affectedEntityIds]);
            if (!event.observedOutcome.operations.length) fail("SCENE_SOURCE_OUTCOME_EMPTY", "A source-reviewed material transition has an empty occurrence outcome.", "semantic", [event.id]);
          }
        }
      } else if (test.kind === "knowledge-cut") {
        const acquisition = catalog.events.get(test.acquisitionEventId);
        const learned = acquisition?.observedKnowledge?.operations.filter((op) => op.op === "learn" && op.actorId === test.actorId) ?? [];
        if (!learned.length) fail("SCENE_KNOWLEDGE_ACQUISITION_MISSING", `No acquisition path for ${test.actorId}: ${test.contentExpectation}`, "semantic", [test.acquisitionEventId]);
        if (!test.claimId) { status = "unknown"; fail("SCENE_KNOWLEDGE_IDENTITY_UNRESOLVED", "Resolve the expected content to an exact claim/proposition via same-source discovery; do not invent a claim ID.", "semantic", [test.acquisitionEventId]); }
        else {
          if (!catalog.claims.has(test.claimId)) throw new Error(`Unknown expected claim ${test.claimId}`);
          if (!test.afterEventIds.includes(test.acquisitionEventId) || test.beforeEventIds.includes(test.acquisitionEventId)
            || test.beforeEventIds.some((id) => !test.afterEventIds.includes(id))) throw new Error("Knowledge cuts must extend the before history with the acquisition event.");
          const project = (ids: string[]) => {
            if (new Set(ids).size !== ids.length) throw new Error("A knowledge cut cannot replay the same event twice.");
            let knowledge = emptyKnowledgeState(contentHash(ids));
            for (const id of ids) {
              const event = catalog.events.get(id);
              if (!event || !event.evidence.some((ref) => ref.span.sourceId === spec.sourceId)) throw new Error(`Invalid source-scoped cut event ${id}`);
              const commit = contentHash({ before: knowledge.atCommit, event });
              knowledge = applyKnowledgeDelta(knowledge, event.observedKnowledge ?? { version: 1, operations: [] }, commit,
                { entities: catalog.entities, claims: catalog.claims, propositions: catalog.propositions, attributions: catalog.attributions, branchSemantics: emptyBranchSemanticState(commit) });
            }
            return knowledge;
          };
          const before = project(test.beforeEventIds), after = project(test.afterEventIds);
          const known = (state: typeof before) => Boolean(state.actors[test.actorId]?.[test.claimId!] && state.actors[test.actorId]![test.claimId!]!.status !== "disbelieves");
          observations.beforeKnown = known(before); observations.afterKnown = known(after);
          observations.afterAcquisition = after.actors[test.actorId]?.[test.claimId] ?? null;
          if (known(before) !== test.expectedBefore || known(after) !== test.expectedAfter) fail("SCENE_KNOWLEDGE_CUT_MISMATCH", "Actor knowledge does not match the independently reviewed before/after cuts.", "semantic", [...test.afterEventIds]);
          if (test.expectedAfter && !learned.some((op) => op.op === "learn" && op.claimId === test.claimId && op.propositionId && op.acquisitionMode)) fail("SCENE_KNOWLEDGE_PATH_UNPROVEN", "Expected learning needs the exact claim, proposition and acquisition mode at the named event.", "semantic", [test.acquisitionEventId, test.claimId]);
        }
      } else if (test.kind === "norm-scope") {
        const norm = catalog.normTemplates.get(test.normId);
        if (!norm) fail("SCENE_NORM_MISSING", "Discover the exact source-scoped norm before review.", "source-review", [test.normId]);
        else observations.scenarios = test.scenarios.map((scenario) => {
          if (catalog.entities.get(scenario.actorId)?.kind !== "character") throw new Error(`Unknown norm subject ${scenario.actorId}`);
          const state = makeState(scenario.seed);
          const effective = resolveEffectiveNormTemplates([norm], state, scenario.actorId).length > 0;
          if (effective !== scenario.expectedEffective) fail("SCENE_NORM_SCOPE_MISMATCH", `${scenario.label}: expected effective=${scenario.expectedEffective}, observed ${effective}; review time, subject/jurisdiction and exceptions from source.`, "executable", [norm.id]);
          return { label: scenario.label, effective, expected: scenario.expectedEffective };
        });
      } else {
        const before = makeState(test.seed);
        const input = { actorId: test.actorId, participants: test.participants, hasKnowledge: false, hasTimeAdvance: false, hasSceneTransition: false };
        const instantiated = resolveActionInvocation(test.action, catalog.actionSchemas, catalog.entities, { ...input, proposedDelta: { version: 1, operations: [] } });
        const delta: StateDelta = { version: 1, operations: instantiated.stateEffects.filter((effect) => effect.required).map((effect) => effect.operation) };
        const resolved = resolveActionInvocation(test.action, catalog.actionSchemas, catalog.entities, { ...input, proposedDelta: delta });
        if (resolved.issues.length) throw new Error(resolved.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
        const guards = resolved.preconditions.map((predicate) => evaluatePredicateTruth(before, predicate, registry));
        const allowed = guards.includes("false") ? "false" : guards.includes("unknown") ? "unknown" : "true";
        observations.allowed = allowed; observations.generatedDelta = delta;
        if (allowed !== test.expectedAllowed) fail("SCENE_ACTION_GUARD_MISMATCH", `Expected ${test.expectedAllowed}, got ${allowed}; missing prerequisites cannot be assumed true.`, "executable", [test.action.schemaId]);
        if (allowed === "unknown") status = "unknown";
        const after: WorldState = allowed === "true" ? applyStateDelta(before, delta, registry, catalog.entities, catalog.rules) : before;
        observations.after = after.values;
        if (test.expectedAfter.some((predicate) => evaluatePredicateTruth(after, predicate, registry) !== "true")) fail("SCENE_ACTION_OUTCOME_MISMATCH", "The generated action transition fails the independent post-state expectation.", "executable", [test.action.schemaId]);
      }
    } catch (error) { fail("SCENE_REVIEW_INPUT_UNPROVEN", String(error), "source-review", []); }
    if (status === "verified" && issues.length) status = "blocked";
    return { id: test.id, scene: test.scene, kind: test.kind, status, evidence: test.evidence, observations, issues };
  });
  const repairTasks = cases.flatMap((test) => test.issues.map((issue) => ({
    id: `scene-repair-${contentHash({ caseId: test.id, issue }).slice(0, 20)}`, caseId: test.id, stage: issue.stage,
    artifactIds: issue.artifactIds, diagnostic: `${issue.code}: ${issue.message}`, sourceAnchors: test.evidence,
    instruction: issue.stage === "semantic" ? "Schedule a bounded semantic repair using these source anchors and exact artifact IDs; preserve the prior revision. Revalidate the dependent execution after semantic repair."
      : issue.stage === "ontology" ? "Host design review is required before encoding this source concept. Keep it explicitly unsupported; never substitute another field or certify an empty effect."
        : "Inspect the named source-scoped dependencies and repair only this diagnosed gap in the indicated phase; retain valid drafts.",
  })));
  return { version: 1, sourceId: spec.sourceId, sourceSha256: spec.sourceSha256, reviewedAt: new Date().toISOString(),
    specHash: contentHash(spec), catalogHash: contentHash(Object.fromEntries(Object.entries(catalog).filter(([, map]) => map instanceof Map)
      .map(([key, map]) => [key, [...map!.values()].sort((a, b) => a.id.localeCompare(b.id))]))),
    review: spec.review, verified: cases.every((test) => test.status === "verified"), cases, repairTasks,
    scope: "Independent finite scene checks over a read-only catalog. Probes use explicit fixture states and selected event histories; no branch truth, candidate certificate, or full-book playability is written." };
}
