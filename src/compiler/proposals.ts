import { z } from "zod";
import { characterGoalSchema, characterModelSchema, type CharacterGoal, type CharacterModel } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { initialWorldSchema } from "../world/initial.js";
import {
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  evidenceRefSchema,
  idSchema,
  possibilitySchema,
  stateDeltaSchema,
  stateOperationSchema,
  stateValueSchema,
  storyTimeSchema,
  worldRuleSchema,
  type ArtifactProposal,
  type CanonicalEvent,
  type Claim,
  type EvidenceRef,
  type KnowledgeDelta,
  type Predicate,
  type StateDelta,
  type StoryTime,
  type WorldRule,
} from "../world/model.js";
import { PossibilityTemplateStore, type PossibilityTemplate } from "../world/possibility-model.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { assertEvidenceExclusiveToSource, assertSingleEvidenceSource, evidenceSourceIds } from "../world/source-scope.js";
import { hasExecutablePossibilityEffect, isMetaKnowledgePredicate } from "./semantics.js";
import { EvidenceVerifier, validateEntityNameEvidence } from "./evidence.js";

const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
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
const compilerPossibilitySchema = possibilityTemplateSchema.extend({ evidence: evidenceRefSchema.array().min(1) }).superRefine((possibility, ctx) => {
  if (possibility.kind === "player-choice" && !hasExecutablePossibilityEffect(possibility)) {
    ctx.addIssue({
      code: "custom",
      path: ["proposedDelta"],
      message: "A player-choice must contain a concrete state or knowledge effect so it can diverge from canon.",
    });
  }
});
export type CompilerProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world" | "character-goal" | "character-model" | "state-delta" | "possibility";
export const COMPILER_STATE_FIELDS = DEFAULT_STATE_FIELDS.map((field) => field.key);
const compilerStateFieldMap = new Map(DEFAULT_STATE_FIELDS.map((field) => [field.key, field]));
const compilerStateFieldSet = new Set(COMPILER_STATE_FIELDS);
const stateFieldOperations = new Set(["set", "unset", "add-member", "remove-member", "adjust-number", "fact-equals", "fact-gte", "fact-lte", "fact-exists", "entity-in"]);

export const compilerProposalSchemas = {
  entity: entitySchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  claim: compilerClaimSchema,
  "canonical-event": compilerCanonicalEventSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
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

export class CompilerProposalService {
  readonly store: ProposalStore;
  constructor(workspaceRoot: string) { this.store = new ProposalStore(workspaceRoot); }
  async submit(kind: CompilerProposalKind, input: { proposalId: string; payload: unknown; evidence?: unknown; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string; compilerBatchId?: string } }): Promise<{ proposalId: string; kind: CompilerProposalKind }> {
    const schema = compilerProposalSchemas[kind];
    const payload = schema.parse(input.payload);
    if (kind !== "entity" && kind !== "claim" && kind !== "character-model") assertCompilerStateFields(payload);
    const evidence = input.evidence === undefined ? [] : evidenceRefSchema.array().parse(input.evidence);
    const payloadEvidence = payload && typeof payload === "object" && !Array.isArray(payload)
      && Array.isArray((payload as { evidence?: unknown }).evidence)
      ? evidenceRefSchema.array().parse((payload as { evidence: unknown[] }).evidence)
      : [];
    assertSingleEvidenceSource(
      [...payloadEvidence, ...evidence],
      `Compiler proposal ${input.proposalId}`,
    );
    const proposal: ArtifactProposal<unknown> = {
      id: input.proposalId,
      kind,
      schemaVersion: 1,
      payload,
      evidence: evidence as EvidenceRef[],
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
  return rejected;
}

type ProposalClosureCatalog = {
  entities: Set<string>;
  entityKinds: Map<string, string>;
  claims: Set<string>;
  events: Set<string>;
  rules: Set<string>;
  possibilities: Set<string>;
};

type StagedProposal = { kind: CompilerProposalKind; payload: unknown; evidence: EvidenceRef[] };

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
  const evidenceVerifier = new EvidenceVerifier(workspaceRoot);
  const [canonicalEntities, canonicalClaims, canonicalEvents, canonicalRules, canonicalPossibilities, pending] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
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
    claims: new Set(canonicalClaims.filter(fromActiveSource).map((item) => item.id)),
    events: new Set(canonicalEvents.filter(fromActiveSource).map((item) => item.id)),
    rules: new Set(canonicalRules.filter(fromActiveSource).map((item) => item.id)),
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
    });
    const logicalIdentity = compilerProposalLogicalIdentity(summary.kind, payload);
    if (logicalIdentity) proposalsByLogicalIdentity.set(logicalIdentity, [...(proposalsByLogicalIdentity.get(logicalIdentity) ?? []), summary.id]);
    if (summary.kind === "entity") {
      const entity = payload as { id: string; kind: string };
      catalog.entities.add(entity.id);
      catalog.entityKinds.set(entity.id, entity.kind);
    }
    if (summary.kind === "claim") catalog.claims.add((payload as { id: string }).id);
    if (summary.kind === "canonical-event") catalog.events.add((payload as { id: string }).id);
    if (summary.kind === "world-rule") catalog.rules.add((payload as { id: string }).id);
    if (summary.kind === "possibility") catalog.possibilities.add((payload as { id: string }).id);
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
    const payloadEvidence = (proposal.payload as { evidence?: EvidenceRef[] }).evidence ?? [];
    if (sourceId) {
      const proposalSourceIds = evidenceSourceIds([...payloadEvidence, ...proposal.evidence]);
      if (proposalSourceIds.length !== 1 || proposalSourceIds[0] !== sourceId) {
        issues.add(`${proposalId}: evidence must belong exclusively to active source '${sourceId}', found ${proposalSourceIds.join(", ") || "none"}`);
      }
    }
    const inspected = await evidenceVerifier.inspectAll([...payloadEvidence, ...proposal.evidence]);
    for (const evidenceIssue of inspected.issues) {
      issues.add(`${proposalId}: ${formatGroundingIssue(evidenceIssue)}`);
    }
    if (proposal.kind === "entity" && inspected.valid) {
      for (const nameIssue of validateEntityNameEvidence(entitySchema.parse(proposal.payload), inspected.excerpts)) {
        issues.add(`${proposalId}: ${formatGroundingIssue(nameIssue)}`);
      }
    }
    collectProposalClosureIssues(proposalId, proposal, catalog, issues);
  }
  collectEventDependencyCycles(staged, new Set(proposalIds), issues);
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
  const fieldReference = (entityId: string, field: string, path: string) => {
    const kind = catalog.entityKinds.get(entityId);
    const spec = DEFAULT_STATE_FIELDS.find((candidate) => candidate.key === field);
    if (kind && spec && !spec.appliesTo.includes(kind as never)) {
      issues.add(`${proposalId}: ${path} field '${field}' does not apply to entity '${entityId}' of kind '${kind}'`);
    }
  };
  const payload = proposal.payload;
  if (proposal.kind === "entity") return;
  if (proposal.kind === "claim") {
    const claim = payload as Claim;
    missing("entities", claim.subject, "subject");
    if (claim.speaker) missing("entities", claim.speaker, "speaker");
    return;
  }
  if (proposal.kind === "canonical-event") {
    const event = payload as CanonicalEvent;
    event.participants.forEach((id, index) => missing("entities", id, `participants.${index}`));
    event.causalParents.forEach((id, index) => missing("events", id, `causalParents.${index}`));
    collectStoryTimeIssues(event.storyTime, "storyTime", missing);
    event.preconditions.forEach((predicate, index) => collectPredicateIssues(predicate, `preconditions.${index}`, missing, fieldReference));
    collectStateDeltaIssues(event.observedOutcome, "observedOutcome", missing, fieldReference);
    if (event.observedKnowledge) collectKnowledgeDeltaIssues(event.observedKnowledge, "observedKnowledge", missing);
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
