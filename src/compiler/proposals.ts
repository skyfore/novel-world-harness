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
import { hasExecutablePossibilityEffect, isMetaKnowledgePredicate } from "./semantics.js";

const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
const compilerRulePredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("fact-equals"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
    z.object({ op: z.literal("fact-exists"), entityId: idSchema, field: z.string().min(1) }).strict(),
    z.object({ op: z.literal("entity-in"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
    z.object({ op: z.literal("rule-active"), ruleId: idSchema }).strict(),
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
    operations: z.array(stateOperationSchema).max(1, "Compiler canonical events must describe one world-state operation at a time."),
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
const compilerStateFieldSet = new Set(COMPILER_STATE_FIELDS);
const stateFieldOperations = new Set(["set", "unset", "add-member", "remove-member", "fact-equals", "fact-exists", "entity-in"]);

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

export class CompilerProposalService {
  readonly store: ProposalStore;
  constructor(workspaceRoot: string) { this.store = new ProposalStore(workspaceRoot); }
  async submit(kind: CompilerProposalKind, input: { proposalId: string; payload: unknown; evidence?: unknown; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string } }): Promise<{ proposalId: string; kind: CompilerProposalKind }> {
    const schema = compilerProposalSchemas[kind];
    const payload = schema.parse(input.payload);
    if (kind !== "entity" && kind !== "claim" && kind !== "character-model") assertCompilerStateFields(payload);
    const evidence = input.evidence === undefined ? [] : evidenceRefSchema.array().parse(input.evidence);
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
}

type ProposalClosureCatalog = {
  entities: Set<string>;
  claims: Set<string>;
  events: Set<string>;
  rules: Set<string>;
  possibilities: Set<string>;
};

type StagedProposal = { kind: CompilerProposalKind; payload: unknown };

/**
 * Checks that every logical artifact referenced by this batch is supplied by
 * canonical data or by a pending proposal. This deliberately does not accept
 * proposals or mutate canonical truth; it only prevents an evidence batch from
 * being checkpointed while its proposal graph is incomplete.
 */
export async function validateCompilerProposalClosure(workspaceRoot: string, proposalIds: readonly string[]): Promise<string[]> {
  if (!proposalIds.length) return [];
  const proposals = new ProposalStore(workspaceRoot);
  const canon = new CanonicalModelStore(workspaceRoot);
  const possibilities = new PossibilityTemplateStore(workspaceRoot);
  const [canonicalEntities, canonicalClaims, canonicalEvents, canonicalRules, canonicalPossibilities, pending] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    possibilities.list(),
    proposals.list("pending"),
  ]);
  const catalog: ProposalClosureCatalog = {
    entities: new Set(canonicalEntities.map((item) => item.id)),
    claims: new Set(canonicalClaims.map((item) => item.id)),
    events: new Set(canonicalEvents.map((item) => item.id)),
    rules: new Set(canonicalRules.map((item) => item.id)),
    possibilities: new Set(canonicalPossibilities.map((item) => item.id)),
  };
  const staged = new Map<string, StagedProposal>();
  for (const summary of pending) {
    if (!isCompilerProposalKind(summary.kind)) continue;
    const envelope = await proposals.readEnvelope("pending", summary.id);
    const payload = compilerProposalSchemas[summary.kind].parse(envelope.payload);
    staged.set(summary.id, { kind: summary.kind, payload });
    if (summary.kind === "entity") catalog.entities.add((payload as { id: string }).id);
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
    collectProposalClosureIssues(proposalId, proposal, catalog, issues);
  }
  return [...issues].sort();
}

function collectProposalClosureIssues(
  proposalId: string,
  proposal: StagedProposal,
  catalog: ProposalClosureCatalog,
  issues: Set<string>,
): void {
  const missing = (kind: keyof ProposalClosureCatalog, id: string, path: string) => {
    if (!catalog[kind].has(id)) issues.add(`${proposalId}: ${path} references unknown ${singular(kind)} '${id}'`);
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
    event.preconditions.forEach((predicate, index) => collectPredicateIssues(predicate, `preconditions.${index}`, missing));
    collectStateDeltaIssues(event.observedOutcome, "observedOutcome", missing);
    if (event.observedKnowledge) collectKnowledgeDeltaIssues(event.observedKnowledge, "observedKnowledge", missing);
    return;
  }
  if (proposal.kind === "world-rule") {
    const rule = payload as WorldRule;
    [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])]
      .forEach((predicate, index) => collectPredicateIssues(predicate, `predicates.${index}`, missing));
    return;
  }
  if (proposal.kind === "initial-world") {
    const initial = payload as z.infer<typeof initialWorldSchema>;
    collectStateDeltaIssues(initial.delta, "delta", missing);
    if (initial.knowledge) collectKnowledgeDeltaIssues(initial.knowledge, "knowledge", missing);
    return;
  }
  if (proposal.kind === "character-goal") {
    const goal = payload as CharacterGoal;
    missing("entities", goal.actorId, "actorId");
    goal.requiresKnowledge.forEach((id, index) => missing("claims", id, `requiresKnowledge.${index}`));
    goal.blockedByKnowledge?.forEach((id, index) => missing("claims", id, `blockedByKnowledge.${index}`));
    const action = goal.candidateAction;
    action?.participants?.forEach((id, index) => missing("entities", id, `candidateAction.participants.${index}`));
    action?.preconditions.forEach((predicate, index) => collectPredicateIssues(predicate, `candidateAction.preconditions.${index}`, missing));
    if (action) collectStateDeltaIssues(action.proposedDelta, "candidateAction.proposedDelta", missing);
    if (action?.proposedKnowledge) collectKnowledgeDeltaIssues(action.proposedKnowledge, "candidateAction.proposedKnowledge", missing);
    return;
  }
  if (proposal.kind === "character-model") {
    missing("entities", (payload as CharacterModel).actorId, "actorId");
    return;
  }
  if (proposal.kind === "state-delta") {
    collectStateDeltaIssues(payload as StateDelta, "stateDelta", missing);
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
    .forEach((predicate, index) => collectPredicateIssues(predicate, `predicates.${index}`, missing));
  if (possibility.proposedDelta) collectStateDeltaIssues(possibility.proposedDelta, "proposedDelta", missing);
  if (possibility.proposedKnowledge) collectKnowledgeDeltaIssues(possibility.proposedKnowledge, "proposedKnowledge", missing);
}

type MissingReference = (kind: keyof ProposalClosureCatalog, id: string, path: string) => void;

function collectStoryTimeIssues(storyTime: StoryTime, path: string, missing: MissingReference): void {
  if (storyTime.kind === "relative") missing("events", storyTime.anchorEventId, `${path}.anchorEventId`);
}

function collectPredicateIssues(predicate: Predicate, path: string, missing: MissingReference): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => collectPredicateIssues(item, `${path}.items.${index}`, missing));
    return;
  }
  if (predicate.op === "not") {
    collectPredicateIssues(predicate.item, `${path}.item`, missing);
    return;
  }
  if (predicate.op === "rule-active") {
    missing("rules", predicate.ruleId, `${path}.ruleId`);
    return;
  }
  if (predicate.op === "after-step" || predicate.op === "before-step") return;
  missing("entities", predicate.entityId, `${path}.entityId`);
  if (predicate.op === "entity-in") missing("entities", predicate.member, `${path}.member`);
  if (predicate.op === "fact-equals") collectStateValueReferences(predicate.field, predicate.value, `${path}.value`, missing);
}

function collectStateDeltaIssues(delta: StateDelta, path: string, missing: MissingReference): void {
  delta.operations.forEach((operation, index) => {
    const operationPath = `${path}.operations.${index}`;
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") {
      missing("rules", operation.ruleId, `${operationPath}.ruleId`);
      return;
    }
    missing("entities", operation.entityId, `${operationPath}.entityId`);
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

function isCompilerProposalKind(kind: string): kind is CompilerProposalKind {
  return Object.prototype.hasOwnProperty.call(compilerProposalSchemas, kind);
}

function singular(kind: keyof ProposalClosureCatalog): string {
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
  for (const nested of Object.values(record)) assertCompilerStateFields(nested);
}
