import { z } from "zod";
import { ActorModelStore, characterGoalSchema, characterModelSchema, type CharacterGoal, type CharacterModel } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { initialWorldSchema } from "../world/initial.js";
import {
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  eventParticipationSchema,
  eventRelationSchema,
  attributionSchema,
  evidenceAssertionSchema,
  evidenceRefSchema,
  idSchema,
  propositionSchema,
  validateParticipantPresence,
  stateDeltaSchema,
  stateOperationSchema,
  stateValueSchema,
  storyTimeSchema,
  worldRuleSchema,
  type ArtifactProposal,
  type Attribution,
  type CanonicalEvent,
  type Claim,
  type EvidenceRef,
  type EvidenceAssertion,
  type EventParticipation,
  type EventRelation,
  type KnowledgeDelta,
  type ParticipantPresence,
  type Predicate,
  type Proposition,
  type StateDelta,
  type StoryTime,
  type WorldRule,
} from "../world/model.js";
import { validateEventParticipationCatalog } from "../world/event-semantics.js";
import { validateEventRelationCatalog } from "../world/event-relations.js";
import {
  validateCharacterOntologyEvidenceAssertions,
  validateCharacterOntologyReferences,
} from "../world/character-ontology.js";
import {
  validateRelationshipOntologyEvidenceAssertions,
  validateRelationshipOntologyReferences,
} from "../world/relationship-ontology.js";
import { PossibilityTemplateStore, possibilityTemplateSchema, type PossibilityTemplate } from "../world/possibility-model.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { assertEvidenceExclusiveToSource, assertSingleEvidenceSource, evidenceSourceIds } from "../world/source-scope.js";
import { hasExecutablePossibilityEffect, isMetaKnowledgePredicate } from "./semantics.js";
import { EvidenceVerifier, validateEntityNameEvidence } from "./evidence.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import {
  evidenceAssertionSourceIds,
  validateEvidenceAssertionTargets,
} from "./evidence-assertions.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { findKnowledgeDeltas, validateKnowledgeSemanticReferences } from "../world/knowledge-semantics.js";

const compilerRulePredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("fact-equals"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
    z.object({ op: z.literal("fact-gte"), entityId: idSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
    z.object({ op: z.literal("fact-lte"), entityId: idSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
    z.object({ op: z.literal("fact-exists"), entityId: idSchema, field: z.string().min(1) }).strict(),
    z.object({ op: z.literal("entity-in"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
    z.object({ op: z.literal("rule-active"), ruleId: idSchema }).strict(),
    z.object({ op: z.literal("elapsed-days-gte"), days: z.number().finite().nonnegative() }).strict(),
    z.object({ op: z.literal("elapsed-days-lte"), days: z.number().finite().nonnegative() }).strict(),
    z.object({ op: z.literal("story-time-at-or-after"), time: storyTimeSchema }).strict(),
    z.object({ op: z.literal("story-time-before"), time: storyTimeSchema }).strict(),
    z.object({ op: z.literal("all"), items: z.array(compilerRulePredicateSchema) }).strict(),
    z.object({ op: z.literal("any"), items: z.array(compilerRulePredicateSchema) }).strict(),
    z.object({ op: z.literal("not"), item: compilerRulePredicateSchema }).strict(),
  ]),
);
const compilerWorldRuleSchema = worldRuleSchema.extend({
  appliesWhen: z.array(compilerRulePredicateSchema),
  forbids: z.array(compilerRulePredicateSchema).optional(),
  requires: z.array(compilerRulePredicateSchema).optional(),
});
const compilerCanonicalEventSchema = canonicalEventSchema.extend({
  observedOutcome: stateDeltaSchema.extend({
    operations: z.array(stateOperationSchema).max(16, "A single atomic canonical event may contain at most 16 typed world-state effects."),
  }),
});
const compilerClaimSchema = claimSchema.extend({ evidence: evidenceRefSchema.array().min(1) }).superRefine((claim, ctx) => {
  if (isMetaKnowledgePredicate(claim.predicate)) {
    ctx.addIssue({
      code: "custom",
      path: ["predicate"],
      message: "Character knowledge must use KnowledgeDelta over a base-world claim; ignorance is the absence of that learned claim, not a knows/does-not-know meta-claim.",
    });
  }
});
const compilerPropositionSchema = propositionSchema.safeExtend({ evidence: evidenceRefSchema.array().min(1) }).superRefine((proposition, ctx) => {
  if (isMetaKnowledgePredicate(proposition.relationId)) {
    ctx.addIssue({
      code: "custom",
      path: ["relationId"],
      message: "Epistemic attitudes belong in Attribution; a Proposition must describe only the attributed content.",
    });
  }
});
const compilerAttributionSchema = attributionSchema.safeExtend({ evidence: evidenceRefSchema.array().min(1) });
const compilerEventParticipationSchema = eventParticipationSchema.safeExtend({ evidence: evidenceRefSchema.array().min(1) });
const compilerEventRelationSchema = eventRelationSchema.safeExtend({ evidence: evidenceRefSchema.array().min(1) });
const compilerPossibilitySchema = possibilityTemplateSchema.safeExtend({ evidence: evidenceRefSchema.array().min(1) }).superRefine((possibility, ctx) => {
  validateParticipantPresence(possibility, ctx);
  if (possibility.kind === "player-choice" && !hasExecutablePossibilityEffect(possibility)) {
    ctx.addIssue({
      code: "custom",
      path: ["proposedDelta"],
      message: "A player-choice must contain a concrete state or knowledge effect so it can diverge from canon.",
    });
  }
});
export type CompilerProposalKind = "entity" | "proposition" | "attribution" | "claim" | "canonical-event" | "event-participation" | "event-relation" | "world-rule" | "initial-world" | "character-goal" | "character-model" | "state-delta" | "possibility";
export const COMPILER_STATE_FIELDS = DEFAULT_STATE_FIELDS.map((field) => field.key);
const compilerStateFieldMap = new Map(DEFAULT_STATE_FIELDS.map((field) => [field.key, field]));
const compilerStateFieldSet = new Set(COMPILER_STATE_FIELDS);
const stateFieldOperations = new Set(["set", "unset", "add-member", "remove-member", "adjust-number", "fact-equals", "fact-gte", "fact-lte", "fact-exists", "entity-in"]);

export const compilerProposalSchemas = {
  entity: entitySchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  proposition: compilerPropositionSchema,
  attribution: compilerAttributionSchema,
  claim: compilerClaimSchema,
  "canonical-event": compilerCanonicalEventSchema
    .extend({ evidence: evidenceRefSchema.array().min(1) })
    .superRefine(validateParticipantPresence),
  "event-participation": compilerEventParticipationSchema,
  "event-relation": compilerEventRelationSchema,
  "world-rule": compilerWorldRuleSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  "initial-world": initialWorldSchema,
  "character-goal": characterGoalSchema,
  "character-model": characterModelSchema,
  "state-delta": stateDeltaSchema,
  possibility: compilerPossibilitySchema,
} satisfies Record<CompilerProposalKind, z.ZodTypeAny>;

export function compilerProposalLogicalIdentity(kind: CompilerProposalKind, payload: unknown): string | undefined {
  if (kind === "initial-world") return "initial-world:singleton";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const logicalId = kind === "character-model" ? record.actorId : record.id;
  return typeof logicalId === "string" ? `${kind}:${logicalId}` : undefined;
}

/** Stable committed-artifact identity used by field-level evidence bindings. */
export function compilerProposalArtifactId(
  kind: CompilerProposalKind,
  payload: unknown,
  proposalId: string,
): string {
  if (kind === "initial-world") return "initial-world";
  if (kind === "state-delta") return idSchema.parse(proposalId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Compiler proposal ${proposalId} has no object payload identity.`);
  }
  const record = payload as Record<string, unknown>;
  return idSchema.parse(kind === "character-model" ? record.actorId : record.id);
}

export function compilerPayloadEvidence(payload: unknown): EvidenceRef[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as { evidence?: unknown; counterEvidence?: unknown };
  const nested = payload as Record<string, unknown>;
  const semanticChildren = [
    nested.developmentPhases,
    nested.dispositions,
    nested.appraisalEpisodes,
    nested.developmentEpisodes,
  ].flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
  return [record, ...semanticChildren].flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as { evidence?: unknown; counterEvidence?: unknown };
    return [item.evidence, item.counterEvidence].flatMap((evidence) =>
      evidence === undefined ? [] : evidenceRefSchema.array().parse(evidence));
  });
}

export class CompilerProposalService {
  readonly store: ProposalStore;
  constructor(workspaceRoot: string) { this.store = new ProposalStore(workspaceRoot); }
  async submit(kind: CompilerProposalKind, input: { proposalId: string; payload: unknown; evidence?: unknown; evidenceAssertions?: unknown; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string; compilerBatchId?: string } }): Promise<{ proposalId: string; kind: CompilerProposalKind }> {
    const schema = compilerProposalSchemas[kind];
    const payload = schema.parse(input.payload);
    if (kind !== "entity" && kind !== "claim" && kind !== "character-model") assertCompilerStateFields(payload);
    const evidence = input.evidence === undefined ? [] : evidenceRefSchema.array().parse(input.evidence);
    const evidenceAssertions = input.evidenceAssertions === undefined
      ? []
      : evidenceAssertionSchema.array().parse(input.evidenceAssertions);
    const payloadEvidence = compilerPayloadEvidence(payload);
    const legacySourceId = assertSingleEvidenceSource(
      [...payloadEvidence, ...evidence],
      `Compiler proposal ${input.proposalId}`,
    );
    const assertionSourceIds = evidenceAssertionSourceIds(evidenceAssertions);
    if (assertionSourceIds.length > 1) {
      throw new Error(`Compiler proposal ${input.proposalId} mixes exact evidence from multiple novel sources: ${assertionSourceIds.join(", ")}.`);
    }
    if (legacySourceId && assertionSourceIds[0] && legacySourceId !== assertionSourceIds[0]) {
      throw new Error(
        `Compiler proposal ${input.proposalId} has legacy evidence from ${legacySourceId} but exact evidence from ${assertionSourceIds[0]}.`,
      );
    }
    const artifactId = compilerProposalArtifactId(kind, payload, input.proposalId);
    const targetIssues = validateEvidenceAssertionTargets(kind, artifactId, payload, evidenceAssertions);
    const characterEvidenceIssues = kind === "character-model"
      ? validateCharacterOntologyEvidenceAssertions(characterModelSchema.parse(payload), evidenceAssertions)
      : [];
    if (targetIssues.length || characterEvidenceIssues.length) {
      throw new Error([...targetIssues, ...characterEvidenceIssues]
        .map((item) => `${item.code}${item.path ? ` at ${item.path}` : ""}: ${item.message}`).join("; "));
    }
    const proposal: ArtifactProposal<unknown> = {
      id: input.proposalId,
      kind,
      schemaVersion: evidenceAssertions.length ? 2 : 1,
      payload,
      evidence: evidence as EvidenceRef[],
      evidenceAssertions,
      generatedBy: input.generatedBy,
      createdAt: new Date().toISOString(),
    };
    await this.store.writePending(proposal, schema);
    return { proposalId: input.proposalId, kind };
  }
  async withdraw(proposalId: string): Promise<void> {
    await this.store.transition(proposalId, "pending", "rejected");
  }
}

export async function rejectPendingCompilerBatchProposals(
  workspaceRoot: string,
  compilerBatchId: string,
): Promise<string[]> {
  const store = new ProposalStore(workspaceRoot);
  const rejected: string[] = [];
  for (const summary of await store.list("pending")) {
    const envelope = await store.readEnvelope("pending", summary.id);
    const generatedBy = envelope.generatedBy;
    if (
      !generatedBy
      || typeof generatedBy !== "object"
      || Array.isArray(generatedBy)
      || (generatedBy as Record<string, unknown>).compilerBatchId !== compilerBatchId
    ) continue;
    await store.transition(summary.id, "pending", "rejected");
    rejected.push(summary.id);
  }
  const workspace = await WorkspaceStore.create(workspaceRoot);
  for (const source of await workspace.listSources()) {
    const titleProposal = source.pendingTitleProposal;
    if (titleProposal?.generatedBy.compilerBatchId !== compilerBatchId) continue;
    await workspace.withdrawSourceTitleProposal(source.id, titleProposal.proposalId);
    rejected.push(titleProposal.proposalId);
  }
  rejected.push(...await new SourceAnnotationStore(workspaceRoot).rejectBatch(compilerBatchId));
  rejected.push(...await new EntityResolutionStore(workspaceRoot).rejectBatch(compilerBatchId));
  rejected.push(...await new EventResolutionStore(workspaceRoot).rejectBatch(compilerBatchId));
  return rejected;
}

/**
 * Reject every pending compiler draft owned by one source preparation run.
 *
 * Reparse can add boundary-calibration batches after its initial batch list is
 * captured. Cleaning only that initial list leaves those dynamic drafts behind,
 * and prepared-cache activation correctly refuses to materialize a rollback
 * while any source proposal is pending. Evidence is the primary ownership
 * boundary; the host-issued compiler batch id also covers proposal kinds whose
 * payload does not carry evidence itself.
 */
export async function rejectPendingCompilerSourceProposals(
  workspaceRoot: string,
  sourceId: string,
): Promise<string[]> {
  idSchema.parse(sourceId);
  const store = new ProposalStore(workspaceRoot);
  const sourceEvidenceIds = new Set((await store.list("pending", sourceId)).map((summary) => summary.id));
  const rejected: string[] = [];
  for (const summary of await store.list("pending")) {
    const envelope = await store.readEnvelope("pending", summary.id);
    const generatedBy = envelope.generatedBy;
    const compilerBatchId = generatedBy && typeof generatedBy === "object" && !Array.isArray(generatedBy)
      ? (generatedBy as Record<string, unknown>).compilerBatchId
      : undefined;
    if (
      !sourceEvidenceIds.has(summary.id)
      && !(typeof compilerBatchId === "string" && compilerBatchBelongsToSource(compilerBatchId, sourceId))
    ) continue;
    await store.transition(summary.id, "pending", "rejected");
    rejected.push(summary.id);
  }
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const source = await workspace.getSource(sourceId);
  if (source?.pendingTitleProposal) {
    await workspace.withdrawSourceTitleProposal(sourceId, source.pendingTitleProposal.proposalId);
    rejected.push(source.pendingTitleProposal.proposalId);
  }
  rejected.push(...await new SourceAnnotationStore(workspaceRoot).rejectSource(sourceId));
  rejected.push(...await new EntityResolutionStore(workspaceRoot).rejectSource(sourceId));
  rejected.push(...await new EventResolutionStore(workspaceRoot).rejectSource(sourceId));
  return rejected;
}

function compilerBatchBelongsToSource(compilerBatchId: string, sourceId: string): boolean {
  return compilerBatchId.startsWith(`batch-${sourceId}-`)
    || compilerBatchId.startsWith(`boundary-${sourceId}-`)
    || compilerBatchId.startsWith(`structure-${sourceId}-`)
    || compilerBatchId.startsWith(`opening-batch-${sourceId}-`)
    || compilerBatchId.startsWith(`opening-boundary-${sourceId}-`)
    || compilerBatchId.startsWith(`opening-structure-${sourceId}-`);
}

type ProposalClosureCatalog = {
  entities: Set<string>;
  entityKinds: Map<string, string>;
  propositions: Set<string>;
  attributions: Set<string>;
  claims: Set<string>;
  events: Set<string>;
  rules: Set<string>;
  goals: Set<string>;
  possibilities: Set<string>;
};

type StagedProposal = {
  kind: CompilerProposalKind;
  payload: unknown;
  evidence: EvidenceRef[];
  evidenceAssertions: EvidenceAssertion[];
};

/**
 * Checks that every logical artifact referenced by this batch is supplied by
 * canonical data or by a pending proposal. This deliberately does not accept
 * proposals or mutate canonical truth; it only prevents an evidence batch from
 * being checkpointed while its proposal graph is incomplete.
 */
export async function validateCompilerProposalClosure(
  workspaceRoot: string,
  proposalIds: readonly string[],
  sourceId?: string,
): Promise<string[]> {
  if (!proposalIds.length) return [];
  const proposals = new ProposalStore(workspaceRoot);
  const canon = new CanonicalModelStore(workspaceRoot);
  const possibilities = new PossibilityTemplateStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  const evidenceVerifier = new EvidenceVerifier(workspaceRoot);
  const [canonicalEntities, canonicalPropositions, canonicalAttributions, canonicalClaims, canonicalEvents, canonicalEventParticipations, canonicalEventRelations, canonicalRules, canonicalGoals, canonicalPossibilities, pending] = await Promise.all([
    canon.listEntities(),
    canon.listPropositions(),
    canon.listAttributions(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listEventParticipations(),
    canon.listEventRelations(),
    canon.listRules(),
    actors.listGoals(),
    possibilities.list(),
    proposals.list("pending"),
  ]);
  const fromActiveSource = <T extends { id?: string; evidence?: readonly EvidenceRef[] }>(item: T) => {
    if (!sourceId) return true;
    const evidence = item.evidence ?? [];
    const matches = evidence.some((reference) => reference.span.sourceId === sourceId);
    if (matches) assertEvidenceExclusiveToSource(evidence, sourceId, `Proposal-closure artifact ${item.id ?? "unknown"}`);
    return matches;
  };
  const catalog: ProposalClosureCatalog = {
    entities: new Set(canonicalEntities.filter(fromActiveSource).map((item) => item.id)),
    entityKinds: new Map(canonicalEntities.filter(fromActiveSource).map((item) => [item.id, item.kind])),
    propositions: new Set(canonicalPropositions.filter(fromActiveSource).map((item) => item.id)),
    attributions: new Set(canonicalAttributions.filter(fromActiveSource).map((item) => item.id)),
    claims: new Set(canonicalClaims.filter(fromActiveSource).map((item) => item.id)),
    events: new Set(canonicalEvents.filter(fromActiveSource).map((item) => item.id)),
    rules: new Set(canonicalRules.filter(fromActiveSource).map((item) => item.id)),
    goals: new Set(canonicalGoals.filter(fromActiveSource).map((item) => item.id)),
    possibilities: new Set(canonicalPossibilities.filter(fromActiveSource).map((item) => item.id)),
  };
  const staged = new Map<string, StagedProposal>();
  const proposalsByLogicalIdentity = new Map<string, string[]>();
  const activePendingIds = sourceId
    ? new Set((await proposals.list("pending", sourceId)).map((summary) => summary.id))
    : undefined;
  for (const summary of pending) {
    if (activePendingIds && !activePendingIds.has(summary.id)) continue;
    if (!isCompilerProposalKind(summary.kind)) continue;
    const envelope = await proposals.readEnvelope("pending", summary.id);
    const payload = compilerProposalSchemas[summary.kind].parse(envelope.payload);
    staged.set(summary.id, {
      kind: summary.kind,
      payload,
      evidence: evidenceRefSchema.array().parse(envelope.evidence),
      evidenceAssertions: evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []),
    });
    const logicalIdentity = compilerProposalLogicalIdentity(summary.kind, payload);
    if (logicalIdentity) proposalsByLogicalIdentity.set(logicalIdentity, [...(proposalsByLogicalIdentity.get(logicalIdentity) ?? []), summary.id]);
    if (summary.kind === "entity") {
      const entity = payload as { id: string; kind: string };
      catalog.entities.add(entity.id);
      catalog.entityKinds.set(entity.id, entity.kind);
    }
    if (summary.kind === "proposition") catalog.propositions.add((payload as { id: string }).id);
    if (summary.kind === "attribution") catalog.attributions.add((payload as { id: string }).id);
    if (summary.kind === "claim") catalog.claims.add((payload as { id: string }).id);
    if (summary.kind === "canonical-event") catalog.events.add((payload as { id: string }).id);
    if (summary.kind === "world-rule") catalog.rules.add((payload as { id: string }).id);
    if (summary.kind === "character-goal") catalog.goals.add((payload as { id: string }).id);
    if (summary.kind === "possibility") catalog.possibilities.add((payload as { id: string }).id);
  }

  const semanticCatalog = {
    claims: new Map(canonicalClaims.filter(fromActiveSource).map((claim) => [claim.id, claim])),
    propositions: new Map(canonicalPropositions.filter(fromActiveSource).map((proposition) => [proposition.id, proposition])),
    attributions: new Map(canonicalAttributions.filter(fromActiveSource).map((attribution) => [attribution.id, attribution])),
  };
  const participationCatalog = {
    entities: new Map(canonicalEntities.filter(fromActiveSource).map((entity) => [entity.id, entity])),
    events: new Map(canonicalEvents.filter(fromActiveSource).map((event) => [event.id, event])),
    participations: new Map(canonicalEventParticipations.filter(fromActiveSource).map((item) => [item.id, item])),
  };
  const relationCatalog = {
    events: new Map(canonicalEvents.filter(fromActiveSource).map((event) => [event.id, event])),
    relations: new Map(canonicalEventRelations.filter(fromActiveSource).map((item) => [item.id, item])),
    requireCompleteCausalProjectionForEventIds: new Set<string>(),
  };
  const characterOntologyCatalog = {
    entities: new Map(canonicalEntities.filter(fromActiveSource).map((entity) => [entity.id, { kind: entity.kind }])),
    propositions: new Set(canonicalPropositions.filter(fromActiveSource).map((proposition) => proposition.id)),
    claims: new Set(canonicalClaims.filter(fromActiveSource).map((claim) => claim.id)),
    events: new Map(canonicalEvents.filter(fromActiveSource).map((event) => [event.id, {
      participants: event.participants,
      participantPresence: event.participantPresence,
    }])),
    goals: new Map(canonicalGoals.filter(fromActiveSource).map((goal) => [goal.id, { actorId: goal.actorId }])),
  };
  for (const proposal of staged.values()) {
    if (proposal.kind === "entity") {
      const value = entitySchema.parse(proposal.payload);
      participationCatalog.entities.set(value.id, value);
      characterOntologyCatalog.entities.set(value.id, { kind: value.kind });
    } else if (proposal.kind === "canonical-event") {
      const value = canonicalEventSchema.parse(proposal.payload);
      participationCatalog.events.set(value.id, value);
      characterOntologyCatalog.events.set(value.id, {
        participants: value.participants,
        participantPresence: value.participantPresence,
      });
    } else if (proposal.kind === "event-participation") {
      const value = eventParticipationSchema.parse(proposal.payload);
      participationCatalog.participations.set(value.id, value);
    } else if (proposal.kind === "event-relation") {
      const value = eventRelationSchema.parse(proposal.payload);
      relationCatalog.relations.set(value.id, value);
    } else if (proposal.kind === "claim") {
      const value = claimSchema.parse(proposal.payload);
      semanticCatalog.claims.set(value.id, value);
      characterOntologyCatalog.claims.add(value.id);
    } else if (proposal.kind === "proposition") {
      const value = propositionSchema.parse(proposal.payload);
      semanticCatalog.propositions.set(value.id, value);
      characterOntologyCatalog.propositions.add(value.id);
    } else if (proposal.kind === "attribution") {
      const value = attributionSchema.parse(proposal.payload);
      semanticCatalog.attributions.set(value.id, value);
    } else if (proposal.kind === "character-goal") {
      const value = characterGoalSchema.parse(proposal.payload);
      characterOntologyCatalog.goals.set(value.id, { actorId: value.actorId });
    }
    if (proposal.kind === "canonical-event") {
      const event = canonicalEventSchema.parse(proposal.payload);
      relationCatalog.events.set(event.id, event);
      relationCatalog.requireCompleteCausalProjectionForEventIds.add(event.id);
    }
  }

  const issues = new Set<string>();
  for (const proposalId of proposalIds) {
    const proposal = staged.get(proposalId);
    if (!proposal) {
      issues.add(`${proposalId}: pending proposal is missing`);
      continue;
    }
    const logicalIdentity = compilerProposalLogicalIdentity(proposal.kind, proposal.payload);
    const duplicates = logicalIdentity ? proposalsByLogicalIdentity.get(logicalIdentity) ?? [] : [];
    if (duplicates.length > 1) {
      issues.add(`${proposalId}: logical artifact '${logicalIdentity}' also has active proposal(s) ${duplicates.filter((id) => id !== proposalId).join(", ")}`);
    }
    const payloadEvidence = compilerPayloadEvidence(proposal.payload);
    if (sourceId) {
      const proposalSourceIds = evidenceSourceIds([...payloadEvidence, ...proposal.evidence]);
      const exactSourceIds = evidenceAssertionSourceIds(proposal.evidenceAssertions);
      const allSourceIds = [...new Set([...proposalSourceIds, ...exactSourceIds])].sort();
      if (allSourceIds.length !== 1 || allSourceIds[0] !== sourceId) {
        issues.add(`${proposalId}: evidence must belong exclusively to active source '${sourceId}', found ${allSourceIds.join(", ") || "none"}`);
      }
    }
    const inspected = await evidenceVerifier.inspectAll([...payloadEvidence, ...proposal.evidence]);
    for (const evidenceIssue of inspected.issues) {
      issues.add(`${proposalId}: ${formatGroundingIssue(evidenceIssue)}`);
    }
    const artifactId = compilerProposalArtifactId(proposal.kind, proposal.payload, proposalId);
    for (const targetIssue of validateEvidenceAssertionTargets(
      proposal.kind,
      artifactId,
      proposal.payload,
      proposal.evidenceAssertions,
    )) {
      issues.add(`${proposalId}: ${formatGroundingIssue(targetIssue)}`);
    }
    const exactInspection = await evidenceVerifier.inspectAssertions(proposal.evidenceAssertions);
    for (const evidenceIssue of exactInspection.issues) {
      issues.add(`${proposalId}: ${formatGroundingIssue(evidenceIssue)}`);
    }
    if (proposal.kind === "entity" && inspected.valid) {
      for (const nameIssue of validateEntityNameEvidence(entitySchema.parse(proposal.payload), inspected.excerpts)) {
        issues.add(`${proposalId}: ${formatGroundingIssue(nameIssue)}`);
      }
    }
    collectProposalClosureIssues(proposalId, proposal, catalog, issues);
    for (const located of findKnowledgeDeltas(proposal.payload)) {
      for (let index = 0; index < located.delta.operations.length; index += 1) {
        const operationPath = `${located.path || "payload"}.operations.${index}`;
        for (const semanticIssue of validateKnowledgeSemanticReferences(
          located.delta.operations[index]!,
          semanticCatalog,
          operationPath,
        )) {
          issues.add(`${proposalId}: ${semanticIssue.code} at ${semanticIssue.path ?? operationPath}: ${semanticIssue.message}`);
        }
      }
    }
  }
  collectSemanticDependencyCycles(staged, new Set(proposalIds), "proposition", issues);
  collectSemanticDependencyCycles(staged, new Set(proposalIds), "attribution", issues);
  collectEventDependencyCycles(staged, new Set(proposalIds), issues);
  for (const participationIssue of validateEventParticipationCatalog({
    entities: participationCatalog.entities,
    events: participationCatalog.events,
    participations: participationCatalog.participations.values(),
  })) {
    issues.add(`event-participation: ${participationIssue.code} at ${participationIssue.path ?? "payload"}: ${participationIssue.message}`);
  }
  for (const relationIssue of validateEventRelationCatalog({
    events: relationCatalog.events,
    relations: relationCatalog.relations.values(),
    requireCompleteCausalProjectionForEventIds: relationCatalog.requireCompleteCausalProjectionForEventIds,
  })) {
    issues.add(`event-relation: ${relationIssue.code} at ${relationIssue.path ?? "payload"}: ${relationIssue.message}`);
  }
  for (const [proposalId, proposal] of staged) {
    if (proposal.kind !== "character-model") continue;
    const model = characterModelSchema.parse(proposal.payload);
    for (const ontologyIssue of [
      ...validateCharacterOntologyReferences(model, characterOntologyCatalog),
      ...validateCharacterOntologyEvidenceAssertions(model, proposal.evidenceAssertions),
      ...validateRelationshipOntologyReferences(model, characterOntologyCatalog),
      ...validateRelationshipOntologyEvidenceAssertions(model, proposal.evidenceAssertions),
    ]) {
      issues.add(`${proposalId}: ${ontologyIssue.code} at ${ontologyIssue.path ?? "payload"}: ${ontologyIssue.message}`);
    }
  }
  return [...issues].sort();
}

function formatGroundingIssue(issue: { code: string; message: string; path?: string }): string {
  return `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`;
}

function collectProposalClosureIssues(
  proposalId: string,
  proposal: StagedProposal,
  catalog: ProposalClosureCatalog,
  issues: Set<string>,
): void {
  const missing = (kind: Exclude<keyof ProposalClosureCatalog, "entityKinds">, id: string, path: string) => {
    if (!catalog[kind].has(id)) issues.add(`${proposalId}: ${path} references unknown ${singular(kind)} '${id}'`);
  };
  const character = (entityId: string, path: string) => {
    missing("entities", entityId, path);
    const kind = catalog.entityKinds.get(entityId);
    if (kind && kind !== "character") {
      issues.add(`${proposalId}: ${path} references '${entityId}' of kind '${kind}', but participant presence is character-only`);
    }
  };
  const presence = (
    participants: readonly string[] | undefined,
    entries: readonly ParticipantPresence[] | undefined,
    path: string,
    requireEveryCharacterParticipant: boolean,
  ) => {
    const participantIds = participants ? new Set(participants) : undefined;
    const seen = new Set<string>();
    for (let index = 0; index < (entries?.length ?? 0); index += 1) {
      const entry = entries![index]!;
      const entryPath = `${path}.${index}.entityId`;
      character(entry.entityId, entryPath);
      if (participantIds && !participantIds.has(entry.entityId)) {
        issues.add(`${proposalId}: ${entryPath} references '${entry.entityId}', which is not a participant`);
      }
      if (seen.has(entry.entityId)) {
        issues.add(`${proposalId}: ${entryPath} duplicates participant presence for '${entry.entityId}'`);
      }
      seen.add(entry.entityId);
    }
    if (!participants || !requireEveryCharacterParticipant) return;
    for (let index = 0; index < participants.length; index += 1) {
      const participantId = participants[index]!;
      if (catalog.entityKinds.get(participantId) === "character" && !seen.has(participantId)) {
        issues.add(`${proposalId}: ${path} is missing character participant '${participantId}' from participants.${index}`);
      }
    }
  };
  const fieldReference = (entityId: string, field: string, path: string) => {
    const kind = catalog.entityKinds.get(entityId);
    const spec = DEFAULT_STATE_FIELDS.find((candidate) => candidate.key === field);
    if (kind && spec && !spec.appliesTo.includes(kind as never)) {
      issues.add(`${proposalId}: ${path} field '${field}' does not apply to entity '${entityId}' of kind '${kind}'`);
    }
  };
  const payload = proposal.payload;
  if (proposal.kind === "entity") return;
  if (proposal.kind === "proposition") {
    const proposition = payload as Proposition;
    missing("entities", proposition.subjectEntityId, "subjectEntityId");
    if (proposition.object.kind === "entity") missing("entities", proposition.object.entityId, "object.entityId");
    if (proposition.object.kind === "proposition") missing("propositions", proposition.object.propositionId, "object.propositionId");
    if (proposition.validStoryTime) collectStoryTimeIssues(proposition.validStoryTime, "validStoryTime", missing);
    return;
  }
  if (proposal.kind === "attribution") {
    const attribution = payload as Attribution;
    missing("propositions", attribution.propositionId, "propositionId");
    if (attribution.holderEntityId) missing("entities", attribution.holderEntityId, "holderEntityId");
    if (attribution.sourceAttributionId) missing("attributions", attribution.sourceAttributionId, "sourceAttributionId");
    return;
  }
  if (proposal.kind === "claim") {
    const claim = payload as Claim;
    missing("entities", claim.subject, "subject");
    if (claim.speaker) missing("entities", claim.speaker, "speaker");
    return;
  }
  if (proposal.kind === "canonical-event") {
    const event = payload as CanonicalEvent;
    event.participants.forEach((id, index) => missing("entities", id, `participants.${index}`));
    presence(event.participants, event.participantPresence, "participantPresence", true);
    event.causalParents.forEach((id, index) => missing("events", id, `causalParents.${index}`));
    collectStoryTimeIssues(event.storyTime, "storyTime", missing);
    event.preconditions.forEach((predicate, index) => collectPredicateIssues(predicate, `preconditions.${index}`, missing, fieldReference));
    collectStateDeltaIssues(event.observedOutcome, "observedOutcome", missing, fieldReference);
    if (event.observedKnowledge) collectKnowledgeDeltaIssues(event.observedKnowledge, "observedKnowledge", missing);
    for (let index = 0; index < (event.characterEntryCheckpoints?.length ?? 0); index += 1) {
      const checkpoint = event.characterEntryCheckpoints![index]!;
      const prefix = `characterEntryCheckpoints.${index}`;
      missing("entities", checkpoint.actorId, `${prefix}.actorId`);
      const actorKind = catalog.entityKinds.get(checkpoint.actorId);
      if (actorKind && actorKind !== "character") {
        issues.add(`${proposalId}: ${prefix}.actorId references '${checkpoint.actorId}' of kind '${actorKind}', but an entry actor must be a character`);
      }
      if (!event.participants.includes(checkpoint.actorId)) {
        issues.add(`${proposalId}: ${prefix}.actorId references '${checkpoint.actorId}', which is not an event participant`);
      }
      presence(event.participants, checkpoint.participantPresence, `${prefix}.participantPresence`, false);
      collectStateDeltaIssues(checkpoint.delta, `${prefix}.delta`, missing, fieldReference);
      if (checkpoint.knowledge) collectKnowledgeDeltaIssues(checkpoint.knowledge, `${prefix}.knowledge`, missing);
    }
    return;
  }
  if (proposal.kind === "event-participation") {
    const participation = payload as EventParticipation;
    missing("events", participation.eventId, "eventId");
    missing("entities", participation.entityId, "entityId");
    return;
  }
  if (proposal.kind === "event-relation") {
    const relation = payload as EventRelation;
    missing("events", relation.fromEventId, "fromEventId");
    missing("events", relation.toEventId, "toEventId");
    relation.requiredConditions?.forEach((predicate, index) =>
      collectPredicateIssues(predicate, `requiredConditions.${index}`, missing, fieldReference));
    return;
  }
  if (proposal.kind === "world-rule") {
    const rule = payload as WorldRule;
    [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])]
      .forEach((predicate, index) => collectPredicateIssues(predicate, `predicates.${index}`, missing, fieldReference));
    return;
  }
  if (proposal.kind === "initial-world") {
    const initial = payload as z.infer<typeof initialWorldSchema>;
    presence(undefined, initial.participantPresence, "participantPresence", false);
    collectStateDeltaIssues(initial.delta, "delta", missing, fieldReference);
    if (initial.knowledge) collectKnowledgeDeltaIssues(initial.knowledge, "knowledge", missing);
    if (initial.checkpoint?.beforeCanonicalEventId) missing("events", initial.checkpoint.beforeCanonicalEventId, "checkpoint.beforeCanonicalEventId");
    if (initial.checkpoint?.storyTime) collectStoryTimeIssues(initial.checkpoint.storyTime, "checkpoint.storyTime", missing);
    return;
  }
  if (proposal.kind === "character-goal") {
    const goal = payload as CharacterGoal;
    missing("entities", goal.actorId, "actorId");
    goal.requiresKnowledge.forEach((id, index) => missing("claims", id, `requiresKnowledge.${index}`));
    goal.blockedByKnowledge?.forEach((id, index) => missing("claims", id, `blockedByKnowledge.${index}`));
    goal.targetIds?.forEach((id, index) => missing("entities", id, `targetIds.${index}`));
    goal.activation?.preconditions.forEach((predicate, index) =>
      collectPredicateIssues(predicate, `activation.preconditions.${index}`, missing, fieldReference));
    goal.activation?.afterCanonicalEventIds.forEach((id, index) =>
      missing("events", id, `activation.afterCanonicalEventIds.${index}`));
    if (goal.activation?.storyWindow) collectStoryTimeIssues(goal.activation.storyWindow, "activation.storyWindow", missing);
    goal.completion?.forEach((predicate, index) =>
      collectPredicateIssues(predicate, `completion.${index}`, missing, fieldReference));
    goal.expiry?.forEach((predicate, index) =>
      collectPredicateIssues(predicate, `expiry.${index}`, missing, fieldReference));
    goal.milestones?.forEach((milestone, milestoneIndex) => milestone.conditions.forEach((predicate, index) =>
      collectPredicateIssues(predicate, `milestones.${milestoneIndex}.conditions.${index}`, missing, fieldReference)));
    const actions = [
      ...(goal.candidateAction ? [{ path: "candidateAction", value: goal.candidateAction }] : []),
      ...(goal.actionPatterns ?? []).map((value, index) => ({ path: `actionPatterns.${index}`, value })),
    ];
    for (const { path, value } of actions) {
      value.participants?.forEach((id, index) => missing("entities", id, `${path}.participants.${index}`));
      value.preconditions.forEach((predicate, index) => collectPredicateIssues(predicate, `${path}.preconditions.${index}`, missing, fieldReference));
      collectStateDeltaIssues(value.proposedDelta, `${path}.proposedDelta`, missing, fieldReference);
      if (value.proposedKnowledge) collectKnowledgeDeltaIssues(value.proposedKnowledge, `${path}.proposedKnowledge`, missing);
    }
    return;
  }
  if (proposal.kind === "character-model") {
    const model = payload as CharacterModel;
    missing("entities", model.actorId, "actorId");
    model.developmentPhases?.forEach((phase, phaseIndex) => {
      phase.activation.preconditions.forEach((predicate, index) =>
        collectPredicateIssues(predicate, `developmentPhases.${phaseIndex}.activation.preconditions.${index}`, missing, fieldReference));
      phase.activation.afterCanonicalEventIds.forEach((id, index) =>
        missing("events", id, `developmentPhases.${phaseIndex}.activation.afterCanonicalEventIds.${index}`));
      phase.activation.afterExperiencedCanonicalEventIds.forEach((id, index) =>
        missing("events", id, `developmentPhases.${phaseIndex}.activation.afterExperiencedCanonicalEventIds.${index}`));
      phase.activation.requiresKnowledge.forEach((id, index) =>
        missing("claims", id, `developmentPhases.${phaseIndex}.activation.requiresKnowledge.${index}`));
      if (phase.activation.storyWindow) {
        collectStoryTimeIssues(phase.activation.storyWindow, `developmentPhases.${phaseIndex}.activation.storyWindow`, missing);
      }
    });
    return;
  }
  if (proposal.kind === "state-delta") {
    collectStateDeltaIssues(payload as StateDelta, "stateDelta", missing, fieldReference);
    return;
  }
  const possibility = payload as PossibilityTemplate;
  possibility.participants.forEach((id, index) => missing("entities", id, `participants.${index}`));
  presence(possibility.participants, possibility.participantPresence, "participantPresence", true);
  possibility.causalParents.forEach((id, index) => {
    if (!catalog.events.has(id) && !catalog.possibilities.has(id)) {
      issues.add(`${proposalId}: causalParents.${index} references unknown event or possibility '${id}'`);
    }
  });
  if (possibility.canonicalEventId) missing("events", possibility.canonicalEventId, "canonicalEventId");
  if (possibility.candidateWindow) collectStoryTimeIssues(possibility.candidateWindow, "candidateWindow", missing);
  [...possibility.preconditions, ...possibility.blockers, ...(possibility.expiry ?? [])]
    .forEach((predicate, index) => collectPredicateIssues(predicate, `predicates.${index}`, missing, fieldReference));
  if (possibility.proposedDelta) collectStateDeltaIssues(possibility.proposedDelta, "proposedDelta", missing, fieldReference);
  if (possibility.proposedKnowledge) collectKnowledgeDeltaIssues(possibility.proposedKnowledge, "proposedKnowledge", missing);
  possibility.canonicalScaffold?.roles.forEach((role, roleIndex) => {
    missing("entities", role.canonicalEntityId, `canonicalScaffold.roles.${roleIndex}.canonicalEntityId`);
    const canonicalKind = catalog.entityKinds.get(role.canonicalEntityId);
    if (canonicalKind && !role.allowedEntityKinds.includes(canonicalKind as never)) {
      issues.add(`${proposalId}: canonicalScaffold.roles.${roleIndex}.allowedEntityKinds does not include canonical entity kind '${canonicalKind}'`);
    }
    role.requiredState.forEach((predicate, predicateIndex) =>
      collectPredicateIssues(
        predicate,
        `canonicalScaffold.roles.${roleIndex}.requiredState.${predicateIndex}`,
        missing,
        fieldReference,
      ));
    role.requiresKnowledge.forEach((claimId, claimIndex) =>
      missing("claims", claimId, `canonicalScaffold.roles.${roleIndex}.requiresKnowledge.${claimIndex}`));
  });
}

type MissingReference = (kind: Exclude<keyof ProposalClosureCatalog, "entityKinds">, id: string, path: string) => void;
type FieldReference = (entityId: string, field: string, path: string) => void;

function collectStoryTimeIssues(storyTime: StoryTime, path: string, missing: MissingReference): void {
  if (storyTime.kind === "relative") missing("events", storyTime.anchorEventId, `${path}.anchorEventId`);
}

function collectPredicateIssues(predicate: Predicate, path: string, missing: MissingReference, fieldReference: FieldReference): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => collectPredicateIssues(item, `${path}.items.${index}`, missing, fieldReference));
    return;
  }
  if (predicate.op === "not") {
    collectPredicateIssues(predicate.item, `${path}.item`, missing, fieldReference);
    return;
  }
  if (predicate.op === "rule-active") {
    missing("rules", predicate.ruleId, `${path}.ruleId`);
    return;
  }
  if (predicate.op === "after-step" || predicate.op === "before-step"
    || predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte") return;
  if (predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") {
    collectStoryTimeIssues(predicate.time, `${path}.time`, missing);
    return;
  }
  missing("entities", predicate.entityId, `${path}.entityId`);
  fieldReference(predicate.entityId, predicate.field, `${path}.field`);
  if (predicate.op === "entity-in") missing("entities", predicate.member, `${path}.member`);
  if (predicate.op === "fact-equals") collectStateValueReferences(predicate.field, predicate.value, `${path}.value`, missing);
}

function collectStateDeltaIssues(delta: StateDelta, path: string, missing: MissingReference, fieldReference: FieldReference): void {
  delta.operations.forEach((operation, index) => {
    const operationPath = `${path}.operations.${index}`;
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") {
      missing("rules", operation.ruleId, `${operationPath}.ruleId`);
      return;
    }
    missing("entities", operation.entityId, `${operationPath}.entityId`);
    fieldReference(operation.entityId, operation.field, `${operationPath}.field`);
    if (operation.op === "add-member" || operation.op === "remove-member") {
      missing("entities", operation.member, `${operationPath}.member`);
    }
    if (operation.op === "set") collectStateValueReferences(operation.field, operation.value, `${operationPath}.value`, missing);
  });
}

function collectStateValueReferences(field: string, value: unknown, path: string, missing: MissingReference): void {
  const spec = DEFAULT_STATE_FIELDS.find((candidate) => candidate.key === field);
  if (spec?.valueType === "entity-ref" && typeof value === "string") missing("entities", value, path);
  if (spec?.valueType === "entity-ref-set" && Array.isArray(value)) {
    value.forEach((id, index) => { if (typeof id === "string") missing("entities", id, `${path}.${index}`); });
  }
}

function collectKnowledgeDeltaIssues(delta: KnowledgeDelta, path: string, missing: MissingReference): void {
  delta.operations.forEach((operation, index) => {
    const operationPath = `${path}.operations.${index}`;
    missing("entities", operation.actorId, `${operationPath}.actorId`);
    missing("claims", operation.claimId, `${operationPath}.claimId`);
    if (operation.propositionId) missing("propositions", operation.propositionId, `${operationPath}.propositionId`);
    if (operation.op === "learn" && operation.attributionId) {
      missing("attributions", operation.attributionId, `${operationPath}.attributionId`);
    }
    if (operation.op === "learn" && operation.sourceActorId) missing("entities", operation.sourceActorId, `${operationPath}.sourceActorId`);
  });
}

function collectEventDependencyCycles(
  staged: ReadonlyMap<string, StagedProposal>,
  activeProposalIds: ReadonlySet<string>,
  issues: Set<string>,
): void {
  const events = new Map<string, { proposalId: string; event: CanonicalEvent }>();
  for (const [proposalId, proposal] of staged) {
    if (!activeProposalIds.has(proposalId) || proposal.kind !== "canonical-event") continue;
    const event = proposal.payload as CanonicalEvent;
    events.set(event.id, { proposalId, event });
  }
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (eventId: string) => {
    if (state.get(eventId) === "visited") return;
    if (state.get(eventId) === "visiting") {
      const cycleStart = stack.indexOf(eventId);
      for (const member of stack.slice(Math.max(0, cycleStart))) {
        const proposalId = events.get(member)?.proposalId;
        if (proposalId) issues.add(`${proposalId}: canonical-event dependency cycle includes '${member}'`);
      }
      return;
    }
    const candidate = events.get(eventId);
    if (!candidate) return;
    state.set(eventId, "visiting");
    stack.push(eventId);
    const dependencies = [
      ...candidate.event.causalParents,
      ...(candidate.event.storyTime.kind === "relative" ? [candidate.event.storyTime.anchorEventId] : []),
    ];
    dependencies.filter((dependency) => events.has(dependency)).forEach(visit);
    stack.pop();
    state.set(eventId, "visited");
  };
  [...events.keys()].sort().forEach(visit);
}

function collectSemanticDependencyCycles(
  staged: ReadonlyMap<string, StagedProposal>,
  activeProposalIds: ReadonlySet<string>,
  kind: "proposition" | "attribution",
  issues: Set<string>,
): void {
  const artifacts = new Map<string, { proposalId: string; dependencies: string[] }>();
  for (const [proposalId, proposal] of staged) {
    if (!activeProposalIds.has(proposalId) || proposal.kind !== kind) continue;
    if (kind === "proposition") {
      const value = proposal.payload as Proposition;
      artifacts.set(value.id, {
        proposalId,
        dependencies: value.object.kind === "proposition" ? [value.object.propositionId] : [],
      });
    } else {
      const value = proposal.payload as Attribution;
      artifacts.set(value.id, {
        proposalId,
        dependencies: value.sourceAttributionId ? [value.sourceAttributionId] : [],
      });
    }
  }
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      for (const member of stack.slice(Math.max(0, cycleStart))) {
        const proposalId = artifacts.get(member)?.proposalId;
        if (proposalId) issues.add(`${proposalId}: ${kind} dependency cycle includes '${member}'`);
      }
      return;
    }
    const artifact = artifacts.get(id);
    if (!artifact) return;
    state.set(id, "visiting");
    stack.push(id);
    artifact.dependencies.filter((dependency) => artifacts.has(dependency)).forEach(visit);
    stack.pop();
    state.set(id, "visited");
  };
  [...artifacts.keys()].sort().forEach(visit);
}

function isCompilerProposalKind(kind: string): kind is CompilerProposalKind {
  return Object.prototype.hasOwnProperty.call(compilerProposalSchemas, kind);
}

function singular(kind: Exclude<keyof ProposalClosureCatalog, "entityKinds">): string {
  if (kind === "entities") return "entity";
  if (kind === "possibilities") return "possibility";
  return kind.slice(0, -1);
}

function assertCompilerStateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCompilerStateFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.op === "string" && stateFieldOperations.has(record.op) && typeof record.field === "string" && !compilerStateFieldSet.has(record.field)) {
    throw new Error(`Unsupported compiler state field '${record.field}'. Allowed fields: ${COMPILER_STATE_FIELDS.join(", ")}.`);
  }
  if (typeof record.op === "string" && stateFieldOperations.has(record.op) && typeof record.field === "string") {
    const spec = compilerStateFieldMap.get(record.field);
    if (spec && (record.op === "set" || record.op === "fact-equals")) {
      assertCompilerStateValueShape(spec, record.value);
    }
    if (spec && (record.op === "adjust-number" || record.op === "fact-gte" || record.op === "fact-lte") && spec.valueType !== "number") {
      throw new Error(`${record.op} requires a numeric field; '${record.field}' is ${spec.valueType}.`);
    }
    if (spec && ["add-member", "remove-member", "entity-in"].includes(record.op) && spec.valueType !== "entity-ref-set") {
      throw new Error(`${record.op} requires an entity-ref-set field; '${record.field}' is ${spec.valueType}.`);
    }
  }
  for (const nested of Object.values(record)) assertCompilerStateFields(nested);
}

function assertCompilerStateValueShape(
  spec: (typeof DEFAULT_STATE_FIELDS)[number],
  value: unknown,
): void {
  if (value === null) {
    if (spec.required) throw new Error(`Required compiler state field cannot be null: ${spec.key}.`);
    return;
  }
  if (spec.cardinality === "many" && !Array.isArray(value)) {
    throw new Error(`Compiler state field '${spec.key}' requires an array value.`);
  }
  if (spec.cardinality === "one" && Array.isArray(value)) {
    throw new Error(`Compiler state field '${spec.key}' requires a scalar value.`);
  }
  if (spec.valueType === "boolean" && typeof value !== "boolean") {
    throw new Error(`Compiler state field '${spec.key}' requires a boolean value.`);
  }
  if (spec.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`Compiler state field '${spec.key}' requires a finite number value.`);
  }
  if (typeof value === "number" && spec.minimum !== undefined && value < spec.minimum) {
    throw new Error(`Compiler state field '${spec.key}' must be >= ${spec.minimum}.`);
  }
  if (typeof value === "number" && spec.maximum !== undefined && value > spec.maximum) {
    throw new Error(`Compiler state field '${spec.key}' must be <= ${spec.maximum}.`);
  }
  if (
    (spec.valueType === "string" || spec.valueType === "json-scalar")
    && typeof value !== "string"
    && typeof value !== "number"
    && typeof value !== "boolean"
  ) {
    throw new Error(`Compiler state field '${spec.key}' requires a scalar value.`);
  }
  if (spec.valueType === "entity-ref") assertCompilerEntityReferenceShape(spec.key, value);
  if (spec.valueType === "entity-ref-set") {
    if (!Array.isArray(value)) throw new Error(`Compiler state field '${spec.key}' requires an entity-reference array.`);
    value.forEach((item, index) => assertCompilerEntityReferenceShape(`${spec.key}[${index}]`, item));
  }
}

function assertCompilerEntityReferenceShape(field: string, value: unknown): void {
  if (typeof value !== "string" || !idSchema.safeParse(value).success) {
    throw new Error(`Compiler state field '${field}' contains invalid entity reference '${String(value)}'; entity references must be ASCII logical IDs.`);
  }
}
