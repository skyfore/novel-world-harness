import { z } from "zod";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore } from "../world/canonical-model.js";

const edgeSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();

const byteSpanSchema = z
  .object({
    sourceId: z.string().min(1),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
  })
  .strict()
  .refine((span) => span.endByte > span.startByte, {
    message: "endByte must be greater than startByte",
    path: ["endByte"],
  });

const semanticMentionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["entity", "event", "time", "place", "quotation"]),
    span: byteSpanSchema,
    type: z.string().min(1).optional(),
  })
  .strict();

const entityClusterSchema = z
  .object({
    id: z.string().min(1),
    mentionIds: z.array(z.string().min(1)).min(1),
    canonicalEntityId: z.string().min(1).optional(),
  })
  .strict();

const eventClusterSchema = z
  .object({
    id: z.string().min(1),
    mentionIds: z.array(z.string().min(1)).min(1),
    canonicalEventId: z.string().min(1).optional(),
  })
  .strict();

const quotationSchema = z
  .object({
    id: z.string().min(1),
    span: byteSpanSchema,
    speakerEntityClusterId: z.string().min(1).optional(),
    addresseeEntityClusterIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

const eventParticipantSchema = z
  .object({
    id: z.string().min(1),
    eventClusterId: z.string().min(1),
    entityClusterId: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();

const eventRelationSchema = z
  .object({
    id: z.string().min(1),
    fromEventClusterId: z.string().min(1),
    toEventClusterId: z.string().min(1),
    type: z.enum([
      "coreference",
      "subevent",
      "before",
      "after",
      "during",
      "overlaps",
      "causes",
      "enables",
      "prevents",
      "motivates",
      "explains",
      "narrative-continuation",
    ]),
    evidenceSpans: z.array(byteSpanSchema).default([]),
  })
  .strict();

const propositionSchema = z
  .object({
    id: z.string().min(1),
    subjectEntityClusterId: z.string().min(1),
    predicate: z.string().min(1),
    polarity: z.enum(["positive", "negative"]),
    modality: z.enum(["asserted", "possible", "necessary", "counterfactual"]),
    holderEntityClusterId: z.string().min(1).optional(),
    evidenceSpans: z.array(byteSpanSchema).min(1),
  })
  .strict();

const knowledgeSchema = z
  .object({
    id: z.string().min(1),
    actorEntityClusterId: z.string().min(1),
    propositionId: z.string().min(1),
    status: z.enum(["knows", "believes", "suspects", "heard", "disbelieves"]),
    acquisition: z.enum(["observed", "told", "read", "inferred", "remembered", "deceived"]),
  })
  .strict();

const stateEffectSchema = z
  .object({
    id: z.string().min(1),
    eventClusterId: z.string().min(1),
    op: z.enum(["set", "unset", "add-member", "remove-member", "adjust-number", "activate-rule", "deactivate-rule"]),
    entityClusterId: z.string().min(1).optional(),
    field: z.string().min(1).optional(),
  })
  .strict();

const characterAssertionSchema = z
  .object({
    id: z.string().min(1),
    actorEntityClusterId: z.string().min(1),
    kind: z.enum(["disposition", "goal", "appraisal", "development"]),
    evidenceSpans: z.array(byteSpanSchema).min(1),
  })
  .strict();

const legacyCompilerGoldSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    expectedEntityIds: z.array(z.string().min(1)).default([]),
    expectedClaimIds: z.array(z.string().min(1)).default([]),
    expectedEventIds: z.array(z.string().min(1)).default([]),
    expectedCausalEdges: z.array(edgeSchema).default([]),
    expectedRuleIds: z.array(z.string().min(1)).default([]),
    expectedGoalIds: z.array(z.string().min(1)).default([]),
    expectedCharacterModelActorIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const compilerSemanticGoldSchema = z
  .object({
    version: z.literal(2),
    name: z.string().min(1),
    canonical: z
      .object({
        expectedEntityIds: z.array(z.string().min(1)).default([]),
        expectedClaimIds: z.array(z.string().min(1)).default([]),
        expectedEventIds: z.array(z.string().min(1)).default([]),
        expectedCausalEdges: z.array(edgeSchema).default([]),
        expectedRuleIds: z.array(z.string().min(1)).default([]),
        expectedGoalIds: z.array(z.string().min(1)).default([]),
        expectedCharacterModelActorIds: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({
        expectedEntityIds: [],
        expectedClaimIds: [],
        expectedEventIds: [],
        expectedCausalEdges: [],
        expectedRuleIds: [],
        expectedGoalIds: [],
        expectedCharacterModelActorIds: [],
      }),
    semantic: z
      .object({
        mentions: z.array(semanticMentionSchema).default([]),
        entityClusters: z.array(entityClusterSchema).default([]),
        eventClusters: z.array(eventClusterSchema).default([]),
        quotations: z.array(quotationSchema).default([]),
        eventParticipants: z.array(eventParticipantSchema).default([]),
        eventRelations: z.array(eventRelationSchema).default([]),
        propositions: z.array(propositionSchema).default([]),
        knowledge: z.array(knowledgeSchema).default([]),
        stateEffects: z.array(stateEffectSchema).default([]),
        characterAssertions: z.array(characterAssertionSchema).default([]),
      })
      .strict()
      .default({
        mentions: [],
        entityClusters: [],
        eventClusters: [],
        quotations: [],
        eventParticipants: [],
        eventRelations: [],
        propositions: [],
        knowledge: [],
        stateEffects: [],
        characterAssertions: [],
      }),
  })
  .strict()
  .superRefine((gold, ctx) => {
    const mentionIds = uniqueIds(gold.semantic.mentions, "semantic.mentions", ctx);
    const entityClusterIds = uniqueIds(gold.semantic.entityClusters, "semantic.entityClusters", ctx);
    const eventClusterIds = uniqueIds(gold.semantic.eventClusters, "semantic.eventClusters", ctx);
    const propositionIds = uniqueIds(gold.semantic.propositions, "semantic.propositions", ctx);
    uniqueIds(gold.semantic.quotations, "semantic.quotations", ctx);
    uniqueIds(gold.semantic.eventParticipants, "semantic.eventParticipants", ctx);
    uniqueIds(gold.semantic.eventRelations, "semantic.eventRelations", ctx);
    uniqueIds(gold.semantic.knowledge, "semantic.knowledge", ctx);
    uniqueIds(gold.semantic.stateEffects, "semantic.stateEffects", ctx);
    uniqueIds(gold.semantic.characterAssertions, "semantic.characterAssertions", ctx);

    for (let index = 0; index < gold.semantic.entityClusters.length; index += 1) {
      for (const mentionId of gold.semantic.entityClusters[index]!.mentionIds) {
        if (!mentionIds.has(mentionId)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown mention '${mentionId}'`,
            path: ["semantic", "entityClusters", index, "mentionIds"],
          });
        }
      }
    }
    for (let index = 0; index < gold.semantic.eventClusters.length; index += 1) {
      for (const mentionId of gold.semantic.eventClusters[index]!.mentionIds) {
        if (!mentionIds.has(mentionId)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown mention '${mentionId}'`,
            path: ["semantic", "eventClusters", index, "mentionIds"],
          });
        }
      }
    }
    for (let index = 0; index < gold.semantic.eventParticipants.length; index += 1) {
      const participant = gold.semantic.eventParticipants[index]!;
      if (!eventClusterIds.has(participant.eventClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown event cluster '${participant.eventClusterId}'`,
          path: ["semantic", "eventParticipants", index, "eventClusterId"],
        });
      }
      if (!entityClusterIds.has(participant.entityClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown entity cluster '${participant.entityClusterId}'`,
          path: ["semantic", "eventParticipants", index, "entityClusterId"],
        });
      }
    }
    for (let index = 0; index < gold.semantic.eventRelations.length; index += 1) {
      const relation = gold.semantic.eventRelations[index]!;
      for (const [field, id] of [
        ["fromEventClusterId", relation.fromEventClusterId],
        ["toEventClusterId", relation.toEventClusterId],
      ] as const) {
        if (!eventClusterIds.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown event cluster '${id}'`,
            path: ["semantic", "eventRelations", index, field],
          });
        }
      }
    }
    for (let index = 0; index < gold.semantic.quotations.length; index += 1) {
      const quotation = gold.semantic.quotations[index]!;
      const referencedClusters = [
        ...(quotation.speakerEntityClusterId ? [quotation.speakerEntityClusterId] : []),
        ...quotation.addresseeEntityClusterIds,
      ];
      for (const clusterId of referencedClusters) {
        if (!entityClusterIds.has(clusterId)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown entity cluster '${clusterId}'`,
            path: ["semantic", "quotations", index],
          });
        }
      }
    }
    for (let index = 0; index < gold.semantic.propositions.length; index += 1) {
      const proposition = gold.semantic.propositions[index]!;
      for (const [field, clusterId] of [
        ["subjectEntityClusterId", proposition.subjectEntityClusterId],
        ...(proposition.holderEntityClusterId
          ? [["holderEntityClusterId", proposition.holderEntityClusterId] as const]
          : []),
      ] as const) {
        if (!entityClusterIds.has(clusterId)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown entity cluster '${clusterId}'`,
            path: ["semantic", "propositions", index, field],
          });
        }
      }
    }
    for (let index = 0; index < gold.semantic.knowledge.length; index += 1) {
      const item = gold.semantic.knowledge[index]!;
      if (!entityClusterIds.has(item.actorEntityClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown entity cluster '${item.actorEntityClusterId}'`,
          path: ["semantic", "knowledge", index, "actorEntityClusterId"],
        });
      }
      if (!propositionIds.has(item.propositionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown proposition '${item.propositionId}'`,
          path: ["semantic", "knowledge", index, "propositionId"],
        });
      }
    }
    for (let index = 0; index < gold.semantic.stateEffects.length; index += 1) {
      const effect = gold.semantic.stateEffects[index]!;
      if (!eventClusterIds.has(effect.eventClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown event cluster '${effect.eventClusterId}'`,
          path: ["semantic", "stateEffects", index, "eventClusterId"],
        });
      }
      if (effect.entityClusterId && !entityClusterIds.has(effect.entityClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown entity cluster '${effect.entityClusterId}'`,
          path: ["semantic", "stateEffects", index, "entityClusterId"],
        });
      }
    }
    for (let index = 0; index < gold.semantic.characterAssertions.length; index += 1) {
      const assertion = gold.semantic.characterAssertions[index]!;
      if (!entityClusterIds.has(assertion.actorEntityClusterId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown entity cluster '${assertion.actorEntityClusterId}'`,
          path: ["semantic", "characterAssertions", index, "actorEntityClusterId"],
        });
      }
    }
  });

export const compilerGoldSchema = z.discriminatedUnion("version", [
  legacyCompilerGoldSchema,
  compilerSemanticGoldSchema,
]);
export type CompilerGold = z.infer<typeof compilerGoldSchema>;
export type CompilerSemanticGold = z.infer<typeof compilerSemanticGoldSchema>;

export type SetMetric = {
  expected: number;
  actual: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  missing: string[];
  unexpected: string[];
};

export type SemanticEvaluationStatus = "evaluated" | "not-implemented" | "not-annotated";

export type SemanticLayerMetric = {
  status: SemanticEvaluationStatus;
  expected: number;
  actual: number | null;
  matched: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  reason?: string;
};

export type SemanticLayerName =
  | "mentions"
  | "entityResolution"
  | "eventResolution"
  | "quotations"
  | "eventParticipants"
  | "eventRelations"
  | "propositions"
  | "knowledge"
  | "stateEffects"
  | "characterAssertions";

export type CompilerEvaluationReport = {
  version: 1;
  goldVersion: 1 | 2;
  suite: string;
  entities: SetMetric;
  claims: SetMetric;
  events: SetMetric;
  causalEdges: SetMetric;
  rules: SetMetric;
  goals: SetMetric;
  characterModels: SetMetric;
  semanticLayers: Record<SemanticLayerName, SemanticLayerMetric>;
  evaluatedDimensions: string[];
  unavailableDimensions: string[];
  macroF1: number | null;
};

export async function evaluateCompilerAgainstGold(
  workspaceRoot: string,
  goldInput: unknown,
): Promise<CompilerEvaluationReport> {
  const gold = compilerGoldSchema.parse(goldInput);
  const canon = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  const [entities, claims, events, rules, goals, models] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    actors.listGoals(),
    actors.listModels(),
  ]);

  const expected = gold.version === 1 ? gold : gold.canonical;
  const eventEdges = events.flatMap((event) => event.causalParents.map((parent) => edgeId(parent, event.id)));
  const semanticLayers = semanticLayerBaseline(gold);
  const report: CompilerEvaluationReport = {
    version: 1,
    goldVersion: gold.version,
    suite: gold.name,
    entities: setMetric(expected.expectedEntityIds, entities.map((entity) => entity.id)),
    claims: setMetric(expected.expectedClaimIds, claims.map((claim) => claim.id)),
    events: setMetric(expected.expectedEventIds, events.map((event) => event.id)),
    causalEdges: setMetric(expected.expectedCausalEdges.map((edge) => edgeId(edge.from, edge.to)), eventEdges),
    rules: setMetric(expected.expectedRuleIds, rules.map((rule) => rule.id)),
    goals: setMetric(expected.expectedGoalIds, goals.map((goal) => goal.id)),
    characterModels: setMetric(expected.expectedCharacterModelActorIds, models.map((model) => model.actorId)),
    semanticLayers,
    evaluatedDimensions: [
      "entities",
      "claims",
      "events",
      "causalEdges",
      "rules",
      "goals",
      "characterModels",
      ...Object.entries(semanticLayers)
        .filter(([, metric]) => metric.status === "evaluated")
        .map(([name]) => name),
    ],
    unavailableDimensions: Object.entries(semanticLayers)
      .filter(([, metric]) => metric.status === "not-implemented")
      .map(([name]) => name),
    macroF1: null,
  };
  const f1s = [
    report.entities,
    report.claims,
    report.events,
    report.causalEdges,
    report.rules,
    report.goals,
    report.characterModels,
  ]
    .map((metric) => metric.f1)
    .filter((value): value is number => value !== null);
  report.macroF1 = f1s.length ? f1s.reduce((sum, value) => sum + value, 0) / f1s.length : null;
  return report;
}

function semanticLayerBaseline(gold: CompilerGold): Record<SemanticLayerName, SemanticLayerMetric> {
  const counts: Record<SemanticLayerName, number> = gold.version === 1
    ? {
      mentions: 0,
      entityResolution: 0,
      eventResolution: 0,
      quotations: 0,
      eventParticipants: 0,
      eventRelations: 0,
      propositions: 0,
      knowledge: 0,
      stateEffects: 0,
      characterAssertions: 0,
    }
    : {
      mentions: gold.semantic.mentions.length,
      entityResolution: gold.semantic.entityClusters.length,
      eventResolution: gold.semantic.eventClusters.length,
      quotations: gold.semantic.quotations.length,
      eventParticipants: gold.semantic.eventParticipants.length,
      eventRelations: gold.semantic.eventRelations.length,
      propositions: gold.semantic.propositions.length,
      knowledge: gold.semantic.knowledge.length,
      stateEffects: gold.semantic.stateEffects.length,
      characterAssertions: gold.semantic.characterAssertions.length,
    };
  return Object.fromEntries(
    Object.entries(counts).map(([name, expected]) => [
      name,
      expected === 0
        ? {
          status: "not-annotated" as const,
          expected,
          actual: null,
          matched: null,
          precision: null,
          recall: null,
          f1: null,
          reason: "The gold suite does not annotate this semantic dimension.",
        }
        : {
          status: "not-implemented" as const,
          expected,
          actual: null,
          matched: null,
          precision: null,
          recall: null,
          f1: null,
          reason: "The current compiler has no persisted semantic layer for this dimension yet.",
        },
    ]),
  ) as Record<SemanticLayerName, SemanticLayerMetric>;
}

function uniqueIds(
  values: readonly { id: string }[],
  path: string,
  ctx: z.core.$RefinementCtx,
): Set<string> {
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const id = values[index]!.id;
    if (ids.has(id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate id '${id}'`,
        path: [...path.split("."), index, "id"],
      });
    }
    ids.add(id);
  }
  return ids;
}

function setMetric(expectedInput: readonly string[], actualInput: readonly string[]): SetMetric {
  const expected = new Set(expectedInput);
  const actual = new Set(actualInput);
  const matchedIds = [...expected].filter((id) => actual.has(id));
  const precision = actual.size ? matchedIds.length / actual.size : expected.size ? 0 : null;
  const recall = expected.size ? matchedIds.length / expected.size : actual.size ? null : null;
  const f1 = precision !== null && recall !== null
    ? precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall)
    : null;
  return {
    expected: expected.size,
    actual: actual.size,
    matched: matchedIds.length,
    precision,
    recall,
    f1,
    missing: [...expected].filter((id) => !actual.has(id)).sort(),
    unexpected: [...actual].filter((id) => !expected.has(id)).sort(),
  };
}

function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}
