import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { idSchema } from "../../world/model.js";
import { worldStorageRoot } from "../../world/paths.js";

/**
 * Durable state of the slim compile pipeline (iteration 02, design 5).
 *
 * One small JSON document per concern and source. Documents are rewritten
 * atomically; none of them is a per-artifact requirement ledger. Model
 * output still enters the world only through the annotation, resolution and
 * proposal stores; these documents hold the pipeline's own decisions
 * (census classes, lexicon identity decisions, reviewed dispositions, the
 * roster review) and its scope receipts.
 */
export const PIPELINE_STORE_VERSION = 1 as const;

const rangeSchema = z.object({ startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() }).strict();
export type PipelineRange = z.infer<typeof rangeSchema>;

export const CENSUS_CLASSES = ["person", "location", "organization", "object", "lore", "time", "non-entity"] as const;
export type CensusClass = typeof CENSUS_CLASSES[number];
export const censusEntrySchema = z.object({
  surface: z.string().trim().min(1).max(40),
  class: z.enum(CENSUS_CLASSES),
  occurrences: z.number().int().nonnegative(),
  firstByte: z.number().int().nonnegative(),
  /** `host` for deterministic classes (time expressions); `model` otherwise. */
  decidedBy: z.enum(["host", "model"]),
  rationale: z.string().trim().max(500).optional(),
  scopeId: z.string().min(1),
}).strict();
export type CensusEntry = z.infer<typeof censusEntrySchema>;
const censusDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), entries: z.array(censusEntrySchema) }).strict();

/** One identity decision per lexicon surface (optionally limited to a byte range), expanded by the host to every mention. */
export const lexiconDecisionSchema = z.object({
  id: idSchema,
  surface: z.string().trim().min(1).max(40),
  verdict: z.enum(["entity", "non-referential", "ambiguous"]),
  entityId: idSchema.optional(),
  aliasType: z.enum(["name", "title", "office", "kinship", "nickname", "other"]).optional(),
  /** Absent: the whole source. Present: only mentions inside these ranges (same-name characters). */
  ranges: z.array(rangeSchema).max(64).optional(),
  /** Mentions this decision does not cover; they need their own resolution. */
  exceptMentionIds: z.array(idSchema).max(256).default([]),
  rationale: z.string().trim().min(1).max(1_000),
  scopeId: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === "entity" && !value.entityId) ctx.addIssue({ code: "custom", path: ["entityId"], message: "An entity decision names its entity" });
  if (value.verdict !== "entity" && value.entityId) ctx.addIssue({ code: "custom", path: ["entityId"], message: "Only an entity decision names an entity" });
});
export type LexiconDecision = z.infer<typeof lexiconDecisionSchema>;
const lexiconDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), decisions: z.array(lexiconDecisionSchema) }).strict();

export const DISPOSITION_VERDICTS = ["not-stated", "unconditioned", "narration-only", "unknown", "no-change", "rejected-candidate"] as const;
export const pipelineDispositionSchema = z.object({
  measureId: z.string().min(1),
  subject: z.string().min(1).max(300),
  verdict: z.enum(DISPOSITION_VERDICTS),
  rationale: z.string().trim().min(1).max(1_000),
  scopeId: z.string().min(1),
}).strict();
export type PipelineDisposition = z.infer<typeof pipelineDispositionSchema>;
const dispositionDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), dispositions: z.array(pipelineDispositionSchema) }).strict();

/** Host observation candidates the model reviewed; a rejection counts as handled, an acceptance points at its annotation. */
export const candidateReviewSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(["speech", "name", "time"]),
  range: rangeSchema,
  verdict: z.enum(["accepted", "rewritten", "rejected"]),
  annotationId: idSchema.optional(),
  rationale: z.string().trim().max(500).optional(),
  scopeId: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === "rejected" && !value.rationale) ctx.addIssue({ code: "custom", path: ["rationale"], message: "A rejected candidate needs a rationale" });
  if (value.verdict !== "rejected" && !value.annotationId) ctx.addIssue({ code: "custom", path: ["annotationId"], message: "An accepted candidate points at its annotation" });
});
export type CandidateReview = z.infer<typeof candidateReviewSchema>;
const reviewDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), reviews: z.array(candidateReviewSchema) }).strict();

/**
 * Model dispositions for structure units that carry no annotation. "Represented"
 * is never declared: the host derives it from annotation coverage. A unit that
 * holds a host candidate cannot be closed as background or duplicate.
 */
export const unitAccountSchema = z.object({
  unitId: idSchema,
  status: z.enum(["background-only", "duplicate-description", "paratext"]),
  rationale: z.string().trim().min(1).max(500),
  scopeId: z.string().min(1),
}).strict();
export type UnitAccount = z.infer<typeof unitAccountSchema>;
const accountingDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), records: z.array(unitAccountSchema) }).strict();

export const rosterDocumentSchema = z.object({
  version: z.literal(PIPELINE_STORE_VERSION),
  candidates: z.array(z.object({ actorId: idSchema, name: z.string().min(1), lines: z.number().int().nonnegative(), agentEvents: z.number().int().nonnegative(), basis: z.array(z.enum(["speaking", "agent", "viewpoint"])) }).strict()),
  review: z.object({
    scopeId: z.string().min(1),
    reviewedAt: z.string().datetime(),
    majors: z.array(idSchema),
    missing: z.array(z.object({ name: z.string().trim().min(1), rationale: z.string().trim().min(1), firstByte: z.number().int().nonnegative().optional() }).strict()),
    rationale: z.string().trim().min(1).max(2_000),
  }).strict().optional(),
}).strict();
export type RosterDocument = z.infer<typeof rosterDocumentSchema>;

export const stageUsageSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cost: z.number().nonnegative(), requests: z.number().int().nonnegative() }).strict();
export type StageUsage = z.infer<typeof stageUsageSchema>;
export const emptyUsage = (): StageUsage => ({ input: 0, output: 0, cacheRead: 0, cost: 0, requests: 0 });
export function addUsage(left: StageUsage, right: StageUsage): StageUsage {
  return { input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cost: left.cost + right.cost, requests: left.requests + right.requests };
}

export const gateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), detail: z.string().max(2_000) }).strict()),
}).strict();
export type GateResult = z.infer<typeof gateResultSchema>;

export const scopeReceiptSchema = z.object({
  id: z.string().min(1).max(200),
  stage: z.string().min(1),
  range: rangeSchema,
  /** Work-item subjects for whole-source stages (world, gaps). */
  items: z.array(z.string()).max(512).default([]),
  status: z.enum(["running", "completed", "held"]),
  attempts: z.number().int().nonnegative(),
  gate: gateResultSchema.optional(),
  usage: stageUsageSchema,
  traceRunIds: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().max(4_000).optional(),
}).strict();
export type ScopeReceipt = z.infer<typeof scopeReceiptSchema>;
const receiptsDocumentSchema = z.object({ version: z.literal(PIPELINE_STORE_VERSION), receipts: z.array(scopeReceiptSchema) }).strict();

/** The prefix this source is compiled through (design 5.1 prefix compile). */
export const pipelineRunSchema = z.object({
  version: z.literal(PIPELINE_STORE_VERSION),
  sourceId: idSchema,
  limit: z.number().int().positive(),
  throughChapter: z.number().int().positive().optional(),
  throughByte: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export function pipelineRoot(workspaceRoot: string): string {
  return path.join(worldStorageRoot(workspaceRoot), "compiler", "pipeline", `v${PIPELINE_STORE_VERSION}`);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Per-source pipeline documents. Callers hold the workspace compiler lock. */
export class PipelineStore {
  readonly directory: string;
  constructor(readonly workspaceRoot: string, readonly sourceId: string) {
    this.directory = path.join(pipelineRoot(workspaceRoot), idSchema.parse(sourceId));
  }

  private async read<T>(name: string, schema: z.ZodType<T>, empty: T): Promise<T> {
    try { return schema.parse(JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw error; }
  }
  private async write<T>(name: string, schema: z.ZodType<T>, value: T): Promise<void> {
    await writeJsonAtomic(path.join(this.directory, name), schema.parse(value));
  }

  async census(): Promise<CensusEntry[]> { return (await this.read("census.json", censusDocumentSchema, { version: 1, entries: [] })).entries; }
  /** Upsert by surface: the latest classification wins. */
  async recordCensus(entries: readonly CensusEntry[]): Promise<void> {
    const current = new Map((await this.census()).map((entry) => [entry.surface, entry]));
    for (const entry of entries) current.set(entry.surface, censusEntrySchema.parse(entry));
    await this.write("census.json", censusDocumentSchema, { version: 1, entries: [...current.values()].sort((a, b) => a.firstByte - b.firstByte || a.surface.localeCompare(b.surface)) });
  }

  async lexiconDecisions(): Promise<LexiconDecision[]> { return (await this.read("lexicon.json", lexiconDocumentSchema, { version: 1, decisions: [] })).decisions; }
  /** Upsert by decision ID. */
  async recordLexiconDecisions(decisions: readonly LexiconDecision[]): Promise<void> {
    const current = new Map((await this.lexiconDecisions()).map((item) => [item.id, item]));
    for (const decision of decisions) current.set(decision.id, lexiconDecisionSchema.parse(decision));
    await this.write("lexicon.json", lexiconDocumentSchema, { version: 1, decisions: [...current.values()].sort((a, b) => a.id.localeCompare(b.id)) });
  }

  async dispositions(): Promise<PipelineDisposition[]> { return (await this.read("dispositions.json", dispositionDocumentSchema, { version: 1, dispositions: [] })).dispositions; }
  /** Upsert by (measure, subject). */
  async recordDispositions(dispositions: readonly PipelineDisposition[]): Promise<void> {
    const key = (item: PipelineDisposition) => `${item.measureId}\u0000${item.subject}`;
    const current = new Map((await this.dispositions()).map((item) => [key(item), item]));
    for (const item of dispositions) current.set(key(item), pipelineDispositionSchema.parse(item));
    await this.write("dispositions.json", dispositionDocumentSchema, { version: 1, dispositions: [...current.values()] });
  }
  async removeDispositions(predicate: (item: PipelineDisposition) => boolean): Promise<void> {
    await this.write("dispositions.json", dispositionDocumentSchema, { version: 1, dispositions: (await this.dispositions()).filter((item) => !predicate(item)) });
  }

  async candidateReviews(): Promise<CandidateReview[]> { return (await this.read("candidate-reviews.json", reviewDocumentSchema, { version: 1, reviews: [] })).reviews; }
  async recordCandidateReviews(reviews: readonly CandidateReview[]): Promise<void> {
    const current = new Map((await this.candidateReviews()).map((item) => [item.candidateId, item]));
    for (const review of reviews) current.set(review.candidateId, candidateReviewSchema.parse(review));
    await this.write("candidate-reviews.json", reviewDocumentSchema, { version: 1, reviews: [...current.values()].sort((a, b) => a.range.startByte - b.range.startByte || a.candidateId.localeCompare(b.candidateId)) });
  }

  async unitAccounts(): Promise<UnitAccount[]> { return (await this.read("accounting.json", accountingDocumentSchema, { version: 1, records: [] })).records; }
  async recordUnitAccounts(records: readonly UnitAccount[]): Promise<void> {
    const current = new Map((await this.unitAccounts()).map((item) => [item.unitId, item]));
    for (const record of records) current.set(record.unitId, unitAccountSchema.parse(record));
    await this.write("accounting.json", accountingDocumentSchema, { version: 1, records: [...current.values()] });
  }

  async roster(): Promise<RosterDocument | null> {
    const value = await this.read<RosterDocument | null>("roster.json", rosterDocumentSchema.nullable(), null);
    return value;
  }
  async writeRoster(roster: RosterDocument): Promise<void> { await this.write("roster.json", rosterDocumentSchema, roster); }

  async receipts(): Promise<ScopeReceipt[]> { return (await this.read("receipts.json", receiptsDocumentSchema, { version: 1, receipts: [] })).receipts; }
  async receipt(id: string): Promise<ScopeReceipt | undefined> { return (await this.receipts()).find((item) => item.id === id); }
  async writeReceipt(receipt: ScopeReceipt): Promise<void> {
    const current = (await this.receipts()).filter((item) => item.id !== receipt.id);
    await this.write("receipts.json", receiptsDocumentSchema, { version: 1, receipts: [...current, scopeReceiptSchema.parse(receipt)] });
  }

  async run(): Promise<PipelineRun | null> { return this.read<PipelineRun | null>("run.json", pipelineRunSchema.nullable(), null); }
  async writeRun(run: PipelineRun): Promise<void> { await this.write("run.json", pipelineRunSchema, run); }

  /** Delete every pipeline document of this source (reset-analysis and purge use this). */
  async remove(): Promise<void> { await fs.rm(this.directory, { recursive: true, force: true }); }
}
