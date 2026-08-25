import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import {
  entityKindSchema,
  idSchema,
  textAnchorSchema,
  type TextAnchor,
} from "../world/model.js";
import { EvidenceVerifier } from "./evidence.js";

export const SOURCE_ANNOTATION_ONTOLOGY_VERSION = "observation-v1" as const;

export const sourceAnnotationTypeSchema = z.enum([
  "entity-mention",
  "quotation",
  "discourse-segment",
]);
export type SourceAnnotationType = z.infer<typeof sourceAnnotationTypeSchema>;

export const sourceAnnotationDerivationSchema = z.object({
  runId: z.string().min(1).max(300),
  worker: z.string().min(1),
  compilerBatchId: idSchema.optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptHash: z.string().min(1).optional(),
  ontologyVersion: z.literal(SOURCE_ANNOTATION_ONTOLOGY_VERSION),
}).strict();
export type SourceAnnotationDerivation = z.infer<typeof sourceAnnotationDerivationSchema>;

const annotationCommon = {
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  derivation: sourceAnnotationDerivationSchema,
};

const entityKindCandidatesSchema = z.array(entityKindSchema)
  .min(1)
  .max(8)
  .refine((values) => new Set(values).size === values.length, "kindCandidates must be unique");

export const entityMentionSchema = z.object({
  ...annotationCommon,
  annotationType: z.literal("entity-mention"),
  anchor: textAnchorSchema,
  surface: z.string().max(4_000),
  form: z.enum(["proper", "nominal", "pronoun", "title", "kinship", "collective", "zero-anaphora"]),
  kindCandidates: entityKindCandidatesSchema,
  sceneId: idSchema.optional(),
  confidence: z.number().min(0).max(1),
  interpretation: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.anchor.sourceId !== value.sourceId) {
    ctx.addIssue({ code: "custom", path: ["anchor"], message: "Entity-mention anchor must belong to its source" });
  }
  if (value.form === "zero-anaphora") {
    if (value.surface !== "") {
      ctx.addIssue({ code: "custom", path: ["surface"], message: "Zero anaphora has no surface text" });
    }
    if (!value.interpretation) {
      ctx.addIssue({ code: "custom", path: ["interpretation"], message: "Zero anaphora requires an interpretation" });
    }
  } else if (!value.surface) {
    ctx.addIssue({ code: "custom", path: ["surface"], message: "Non-zero mentions require source surface text" });
  }
});
export type EntityMention = z.infer<typeof entityMentionSchema>;

export const quotationSchema = z.object({
  ...annotationCommon,
  annotationType: z.literal("quotation"),
  anchor: textAnchorSchema,
  mode: z.enum(["direct", "indirect", "free-indirect"]),
  speakerMentionId: idSchema.optional(),
  addresseeMentionIds: z.array(idSchema).max(32)
    .refine((values) => new Set(values).size === values.length, "addresseeMentionIds must be unique"),
  cueAnchor: textAnchorSchema.optional(),
  sceneId: idSchema.optional(),
  attributionConfidence: z.number().min(0).max(1),
  interpretation: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.anchor.sourceId !== value.sourceId || (value.cueAnchor && value.cueAnchor.sourceId !== value.sourceId)) {
    ctx.addIssue({ code: "custom", path: ["anchor"], message: "Quotation anchors must belong to their source" });
  }
  if (value.mode !== "direct" && !value.interpretation) {
    ctx.addIssue({ code: "custom", path: ["interpretation"], message: "Indirect discourse requires an interpretation" });
  }
});
export type Quotation = z.infer<typeof quotationSchema>;

export const discourseObservationSchema = z.object({
  ...annotationCommon,
  annotationType: z.literal("discourse-segment"),
  kind: z.enum([
    "scene",
    "summary",
    "flashback",
    "flashforward",
    "frame",
    "recollection",
    "hypothetical",
    "dream",
    "embedded-document",
    "narrator-commentary",
  ]),
  anchors: z.array(textAnchorSchema).min(1).max(32),
  viewpointMentionId: idSchema.optional(),
  confidence: z.number().min(0).max(1),
  interpretation: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.anchors.some((anchor) => anchor.sourceId !== value.sourceId)) {
    ctx.addIssue({ code: "custom", path: ["anchors"], message: "Discourse anchors must belong to their source" });
  }
  const distinct = new Set(value.anchors.map((anchor) => `${anchor.startByte}:${anchor.endByte}`));
  if (distinct.size !== value.anchors.length) {
    ctx.addIssue({ code: "custom", path: ["anchors"], message: "Discourse anchors must be unique" });
  }
});
export type DiscourseObservation = z.infer<typeof discourseObservationSchema>;

export const sourceAnnotationSchema = z.discriminatedUnion("annotationType", [
  entityMentionSchema,
  quotationSchema,
  discourseObservationSchema,
]);
export type SourceAnnotation = z.infer<typeof sourceAnnotationSchema>;

export const sourceAnnotationProposalSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  annotationType: sourceAnnotationTypeSchema,
  payload: sourceAnnotationSchema,
  generatedBy: z.object({
    worker: z.string().min(1),
    compilerBatchId: idSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
  }).strict(),
  createdAt: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.annotationType !== value.payload.annotationType) {
    ctx.addIssue({ code: "custom", path: ["annotationType"], message: "Proposal and payload annotation types must match" });
  }
});
export type SourceAnnotationProposal = z.infer<typeof sourceAnnotationProposalSchema>;

export type SourceAnnotationProposalStatus = "pending" | "accepted" | "rejected";
export type SourceAnnotationProposalSummary = {
  id: string;
  annotationType: SourceAnnotationType;
  annotationId: string;
  compilerBatchId?: string;
  createdAt: string;
};

const storedAnnotationRefSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  annotationType: sourceAnnotationTypeSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * Source observations have their own proposal/commit lifecycle. They are not
 * canonical world artifacts: committing one records what the source says or
 * how its discourse is organized, without creating an entity or world fact.
 */
export class SourceAnnotationStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(
      workspaceStateDir(workspaceRoot),
      "world",
      "v1",
      "compiler",
      "observations",
      "v1",
      "annotations",
    );
  }

  async stage(sourceIdInput: string, proposalInput: SourceAnnotationProposal): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposal = sourceAnnotationProposalSchema.parse(proposalInput);
    if (proposal.payload.sourceId !== sourceId) {
      throw new Error(`Annotation proposal ${proposal.id} belongs to ${proposal.payload.sourceId}, not ${sourceId}.`);
    }
    const filePath = this.proposalPath(sourceId, "pending", proposal.id);
    try {
      const existing = sourceAnnotationProposalSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (canonicalJson(proposalIdentity(existing)) === canonicalJson(proposalIdentity(proposal))) return;
      throw new Error(`Pending annotation proposal ${proposal.id} already exists with different content; use a new proposal id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const status of ["accepted", "rejected"] as const) {
      if (await exists(this.proposalPath(sourceId, status, proposal.id))) {
        throw new Error(`Annotation proposal ${proposal.id} already exists in ${status} history; use a new proposal id.`);
      }
    }
    await writeImmutable(filePath, proposal);
  }

  async readProposal(
    sourceIdInput: string,
    status: SourceAnnotationProposalStatus,
    proposalIdInput: string,
  ): Promise<SourceAnnotationProposal> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    return sourceAnnotationProposalSchema.parse(
      JSON.parse(await fs.readFile(this.proposalPath(sourceId, status, proposalId), "utf8")),
    );
  }

  async listProposals(
    sourceIdInput: string,
    status: SourceAnnotationProposalStatus = "pending",
  ): Promise<SourceAnnotationProposalSummary[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const directory = this.proposalDirectory(sourceId, status);
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: SourceAnnotationProposalSummary[] = [];
    for (const name of names) {
      const proposal = sourceAnnotationProposalSchema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
      summaries.push({
        id: proposal.id,
        annotationType: proposal.annotationType,
        annotationId: proposal.payload.id,
        ...(proposal.generatedBy.compilerBatchId ? { compilerBatchId: proposal.generatedBy.compilerBatchId } : {}),
        createdAt: proposal.createdAt,
      });
    }
    return summaries;
  }

  async listBatchProposals(sourceId: string, compilerBatchId: string): Promise<SourceAnnotationProposalSummary[]> {
    const summaries = [
      ...await this.listProposals(sourceId, "pending"),
      ...await this.listProposals(sourceId, "accepted"),
    ];
    return summaries.filter((summary) => summary.compilerBatchId === compilerBatchId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async withdraw(sourceIdInput: string, proposalIdInput: string): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    await this.transition(sourceId, proposalId, "pending", "rejected");
  }

  async commitProposals(sourceIdInput: string, proposalIdsInput: readonly string[]): Promise<SourceAnnotation[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalIds = [...new Set(proposalIdsInput.map((id) => idSchema.parse(id)))].sort();
    const proposals = await Promise.all(proposalIds.map(async (proposalId) => {
      try {
        return { status: "pending" as const, proposal: await this.readProposal(sourceId, "pending", proposalId) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { status: "accepted" as const, proposal: await this.readProposal(sourceId, "accepted", proposalId) };
      }
    }));
    const logicalIds = new Set<string>();
    for (const { proposal } of proposals) {
      if (logicalIds.has(proposal.payload.id)) {
        throw new Error(`Annotation ${proposal.payload.id} has more than one active proposal in this batch.`);
      }
      logicalIds.add(proposal.payload.id);
    }
    for (const { status, proposal } of proposals) {
      const annotation = sourceAnnotationSchema.parse(proposal.payload);
      await this.bindAnnotation(sourceId, annotation);
      if (status === "pending") await this.transition(sourceId, proposal.id, "pending", "accepted");
    }
    return proposals.map(({ proposal }) => structuredClone(proposal.payload));
  }

  async read(sourceIdInput: string, annotationIdInput: string): Promise<SourceAnnotation> {
    const sourceId = idSchema.parse(sourceIdInput);
    const annotationId = idSchema.parse(annotationIdInput);
    const ref = storedAnnotationRefSchema.parse(
      JSON.parse(await fs.readFile(this.refPath(sourceId, annotationId), "utf8")),
    );
    if (ref.sourceId !== sourceId || ref.id !== annotationId) throw new Error(`Invalid annotation ref ${annotationId}.`);
    const annotation = sourceAnnotationSchema.parse(
      JSON.parse(await fs.readFile(this.revisionPath(sourceId, annotationId, ref.hash), "utf8")),
    );
    if (contentHash(annotation) !== ref.hash) throw new Error(`Corrupt annotation revision ${annotationId}@${ref.hash}.`);
    return annotation;
  }

  async list(sourceIdInput: string, annotationType?: SourceAnnotationType): Promise<SourceAnnotation[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const directory = this.refsDirectory(sourceId);
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const annotations: SourceAnnotation[] = [];
    for (const name of names) {
      const annotation = await this.read(sourceId, name.slice(0, -5));
      if (!annotationType || annotation.annotationType === annotationType) annotations.push(annotation);
    }
    return annotations.sort((left, right) => firstAnchor(left).startByte - firstAnchor(right).startByte
      || left.annotationType.localeCompare(right.annotationType)
      || left.id.localeCompare(right.id));
  }

  async rejectBatch(compilerBatchId: string): Promise<string[]> {
    idSchema.parse(compilerBatchId);
    const rejected: string[] = [];
    for (const sourceId of await this.listSourceIds()) {
      for (const summary of await this.listProposals(sourceId, "pending")) {
        if (summary.compilerBatchId !== compilerBatchId) continue;
        await this.withdraw(sourceId, summary.id);
        rejected.push(summary.id);
      }
      for (const summary of await this.listProposals(sourceId, "accepted")) {
        if (summary.compilerBatchId !== compilerBatchId) continue;
        const proposal = await this.readProposal(sourceId, "accepted", summary.id);
        await this.rollbackAcceptedProposal(sourceId, proposal);
        await this.transition(sourceId, summary.id, "accepted", "rejected");
        rejected.push(summary.id);
      }
    }
    return rejected.sort();
  }

  async rejectSource(sourceIdInput: string): Promise<string[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const rejected: string[] = [];
    for (const summary of await this.listProposals(sourceId, "pending")) {
      await this.withdraw(sourceId, summary.id);
      rejected.push(summary.id);
    }
    return rejected.sort();
  }

  async removeSource(sourceIdInput: string): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    await fs.rm(this.sourceDirectory(sourceId), { recursive: true, force: true });
  }

  private async listSourceIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && idSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async transition(
    sourceId: string,
    proposalId: string,
    from: SourceAnnotationProposalStatus,
    to: Exclude<SourceAnnotationProposalStatus, "pending">,
  ): Promise<void> {
    const source = this.proposalPath(sourceId, from, proposalId);
    const target = this.proposalPath(sourceId, to, proposalId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`Annotation proposal not found: ${proposalId}`), { code: "ENOENT" });
      throw error;
    }
  }

  private async bindAnnotation(sourceId: string, annotationInput: SourceAnnotation): Promise<void> {
    const annotation = sourceAnnotationSchema.parse(annotationInput);
    const hash = contentHash(annotation);
    await writeImmutable(this.revisionPath(sourceId, annotation.id, hash), annotation);
    await atomicJson(this.refPath(sourceId, annotation.id), {
      version: 1,
      id: annotation.id,
      sourceId,
      annotationType: annotation.annotationType,
      hash,
    });
  }

  private async rollbackAcceptedProposal(sourceId: string, proposal: SourceAnnotationProposal): Promise<void> {
    let current: z.infer<typeof storedAnnotationRefSchema>;
    try {
      current = storedAnnotationRefSchema.parse(JSON.parse(await fs.readFile(this.refPath(sourceId, proposal.payload.id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (current.hash !== contentHash(proposal.payload)) return;
    const candidates: SourceAnnotationProposal[] = [];
    for (const summary of await this.listProposals(sourceId, "accepted")) {
      if (summary.id === proposal.id || summary.annotationId !== proposal.payload.id) continue;
      candidates.push(await this.readProposal(sourceId, "accepted", summary.id));
    }
    const prior = candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    if (prior) await this.bindAnnotation(sourceId, prior.payload);
    else await fs.rm(this.refPath(sourceId, proposal.payload.id), { force: true });
  }

  private sourceDirectory(sourceId: string): string { return path.join(this.root, sourceId); }
  private proposalDirectory(sourceId: string, status: SourceAnnotationProposalStatus): string {
    return path.join(this.sourceDirectory(sourceId), "proposals", status);
  }
  private proposalPath(sourceId: string, status: SourceAnnotationProposalStatus, proposalId: string): string {
    return path.join(this.proposalDirectory(sourceId, status), `${idSchema.parse(proposalId)}.json`);
  }
  private refsDirectory(sourceId: string): string { return path.join(this.sourceDirectory(sourceId), "refs"); }
  private refPath(sourceId: string, annotationId: string): string {
    return path.join(this.refsDirectory(sourceId), `${idSchema.parse(annotationId)}.json`);
  }
  private revisionPath(sourceId: string, annotationId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid annotation revision hash: ${hash}`);
    return path.join(this.sourceDirectory(sourceId), "revisions", idSchema.parse(annotationId), `${hash}.json`);
  }
}

/** Validate source-local references before the finish handshake commits them. */
export async function validateSourceAnnotationClosure(
  workspaceRoot: string,
  sourceIdInput: string,
  proposalIdsInput: readonly string[],
  options: { includeCommitted?: boolean; verifyAnchors?: boolean } = {},
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const proposalIds = [...new Set(proposalIdsInput.map((id) => idSchema.parse(id)))].sort();
  if (!proposalIds.length && !options.includeCommitted) return [];
  const store = new SourceAnnotationStore(workspaceRoot);
  const [committed, allPending] = await Promise.all([
    store.list(sourceId),
    store.listProposals(sourceId, "pending"),
  ]);
  const staged: SourceAnnotationProposal[] = [];
  const issues = new Set<string>();
  for (const proposalId of proposalIds) {
    try {
      staged.push(await readActiveProposal(store, sourceId, proposalId));
    } catch {
      issues.add(`${proposalId}: active annotation proposal is missing`);
    }
  }
  const byId = new Map(committed.map((annotation) => [annotation.id, annotation]));
  const committedById = new Map(byId);
  const stagedByLogicalId = new Map<string, string[]>();
  for (const proposal of staged) {
    const annotation = proposal.payload;
    const prior = committedById.get(annotation.id);
    if (prior && prior.annotationType !== annotation.annotationType) {
      issues.add(`${proposal.id}: annotation ${annotation.id} cannot change type from ${prior.annotationType} to ${annotation.annotationType}`);
    }
    stagedByLogicalId.set(annotation.id, [...(stagedByLogicalId.get(annotation.id) ?? []), proposal.id]);
    byId.set(annotation.id, annotation);
  }
  for (const [annotationId, ids] of stagedByLogicalId) {
    if (ids.length > 1) issues.add(`${annotationId}: more than one active annotation proposal (${ids.join(", ")})`);
    const competing = allPending
      .filter((summary) => summary.annotationId === annotationId && !proposalIds.includes(summary.id))
      .map((summary) => summary.id);
    if (competing.length) {
      issues.add(`${annotationId}: active proposal(s) outside this finish handshake also target the annotation (${competing.join(", ")})`);
    }
  }
  const verifier = options.verifyAnchors === false ? undefined : new EvidenceVerifier(workspaceRoot);
  const entries = new Map<string, { label: string; annotation: SourceAnnotation }>();
  if (options.includeCommitted) {
    for (const annotation of committed) {
      entries.set(annotation.id, { label: `committed:${annotation.id}`, annotation });
    }
  } else {
    const revisedIds = new Set(staged.map((proposal) => proposal.payload.id));
    for (const annotation of committed) {
      if (annotationReferenceIds(annotation).some((id) => revisedIds.has(id))) {
        entries.set(annotation.id, { label: `committed:${annotation.id}`, annotation });
      }
    }
  }
  for (const proposal of staged) {
    entries.set(proposal.payload.id, { label: proposal.id, annotation: proposal.payload });
  }
  for (const { label, annotation } of entries.values()) {
    if (verifier) {
      for (const anchor of annotationAnchors(annotation)) {
        if (anchor.sourceId !== sourceId) {
          issues.add(`${label}: anchor escapes active source ${sourceId}`);
          continue;
        }
        const inspection = await verifier.inspectAnchor(anchor);
        for (const issue of inspection.issues) issues.add(`${label}: ${issue.code}: ${issue.message}`);
      }
    }
    if (annotation.annotationType === "entity-mention" && annotation.sceneId) {
      requireAnnotationReference(issues, label, byId, annotation.sceneId, "discourse-segment", "sceneId", "scene");
    }
    if (annotation.annotationType === "quotation") {
      if (annotation.speakerMentionId) {
        requireAnnotationReference(issues, label, byId, annotation.speakerMentionId, "entity-mention", "speakerMentionId");
      }
      for (const addresseeId of annotation.addresseeMentionIds) {
        requireAnnotationReference(issues, label, byId, addresseeId, "entity-mention", "addresseeMentionIds");
      }
      if (annotation.sceneId) {
        requireAnnotationReference(issues, label, byId, annotation.sceneId, "discourse-segment", "sceneId", "scene");
      }
    }
    if (annotation.annotationType === "discourse-segment" && annotation.viewpointMentionId) {
      requireAnnotationReference(issues, label, byId, annotation.viewpointMentionId, "entity-mention", "viewpointMentionId");
    }
  }
  return [...issues].sort();
}

export function annotationAnchors(annotation: SourceAnnotation): TextAnchor[] {
  if (annotation.annotationType === "discourse-segment") return structuredClone(annotation.anchors);
  if (annotation.annotationType === "quotation" && annotation.cueAnchor) {
    return [structuredClone(annotation.anchor), structuredClone(annotation.cueAnchor)];
  }
  return [structuredClone(annotation.anchor)];
}

export function annotationReferenceIds(annotation: SourceAnnotation): string[] {
  if (annotation.annotationType === "entity-mention") return annotation.sceneId ? [annotation.sceneId] : [];
  if (annotation.annotationType === "quotation") {
    return [...new Set([
      ...(annotation.speakerMentionId ? [annotation.speakerMentionId] : []),
      ...annotation.addresseeMentionIds,
      ...(annotation.sceneId ? [annotation.sceneId] : []),
    ])].sort();
  }
  return annotation.viewpointMentionId ? [annotation.viewpointMentionId] : [];
}

async function readActiveProposal(
  store: SourceAnnotationStore,
  sourceId: string,
  proposalId: string,
): Promise<SourceAnnotationProposal> {
  try {
    return await store.readProposal(sourceId, "pending", proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return store.readProposal(sourceId, "accepted", proposalId);
  }
}

function requireAnnotationReference(
  issues: Set<string>,
  proposalId: string,
  annotations: ReadonlyMap<string, SourceAnnotation>,
  targetId: string,
  expectedType: SourceAnnotationType,
  field: string,
  expectedDiscourseKind?: DiscourseObservation["kind"],
): void {
  const target = annotations.get(targetId);
  if (!target) {
    issues.add(`${proposalId}: ${field} references unknown annotation '${targetId}'`);
    return;
  }
  if (target.annotationType !== expectedType) {
    issues.add(`${proposalId}: ${field} '${targetId}' must reference ${expectedType}, found ${target.annotationType}`);
    return;
  }
  if (expectedDiscourseKind && target.annotationType === "discourse-segment" && target.kind !== expectedDiscourseKind) {
    issues.add(`${proposalId}: ${field} '${targetId}' must reference a ${expectedDiscourseKind} discourse segment, found ${target.kind}`);
  }
}

function firstAnchor(annotation: SourceAnnotation): TextAnchor {
  return annotation.annotationType === "discourse-segment" ? annotation.anchors[0]! : annotation.anchor;
}

function proposalIdentity(proposal: SourceAnnotationProposal): Omit<SourceAnnotationProposal, "createdAt"> {
  const { createdAt: _createdAt, ...identity } = proposal;
  return identity;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) {
      throw new Error(`Immutable source observation already exists with different content: ${filePath}`);
    }
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
