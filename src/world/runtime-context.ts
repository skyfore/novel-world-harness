import { z } from "zod";
import { contentHash } from "./canonical.js";
import { idSchema, type ValidationIssue } from "./model.js";

export const runtimeContextDomainSchema = z.enum([
  "identity",
  "reference",
  "current-state",
  "actor-memory",
  "spatial",
  "world-rule",
  "causality",
  "relationship",
  "artifact-provenance",
  "characterization",
  "literary-texture",
]);
export type RuntimeContextDomain = z.infer<typeof runtimeContextDomainSchema>;

export const runtimeContextAudienceSchema = z.enum(["actor", "world", "reader", "style", "unknown"]);
export type RuntimeContextAudience = z.infer<typeof runtimeContextAudienceSchema>;

/**
 * Model-authored request for more evidence. It contains no branch/source IDs,
 * offsets, or authority claims; the host binds all of those after capture.
 */
export const runtimeContextRequestSchema = z.object({
  decision: z.literal("needs-context"),
  domain: runtimeContextDomainSchema,
  question: z.string().trim().min(1).max(1_000),
  audience: runtimeContextAudienceSchema,
  searchTerms: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
}).strict();
export type RuntimeContextRequest = z.infer<typeof runtimeContextRequestSchema>;

export const runtimeContextNeedSchema = runtimeContextRequestSchema.omit({ decision: true }).extend({
  version: z.literal(1),
  id: idSchema,
  requestedBy: z.enum(["translation", "adjudication", "narration"]),
  retryAt: z.enum(["translation", "adjudication", "none"]),
  issueCodes: z.array(z.string().trim().min(1).max(240)).max(32),
}).strict();
export type RuntimeContextNeed = z.infer<typeof runtimeContextNeedSchema>;

export const runtimeContextArtifactRefSchema = z.object({
  kind: idSchema,
  id: idSchema,
}).strict();
export type RuntimeContextArtifactRef = z.infer<typeof runtimeContextArtifactRefSchema>;

export const runtimeContextFindingProposalSchema = z.object({
  statement: z.string().trim().min(1).max(1_500),
  passageRefs: z.array(z.string().regex(/^source-unit:[A-Za-z0-9][A-Za-z0-9._-]*$/)).min(1).max(8),
  artifactRefs: z.array(runtimeContextArtifactRefSchema).max(16).default([]),
  temporalClass: z.enum(["prior", "current", "future", "unknown"]),
  audiences: z.array(runtimeContextAudienceSchema).min(1).max(5),
}).strict();
export type RuntimeContextFindingProposal = z.infer<typeof runtimeContextFindingProposalSchema>;

export const runtimeContextProposalSchema = z.object({
  version: z.literal(1),
  needId: idSchema,
  conclusion: z.enum(["found", "ambiguous", "not-found"]),
  findings: z.array(runtimeContextFindingProposalSchema).max(12),
  summary: z.string().trim().min(1).max(1_500),
}).strict().superRefine((value, ctx) => {
  if (value.conclusion === "found" && value.findings.length === 0) {
    ctx.addIssue({ code: "custom", path: ["findings"], message: "A found consultation requires at least one cited finding" });
  }
  if (value.conclusion === "not-found" && value.findings.length > 0) {
    ctx.addIssue({ code: "custom", path: ["findings"], message: "A not-found consultation cannot contain findings" });
  }
});
export type RuntimeContextProposal = z.infer<typeof runtimeContextProposalSchema>;

export const runtimeContextAdmissionStatusSchema = z.enum([
  "admitted",
  "presentation-only",
  "repair-only",
  "future-only",
  "ambiguous",
  "not-found",
  "unavailable",
]);
export type RuntimeContextAdmissionStatus = z.infer<typeof runtimeContextAdmissionStatusSchema>;

export const runtimeContextFactSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  authority: z.enum(["actor-visible", "committed-world", "turn-reference"]),
  basis: z.array(runtimeContextArtifactRefSchema).min(1).max(16),
}).strict();
export type RuntimeContextFact = z.infer<typeof runtimeContextFactSchema>;

export const runtimeNarrativeContextSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  authority: z.literal("presentation-only"),
  evidenceRefs: z.array(z.string().regex(/^source-unit:[A-Za-z0-9][A-Za-z0-9._-]*$/)).min(1).max(8),
  safety: z.literal("frozen-current-or-prior-evidence"),
}).strict();
export type RuntimeNarrativeContext = z.infer<typeof runtimeNarrativeContextSchema>;

export const runtimeContextSupplementSchema = z.object({
  version: z.literal(1),
  translation: z.array(runtimeContextFactSchema).max(12),
  adjudication: z.array(runtimeContextFactSchema).max(12),
  choice: z.array(runtimeContextFactSchema).max(12),
  narrative: z.array(runtimeNarrativeContextSchema).max(12),
}).strict().superRefine((value, ctx) => {
  value.translation.forEach((fact, index) => {
    if (fact.authority === "committed-world") {
      ctx.addIssue({ code: "custom", path: ["translation", index, "authority"], message: "Translation context must be actor-visible or turn-reference only" });
    }
  });
  value.adjudication.forEach((fact, index) => {
    if (fact.authority === "turn-reference") {
      ctx.addIssue({ code: "custom", path: ["adjudication", index, "authority"], message: "Turn-reference context cannot become world-adjudication authority" });
    }
  });
  value.choice.forEach((fact, index) => {
    if (fact.authority !== "actor-visible") {
      ctx.addIssue({ code: "custom", path: ["choice", index, "authority"], message: "Choice context must be actor-visible" });
    }
  });
});
export type RuntimeContextSupplement = z.infer<typeof runtimeContextSupplementSchema>;

export const runtimeCompilerRepairHintSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  branchId: idSchema,
  atCommit: idSchema,
  need: runtimeContextNeedSchema,
  summary: z.string().trim().min(1).max(1_500),
  evidenceRefs: z.array(z.string().regex(/^source-unit:[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(32),
  artifactRefs: z.array(runtimeContextArtifactRefSchema).max(64),
}).strict();
export type RuntimeCompilerRepairHint = z.infer<typeof runtimeCompilerRepairHintSchema>;

export const runtimeContextConsultationRecordSchema = z.object({
  version: z.literal(1),
  need: runtimeContextNeedSchema,
  status: runtimeContextAdmissionStatusSchema,
  sourceId: idSchema.optional(),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  proposalSummary: z.string().trim().min(1).max(1_500),
  evidenceRefs: z.array(z.string().regex(/^source-unit:[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(32),
  artifactRefs: z.array(runtimeContextArtifactRefSchema).max(64),
  retryRecommended: z.boolean(),
}).strict();
export type RuntimeContextConsultationRecord = z.infer<typeof runtimeContextConsultationRecordSchema>;

export const runtimeContextConsultationResultSchema = z.object({
  record: runtimeContextConsultationRecordSchema,
  supplement: runtimeContextSupplementSchema,
  repairHints: z.array(runtimeCompilerRepairHintSchema).max(12),
}).strict();
export type RuntimeContextConsultationResult = z.infer<typeof runtimeContextConsultationResultSchema>;

export type RuntimeContextConsultationInput = Readonly<{
  need: RuntimeContextNeed;
  branchId: string;
  actorId: string;
  expectedHead: string;
  sourceId?: string;
  utterance: string;
  /** Actor-safe projection; it remains the upper bound for actor-facing admissions. */
  actorContext: unknown;
  /** Uncommitted proposal data, supplied only to focus retrieval. */
  candidate?: unknown;
  /** Relevant current-world slice, supplied only for adjudication requests. */
  world?: unknown;
}>;

/** Trusted host-side orchestration boundary. Model output inside an implementation remains a proposal. */
export type RuntimeContextResolver = (
  input: RuntimeContextConsultationInput,
) => Promise<RuntimeContextConsultationResult> | RuntimeContextConsultationResult;

/** Optional host observability hooks; they carry no admission or mutation authority. */
export type RuntimeContextConsultationObserver = Readonly<{
  onGapDetected?: (need: RuntimeContextNeed) => Promise<void> | void;
  onSupplementValidated?: (result: RuntimeContextConsultationResult) => Promise<void> | void;
}>;

const GAP_ELIGIBLE_CODES = new Set([
  "PLAYER_PRECONDITION_UNGROUNDED",
  "PLAYER_SPATIAL_ORIGIN_UNKNOWN",
  "PLAYER_SPATIAL_CONTEXT_UNKNOWN",
  "PLAYER_SPATIAL_ROUTE_UNPROVEN",
  "SPATIAL_LOCATION_REQUIRED",
  "SPATIAL_ROUTE_UNPROVEN",
  "PLAYER_ENTITY_OUT_OF_SCOPE",
]);

export function isRuntimeContextGapIssue(issue: Pick<ValidationIssue, "code">): boolean {
  return GAP_ELIGIBLE_CODES.has(issue.code);
}

/**
 * Deterministic trigger: mixed or definitive failures never get relabelled as
 * missing data. This prevents source consultation from becoming a bypass for
 * capability, knowledge, stale-head, or rule enforcement.
 */
export function runtimeContextNeedForIssues(
  requestedBy: "translation" | "adjudication",
  utterance: string,
  issues: readonly ValidationIssue[],
): RuntimeContextNeed | undefined {
  if (!issues.length || !issues.every(isRuntimeContextGapIssue)) return undefined;
  const codes = [...new Set(issues.map((entry) => entry.code))].sort();
  const domain: RuntimeContextDomain = codes.some((code) => code.startsWith("PLAYER_SPATIAL_") || code.startsWith("SPATIAL_"))
    ? "spatial"
    : codes.includes("PLAYER_ENTITY_OUT_OF_SCOPE")
      ? "identity"
      : "current-state";
  return materializeRuntimeContextNeed({
    decision: "needs-context",
    domain,
    question: `Resolve only the missing evidence needed to interpret this immediate player intent: ${bounded(utterance, 600)}`,
    audience: requestedBy === "translation" ? "actor" : "world",
    searchTerms: [],
  }, requestedBy, codes);
}

export function materializeRuntimeContextNeed(
  requestInput: RuntimeContextRequest,
  requestedBy: "translation" | "adjudication" | "narration",
  issueCodes: readonly string[] = [],
): RuntimeContextNeed {
  const request = runtimeContextRequestSchema.parse(requestInput);
  const retryAt = requestedBy === "narration" ? "none" : requestedBy;
  const semantic = {
    requestedBy,
    retryAt,
    domain: request.domain,
    question: request.question,
    audience: request.audience,
    searchTerms: [...new Set(request.searchTerms)].slice(0, 8),
    issueCodes: [...new Set(issueCodes)].sort(),
  };
  return runtimeContextNeedSchema.parse({
    version: 1,
    id: `context-need-${contentHash(semantic).slice(0, 24)}`,
    ...semantic,
  });
}

export function mergeRuntimeContextSupplements(
  current: RuntimeContextSupplement | undefined,
  incoming: RuntimeContextSupplement,
): RuntimeContextSupplement {
  if (!current) return runtimeContextSupplementSchema.parse(structuredClone(incoming));
  const unique = <T>(items: readonly T[]) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
  return runtimeContextSupplementSchema.parse({
    version: 1,
    translation: unique([...current.translation, ...incoming.translation]),
    adjudication: unique([...current.adjudication, ...incoming.adjudication]),
    choice: unique([...current.choice, ...incoming.choice]),
    narrative: unique([...current.narrative, ...incoming.narrative]),
  });
}

export function emptyRuntimeContextSupplement(): RuntimeContextSupplement {
  return { version: 1, translation: [], adjudication: [], choice: [], narrative: [] };
}

export function runtimeContextSupplementHasMaterial(
  supplement: RuntimeContextSupplement,
  consumer?: "translation" | "adjudication" | "choice" | "narrative",
): boolean {
  return consumer
    ? supplement[consumer].length > 0
    : supplement.translation.length + supplement.adjudication.length + supplement.choice.length + supplement.narrative.length > 0;
}

function bounded(value: string, max: number): string {
  const characters = Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " "));
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
}
