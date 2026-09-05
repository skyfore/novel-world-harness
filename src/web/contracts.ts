import { z } from "zod";
import { frozenWorldBaseSchema } from "../world/base-schema.js";
import { preparedPlayRoleSchema } from "../world/play-role-schema.js";

export const WEB_API_VERSION = "v1" as const;

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const novelSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourcePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  contentSha256: z.string().min(1),
  registeredAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  instanceCount: z.number().int().nonnegative(),
}).strict();

export const instanceSummarySchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1),
  headCommitId: z.string().min(1),
  logicalStep: z.number().int().nonnegative(),
  commitCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  lastEventTitle: z.string().optional(),
  parentBranchId: z.string().optional(),
  active: z.boolean(),
  sourceId: z.string().optional(),
  sourceTitle: z.string().optional(),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  sessionAtHead: z.boolean().optional(),
  preparedRevisionHash: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  lastPlayedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const playSessionSummarySchema = z.object({
  id: z.string().min(1),
  storageVersion: z.union([z.literal(1), z.literal(2)]),
  branchId: z.string().min(1),
  title: z.string().min(1),
  sourceId: z.string().optional(),
  actorId: z.string().min(1),
  actorName: z.string().optional(),
  conversationId: z.string().min(1),
  lastCommitId: z.string().min(1),
  active: z.boolean(),
  atHead: z.boolean(),
  status: z.enum(["active", "idle", "archived", "detached"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const catalogSnapshotSchema = z.object({
  project: projectSummarySchema.nullable(),
  novels: z.array(novelSummarySchema),
  instances: z.array(instanceSummarySchema),
  playSessions: z.array(playSessionSummarySchema),
  activeSessionId: z.string().nullable(),
}).strict();

export const providerSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  configured: z.boolean(),
  authSource: z.enum(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"]).optional(),
  authLabel: z.string().optional(),
  credentialType: z.enum(["api_key", "oauth"]).optional(),
  authTypes: z.array(z.enum(["api_key", "oauth"])),
  modelCount: z.number().int().nonnegative(),
}).strict();

export const modelSummarySchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  available: z.boolean(),
}).strict();

export const modelCatalogSchema = z.object({
  providers: z.array(providerSummarySchema),
  models: z.array(modelSummarySchema),
  diagnostic: z.string().optional(),
}).strict();

export const modelRoleSchema = z.enum([
  "controller",
  "extractor",
  "narrator",
  "player-action",
  "adjudicator",
  "npc",
  "specialist",
]);

export const modelProfileSummarySchema = z.object({
  role: modelRoleSchema,
  profileId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  inheritedDefault: z.boolean(),
}).strict();

export const modelProfileListSchema = z.object({
  version: z.literal(1),
  configPath: z.string().min(1),
  defaultProfileId: z.string().min(1).optional(),
  roles: z.array(modelProfileSummarySchema),
}).strict();

export const updateModelProfileRequestSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const providerCredentialRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const providerLoginRequestSchema = z.object({
  authType: z.enum(["api_key", "oauth"]),
  apiKey: z.string().min(1).max(100_000).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (value.authType === "api_key" && !value.apiKey) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "An API key is required for api_key login." });
  if (value.authType === "oauth" && value.apiKey !== undefined) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "OAuth login must not include an API key." });
});

export const authInteractionPromptSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), message: z.string().min(1), placeholder: z.string().optional() }).strict(),
  z.object({ type: z.literal("secret"), message: z.string().min(1), placeholder: z.string().optional() }).strict(),
  z.object({ type: z.literal("manual_code"), message: z.string().min(1), placeholder: z.string().optional() }).strict(),
  z.object({
    type: z.literal("select"),
    message: z.string().min(1),
    options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() }).strict()).min(1),
  }).strict(),
]);

export const authInteractionSnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  operationId: z.string().min(1),
  providerId: z.string().min(1),
  status: z.enum(["pending", "answered", "cancelled", "expired"]),
  prompt: authInteractionPromptSchema,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const answerAuthInteractionRequestSchema = z.object({ answer: z.string().max(100_000) }).strict();

export const providerCredentialResultSchema = z.object({
  providerId: z.string().min(1),
  configured: z.boolean(),
  authType: z.enum(["api_key", "oauth"]).optional(),
  authSource: providerSummarySchema.shape.authSource,
  authLabel: z.string().optional(),
}).strict();

export const featureSummarySchema = z.object({
  id: z.enum(["library", "play", "trace", "compiler", "ontology", "model-settings"]),
  status: z.enum(["available", "foundation", "planned"]),
  phase: z.number().int().nonnegative(),
}).strict();

export const bootstrapResponseSchema = z.object({
  version: z.literal(1),
  apiVersion: z.literal(WEB_API_VERSION),
  server: z.object({
    name: z.literal("novel-world-harness"),
    version: z.string().min(1),
    nodeVersion: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
  }).strict(),
  workspace: z.object({
    root: z.string().min(1),
    displayName: z.string().min(1),
  }).strict(),
  csrfToken: z.string().min(32),
  catalog: catalogSnapshotSchema,
  modelCatalog: modelCatalogSchema,
  features: z.array(featureSummarySchema),
}).strict();

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  apiVersion: z.literal(WEB_API_VERSION),
  startedAt: z.string().datetime({ offset: true }),
}).strict();

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
  retry: z.object({
    kind: z.enum(["none", "same-request", "after-refresh", "after-user-action"]),
    maxAttempts: z.literal(1).optional(),
    discoveryEndpoint: z.string().optional(),
    copyField: z.string().optional(),
  }).strict(),
}).strict();

export const webEventTypeSchema = z.enum([
  "server.ready",
  "catalog.invalidated",
  "operation.changed",
  "play.narration.delta",
  "play.narration.completed",
  "play.message.appended",
  "interaction.requested",
  "interaction.resolved",
  "model.catalog.changed",
]);

export const webEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().regex(/^\d+$/),
  occurredAt: z.string().datetime({ offset: true }),
  type: webEventTypeSchema,
  operationId: z.string().optional(),
  runId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
}).strict();

export const operationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const operationKindSchema = z.enum([
  "player-move",
  "scene-narration",
  "narration-retry",
  "provider-login",
  "prepare",
  "instance-create",
  "branch-fork",
  "instance-remove",
  "analysis-reset",
  "novel-remove",
]);

export const operationSnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  kind: operationKindSchema,
  scopeId: z.string().min(1),
  clientRequestId: z.string().min(1),
  requestFingerprint: z.string().min(1),
  runId: z.string().min(1).optional(),
  status: operationStatusSchema,
  cancellable: z.boolean(),
  commitBoundaryCrossed: z.boolean(),
  phase: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  progress: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: apiErrorSchema.optional(),
}).strict();

export const operationAcceptedSchema = z.object({
  operation: operationSnapshotSchema,
  reused: z.boolean(),
}).strict();

export const sourceRegistrationRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/u.test(value), {
    message: "Source title must fit on one line.",
  }),
  content: z.string().min(1).max(25_000_000),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const preparationStageSchema = z.enum([
  "needs-source",
  "choose-source",
  "compile",
  "review",
  "repair",
  "needs-initial-world",
  "create-branch",
  "ready",
]);

export const preparationNextActionSchema = z.enum([
  "register-source",
  "choose-source",
  "compile",
  "review-proposals",
  "repair-analysis",
  "generate-initial-world",
  "create-instance",
  "play",
]);

export const proposalStatusSchema = z.enum(["pending", "accepted", "rejected"]);

export const proposalSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  worker: z.string().min(1),
  status: proposalStatusSchema,
}).strict();

export const proposalPageSchema = z.object({
  version: z.literal(1),
  items: z.array(proposalSummarySchema),
  page: z.object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    loaded: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).nullable(),
  }).strict(),
  facets: z.object({
    kinds: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
}).strict();

export const compilerReadinessSchema = z.object({
  structural: z.enum(["ready", "not-ready", "unknown"]),
  evidence: z.enum(["ready", "not-ready", "unknown"]),
  accounting: z.enum(["ready", "not-ready", "unknown"]),
  resolution: z.enum(["ready", "not-ready", "unknown"]),
  semantic: z.enum(["ready", "not-ready", "unknown"]),
  runtime: z.enum(["ready", "not-ready", "unknown"]),
  publication: z.enum(["ready", "not-ready", "unknown"]),
  unknownDimensions: z.array(z.string()),
  blockingIssues: z.array(z.string()),
}).strict();

export const compilerAuditSummarySchema = z.object({
  canonical: z.object({
    entities: z.number().int().nonnegative(),
    propositions: z.number().int().nonnegative(),
    attributions: z.number().int().nonnegative(),
    claims: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    eventParticipations: z.number().int().nonnegative(),
    eventRelations: z.number().int().nonnegative(),
    spatialRelations: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    initialWorld: z.boolean(),
    characterGoals: z.number().int().nonnegative(),
    characterModels: z.number().int().nonnegative(),
    possibilities: z.number().int().nonnegative(),
  }).strict(),
  evidence: z.object({
    artifactsChecked: z.number().int().nonnegative(),
    referencesChecked: z.number().int().nonnegative(),
    invalidReferences: z.number().int().nonnegative(),
    assertionsChecked: z.number().int().nonnegative(),
    invalidAssertions: z.number().int().nonnegative(),
    exactBindingRatio: z.number().min(0).max(1).nullable(),
  }).strict(),
  observations: z.object({
    structuralUnits: z.number().int().nonnegative(),
    accountedUnits: z.number().int().nonnegative(),
    unaccountedUnits: z.number().int().nonnegative(),
    blockingUnits: z.number().int().nonnegative(),
    unitCoverage: z.number().min(0).max(1).nullable(),
    byteCoverage: z.number().min(0).max(1).nullable(),
  }).strict(),
  consistency: z.object({
    causalGraphValid: z.boolean().nullable(),
    narrativeGraphNavigable: z.boolean().nullable(),
    semanticReady: z.boolean().nullable(),
    causalComponents: z.number().int().nonnegative(),
    semanticIssues: z.array(z.string()),
  }).strict(),
  readiness: compilerReadinessSchema,
  notes: z.array(z.string()),
}).strict();

export const preparationSnapshotSchema = z.object({
  version: z.literal(1),
  source: novelSummarySchema,
  branchId: z.string().min(1),
  stage: preparationStageSchema,
  nextAction: preparationNextActionSchema,
  progress: z.object({
    completedBatches: z.number().int().nonnegative(),
    totalBatches: z.number().int().nonnegative(),
    remainingBatches: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
  }).strict(),
  proposalCounts: z.object({
    pending: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }).strict(),
  repairReasons: z.array(z.string()),
  closure: z.object({
    subjectSnapshotHash: z.string(), entryReady: z.boolean(), fullNovelReady: z.boolean(),
    majorTotal: z.number().int().nonnegative(), readyTotal: z.number().int().nonnegative(),
    evaluation: z.enum(["not-run", "blocked", "passed"]), roles: z.array(preparedPlayRoleSchema),
    issues: z.array(z.object({ code: z.string(), message: z.string(), path: z.string().optional() }).strict()),
  }).strict().optional(),
  audit: compilerAuditSummarySchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const sourceRegistrationResultSchema = z.object({
  source: novelSummarySchema,
  segmentCount: z.number().int().nonnegative(),
  structuralUnitCount: z.number().int().nonnegative(),
  reused: z.boolean(),
  preparation: preparationSnapshotSchema,
}).strict();

export const prepareNovelRequestSchema = z.object({
  mode: z.enum(["next", "all"]),
  branchId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const proposalDetailSchema = z.object({
  summary: proposalSummarySchema,
  envelope: z.record(z.string(), z.unknown()),
  rejection: z.object({
    version: z.literal(1),
    proposalId: z.string().min(1),
    kind: z.string().min(1),
    rejectedAt: z.string().datetime({ offset: true }),
    errors: z.array(z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      path: z.string().optional(),
    }).strict()).min(1),
  }).strict().nullable(),
}).strict();

export const proposalAcceptRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const proposalRejectRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const proposalDecisionResultSchema = z.object({
  proposalId: z.string().min(1),
  kind: z.string().min(1),
  status: proposalStatusSchema,
  accepted: z.boolean(),
  reused: z.boolean(),
  errors: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().optional(),
  }).strict()),
  warnings: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().optional(),
  }).strict()),
}).strict();

export const proposalConvergeRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const proposalConvergenceResultSchema = z.object({
  sourceId: z.string().min(1),
  counts: z.object({
    accepted: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    staging: z.number().int().nonnegative(),
  }).strict(),
  acceptedPreview: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1) }).strict()).max(50),
  blockedPreview: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    errors: z.array(z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      path: z.string().optional(),
    }).strict()),
  }).strict()).max(50),
  stagingPreview: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1) }).strict()).max(50),
  truncated: z.boolean(),
  reused: z.boolean(),
}).strict();

export const branchIdSchema = z.string().trim().min(1).max(200).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "Branch IDs may contain only letters, numbers, '.', '_', and '-'.",
);

export const createInstanceRequestSchema = z.object({
  sourceId: z.string().min(1),
  branchId: branchIdSchema,
  entryActorId: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const createInstanceResultSchema = z.object({
  instance: instanceSummarySchema,
  created: z.boolean(),
  reused: z.boolean(),
  usedCanonicalInitial: z.boolean(),
  preparedRevisionHash: z.string().min(1).optional(),
}).strict();

export const forkInstanceRequestSchema = z.object({
  newBranchId: branchIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  fromCommit: z.string().min(1).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const forkInstanceResultSchema = z.object({
  instance: instanceSummarySchema,
  parentBranchId: z.string().min(1),
  forkCommitId: z.string().min(1),
  created: z.boolean(),
  reused: z.boolean(),
}).strict();

export const instanceHistoryEventSchema = z.object({
  hash: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string().min(1),
  possibilityId: z.string().min(1).optional(),
}).strict();

export const instanceHistoryCommitSchema = z.object({
  id: z.string().min(1),
  parentCommitId: z.string().min(1).optional(),
  logicalStep: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  events: z.array(instanceHistoryEventSchema),
}).strict();

export const instanceDetailSchema = z.object({
  instance: instanceSummarySchema,
  history: z.array(instanceHistoryCommitSchema),
}).strict();

export const maintenanceActionSchema = z.enum(["remove-instance", "reset-analysis", "remove-novel"]);

export const removalEffectSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  disposition: z.enum(["remove", "modify", "preserve"]),
  count: z.number().int().nonnegative(),
  itemIds: z.array(z.string()).default([]),
  detail: z.string().min(1),
}).strict();

export const removalPreviewSchema = z.object({
  version: z.literal(1),
  action: maintenanceActionSchema,
  target: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    confirmation: z.string().min(1),
  }).strict(),
  effectHash: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.boolean(),
  blockers: z.array(z.string()),
  effects: z.array(removalEffectSchema).min(1),
}).strict();

export const executeRemovalRequestSchema = z.object({
  effectHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const removalExecutionResultSchema = z.object({
  version: z.literal(1),
  action: maintenanceActionSchema,
  targetId: z.string().min(1),
  effectHash: z.string().regex(/^[a-f0-9]{64}$/),
  completed: z.literal(true),
  removed: z.object({
    branches: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    conversationMessages: z.number().int().nonnegative(),
    canonicalArtifacts: z.number().int().nonnegative(),
    actorArtifacts: z.number().int().nonnegative(),
    possibilities: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative(),
    sourceRegistrations: z.number().int().nonnegative(),
  }).strict(),
  immutableSourcePreserved: z.literal(true),
  tracesPreserved: z.literal(true),
}).strict();

export const ontologyViewSchema = z.enum(["model", "events", "places", "rules", "provenance"]);
export const ontologyLayerSchema = z.enum(["canonical", "branch", "possibility", "proposal", "evidence"]);
export const ontologyStatusSchema = z.enum([
  "canonical",
  "active",
  "inactive",
  "branch-committed",
  "possibility",
  "proposal",
  "contested",
  "rejected",
]);

export const ontologyScopeSchema = z.object({
  sourceId: z.string().min(1),
  view: ontologyViewSchema,
  branchId: z.string().min(1).optional(),
  atCommit: z.string().min(1).optional(),
  branchHead: z.string().min(1).optional(),
  includeCanonicalFuture: z.boolean(),
  layers: z.array(ontologyLayerSchema),
}).strict();

export const ontologyEvidenceSchema = z.object({
  sourceId: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startByte: z.number().int().nonnegative().optional(),
  endByte: z.number().int().nonnegative().optional(),
  quoteHash: z.string().min(1),
  strength: z.enum(["explicit", "strong-inference", "weak-inference"]),
  excerpt: z.string().optional(),
  excerptTruncated: z.boolean().optional(),
}).strict();

export const ontologyNodeSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  status: ontologyStatusSchema,
  layer: ontologyLayerSchema,
  revisionHash: z.string().min(1).optional(),
  evidenceCount: z.number().int().nonnegative(),
  shared: z.boolean(),
  storyTime: z.unknown().optional(),
  summary: z.record(z.string(), z.unknown()),
  detailsEndpoint: z.string().min(1),
}).strict();

export const ontologyAssociationSchema = z.object({
  node: ontologyNodeSchema,
  relationLabels: z.array(z.string().min(1)).min(1),
  contextLabels: z.array(z.string().min(1)),
  evidenceCount: z.number().int().nonnegative(),
}).strict();

export const ontologyEdgeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  status: ontologyStatusSchema,
  layer: ontologyLayerSchema,
  evidenceCount: z.number().int().nonnegative(),
  storyTime: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()),
}).strict();

export const ontologyGraphSchema = z.object({
  version: z.literal(1),
  scope: ontologyScopeSchema,
  nodes: z.array(ontologyNodeSchema),
  edges: z.array(ontologyEdgeSchema),
  legend: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    color: z.string().min(1),
    count: z.number().int().nonnegative(),
  }).strict()),
  facets: z.object({
    kinds: z.record(z.string(), z.number().int().nonnegative()),
    statuses: z.record(z.string(), z.number().int().nonnegative()),
    layers: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
  totalNodes: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  truncated: z.boolean(),
  page: z.object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    newNodes: z.number().int().nonnegative(),
    loadedNodes: z.number().int().nonnegative(),
    loadedEdges: z.number().int().nonnegative(),
    remainingEdges: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).nullable(),
    relationshipMode: z.literal("prefix-complete"),
    requiredNodeIds: z.array(z.string()),
  }).strict(),
  diagnostics: z.array(z.string()),
}).strict();

export const ontologyNodeDetailSchema = z.object({
  version: z.literal(1),
  scope: ontologyScopeSchema,
  node: ontologyNodeSchema,
  payload: z.unknown(),
  evidence: z.array(ontologyEvidenceSchema),
  incoming: z.array(ontologyEdgeSchema),
  outgoing: z.array(ontologyEdgeSchema),
  relatedNodes: z.array(ontologyNodeSchema),
  associations: z.array(ontologyAssociationSchema),
  relationPage: z.object({
    limitPerDirection: z.number().int().positive(),
    incomingTotal: z.number().int().nonnegative(),
    outgoingTotal: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
}).strict();

export const createPlaySessionRequestSchema = z.object({
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

/** Roles grounded in the active immutable base, independent of any branch head. */
export const sourcePlayRoleSchema = preparedPlayRoleSchema;

export const sourcePlayRoleListSchema = z.object({
  sourceId: z.string().min(1),
  sourceTitle: z.string().min(1),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  majorTotal: z.number().int().nonnegative(),
  readyMajorTotal: z.number().int().nonnegative(),
  roles: z.array(sourcePlayRoleSchema),
}).strict();

export const startFreshPlayRequestSchema = z.object({
  sourceId: z.string().min(1),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  actorId: z.string().min(1),
  entryCutHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(200).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const playableCharacterSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  aliases: z.array(z.string()),
  alive: z.boolean().optional(),
  locationId: z.string().optional(),
  locationName: z.string().optional(),
  sourceIds: z.array(z.string()),
  availability: z.enum(["current-head", "entry-checkpoint"]).optional(),
  entryKind: z.enum(["opening", "canonical-scene"]).optional(),
  entryTitle: z.string().min(1).optional(),
}).strict();

export const playableCharacterListSchema = z.object({
  branchId: z.string().min(1),
  sourceId: z.string().optional(),
  sourceTitle: z.string().optional(),
  characters: z.array(playableCharacterSchema),
}).strict();

export const updatePlaySessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["idle", "archived"]).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict().refine((value) => value.title !== undefined || value.status !== undefined, {
  message: "At least one play-session field must be updated.",
});

export const playSessionCommandRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const enterPlaySessionRequestSchema = z.object({
  intent: z.enum(["play", "create", "switch", "continue", "resume", "startup"]),
}).strict();

export const playSessionEntryResultSchema = z.object({
  sessionId: z.string().min(1),
  state: z.enum(["ready", "starting", "recovery-required", "unavailable"]),
  reason: z.enum([
    "scene-present",
    "scene-started",
    "scene-operation-active",
    "scene-operation-failed",
    "prior-session-activity",
    "entry-does-not-request-scene",
    "session-not-writable",
  ]),
  sceneRequest: z.enum(["auto", "continue", "none", "opening", "orientation", "turn", "blocked", "recovery"]).optional(),
  purpose: z.enum(["opening", "orientation", "turn", "blocked", "recovery"]).optional(),
  operation: operationSnapshotSchema.optional(),
}).strict();

export const playMoveRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  intent: z.enum(["act", "observe", "reflect", "wait"]).optional(),
  affordanceId: z.string().min(1).optional(),
  expectedHead: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const sceneNarrationRequestSchema = z.object({
  purpose: z.enum(["auto", "opening", "orientation", "turn", "blocked", "recovery"]),
  expectedHead: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const narrationRetryRequestSchema = z.object({
  sourceRunId: z.string().min(1),
  expectedHead: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const playMessageSummarySchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  atCommit: z.string().min(1),
  eventId: z.string().optional(),
  runId: z.string().optional(),
  playerMoveId: z.string().optional(),
  role: z.enum(["player", "scene"]),
  status: z.enum(["accepted", "rejected", "rendered"]),
  text: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const playSessionDetailSchema = z.object({
  session: playSessionSummarySchema,
  headCommitId: z.string().min(1).nullable(),
  messages: z.array(playMessageSummarySchema),
}).strict();

export const startFreshPlayResultSchema = z.object({
  instance: instanceSummarySchema,
  session: playSessionDetailSchema,
  base: frozenWorldBaseSchema,
  reused: z.boolean(),
}).strict();

export const playerChoiceSummarySchema = z.object({
  action: z.string().min(1),
  affordanceId: z.string().optional(),
}).strict();

export const playOperationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  playerMoveId: z.string().min(1),
  accepted: z.boolean(),
  stage: z.string().min(1),
  previousHead: z.string().min(1),
  finalHead: z.string().min(1),
  logicalStep: z.number().int().nonnegative(),
  narrationStatus: z.enum(["rendered", "failed", "skipped"]),
  narration: z.string().optional(),
  narrationError: z.string().optional(),
  warnings: z.array(z.string()),
  choices: z.array(playerChoiceSummarySchema),
  issues: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
  auditId: z.string().optional(),
  eventHash: z.string().optional(),
  worldResponseEvents: z.array(z.object({ eventHash: z.string(), title: z.string(), possibilityId: z.string() }).strict()),
  reactionEvents: z.array(z.object({ eventHash: z.string(), title: z.string(), actorId: z.string() }).passthrough()),
  backgroundEvents: z.array(z.object({ eventHash: z.string(), title: z.string() }).strict()),
}).strict();

export const sceneNarrationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  headCommitId: z.string().min(1),
  purpose: z.enum(["opening", "orientation", "turn", "blocked", "recovery"]),
  narrationStatus: z.enum(["rendered", "failed", "skipped"]),
  narration: z.string().optional(),
  narrationError: z.string().optional(),
  choices: z.array(playerChoiceSummarySchema),
}).strict();

export const narrationRetryResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  sourceRunId: z.string().min(1),
  playerMoveId: z.string().min(1),
  headCommitId: z.string().min(1),
  narrationStatus: z.literal("rendered"),
  narration: z.string().min(1),
  choices: z.array(playerChoiceSummarySchema),
}).strict();

export const removePlaySessionResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  branchPreserved: z.literal(true),
  conversationRemoved: z.boolean(),
}).strict();

export const clearPlayConversationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  branchPreserved: z.literal(true),
  cleared: z.literal(true),
}).strict();

export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type NovelSummary = z.infer<typeof novelSummarySchema>;
export type InstanceSummary = z.infer<typeof instanceSummarySchema>;
export type PlaySessionSummary = z.infer<typeof playSessionSummarySchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ModelRole = z.infer<typeof modelRoleSchema>;
export type ModelProfileSummary = z.infer<typeof modelProfileSummarySchema>;
export type ModelProfileList = z.infer<typeof modelProfileListSchema>;
export type UpdateModelProfileRequest = z.infer<typeof updateModelProfileRequestSchema>;
export type ProviderCredentialRequest = z.infer<typeof providerCredentialRequestSchema>;
export type ProviderLoginRequest = z.infer<typeof providerLoginRequestSchema>;
export type AuthInteractionPrompt = z.infer<typeof authInteractionPromptSchema>;
export type AuthInteractionSnapshot = z.infer<typeof authInteractionSnapshotSchema>;
export type AnswerAuthInteractionRequest = z.infer<typeof answerAuthInteractionRequestSchema>;
export type ProviderCredentialResult = z.infer<typeof providerCredentialResultSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type WebEventType = z.infer<typeof webEventTypeSchema>;
export type WebEvent = z.infer<typeof webEventSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type OperationKind = z.infer<typeof operationKindSchema>;
export type OperationSnapshot = z.infer<typeof operationSnapshotSchema>;
export type OperationAccepted = z.infer<typeof operationAcceptedSchema>;
export type SourceRegistrationRequest = z.infer<typeof sourceRegistrationRequestSchema>;
export type PreparationStage = z.infer<typeof preparationStageSchema>;
export type PreparationNextAction = z.infer<typeof preparationNextActionSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalSummary = z.infer<typeof proposalSummarySchema>;
export type ProposalPage = z.infer<typeof proposalPageSchema>;
export type CompilerAuditSummary = z.infer<typeof compilerAuditSummarySchema>;
export type PreparationSnapshot = z.infer<typeof preparationSnapshotSchema>;
export type SourceRegistrationResult = z.infer<typeof sourceRegistrationResultSchema>;
export type PrepareNovelRequest = z.infer<typeof prepareNovelRequestSchema>;
export type ProposalDetail = z.infer<typeof proposalDetailSchema>;
export type ProposalAcceptRequest = z.infer<typeof proposalAcceptRequestSchema>;
export type ProposalRejectRequest = z.infer<typeof proposalRejectRequestSchema>;
export type ProposalDecisionResult = z.infer<typeof proposalDecisionResultSchema>;
export type ProposalConvergeRequest = z.infer<typeof proposalConvergeRequestSchema>;
export type ProposalConvergenceResult = z.infer<typeof proposalConvergenceResultSchema>;
export type CreateInstanceRequest = z.infer<typeof createInstanceRequestSchema>;
export type CreateInstanceResult = z.infer<typeof createInstanceResultSchema>;
export type ForkInstanceRequest = z.infer<typeof forkInstanceRequestSchema>;
export type ForkInstanceResult = z.infer<typeof forkInstanceResultSchema>;
export type InstanceHistoryEvent = z.infer<typeof instanceHistoryEventSchema>;
export type InstanceHistoryCommit = z.infer<typeof instanceHistoryCommitSchema>;
export type InstanceDetail = z.infer<typeof instanceDetailSchema>;
export type MaintenanceAction = z.infer<typeof maintenanceActionSchema>;
export type RemovalEffect = z.infer<typeof removalEffectSchema>;
export type RemovalPreview = z.infer<typeof removalPreviewSchema>;
export type ExecuteRemovalRequest = z.infer<typeof executeRemovalRequestSchema>;
export type RemovalExecutionResult = z.infer<typeof removalExecutionResultSchema>;
export type OntologyView = z.infer<typeof ontologyViewSchema>;
export type OntologyLayer = z.infer<typeof ontologyLayerSchema>;
export type OntologyStatus = z.infer<typeof ontologyStatusSchema>;
export type OntologyScope = z.infer<typeof ontologyScopeSchema>;
export type OntologyEvidence = z.infer<typeof ontologyEvidenceSchema>;
export type OntologyNode = z.infer<typeof ontologyNodeSchema>;
export type OntologyEdge = z.infer<typeof ontologyEdgeSchema>;
export type OntologyGraph = z.infer<typeof ontologyGraphSchema>;
export type OntologyAssociation = z.infer<typeof ontologyAssociationSchema>;
export type OntologyNodeDetail = z.infer<typeof ontologyNodeDetailSchema>;
export type CreatePlaySessionRequest = z.infer<typeof createPlaySessionRequestSchema>;
export type SourcePlayRole = z.infer<typeof sourcePlayRoleSchema>;
export type SourcePlayRoleList = z.infer<typeof sourcePlayRoleListSchema>;
export type StartFreshPlayRequest = z.infer<typeof startFreshPlayRequestSchema>;
export type StartFreshPlayResult = z.infer<typeof startFreshPlayResultSchema>;
export type PlayableCharacter = z.infer<typeof playableCharacterSchema>;
export type PlayableCharacterList = z.infer<typeof playableCharacterListSchema>;
export type UpdatePlaySessionRequest = z.infer<typeof updatePlaySessionRequestSchema>;
export type PlaySessionCommandRequest = z.infer<typeof playSessionCommandRequestSchema>;
export type EnterPlaySessionRequest = z.infer<typeof enterPlaySessionRequestSchema>;
export type PlaySessionEntryResult = z.infer<typeof playSessionEntryResultSchema>;
export type PlayMoveRequest = z.infer<typeof playMoveRequestSchema>;
export type SceneNarrationRequest = z.infer<typeof sceneNarrationRequestSchema>;
export type NarrationRetryRequest = z.infer<typeof narrationRetryRequestSchema>;
export type PlayMessageSummary = z.infer<typeof playMessageSummarySchema>;
export type PlaySessionDetail = z.infer<typeof playSessionDetailSchema>;
export type PlayerChoiceSummary = z.infer<typeof playerChoiceSummarySchema>;
export type PlayOperationResult = z.infer<typeof playOperationResultSchema>;
export type SceneNarrationResult = z.infer<typeof sceneNarrationResultSchema>;
export type NarrationRetryResult = z.infer<typeof narrationRetryResultSchema>;
export type RemovePlaySessionResult = z.infer<typeof removePlaySessionResultSchema>;
export type ClearPlayConversationResult = z.infer<typeof clearPlayConversationResultSchema>;
