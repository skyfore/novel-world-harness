import { z } from "zod";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { findKnowledgeDeltas } from "../world/knowledge-semantics.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import {
  SourceAnnotationStore,
  type EntityMention,
  type EventMention,
  type Quotation,
  type SourceAnnotation,
} from "../compiler/annotations.js";
import { EntityResolutionStore, type IdentityResolution } from "../compiler/entity-resolution.js";
import { EventResolutionStore, type EventResolution } from "../compiler/event-resolution.js";
import { EvidenceAssertionStore } from "../compiler/evidence-assertions.js";
import type { EvidenceRef, StateOperation } from "../world/model.js";
import { worldRuleEvidence } from "../world/world-rule-ontology.js";

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
    operationality: z.enum(["necessary", "contributory", "blocking", "motivational", "explanatory", "non-operational"]).optional(),
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

const sceneSchema = z.object({
  id: z.string().min(1),
  sceneOccurrenceId: z.string().min(1).optional(),
  eventClusterIds: z.array(z.string().min(1)).default([]),
  locationEntityClusterId: z.string().min(1).optional(),
  viewpointEntityClusterIds: z.array(z.string().min(1)).default([]),
  presentEntityClusterIds: z.array(z.string().min(1)).default([]),
  storyTimeKind: z.enum(["exact", "range", "relative", "ordinal", "unknown"]).optional(),
  evidenceSpans: z.array(byteSpanSchema).min(1),
}).strict();

const actionSchemaGoldSchema = z.object({
  id: z.string().min(1),
  actionSchemaId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  supportingEventClusterIds: z.array(z.string().min(1)).default([]),
  roleIds: z.array(z.string().min(1)).default([]),
  allowedStateFields: z.array(z.string().min(1)).default([]),
  maxStateOperations: z.number().int().nonnegative().optional(),
  evidenceSpans: z.array(byteSpanSchema).min(1),
}).strict();

const executablePolicySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["world-rule", "action-constraint", "norm-template", "process-template"]),
  artifactId: z.string().min(1).optional(),
  actionSchemaId: z.string().min(1).optional(),
  modality: z.enum(["obligation", "prohibition", "permission"]).optional(),
  visibility: z.enum(["public", "observable", "knowledge", "engine"]).optional(),
  supportingEventClusterIds: z.array(z.string().min(1)).default([]),
  evidenceSpans: z.array(byteSpanSchema).min(1),
}).strict();

const characterAssertionSchema = z
  .object({
    id: z.string().min(1),
    actorEntityClusterId: z.string().min(1),
    kind: z.enum(["disposition", "goal", "appraisal", "development", "relationship", "obligation"]),
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
        scenes: z.array(sceneSchema).default([]),
        actionSchemas: z.array(actionSchemaGoldSchema).default([]),
        executablePolicies: z.array(executablePolicySchema).default([]),
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
        scenes: [],
        actionSchemas: [],
        executablePolicies: [],
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
    uniqueIds(gold.semantic.scenes, "semantic.scenes", ctx);
    uniqueIds(gold.semantic.actionSchemas, "semantic.actionSchemas", ctx);
    uniqueIds(gold.semantic.executablePolicies, "semantic.executablePolicies", ctx);
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
    for (let index = 0; index < gold.semantic.scenes.length; index += 1) {
      const scene = gold.semantic.scenes[index]!;
      for (const eventClusterId of scene.eventClusterIds) {
        if (!eventClusterIds.has(eventClusterId)) ctx.addIssue({ code: "custom", message: `Unknown event cluster '${eventClusterId}'`, path: ["semantic", "scenes", index, "eventClusterIds"] });
      }
      for (const clusterId of [
        ...(scene.locationEntityClusterId ? [scene.locationEntityClusterId] : []),
        ...scene.viewpointEntityClusterIds,
        ...scene.presentEntityClusterIds,
      ]) {
        if (!entityClusterIds.has(clusterId)) ctx.addIssue({ code: "custom", message: `Unknown entity cluster '${clusterId}'`, path: ["semantic", "scenes", index] });
      }
    }
    for (let index = 0; index < gold.semantic.actionSchemas.length; index += 1) {
      for (const eventClusterId of gold.semantic.actionSchemas[index]!.supportingEventClusterIds) {
        if (!eventClusterIds.has(eventClusterId)) ctx.addIssue({ code: "custom", message: `Unknown event cluster '${eventClusterId}'`, path: ["semantic", "actionSchemas", index, "supportingEventClusterIds"] });
      }
    }
    for (let index = 0; index < gold.semantic.executablePolicies.length; index += 1) {
      for (const eventClusterId of gold.semantic.executablePolicies[index]!.supportingEventClusterIds) {
        if (!eventClusterIds.has(eventClusterId)) ctx.addIssue({ code: "custom", message: `Unknown event cluster '${eventClusterId}'`, path: ["semantic", "executablePolicies", index, "supportingEventClusterIds"] });
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
  | "scenes"
  | "actionSchemas"
  | "executablePolicies"
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
  const [
    entities,
    propositions,
    attributions,
    claims,
    events,
    eventParticipations,
    eventRelations,
    sceneOccurrences,
    actionSchemas,
    actionConstraints,
    normTemplates,
    processTemplates,
    rules,
    goals,
    models,
    initialWorld,
    possibilities,
  ] = await Promise.all([
    canon.listEntities(),
    canon.listPropositions(),
    canon.listAttributions(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listEventParticipations(),
    canon.listEventRelations(),
    canon.listSceneOccurrences(),
    canon.listActionSchemas(),
    canon.listActionConstraints(),
    canon.listNormTemplates(),
    canon.listProcessTemplates(),
    canon.listRules(),
    actors.listGoals(),
    actors.listModels(),
    new InitialWorldStore(workspaceRoot).get(),
    new PossibilityTemplateStore(workspaceRoot).list(),
  ]);

  const expected = gold.version === 1 ? gold : gold.canonical;
  const eventEdges = events.flatMap((event) => event.causalParents.map((parent) => edgeId(parent, event.id)));
  const semanticLayers = gold.version === 1
    ? semanticLayerNotAnnotated()
    : await evaluateSemanticLayers(workspaceRoot, gold, {
      propositions,
      attributions,
      events,
      eventParticipations,
      eventRelations,
      sceneOccurrences,
      actionSchemas,
      actionConstraints,
      normTemplates,
      processTemplates,
      rules,
      goals,
      models,
      initialWorld,
      possibilities,
    });
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
    ...Object.values(report.semanticLayers)
      .filter((metric) => metric.status === "evaluated"),
  ]
    .map((metric) => metric.f1)
    .filter((value): value is number => value !== null);
  report.macroF1 = f1s.length ? f1s.reduce((sum, value) => sum + value, 0) / f1s.length : null;
  return report;
}

function semanticLayerNotAnnotated(): Record<SemanticLayerName, SemanticLayerMetric> {
  const counts: Record<SemanticLayerName, number> = {
      mentions: 0,
      entityResolution: 0,
      eventResolution: 0,
      quotations: 0,
      eventParticipants: 0,
      eventRelations: 0,
      propositions: 0,
      knowledge: 0,
      stateEffects: 0,
      scenes: 0,
      actionSchemas: 0,
      executablePolicies: 0,
      characterAssertions: 0,
    };
  return Object.fromEntries(
    Object.entries(counts).map(([name, expected]) => [
      name,
      {
          status: "not-annotated" as const,
          expected,
          actual: null,
          matched: null,
          precision: null,
          recall: null,
          f1: null,
          reason: "The gold suite does not annotate this semantic dimension.",
        },
    ]),
  ) as Record<SemanticLayerName, SemanticLayerMetric>;
}

type GoldByteSpan = z.infer<typeof byteSpanSchema>;
type SemanticCatalog = {
  propositions: Awaited<ReturnType<CanonicalModelStore["listPropositions"]>>;
  attributions: Awaited<ReturnType<CanonicalModelStore["listAttributions"]>>;
  events: Awaited<ReturnType<CanonicalModelStore["listEvents"]>>;
  eventParticipations: Awaited<ReturnType<CanonicalModelStore["listEventParticipations"]>>;
  eventRelations: Awaited<ReturnType<CanonicalModelStore["listEventRelations"]>>;
  sceneOccurrences: Awaited<ReturnType<CanonicalModelStore["listSceneOccurrences"]>>;
  actionSchemas: Awaited<ReturnType<CanonicalModelStore["listActionSchemas"]>>;
  actionConstraints: Awaited<ReturnType<CanonicalModelStore["listActionConstraints"]>>;
  normTemplates: Awaited<ReturnType<CanonicalModelStore["listNormTemplates"]>>;
  processTemplates: Awaited<ReturnType<CanonicalModelStore["listProcessTemplates"]>>;
  rules: Awaited<ReturnType<CanonicalModelStore["listRules"]>>;
  goals: Awaited<ReturnType<ActorModelStore["listGoals"]>>;
  models: Awaited<ReturnType<ActorModelStore["listModels"]>>;
  initialWorld: Awaited<ReturnType<InitialWorldStore["get"]>>;
  possibilities: Awaited<ReturnType<PossibilityTemplateStore["list"]>>;
};

type ActualMention = {
  id: string;
  kinds: ReadonlySet<z.infer<typeof semanticMentionSchema>["kind"]>;
  span: GoldByteSpan;
  types: ReadonlySet<string>;
};

type ActualEntityCluster = {
  mentionIds: string[];
  canonicalEntityId?: string;
};

type ActualEventCluster = {
  mentionIds: string[];
  canonicalEventId?: string;
};

async function evaluateSemanticLayers(
  workspaceRoot: string,
  gold: CompilerSemanticGold,
  catalog: SemanticCatalog,
): Promise<Record<SemanticLayerName, SemanticLayerMetric>> {
  const sourceIds = semanticGoldSourceIds(gold);
  const registered = await (await WorkspaceStore.create(workspaceRoot)).listSources();
  const selectedSourceIds = sourceIds.size
    ? registered.map((source) => source.id).filter((sourceId) => sourceIds.has(sourceId))
    : registered.map((source) => source.id);
  const annotations = (await Promise.all(selectedSourceIds.map((sourceId) =>
    new SourceAnnotationStore(workspaceRoot).list(sourceId)))).flat();
  const entityResolutions = (await Promise.all(selectedSourceIds.map((sourceId) =>
    new EntityResolutionStore(workspaceRoot).list(sourceId)))).flat();
  const eventResolutions = (await Promise.all(selectedSourceIds.map((sourceId) =>
    new EventResolutionStore(workspaceRoot).list(sourceId)))).flat();

  const actualMentions = annotations.flatMap(actualMentionRecords);
  const actualMentionById = new Map(actualMentions.map((mention) => [mention.id, mention]));
  const goldMentionById = new Map(gold.semantic.mentions.map((mention) => [mention.id, mention]));
  const goldEntityClusterById = new Map(gold.semantic.entityClusters.map((cluster) => [cluster.id, cluster]));
  const goldEventClusterById = new Map(gold.semantic.eventClusters.map((cluster) => [cluster.id, cluster]));
  const entityResolutionByMention = new Map(entityResolutions.map((resolution) => [resolution.mentionId, resolution]));
  const actualEntityClusters = groupActualEntityClusters(entityResolutions, actualMentionById);
  const actualEventClusters = eventResolutions
    .map((resolution) => ({
      mentionIds: resolution.eventMentionIds.filter((mentionId) => actualMentionById.has(mentionId)).sort(),
      ...(resolution.canonicalEventId ? { canonicalEventId: resolution.canonicalEventId } : {}),
    }))
    .filter((cluster) => cluster.mentionIds.length > 0);

  const goldEntityMentionSpans = (clusterId: string): string[] => {
    const cluster = goldEntityClusterById.get(clusterId);
    return cluster ? cluster.mentionIds.map((id) => goldMentionById.get(id)).filter(Boolean).map((mention) => spanKey(mention!.span)).sort() : [];
  };
  const goldEventMentionSpans = (clusterId: string): string[] => {
    const cluster = goldEventClusterById.get(clusterId);
    return cluster ? cluster.mentionIds.map((id) => goldMentionById.get(id)).filter(Boolean).map((mention) => spanKey(mention!.span)).sort() : [];
  };
  const actualMentionSpans = (mentionIds: readonly string[]): string[] => mentionIds
    .map((id) => actualMentionById.get(id))
    .filter(Boolean)
    .map((mention) => spanKey(mention!.span))
    .sort();
  const entityClusterMatches = (
    expectedClusterId: string,
    actual: ActualEntityCluster,
  ): boolean => {
    const expected = goldEntityClusterById.get(expectedClusterId);
    if (!expected) return false;
    if (expected.canonicalEntityId && expected.canonicalEntityId !== actual.canonicalEntityId) return false;
    return sameStrings(goldEntityMentionSpans(expectedClusterId), actualMentionSpans(actual.mentionIds));
  };
  const eventClusterMatches = (
    expectedClusterId: string,
    actual: ActualEventCluster,
  ): boolean => {
    const expected = goldEventClusterById.get(expectedClusterId);
    if (!expected) return false;
    if (expected.canonicalEventId && expected.canonicalEventId !== actual.canonicalEventId) return false;
    return sameStrings(goldEventMentionSpans(expectedClusterId), actualMentionSpans(actual.mentionIds));
  };
  const entityReferenceMatches = (expectedClusterId: string, actualEntityId: string): boolean => {
    const expected = goldEntityClusterById.get(expectedClusterId);
    if (!expected) return false;
    if (expected.canonicalEntityId) return expected.canonicalEntityId === actualEntityId;
    return actualEntityClusters.some((cluster) =>
      cluster.canonicalEntityId === actualEntityId && entityClusterMatches(expectedClusterId, cluster));
  };
  const eventReferenceMatches = (expectedClusterId: string, actualEventId: string): boolean => {
    const expected = goldEventClusterById.get(expectedClusterId);
    if (!expected) return false;
    if (expected.canonicalEventId) return expected.canonicalEventId === actualEventId;
    return actualEventClusters.some((cluster) =>
      cluster.canonicalEventId === actualEventId && eventClusterMatches(expectedClusterId, cluster));
  };
  const mentionReferenceMatches = (expectedClusterId: string, actualMentionId: string): boolean => {
    const expected = goldEntityClusterById.get(expectedClusterId);
    const mention = actualMentionById.get(actualMentionId);
    if (!expected || !mention) return false;
    const resolved = entityResolutionByMention.get(actualMentionId)?.entityId;
    if (expected.canonicalEntityId) return expected.canonicalEntityId === resolved;
    return goldEntityMentionSpans(expectedClusterId).includes(spanKey(mention.span));
  };

  const quotations = annotations.filter((annotation): annotation is Quotation => annotation.annotationType === "quotation");
  const sourceEventIds = new Set(catalog.events
    .filter((event) => evidenceTouchesSources(event.evidence, sourceIds))
    .map((event) => event.id));
  for (const resolution of eventResolutions) if (resolution.canonicalEventId) sourceEventIds.add(resolution.canonicalEventId);
  const sourceEntityIds = new Set(entityResolutions.flatMap((resolution) => resolution.entityId ? [resolution.entityId] : []));
  const sourcePropositions = catalog.propositions.filter((proposition) => evidenceTouchesSources(proposition.evidence, sourceIds));
  const sourcePropositionIds = new Set(sourcePropositions.map((proposition) => proposition.id));
  const sourceAttributions = catalog.attributions.filter((attribution) =>
    sourcePropositionIds.has(attribution.propositionId) || evidenceTouchesSources(attribution.evidence, sourceIds));
  const sourceParticipations = catalog.eventParticipations.filter((participation) =>
    sourceEventIds.has(participation.eventId) || sourceEntityIds.has(participation.entityId));
  const sourceRelations = catalog.eventRelations.filter((relation) =>
    sourceEventIds.has(relation.fromEventId) || sourceEventIds.has(relation.toEventId));
  const sourceScenes = catalog.sceneOccurrences.filter((scene) => evidenceTouchesSources(scene.evidence, sourceIds));
  const sourceActionSchemas = catalog.actionSchemas.filter((schema) => evidenceTouchesSources(schema.evidence, sourceIds));
  const sourceExecutablePolicies = [
    ...catalog.rules.filter((rule) => evidenceTouchesSources(worldRuleEvidence(rule), sourceIds)).map((rule) => ({
      kind: "world-rule" as const,
      artifactId: rule.id,
      visibility: rule.visibility,
      supportingEventIds: [] as string[],
      evidence: worldRuleEvidence(rule),
    })),
    ...catalog.actionConstraints.filter((constraint) => evidenceTouchesSources(constraint.evidence, sourceIds)).map((constraint) => ({
      kind: "action-constraint" as const,
      artifactId: constraint.id,
      visibility: constraint.visibility,
      ...(constraint.actionPattern.kind === "schema" ? { actionSchemaId: constraint.actionPattern.schemaId } : {}),
      supportingEventIds: constraint.induction.kind === "source-pattern" ? constraint.induction.supportingEventIds : [],
      evidence: constraint.evidence,
    })),
    ...catalog.normTemplates.filter((template) => evidenceTouchesSources(template.evidence, sourceIds)).map((template) => ({
      kind: "norm-template" as const,
      artifactId: template.id,
      visibility: template.visibility,
      modality: template.modality,
      ...(template.actionPattern.kind === "schema" ? { actionSchemaId: template.actionPattern.schemaId } : {}),
      supportingEventIds: template.induction.kind === "source-pattern" ? template.induction.supportingEventIds : [],
      evidence: template.evidence,
    })),
    ...catalog.processTemplates.filter((template) => evidenceTouchesSources(template.evidence, sourceIds)).map((template) => ({
      kind: "process-template" as const,
      artifactId: template.id,
      visibility: template.visibility,
      supportingEventIds: template.induction.kind === "source-pattern" ? template.induction.supportingEventIds : [],
      evidence: template.evidence,
    })),
  ];

  const propositionMatches = (
    expected: CompilerSemanticGold["semantic"]["propositions"][number],
    actual: SemanticCatalog["propositions"][number],
  ): boolean => {
    if (!entityReferenceMatches(expected.subjectEntityClusterId, actual.subjectEntityId)
      || expected.predicate !== actual.relationId
      || expected.polarity !== actual.polarity
      || expected.modality !== actual.modality
      || !expected.evidenceSpans.every((span) => evidenceContainsSpan(actual.evidence, span))) return false;
    if (!expected.holderEntityClusterId) return true;
    return sourceAttributions.some((attribution) =>
      attribution.propositionId === actual.id
      && attribution.holderEntityId
      && entityReferenceMatches(expected.holderEntityClusterId!, attribution.holderEntityId));
  };
  const goldPropositionById = new Map(gold.semantic.propositions.map((proposition) => [proposition.id, proposition]));

  const knowledgeArtifacts: unknown[] = [
    ...(catalog.initialWorld && evidenceTouchesSources(catalog.initialWorld.evidence, sourceIds)
      ? [catalog.initialWorld]
      : []),
    ...catalog.events.filter((event) => sourceEventIds.has(event.id)),
    ...catalog.goals.filter((goal) => evidenceTouchesSources(goal.evidence, sourceIds)),
    ...catalog.models.filter((model) => evidenceTouchesSources(model.evidence, sourceIds)),
    ...catalog.possibilities.filter((possibility) => evidenceTouchesSources(possibility.evidence, sourceIds)),
  ];
  const actualKnowledge = [...new Map(knowledgeArtifacts.flatMap((artifact) =>
    findKnowledgeDeltas(artifact).flatMap(({ delta }) => delta.operations.flatMap((operation) =>
      operation.op === "learn" && operation.propositionId && operation.acquisitionMode
        ? [[knowledgeKey(operation.actorId, operation.propositionId, operation.status, operation.acquisitionMode), operation] as const]
        : []))).map(([key, operation]) => [key, operation])).values()];

  const actualStateEffects = catalog.events
    .filter((event) => sourceEventIds.has(event.id))
    .flatMap((event) => event.observedOutcome.operations.map((operation) => ({ eventId: event.id, operation })));
  const actualCharacterAssertions = await collectCharacterAssertions(workspaceRoot, catalog, sourceIds);

  return {
    mentions: evaluatedLayer(gold.semantic.mentions, actualMentions, (expected, actual) =>
      actual.kinds.has(expected.kind)
      && spanKey(expected.span) === spanKey(actual.span)
      && (!expected.type || actual.types.has(expected.type))),
    entityResolution: evaluatedLayer(gold.semantic.entityClusters, actualEntityClusters, (expected, actual) =>
      entityClusterMatches(expected.id, actual)),
    eventResolution: evaluatedLayer(gold.semantic.eventClusters, actualEventClusters, (expected, actual) =>
      eventClusterMatches(expected.id, actual)),
    quotations: evaluatedLayer(gold.semantic.quotations, quotations, (expected, actual) => {
      if (spanKey(expected.span) !== spanKey(anchorSpan(actual.anchor))) return false;
      if (Boolean(expected.speakerEntityClusterId) !== Boolean(actual.speakerMentionId)) return false;
      if (expected.speakerEntityClusterId
        && !mentionReferenceMatches(expected.speakerEntityClusterId, actual.speakerMentionId!)) return false;
      return referencesMatch(
        expected.addresseeEntityClusterIds,
        actual.addresseeMentionIds,
        mentionReferenceMatches,
      );
    }),
    eventParticipants: evaluatedLayer(gold.semantic.eventParticipants, sourceParticipations, (expected, actual) =>
      expected.role === actual.role
      && eventReferenceMatches(expected.eventClusterId, actual.eventId)
      && entityReferenceMatches(expected.entityClusterId, actual.entityId)),
    eventRelations: evaluatedLayer(gold.semantic.eventRelations, sourceRelations, (expected, actual) =>
      expected.type === actual.type
      && (!expected.operationality || expected.operationality === actual.operationality)
      && eventReferenceMatches(expected.fromEventClusterId, actual.fromEventId)
      && eventReferenceMatches(expected.toEventClusterId, actual.toEventId)
      && expected.evidenceSpans.every((span) => evidenceContainsSpan(actual.evidence, span))),
    propositions: evaluatedLayer(gold.semantic.propositions, sourcePropositions, propositionMatches),
    knowledge: evaluatedLayer(gold.semantic.knowledge, actualKnowledge, (expected, actual) => {
      const expectedProposition = goldPropositionById.get(expected.propositionId);
      const actualProposition = sourcePropositions.find((proposition) => proposition.id === actual.propositionId);
      return Boolean(
        expectedProposition
        && actualProposition
        && entityReferenceMatches(expected.actorEntityClusterId, actual.actorId)
        && propositionMatches(expectedProposition, actualProposition)
        && expected.status === actual.status
        && expected.acquisition === normalizeAcquisition(actual.acquisitionMode!),
      );
    }),
    stateEffects: evaluatedLayer(gold.semantic.stateEffects, actualStateEffects, (expected, actual) =>
      eventReferenceMatches(expected.eventClusterId, actual.eventId)
      && stateEffectMatches(expected, actual.operation, entityReferenceMatches)),
    scenes: evaluatedLayer(gold.semantic.scenes, sourceScenes, (expected, actual) =>
      (!expected.sceneOccurrenceId || expected.sceneOccurrenceId === actual.id)
      && referencesMatch(expected.eventClusterIds, actual.eventIds, eventReferenceMatches)
      && (expected.locationEntityClusterId
        ? Boolean(actual.locationId && entityReferenceMatches(expected.locationEntityClusterId, actual.locationId))
        : actual.locationId === undefined)
      && referencesMatch(expected.viewpointEntityClusterIds, actual.viewpointActorIds, entityReferenceMatches)
      && referencesMatch(expected.presentEntityClusterIds, actual.presentActorIds, entityReferenceMatches)
      && (!expected.storyTimeKind || expected.storyTimeKind === actual.storyInterval?.start.kind)
      && expected.evidenceSpans.every((span) => evidenceContainsSpan(actual.evidence, span))),
    actionSchemas: evaluatedLayer(gold.semantic.actionSchemas, sourceActionSchemas, (expected, actual) =>
      (!expected.actionSchemaId || expected.actionSchemaId === actual.id)
      && (!expected.name || expected.name === actual.name)
      && referencesMatch(
        expected.supportingEventClusterIds,
        actual.induction.kind === "source-pattern" ? actual.induction.supportingEventIds : [],
        eventReferenceMatches,
      )
      && sameStrings([...expected.roleIds].sort(), actual.roles.map((role) => role.id).sort())
      && sameStrings([...expected.allowedStateFields].sort(), [...actual.effectEnvelope.allowedStateFields].sort())
      && (expected.maxStateOperations === undefined || expected.maxStateOperations === actual.effectEnvelope.maxStateOperations)
      && expected.evidenceSpans.every((span) => evidenceContainsSpan(actual.evidence, span))),
    executablePolicies: evaluatedLayer(gold.semantic.executablePolicies, sourceExecutablePolicies, (expected, actual) =>
      expected.kind === actual.kind
      && (!expected.artifactId || expected.artifactId === actual.artifactId)
      && (!expected.actionSchemaId || expected.actionSchemaId === ("actionSchemaId" in actual ? actual.actionSchemaId : undefined))
      && (!expected.modality || expected.modality === ("modality" in actual ? actual.modality : undefined))
      && (!expected.visibility || expected.visibility === actual.visibility)
      && referencesMatch(expected.supportingEventClusterIds, actual.supportingEventIds, eventReferenceMatches)
      && expected.evidenceSpans.every((span) => evidenceContainsSpan(actual.evidence, span))),
    characterAssertions: evaluatedLayer(gold.semantic.characterAssertions, actualCharacterAssertions, (expected, actual) =>
      expected.kind === actual.kind
      && entityReferenceMatches(expected.actorEntityClusterId, actual.actorId)
      && expected.evidenceSpans.every((span) => actual.evidenceSpans.some((actualSpan) =>
        spanKey(span) === spanKey(actualSpan)))),
  };
}

function semanticGoldSourceIds(gold: CompilerSemanticGold): Set<string> {
  return new Set([
    ...gold.semantic.mentions.map((mention) => mention.span.sourceId),
    ...gold.semantic.quotations.map((quotation) => quotation.span.sourceId),
    ...gold.semantic.eventRelations.flatMap((relation) => relation.evidenceSpans.map((span) => span.sourceId)),
    ...gold.semantic.propositions.flatMap((proposition) => proposition.evidenceSpans.map((span) => span.sourceId)),
    ...gold.semantic.scenes.flatMap((scene) => scene.evidenceSpans.map((span) => span.sourceId)),
    ...gold.semantic.actionSchemas.flatMap((schema) => schema.evidenceSpans.map((span) => span.sourceId)),
    ...gold.semantic.executablePolicies.flatMap((policy) => policy.evidenceSpans.map((span) => span.sourceId)),
    ...gold.semantic.characterAssertions.flatMap((assertion) => assertion.evidenceSpans.map((span) => span.sourceId)),
  ]);
}

function actualMentionRecords(annotation: SourceAnnotation): ActualMention[] {
  if (annotation.annotationType === "entity-mention") {
    const mention = annotation as EntityMention;
    const kinds = new Set<z.infer<typeof semanticMentionSchema>["kind"]>(["entity"]);
    if (mention.kindCandidates.includes("location")) kinds.add("place");
    return [{
      id: mention.id,
      kinds,
      span: anchorSpan(mention.anchor),
      types: new Set(mention.kindCandidates),
    }];
  }
  if (annotation.annotationType === "event-mention") {
    const mention = annotation as EventMention;
    return [{
      id: mention.id,
      kinds: new Set(["event"]),
      span: anchorSpan(mention.triggerAnchor),
      types: new Set(mention.eventTypeCandidates),
    }];
  }
  if (annotation.annotationType === "quotation") {
    return [{
      id: annotation.id,
      kinds: new Set(["quotation"]),
      span: anchorSpan(annotation.anchor),
      types: new Set([annotation.mode]),
    }];
  }
  return [];
}

function groupActualEntityClusters(
  resolutions: readonly IdentityResolution[],
  mentionById: ReadonlyMap<string, ActualMention>,
): ActualEntityCluster[] {
  const clusters = new Map<string, ActualEntityCluster>();
  for (const resolution of resolutions) {
    if (!mentionById.has(resolution.mentionId)) continue;
    const key = resolution.entityId ? `entity:${resolution.entityId}` : `resolution:${resolution.id}`;
    const cluster = clusters.get(key) ?? {
      mentionIds: [],
      ...(resolution.entityId ? { canonicalEntityId: resolution.entityId } : {}),
    };
    cluster.mentionIds.push(resolution.mentionId);
    clusters.set(key, cluster);
  }
  return [...clusters.values()].map((cluster) => ({ ...cluster, mentionIds: [...new Set(cluster.mentionIds)].sort() }));
}

function evaluatedLayer<E, A>(
  expected: readonly E[],
  actual: readonly A[],
  matches: (expected: E, actual: A) => boolean,
): SemanticLayerMetric {
  if (!expected.length) {
    return {
      status: "not-annotated",
      expected: 0,
      actual: null,
      matched: null,
      precision: null,
      recall: null,
      f1: null,
      reason: "The gold suite does not annotate this semantic dimension.",
    };
  }
  const matched = maximumMatching(expected, actual, matches);
  const precision = actual.length ? matched / actual.length : 0;
  const recall = matched / expected.length;
  return {
    status: "evaluated",
    expected: expected.length,
    actual: actual.length,
    matched,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function maximumMatching<E, A>(
  expected: readonly E[],
  actual: readonly A[],
  matches: (expected: E, actual: A) => boolean,
): number {
  const actualOwner = new Map<number, number>();
  const assign = (expectedIndex: number, seen: Set<number>): boolean => {
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
      if (seen.has(actualIndex) || !matches(expected[expectedIndex]!, actual[actualIndex]!)) continue;
      seen.add(actualIndex);
      const owner = actualOwner.get(actualIndex);
      if (owner === undefined || assign(owner, seen)) {
        actualOwner.set(actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (assign(index, new Set())) matched += 1;
  }
  return matched;
}

function anchorSpan(anchor: { sourceId: string; startByte: number; endByte: number }): GoldByteSpan {
  return { sourceId: anchor.sourceId, startByte: anchor.startByte, endByte: anchor.endByte };
}

function spanKey(span: GoldByteSpan): string {
  return `${span.sourceId}:${span.startByte}-${span.endByte}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evidenceTouchesSources(evidence: readonly EvidenceRef[], sourceIds: ReadonlySet<string>): boolean {
  return sourceIds.size === 0 || evidence.some((reference) => sourceIds.has(reference.span.sourceId));
}

function evidenceContainsSpan(evidence: readonly EvidenceRef[], span: GoldByteSpan): boolean {
  return evidence.some((reference) => reference.span.sourceId === span.sourceId
    && reference.span.startByte !== undefined
    && reference.span.endByte !== undefined
    && reference.span.startByte <= span.startByte
    && reference.span.endByte >= span.endByte);
}

function referencesMatch(
  expectedIds: readonly string[],
  actualIds: readonly string[],
  matches: (expectedId: string, actualId: string) => boolean,
): boolean {
  return expectedIds.length === actualIds.length
    && maximumMatching(expectedIds, actualIds, matches) === expectedIds.length;
}

function knowledgeKey(actorId: string, propositionId: string, status: string, acquisition: string): string {
  return `${actorId}|${propositionId}|${status}|${acquisition}`;
}

function normalizeAcquisition(value: string): CompilerSemanticGold["semantic"]["knowledge"][number]["acquisition"] {
  return value === "deceived-misattributed" ? "deceived" : value as CompilerSemanticGold["semantic"]["knowledge"][number]["acquisition"];
}

function stateEffectMatches(
  expected: CompilerSemanticGold["semantic"]["stateEffects"][number],
  actual: StateOperation,
  entityMatches: (clusterId: string, entityId: string) => boolean,
): boolean {
  if (expected.op !== actual.op) return false;
  if ("entityId" in actual) {
    if (expected.entityClusterId && !entityMatches(expected.entityClusterId, actual.entityId)) return false;
    if (!expected.entityClusterId) return false;
    return expected.field === undefined || expected.field === actual.field;
  }
  return !expected.entityClusterId && expected.field === undefined;
}

async function collectCharacterAssertions(
  workspaceRoot: string,
  catalog: Pick<SemanticCatalog, "goals" | "models">,
  sourceIds: ReadonlySet<string>,
): Promise<Array<{
  actorId: string;
  kind: CompilerSemanticGold["semantic"]["characterAssertions"][number]["kind"];
  evidenceSpans: GoldByteSpan[];
}>> {
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  const result: Array<{
    actorId: string;
    kind: CompilerSemanticGold["semantic"]["characterAssertions"][number]["kind"];
    evidenceSpans: GoldByteSpan[];
  }> = [];
  const spansFor = async (
    artifactKind: string,
    artifactId: string,
    prefix: string,
    fallback: readonly EvidenceRef[],
  ): Promise<GoldByteSpan[]> => {
    const binding = await exactEvidence.bindingForArtifact(artifactKind, artifactId);
    const exact = binding?.assertions
      .filter((assertion) => assertion.target.jsonPointer === prefix
        || assertion.target.jsonPointer.startsWith(`${prefix}/`))
      .flatMap((assertion) => assertion.anchors.map(anchorSpan)) ?? [];
    const legacy = fallback.flatMap((reference) => reference.span.startByte !== undefined && reference.span.endByte !== undefined
      ? [{ sourceId: reference.span.sourceId, startByte: reference.span.startByte, endByte: reference.span.endByte }]
      : []);
    return [...new Map([...exact, ...legacy]
      .filter((span) => sourceIds.size === 0 || sourceIds.has(span.sourceId))
      .map((span) => [spanKey(span), span])).values()];
  };
  for (const goal of catalog.goals.filter((item) => evidenceTouchesSources(item.evidence, sourceIds))) {
    result.push({
      actorId: goal.actorId,
      kind: "goal",
      evidenceSpans: await spansFor("character-goal", goal.id, "", goal.evidence),
    });
  }
  for (const model of catalog.models.filter((item) => evidenceTouchesSources(item.evidence, sourceIds))) {
    for (let index = 0; index < (model.dispositions?.length ?? 0); index += 1) {
      const item = model.dispositions![index]!;
      result.push({ actorId: model.actorId, kind: "disposition", evidenceSpans: await spansFor("character-model", model.actorId, `/dispositions/${index}`, item.evidence) });
    }
    for (let index = 0; index < (model.appraisalEpisodes?.length ?? 0); index += 1) {
      const item = model.appraisalEpisodes![index]!;
      result.push({ actorId: model.actorId, kind: "appraisal", evidenceSpans: await spansFor("character-model", model.actorId, `/appraisalEpisodes/${index}`, item.evidence) });
    }
    for (let index = 0; index < (model.developmentEpisodes?.length ?? 0); index += 1) {
      const item = model.developmentEpisodes![index]!;
      result.push({ actorId: model.actorId, kind: "development", evidenceSpans: await spansFor("character-model", model.actorId, `/developmentEpisodes/${index}`, item.evidence) });
    }
    for (let index = 0; index < (model.developmentPhases?.length ?? 0); index += 1) {
      const item = model.developmentPhases![index]!;
      result.push({ actorId: model.actorId, kind: "development", evidenceSpans: await spansFor("character-model", model.actorId, `/developmentPhases/${index}`, item.evidence) });
    }
    for (let index = 0; index < (model.relationshipStances?.length ?? 0); index += 1) {
      const item = model.relationshipStances![index]!;
      result.push({ actorId: model.actorId, kind: "relationship", evidenceSpans: await spansFor("character-model", model.actorId, `/relationshipStances/${index}`, item.evidence) });
    }
    for (let index = 0; index < (model.relationshipObligations?.length ?? 0); index += 1) {
      const item = model.relationshipObligations![index]!;
      result.push({ actorId: model.actorId, kind: "obligation", evidenceSpans: await spansFor("character-model", model.actorId, `/relationshipObligations/${index}`, item.evidence) });
    }
  }
  return result;
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
