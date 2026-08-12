import { z } from "zod";

export type ProjectId = string;
export type EntityId = string;
export type ClaimId = string;
export type CanonicalEventId = string;
export type RuleId = string;
export type BranchId = string;
export type ProposalId = string;
export type CommitId = string;
export type ObjectHash = string;

export const SAFE_LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const idSchema = z.string().regex(
  SAFE_LOGICAL_ID,
  "IDs must start with an ASCII letter or digit and contain only letters, digits, dot, underscore, or hyphen",
);

export const sourceSpanSchema = z
  .object({
    sourceId: idSchema,
    startByte: z.number().int().nonnegative().optional(),
    endByte: z.number().int().nonnegative().optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quoteHash: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endLine < value.startLine) ctx.addIssue({ code: "custom", message: "endLine must be >= startLine", path: ["endLine"] });
    if (value.startByte !== undefined && value.endByte !== undefined && value.endByte < value.startByte) {
      ctx.addIssue({ code: "custom", message: "endByte must be >= startByte", path: ["endByte"] });
    }
  });
export type SourceSpan = z.infer<typeof sourceSpanSchema>;

export const evidenceRefSchema = z.object({ span: sourceSpanSchema, strength: z.enum(["explicit", "strong-inference", "weak-inference"]) }).strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const entityKindSchema = z.enum(["character", "location", "faction", "artifact", "institution", "concept", "other"]);
export type EntityKind = z.infer<typeof entityKindSchema>;

export const entitySchema = z.object({ id: idSchema, kind: entityKindSchema, canonicalName: z.string().min(1), aliases: z.array(z.string()), evidence: z.array(evidenceRefSchema) }).strict();
export type Entity = z.infer<typeof entitySchema>;

export const claimSchema = z
  .object({
    id: idSchema,
    subject: idSchema,
    predicate: z.string().min(1),
    object: z.unknown(),
    epistemicType: z.enum(["explicit-fact", "narrator-claim", "character-claim", "rumor", "inference", "interpretation"]),
    speaker: idSchema.optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;

export const storyTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.string().min(1), precision: z.enum(["second", "minute", "hour", "day", "month", "year"]) }).strict(),
  z.object({ kind: z.literal("range"), earliest: z.string().min(1), latest: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("relative"), anchorEventId: idSchema, relation: z.enum(["before", "after", "during"]), offset: z.string().optional() }).strict(),
  z.object({ kind: z.literal("ordinal"), label: z.string().min(1), orderHint: z.number().optional() }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export type StoryTime = z.infer<typeof storyTimeSchema>;

export const logicalTimeSchema = z.object({ step: z.number().int().nonnegative(), storyTime: storyTimeSchema.optional() }).strict();
export type LogicalTime = z.infer<typeof logicalTimeSchema>;

export const valueTypeSchema = z.enum(["boolean", "number", "string", "entity-ref", "entity-ref-set", "json-scalar"]);
export type ValueType = z.infer<typeof valueTypeSchema>;

export const stateFieldSpecSchema = z.object({ key: z.string().min(1), appliesTo: z.array(entityKindSchema).min(1), valueType: valueTypeSchema, cardinality: z.enum(["one", "many"]), required: z.boolean().optional(), exclusive: z.boolean().optional() }).strict();
export type StateFieldSpec = z.infer<typeof stateFieldSpecSchema>;

export const stateValueSchema = z.union([z.boolean(), z.number(), z.string(), z.array(z.string()), z.null()]);
export type StateValue = z.infer<typeof stateValueSchema>;

export type Predicate =
  | { op: "fact-equals"; entityId: EntityId; field: string; value: StateValue }
  | { op: "fact-exists"; entityId: EntityId; field: string }
  | { op: "entity-in"; entityId: EntityId; field: string; member: EntityId }
  | { op: "rule-active"; ruleId: RuleId }
  | { op: "after-step"; step: number }
  | { op: "before-step"; step: number }
  | { op: "all"; items: Predicate[] }
  | { op: "any"; items: Predicate[] }
  | { op: "not"; item: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("fact-equals"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
    z.object({ op: z.literal("fact-exists"), entityId: idSchema, field: z.string().min(1) }).strict(),
    z.object({ op: z.literal("entity-in"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
    z.object({ op: z.literal("rule-active"), ruleId: idSchema }).strict(),
    z.object({ op: z.literal("after-step"), step: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal("before-step"), step: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal("all"), items: z.array(predicateSchema) }).strict(),
    z.object({ op: z.literal("any"), items: z.array(predicateSchema) }).strict(),
    z.object({ op: z.literal("not"), item: predicateSchema }).strict(),
  ]),
);

export const stateOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
  z.object({ op: z.literal("unset"), entityId: idSchema, field: z.string().min(1) }).strict(),
  z.object({ op: z.literal("add-member"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
  z.object({ op: z.literal("remove-member"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
  z.object({ op: z.literal("activate-rule"), ruleId: idSchema }).strict(),
  z.object({ op: z.literal("deactivate-rule"), ruleId: idSchema }).strict(),
]);
export type StateOperation = z.infer<typeof stateOperationSchema>;
export const stateDeltaSchema = z.object({ version: z.literal(1), operations: z.array(stateOperationSchema) }).strict();
export type StateDelta = z.infer<typeof stateDeltaSchema>;

export const knowledgeStatusSchema = z.enum(["knows", "believes", "suspects", "heard", "disbelieves"]);
export const knowledgeOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("learn"), actorId: idSchema, claimId: idSchema, status: knowledgeStatusSchema, confidence: z.number().min(0).max(1), sourceActorId: idSchema.optional() }).strict(),
  z.object({ op: z.literal("forget"), actorId: idSchema, claimId: idSchema }).strict(),
]);
export type KnowledgeOperation = z.infer<typeof knowledgeOperationSchema>;
export const knowledgeDeltaSchema = z.object({ version: z.literal(1), operations: z.array(knowledgeOperationSchema) }).strict();
export type KnowledgeDelta = z.infer<typeof knowledgeDeltaSchema>;

export const canonicalEventSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  participants: z.array(idSchema),
  storyTime: storyTimeSchema,
  preconditions: z.array(predicateSchema),
  observedOutcome: stateDeltaSchema,
  observedKnowledge: knowledgeDeltaSchema.optional(),
  evidence: z.array(evidenceRefSchema),
  causalParents: z.array(idSchema),
  confidence: z.number().min(0).max(1),
}).strict();
export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export const worldRuleSchema = z.object({ id: idSchema, name: z.string().min(1), scope: z.enum(["global", "entity", "location", "faction", "institution"]), appliesWhen: z.array(predicateSchema), forbids: z.array(predicateSchema).optional(), requires: z.array(predicateSchema).optional(), evidence: z.array(evidenceRefSchema) }).strict();
export type WorldRule = z.infer<typeof worldRuleSchema>;

export const eventProposalSchema = z
  .object({
    proposalId: idSchema,
    branchId: idSchema,
    expectedParentCommit: idSchema,
    source: z.enum(["player", "actor", "background", "canon-candidate", "compiler"]),
    actorId: idSchema.optional(),
    title: z.string().min(1),
    participants: z.array(idSchema),
    proposedTime: storyTimeSchema,
    preconditions: z.array(predicateSchema),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    causalParents: z.array(idSchema),
    supersedesCanonicalEventIds: z.array(idSchema).optional(),
    evidence: z.array(evidenceRefSchema),
    possibilityId: idSchema.optional(),
  })
  .strict();
export type EventProposal = z.infer<typeof eventProposalSchema>;

export const committedEventSchema = z
  .object({
    version: z.literal(1),
    eventId: idSchema,
    branchId: idSchema,
    logicalTime: logicalTimeSchema,
    proposalId: idSchema.optional(),
    title: z.string().min(1),
    participants: z.array(idSchema),
    deltaHash: idSchema,
    knowledgeDeltaHash: idSchema.optional(),
    evidence: z.array(evidenceRefSchema),
    causalParents: z.array(idSchema),
    supersedesCanonicalEventIds: z.array(idSchema).optional(),
    possibilityId: idSchema.optional(),
  })
  .strict();
export type CommittedEvent = z.infer<typeof committedEventSchema>;

export const branchSchema = z.object({ id: idSchema, name: z.string().min(1), parentBranchId: idSchema.optional(), forkCommitId: idSchema.optional(), headCommitId: idSchema }).strict();
export type Branch = z.infer<typeof branchSchema>;
export const worldCommitSchema = z.object({ version: z.literal(1), parentCommitId: idSchema.optional(), branchId: idSchema, logicalTime: logicalTimeSchema, eventHashes: z.array(idSchema), canonicalSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), engineVersion: z.string().min(1), schemaVersion: z.number().int().positive() }).strict();
export type WorldCommit = z.infer<typeof worldCommitSchema>;
export const worldStateSchema = z.object({ atCommit: idSchema, logicalTime: logicalTimeSchema, values: z.record(z.string(), z.record(z.string(), stateValueSchema)), activeRuleIds: z.array(idSchema) }).strict();
export type WorldState = z.infer<typeof worldStateSchema>;

export const possibilitySchema = z
  .object({
    id: idSchema,
    branchId: idSchema,
    evaluatedAtCommit: idSchema,
    kind: z.enum(["canon-analogue", "player-choice", "actor-plan", "obligation", "causal-consequence", "background-pressure", "environmental", "generated"]),
    title: z.string().min(1),
    candidateWindow: storyTimeSchema.optional(),
    preconditions: z.array(predicateSchema),
    blockers: z.array(predicateSchema),
    expiry: z.array(predicateSchema).optional(),
    participants: z.array(idSchema),
    causalParents: z.array(idSchema),
    canonicalEventId: idSchema.optional(),
    pressure: z.number().min(0),
    relevance: z.number().min(0),
    proposedDelta: stateDeltaSchema.optional(),
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();
export type Possibility = z.infer<typeof possibilitySchema>;

export const knowledgeFactSchema = z.object({ actorId: idSchema, claimId: idSchema, status: knowledgeStatusSchema, confidence: z.number().min(0).max(1), acquiredAtCommit: idSchema, sourceActorId: idSchema.optional() }).strict();
export type KnowledgeFact = z.infer<typeof knowledgeFactSchema>;

export const validationIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), path: z.string().optional() }).strict();
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export const validationReportSchema = z.object({ proposalId: idSchema, evaluatedAtCommit: idSchema, accepted: z.boolean(), errors: z.array(validationIssueSchema), warnings: z.array(validationIssueSchema), derivedDeltaHash: idSchema.optional() }).strict();
export type ValidationReport = z.infer<typeof validationReportSchema>;

export const artifactProposalSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ id: idSchema, kind: z.string().min(1), schemaVersion: z.number().int().positive(), payload, evidence: z.array(evidenceRefSchema), generatedBy: z.object({ worker: z.string().min(1), provider: z.string().optional(), model: z.string().optional(), promptHash: z.string().optional() }).strict(), createdAt: z.string().min(1) }).strict();

export type ArtifactProposal<T> = { id: ProposalId; kind: string; schemaVersion: number; payload: T; evidence: EvidenceRef[]; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string }; createdAt: string };

export const WORLD_SCHEMA_VERSION = 1;
export const WORLD_ENGINE_VERSION = "0.1.0";
