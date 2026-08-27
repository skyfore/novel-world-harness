import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import {
  entitySchema,
  evidenceAssertionSchema,
  idSchema,
  storyTimeSchema,
  type Entity,
  type EntityKind,
} from "../world/model.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import { EvidenceAssertionStore, evidenceAssertionSourceIds } from "./evidence-assertions.js";
import {
  SourceAnnotationStore,
  entityMentionSchema,
  type EntityMention,
} from "./annotations.js";
import { CompilerBatchStore } from "./batches.js";

export const ENTITY_RESOLUTION_ONTOLOGY_VERSION = "entity-resolution-v1" as const;

export const identityResolutionCandidateSchema = z.object({
  entityId: idSchema,
  confidence: z.number().min(0).max(1),
  basisMentionIds: z.array(idSchema).min(1).max(32)
    .refine((values) => new Set(values).size === values.length, "basisMentionIds must be unique"),
  evidenceAssertionIds: z.array(idSchema).max(32)
    .refine((values) => new Set(values).size === values.length, "evidenceAssertionIds must be unique"),
  rationale: z.string().trim().min(1).max(1_000),
}).strict();
export type IdentityResolutionCandidate = z.infer<typeof identityResolutionCandidateSchema>;

export const identityResolutionSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  mentionId: idSchema,
  status: z.enum(["resolved", "ambiguous", "new-entity", "unresolved"]),
  entityId: idSchema.optional(),
  candidates: z.array(identityResolutionCandidateSchema).max(32),
  aliasType: z.enum(["name", "title", "office", "kinship", "nickname", "other"]).optional(),
  validStoryTime: storyTimeSchema.optional(),
  supersedesResolutionId: idSchema.optional(),
  rationale: z.string().trim().min(1).max(2_000),
  derivation: z.object({
    runId: z.string().min(1).max(300),
    worker: z.string().min(1),
    compilerBatchId: idSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
    ontologyVersion: z.literal(ENTITY_RESOLUTION_ONTOLOGY_VERSION),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const candidateIds = value.candidates.map((candidate) => candidate.entityId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "Resolution candidates must have unique entity IDs" });
  }
  if (value.status === "resolved" || value.status === "new-entity") {
    if (!value.entityId) {
      ctx.addIssue({ code: "custom", path: ["entityId"], message: `${value.status} resolution requires entityId` });
    } else if (!candidateIds.includes(value.entityId)) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "The selected entityId must appear in candidates" });
    }
  } else if (value.entityId) {
    ctx.addIssue({ code: "custom", path: ["entityId"], message: `${value.status} resolution cannot select an entityId` });
  }
  if (value.status === "ambiguous" && value.candidates.length < 2) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "Ambiguous resolution requires at least two candidates" });
  }
  if (value.status === "new-entity" && value.candidates.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "A new-entity resolution must identify exactly one proposed entity" });
  }
  if ((value.status === "ambiguous" || value.status === "unresolved") && value.aliasType) {
    ctx.addIssue({ code: "custom", path: ["aliasType"], message: "Only selected identities may classify an alias" });
  }
});
export type IdentityResolution = z.infer<typeof identityResolutionSchema>;

export const identityResolutionProposalSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  payload: identityResolutionSchema,
  generatedBy: z.object({
    worker: z.string().min(1),
    compilerBatchId: idSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
  }).strict(),
  createdAt: z.string().min(1),
}).strict();
export type IdentityResolutionProposal = z.infer<typeof identityResolutionProposalSchema>;

export type IdentityResolutionProposalStatus = "pending" | "accepted" | "rejected";
export type IdentityResolutionProposalSummary = {
  id: string;
  resolutionId: string;
  mentionId: string;
  status: IdentityResolution["status"];
  compilerBatchId?: string;
  createdAt: string;
};

const storedResolutionRefSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  mentionId: idSchema,
  resolutionId: idSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * Current identity is keyed by mention, while every resolution payload is an
 * immutable revision. Revising a mention's identity moves only its current
 * ref; prior merge/split decisions stay inspectable.
 */
export class EntityResolutionStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(
      workspaceStateDir(workspaceRoot),
      "world",
      "v1",
      "compiler",
      "resolutions",
      "v1",
      "entities",
    );
  }

  async stage(sourceIdInput: string, proposalInput: IdentityResolutionProposal): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposal = identityResolutionProposalSchema.parse(proposalInput);
    if (proposal.payload.sourceId !== sourceId) {
      throw new Error(`Identity-resolution proposal ${proposal.id} belongs to ${proposal.payload.sourceId}, not ${sourceId}.`);
    }
    const filePath = this.proposalPath(sourceId, "pending", proposal.id);
    try {
      const existing = identityResolutionProposalSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (canonicalJson(proposalIdentity(existing)) === canonicalJson(proposalIdentity(proposal))) return;
      throw new Error(`Pending identity-resolution proposal ${proposal.id} already exists with different content; use a new proposal id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const status of ["accepted", "rejected"] as const) {
      if (await exists(this.proposalPath(sourceId, status, proposal.id))) {
        throw new Error(`Identity-resolution proposal ${proposal.id} already exists in ${status} history; use a new proposal id.`);
      }
    }
    await writeImmutable(filePath, proposal);
  }

  async readProposal(
    sourceIdInput: string,
    status: IdentityResolutionProposalStatus,
    proposalIdInput: string,
  ): Promise<IdentityResolutionProposal> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    return identityResolutionProposalSchema.parse(
      JSON.parse(await fs.readFile(this.proposalPath(sourceId, status, proposalId), "utf8")),
    );
  }

  async listProposals(
    sourceIdInput: string,
    status: IdentityResolutionProposalStatus = "pending",
  ): Promise<IdentityResolutionProposalSummary[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const directory = this.proposalDirectory(sourceId, status);
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: IdentityResolutionProposalSummary[] = [];
    for (const name of names) {
      const proposal = identityResolutionProposalSchema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
      summaries.push({
        id: proposal.id,
        resolutionId: proposal.payload.id,
        mentionId: proposal.payload.mentionId,
        status: proposal.payload.status,
        ...(proposal.generatedBy.compilerBatchId ? { compilerBatchId: proposal.generatedBy.compilerBatchId } : {}),
        createdAt: proposal.createdAt,
      });
    }
    return summaries;
  }

  async listBatchProposals(sourceId: string, compilerBatchId: string): Promise<IdentityResolutionProposalSummary[]> {
    return [
      ...await this.listProposals(sourceId, "pending"),
      ...await this.listProposals(sourceId, "accepted"),
    ].filter((summary) => summary.compilerBatchId === compilerBatchId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async withdraw(sourceIdInput: string, proposalIdInput: string): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    await this.transition(sourceId, proposalId, "pending", "rejected");
  }

  async commitProposals(sourceIdInput: string, proposalIdsInput: readonly string[]): Promise<IdentityResolution[]> {
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
    const mentionIds = new Set<string>();
    for (const { proposal } of proposals) {
      if (mentionIds.has(proposal.payload.mentionId)) {
        throw new Error(`Mention ${proposal.payload.mentionId} has more than one active identity-resolution proposal.`);
      }
      mentionIds.add(proposal.payload.mentionId);
    }
    for (const { status, proposal } of proposals) {
      await this.bindResolution(sourceId, proposal.payload);
      if (status === "pending") await this.transition(sourceId, proposal.id, "pending", "accepted");
    }
    return proposals.map(({ proposal }) => structuredClone(proposal.payload));
  }

  async currentForMention(sourceIdInput: string, mentionIdInput: string): Promise<IdentityResolution | null> {
    const sourceId = idSchema.parse(sourceIdInput);
    const mentionId = idSchema.parse(mentionIdInput);
    let ref: z.infer<typeof storedResolutionRefSchema>;
    try {
      ref = storedResolutionRefSchema.parse(JSON.parse(await fs.readFile(this.refPath(sourceId, mentionId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (ref.sourceId !== sourceId || ref.mentionId !== mentionId) throw new Error(`Invalid entity-resolution ref for mention ${mentionId}.`);
    const resolution = identityResolutionSchema.parse(
      JSON.parse(await fs.readFile(this.revisionPath(sourceId, ref.resolutionId, ref.hash), "utf8")),
    );
    if (resolution.mentionId !== mentionId || contentHash(resolution) !== ref.hash) {
      throw new Error(`Corrupt identity resolution ${ref.resolutionId}@${ref.hash}.`);
    }
    return resolution;
  }

  async list(sourceIdInput: string): Promise<IdentityResolution[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    let names: string[];
    try {
      names = (await fs.readdir(this.refsDirectory(sourceId))).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const resolutions: IdentityResolution[] = [];
    for (const name of names) {
      const resolution = await this.currentForMention(sourceId, name.slice(0, -5));
      if (resolution) resolutions.push(resolution);
    }
    return resolutions.sort((left, right) => left.mentionId.localeCompare(right.mentionId));
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

  private async bindResolution(sourceId: string, resolutionInput: IdentityResolution): Promise<void> {
    const resolution = identityResolutionSchema.parse(resolutionInput);
    const hash = contentHash(resolution);
    await writeImmutable(this.revisionPath(sourceId, resolution.id, hash), resolution);
    await atomicJson(this.refPath(sourceId, resolution.mentionId), {
      version: 1,
      sourceId,
      mentionId: resolution.mentionId,
      resolutionId: resolution.id,
      hash,
    });
  }

  private async rollbackAcceptedProposal(sourceId: string, proposal: IdentityResolutionProposal): Promise<void> {
    const current = await this.currentForMention(sourceId, proposal.payload.mentionId);
    if (!current || current.id !== proposal.payload.id || contentHash(current) !== contentHash(proposal.payload)) return;
    const candidates: IdentityResolutionProposal[] = [];
    for (const summary of await this.listProposals(sourceId, "accepted")) {
      if (summary.id === proposal.id || summary.mentionId !== proposal.payload.mentionId) continue;
      candidates.push(await this.readProposal(sourceId, "accepted", summary.id));
    }
    const prior = candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    if (prior) await this.bindResolution(sourceId, prior.payload);
    else await fs.rm(this.refPath(sourceId, proposal.payload.mentionId), { force: true });
  }

  private async listSourceIds(): Promise<string[]> {
    try {
      return (await fs.readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && idSchema.safeParse(entry.name).success)
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
    from: IdentityResolutionProposalStatus,
    to: Exclude<IdentityResolutionProposalStatus, "pending">,
  ): Promise<void> {
    const source = this.proposalPath(sourceId, from, proposalId);
    const target = this.proposalPath(sourceId, to, proposalId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`Identity-resolution proposal not found: ${proposalId}`), { code: "ENOENT" });
      }
      throw error;
    }
  }

  private sourceDirectory(sourceId: string): string { return path.join(this.root, sourceId); }
  private proposalDirectory(sourceId: string, status: IdentityResolutionProposalStatus): string {
    return path.join(this.sourceDirectory(sourceId), "proposals", status);
  }
  private proposalPath(sourceId: string, status: IdentityResolutionProposalStatus, proposalId: string): string {
    return path.join(this.proposalDirectory(sourceId, status), `${idSchema.parse(proposalId)}.json`);
  }
  private refsDirectory(sourceId: string): string { return path.join(this.sourceDirectory(sourceId), "refs"); }
  private refPath(sourceId: string, mentionId: string): string {
    return path.join(this.refsDirectory(sourceId), `${idSchema.parse(mentionId)}.json`);
  }
  private revisionPath(sourceId: string, resolutionId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid identity-resolution revision hash: ${hash}`);
    return path.join(this.sourceDirectory(sourceId), "revisions", idSchema.parse(resolutionId), `${hash}.json`);
  }
}

export type LexicalEntityResolutionCandidate = {
  entityId: string;
  entityKind: EntityKind;
  canonicalName: string;
  matchedText: string;
  match: "exact-canonical-name" | "exact-alias" | "normalized-canonical-name" | "normalized-alias";
  status: "canonical" | "pending";
  availability: "canonical" | "checkpointed-pending" | "current-batch-pending" | "pending";
  resolutionMode?: "resolved" | "new-entity";
};

/** Deterministic, source-scoped lexical candidate generation; no model call. */
export async function generateEntityResolutionCandidates(
  workspaceRoot: string,
  sourceId: string,
  mentionId: string,
  compilerBatchId?: string,
): Promise<{ mention: EntityMention; candidates: LexicalEntityResolutionCandidate[] }> {
  idSchema.parse(sourceId);
  idSchema.parse(mentionId);
  const mention = await loadEntityMention(workspaceRoot, sourceId, mentionId, compilerBatchId);
  const entities = await sourceEntityCatalog(workspaceRoot, sourceId, compilerBatchId);
  const normalizedSurface = normalizeEntitySurface(mention.surface);
  const candidates = new Map<string, LexicalEntityResolutionCandidate>();
  const ranks: Record<LexicalEntityResolutionCandidate["match"], number> = {
    "exact-canonical-name": 0,
    "exact-alias": 1,
    "normalized-canonical-name": 2,
    "normalized-alias": 3,
  };
  if (mention.surface) {
    for (const { entity, status, availability } of entities) {
      if (!mention.kindCandidates.includes(entity.kind)) continue;
      const labels = [
        { text: entity.canonicalName, canonical: true },
        ...entity.aliases.map((text) => ({ text, canonical: false })),
      ];
      for (const label of labels) {
        const exact = mention.surface === label.text;
        const normalized = normalizedSurface === normalizeEntitySurface(label.text);
        if (!exact && !normalized) continue;
        const match: LexicalEntityResolutionCandidate["match"] = exact
          ? label.canonical ? "exact-canonical-name" : "exact-alias"
          : label.canonical ? "normalized-canonical-name" : "normalized-alias";
        const candidate = {
          entityId: entity.id,
          entityKind: entity.kind,
          canonicalName: entity.canonicalName,
          matchedText: label.text,
          match,
          status,
          availability,
          ...(availability === "canonical" || availability === "checkpointed-pending"
            ? { resolutionMode: "resolved" as const }
            : availability === "current-batch-pending"
              ? { resolutionMode: "new-entity" as const }
              : {}),
        } satisfies LexicalEntityResolutionCandidate;
        const prior = candidates.get(entity.id);
        if (!prior || ranks[match] < ranks[prior.match] || (ranks[match] === ranks[prior.match] && status === "canonical")) {
          candidates.set(entity.id, candidate);
        }
      }
    }
  }
  return {
    mention,
    candidates: [...candidates.values()].sort((left, right) => ranks[left.match] - ranks[right.match]
      || left.status.localeCompare(right.status)
      || left.entityId.localeCompare(right.entityId)),
  };
}

export async function validateIdentityResolutionClosure(
  workspaceRoot: string,
  sourceIdInput: string,
  resolutionProposalIdsInput: readonly string[],
  annotationProposalIdsInput: readonly string[],
  worldProposalIdsInput: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const resolutionProposalIds = uniqueParsedIds(resolutionProposalIdsInput);
  if (!resolutionProposalIds.length) return [];
  const resolutionStore = new EntityResolutionStore(workspaceRoot);
  const [current, allPending, mentionCatalog, entityCatalog] = await Promise.all([
    resolutionStore.list(sourceId),
    resolutionStore.listProposals(sourceId, "pending"),
    loadMentionCatalog(workspaceRoot, sourceId, annotationProposalIdsInput),
    loadResolutionEntityCatalog(workspaceRoot, sourceId, worldProposalIdsInput),
  ]);
  const currentByMention = new Map(current.map((resolution) => [resolution.mentionId, resolution]));
  const staged: IdentityResolutionProposal[] = [];
  const issues = new Set<string>();
  for (const proposalId of resolutionProposalIds) {
    try {
      staged.push(await readActiveResolutionProposal(resolutionStore, sourceId, proposalId));
    } catch {
      issues.add(`${proposalId}: active identity-resolution proposal is missing`);
    }
  }
  const stagedByMention = new Map<string, string[]>();
  for (const proposal of staged) {
    stagedByMention.set(proposal.payload.mentionId, [...(stagedByMention.get(proposal.payload.mentionId) ?? []), proposal.id]);
  }
  for (const [mentionId, proposalIds] of stagedByMention) {
    if (proposalIds.length > 1) issues.add(`${mentionId}: more than one active identity resolution (${proposalIds.join(", ")})`);
    const competing = allPending
      .filter((summary) => summary.mentionId === mentionId && !resolutionProposalIds.includes(summary.id))
      .map((summary) => summary.id);
    if (competing.length) issues.add(`${mentionId}: active resolution proposal(s) outside this finish handshake (${competing.join(", ")})`);
  }
  for (const proposal of staged) {
    const resolution = proposal.payload;
    const mention = mentionCatalog.get(resolution.mentionId);
    if (!mention) {
      issues.add(`${proposal.id}: mentionId references unknown entity mention '${resolution.mentionId}'`);
      continue;
    }
    const prior = currentByMention.get(resolution.mentionId);
    const alreadyCurrent = prior?.id === resolution.id && contentHash(prior) === contentHash(resolution);
    if (!alreadyCurrent) {
      if (!prior && resolution.supersedesResolutionId) {
        issues.add(`${proposal.id}: first resolution for ${resolution.mentionId} cannot supersede ${resolution.supersedesResolutionId}`);
      }
      if (prior && (resolution.id === prior.id || resolution.supersedesResolutionId !== prior.id)) {
        issues.add(`${proposal.id}: revision for ${resolution.mentionId} must use a new resolution id and supersede ${prior.id}`);
      }
    }
    for (const candidate of resolution.candidates) {
      if (!candidate.basisMentionIds.includes(resolution.mentionId)) {
        issues.add(`${proposal.id}: candidate ${candidate.entityId} must include primary mention ${resolution.mentionId} in basisMentionIds`);
      }
      for (const basisMentionId of candidate.basisMentionIds) {
        if (!mentionCatalog.has(basisMentionId)) issues.add(`${proposal.id}: candidate ${candidate.entityId} uses unknown basis mention ${basisMentionId}`);
      }
      const entity = entityCatalog.all.get(candidate.entityId);
      if (!entity) {
        issues.add(`${proposal.id}: candidate references unknown entity '${candidate.entityId}'`);
      } else if (!mention.kindCandidates.includes(entity.kind)) {
        issues.add(`${proposal.id}: mention kind candidates do not include ${entity.kind} for entity ${candidate.entityId}`);
      }
      const knownEvidenceIds = entityCatalog.evidenceAssertionIds.get(candidate.entityId) ?? new Set<string>();
      for (const assertionId of candidate.evidenceAssertionIds) {
        if (!knownEvidenceIds.has(assertionId)) {
          issues.add(`${proposal.id}: candidate ${candidate.entityId} cites unknown exact-evidence assertion ${assertionId}`);
        }
      }
    }
    if (resolution.status === "resolved" && resolution.entityId
      && !entityCatalog.canonical.has(resolution.entityId)
      && !entityCatalog.checkpointedPending.has(resolution.entityId)) {
      issues.add(`${proposal.id}: resolved identity '${resolution.entityId}' must be canonical or an active entity proposal from a previously checkpointed source batch; use new-entity only for a same-finish entity proposal`);
    }
    if (resolution.status === "new-entity" && resolution.entityId && !entityCatalog.selectedPending.has(resolution.entityId)) {
      issues.add(entityCatalog.checkpointedPending.has(resolution.entityId)
        ? `${proposal.id}: new-entity identity '${resolution.entityId}' was proposed by a previously checkpointed source batch; reuse it with status resolved instead of proposing it again`
        : `${proposal.id}: new-entity identity '${resolution.entityId}' requires a same-finish entity proposal`);
    }
    if ((resolution.status === "ambiguous" || resolution.status === "unresolved")
      && resolution.candidates.some((candidate) =>
        !entityCatalog.canonical.has(candidate.entityId)
        && !entityCatalog.checkpointedPending.has(candidate.entityId))) {
      issues.add(`${proposal.id}: ${resolution.status} candidates must refer to canonical entities or active entity proposals from previously checkpointed source batches`);
    }
  }
  return [...issues].sort();
}

/**
 * When a source has activated mention inventory, every proposed canonical name
 * and alias must trace through an active resolution. Sources compiled before
 * the observation ontology remain readable until explicitly reparsed.
 */
export async function validateEntityProposalResolutionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  worldProposalIdsInput: readonly string[],
  annotationProposalIdsInput: readonly string[],
  resolutionProposalIdsInput: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [mentions, resolutions, entities] = await Promise.all([
    loadMentionCatalog(workspaceRoot, sourceId, annotationProposalIdsInput),
    loadResolutionCatalog(workspaceRoot, sourceId, resolutionProposalIdsInput),
    loadSelectedEntityProposals(workspaceRoot, sourceId, worldProposalIdsInput),
  ]);
  if (!mentions.size || !entities.size) return [];
  const canonicalIds = new Set((await sourceCanonicalEntities(workspaceRoot, sourceId)).map((entity) => entity.id));
  return entityTraceIssues(entities.values(), mentions, resolutions, canonicalIds);
}

export async function validateCommittedEntityResolutionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  entityInput: Entity,
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const entity = entitySchema.parse(entityInput);
  const annotations = new SourceAnnotationStore(workspaceRoot);
  const mentions = new Map(
    (await annotations.list(sourceId, "entity-mention"))
      .map((mention) => [mention.id, entityMentionSchema.parse(mention)]),
  );
  if (!mentions.size) return [];
  const resolutions = new Map((await new EntityResolutionStore(workspaceRoot).list(sourceId))
    .map((resolution) => [resolution.mentionId, resolution]));
  const canonicalIds = new Set((await sourceCanonicalEntities(workspaceRoot, sourceId)).map((candidate) => candidate.id));
  return entityTraceIssues([entity], mentions, resolutions, canonicalIds);
}

export type EntityResolutionCoverage = {
  sourceId: string;
  mentions: number;
  resolved: number;
  newEntities: number;
  ambiguous: number;
  unresolved: number;
  missing: number;
  pending: number;
  missingMentionIds: string[];
  invalidResolutionIds: string[];
  errors: string[];
};

export async function inspectEntityResolutionCoverage(
  workspaceRoot: string,
  sourceIdInput: string,
): Promise<EntityResolutionCoverage> {
  const sourceId = idSchema.parse(sourceIdInput);
  const annotationStore = new SourceAnnotationStore(workspaceRoot);
  const resolutionStore = new EntityResolutionStore(workspaceRoot);
  const [annotationValues, resolutions, pending, entityValues] = await Promise.all([
    annotationStore.list(sourceId, "entity-mention"),
    resolutionStore.list(sourceId),
    resolutionStore.listProposals(sourceId, "pending"),
    sourceEntityCatalog(workspaceRoot, sourceId),
  ]);
  const mentions = new Map(annotationValues.map((value) => {
    const mention = entityMentionSchema.parse(value);
    return [mention.id, mention] as const;
  }));
  const entities = new Map(entityValues.map(({ entity }) => [entity.id, entity]));
  const byMention = new Map(resolutions.map((resolution) => [resolution.mentionId, resolution]));
  const errors: string[] = [];
  const invalidResolutionIds = new Set<string>();
  for (const resolution of resolutions) {
    const mention = mentions.get(resolution.mentionId);
    if (!mention) {
      errors.push(`${resolution.id}: current resolution refers to missing mention ${resolution.mentionId}`);
      invalidResolutionIds.add(resolution.id);
      continue;
    }
    for (const candidate of resolution.candidates) {
      const entity = entities.get(candidate.entityId);
      if (!entity) {
        errors.push(`${resolution.id}: candidate refers to missing entity ${candidate.entityId}`);
        invalidResolutionIds.add(resolution.id);
      } else if (!mention.kindCandidates.includes(entity.kind)) {
        errors.push(`${resolution.id}: mention kind candidates exclude ${entity.kind} entity ${entity.id}`);
        invalidResolutionIds.add(resolution.id);
      }
      for (const basisMentionId of candidate.basisMentionIds) {
        if (!mentions.has(basisMentionId)) {
          errors.push(`${resolution.id}: candidate basis refers to missing mention ${basisMentionId}`);
          invalidResolutionIds.add(resolution.id);
        }
      }
    }
  }
  const missingMentionIds = [...mentions.keys()].filter((mentionId) => !byMention.has(mentionId)).sort();
  return {
    sourceId,
    mentions: mentions.size,
    resolved: resolutions.filter((resolution) => resolution.status === "resolved").length,
    newEntities: resolutions.filter((resolution) => resolution.status === "new-entity").length,
    ambiguous: resolutions.filter((resolution) => resolution.status === "ambiguous").length,
    unresolved: resolutions.filter((resolution) => resolution.status === "unresolved").length,
    missing: missingMentionIds.length,
    pending: pending.length,
    missingMentionIds,
    invalidResolutionIds: [...invalidResolutionIds].sort(),
    errors: errors.sort(),
  };
}

function entityTraceIssues(
  entities: Iterable<Entity>,
  mentions: ReadonlyMap<string, EntityMention>,
  resolutions: ReadonlyMap<string, IdentityResolution>,
  canonicalIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  for (const entity of entities) {
    const traces = [...mentions.values()].flatMap((mention) => {
      const resolution = resolutions.get(mention.id);
      return resolution
        && (resolution.status === "resolved" || resolution.status === "new-entity")
        && resolution.entityId === entity.id
        && mention.kindCandidates.includes(entity.kind)
        ? [{ mention, resolution }]
        : [];
    });
    const nameTrace = traces.find(({ mention }) => mention.surface === entity.canonicalName);
    if (!nameTrace) {
      issues.push(`Entity ${entity.id} canonicalName '${entity.canonicalName}' has no resolved source mention.`);
    } else if (!canonicalIds.has(entity.id) && nameTrace.resolution.status !== "new-entity") {
      issues.push(`New entity ${entity.id} canonicalName must be established by a new-entity resolution.`);
    }
    entity.aliases.forEach((alias, index) => {
      const aliasTrace = traces.find(({ mention, resolution }) => mention.surface === alias && resolution.aliasType);
      if (!aliasTrace) issues.push(`Entity ${entity.id} alias '${alias}' at aliases.${index} has no alias-classified resolved mention.`);
    });
  }
  return issues;
}

async function loadResolutionCatalog(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, IdentityResolution>> {
  const store = new EntityResolutionStore(workspaceRoot);
  const catalog = new Map((await store.list(sourceId)).map((resolution) => [resolution.mentionId, resolution]));
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    const proposal = await readActiveResolutionProposal(store, sourceId, proposalId);
    catalog.set(proposal.payload.mentionId, proposal.payload);
  }
  return catalog;
}

async function loadMentionCatalog(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, EntityMention>> {
  const store = new SourceAnnotationStore(workspaceRoot);
  const catalog = new Map(
    (await store.list(sourceId, "entity-mention"))
      .map((mention) => [mention.id, entityMentionSchema.parse(mention)]),
  );
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    let proposal;
    try {
      proposal = await store.readProposal(sourceId, "pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      proposal = await store.readProposal(sourceId, "accepted", proposalId);
    }
    if (proposal.payload.annotationType === "entity-mention") {
      const mention = entityMentionSchema.parse(proposal.payload);
      catalog.set(mention.id, mention);
    }
  }
  return catalog;
}

async function loadResolutionEntityCatalog(
  workspaceRoot: string,
  sourceId: string,
  worldProposalIds: readonly string[],
): Promise<{
  canonical: Map<string, Entity>;
  checkpointedPending: Map<string, Entity>;
  selectedPending: Map<string, Entity>;
  all: Map<string, Entity>;
  evidenceAssertionIds: Map<string, Set<string>>;
}> {
  const [canonicalEntities, selectedPending, pendingEntries, progress] = await Promise.all([
    sourceCanonicalEntities(workspaceRoot, sourceId),
    loadSelectedEntityProposals(workspaceRoot, sourceId, worldProposalIds),
    loadSourcePendingEntityProposals(workspaceRoot, sourceId),
    new CompilerBatchStore(workspaceRoot).read(sourceId),
  ]);
  const canonical = new Map(canonicalEntities.map((entity) => [entity.id, entity]));
  const completedBatchIds = new Set(progress.completedBatchIds);
  const checkpointedPending = new Map<string, Entity>();
  for (const entry of pendingEntries) {
    if (entry.compilerBatchId && completedBatchIds.has(entry.compilerBatchId)) {
      checkpointedPending.set(entry.entity.id, entry.entity);
    }
  }
  const evidenceAssertionIds = new Map<string, Set<string>>();
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  for (const entityId of canonical.keys()) {
    const assertions = await exactEvidence.listForArtifact("entity", entityId);
    const sourceIds = evidenceAssertionSourceIds(assertions);
    if (sourceIds.length && (sourceIds.length !== 1 || sourceIds[0] !== sourceId)) {
      throw new Error(`Canonical entity ${entityId} has exact evidence outside source ${sourceId}.`);
    }
    evidenceAssertionIds.set(entityId, new Set(assertions.map((assertion) => assertion.id)));
  }
  for (const entry of pendingEntries) {
    const selected = worldProposalIds.includes(entry.proposalId);
    const checkpointed = entry.compilerBatchId ? completedBatchIds.has(entry.compilerBatchId) : false;
    if (selected || checkpointed) {
      evidenceAssertionIds.set(entry.entity.id, entry.evidenceAssertionIds);
    }
  }
  return {
    canonical,
    checkpointedPending,
    selectedPending,
    all: new Map([...canonical, ...checkpointedPending, ...selectedPending]),
    evidenceAssertionIds,
  };
}

async function loadSelectedEntityProposals(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, Entity>> {
  const store = new ProposalStore(workspaceRoot);
  const selected = new Map<string, Entity>();
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = await store.readEnvelope("pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (envelope.kind !== "entity") continue;
    const entity = entitySchema.parse(envelope.payload);
    assertEvidenceExclusiveToSource(entity.evidence, sourceId, `Entity proposal ${proposalId}`);
    selected.set(entity.id, entity);
  }
  return selected;
}

async function sourceEntityCatalog(
  workspaceRoot: string,
  sourceId: string,
  compilerBatchId?: string,
): Promise<Array<{
  entity: Entity;
  status: "canonical" | "pending";
  availability: LexicalEntityResolutionCandidate["availability"];
}>> {
  const [canonical, pending, progress] = await Promise.all([
    sourceCanonicalEntities(workspaceRoot, sourceId),
    loadSourcePendingEntityProposals(workspaceRoot, sourceId),
    compilerBatchId ? new CompilerBatchStore(workspaceRoot).read(sourceId) : undefined,
  ]);
  const completedBatchIds = new Set(progress?.completedBatchIds ?? []);
  const catalog = new Map<string, {
    entity: Entity;
    status: "canonical" | "pending";
    availability: LexicalEntityResolutionCandidate["availability"];
  }>();
  for (const entity of canonical) {
    catalog.set(entity.id, { entity, status: "canonical", availability: "canonical" });
  }
  for (const entry of pending) {
    const availability = !compilerBatchId
      ? "pending" as const
      : entry.compilerBatchId === compilerBatchId
        ? "current-batch-pending" as const
        : entry.compilerBatchId && completedBatchIds.has(entry.compilerBatchId)
          ? "checkpointed-pending" as const
          : undefined;
    if (!availability) continue;
    const existing = catalog.get(entry.entity.id);
    if (existing?.availability === "canonical" || existing?.availability === "checkpointed-pending") continue;
    if (existing?.availability === "current-batch-pending" && availability === "pending") continue;
    catalog.set(entry.entity.id, { entity: entry.entity, status: "pending", availability });
  }
  return [...catalog.values()];
}

type PendingEntityProposalCatalogEntry = {
  proposalId: string;
  compilerBatchId?: string;
  entity: Entity;
  evidenceAssertionIds: Set<string>;
};

async function loadSourcePendingEntityProposals(
  workspaceRoot: string,
  sourceId: string,
): Promise<PendingEntityProposalCatalogEntry[]> {
  const proposals = new ProposalStore(workspaceRoot);
  const pending: PendingEntityProposalCatalogEntry[] = [];
  for (const summary of await proposals.list("pending", sourceId)) {
    if (summary.kind !== "entity") continue;
    const envelope = await proposals.readEnvelope("pending", summary.id);
    const entity = entitySchema.parse(envelope.payload);
    assertEvidenceExclusiveToSource(entity.evidence, sourceId, `Entity proposal ${summary.id}`);
    const assertions = evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []);
    const sourceIds = evidenceAssertionSourceIds(assertions);
    if (sourceIds.length && (sourceIds.length !== 1 || sourceIds[0] !== sourceId)) {
      throw new Error(`Entity proposal ${summary.id} has exact evidence outside source ${sourceId}.`);
    }
    const generatedBy = envelope.generatedBy;
    const batchId = generatedBy && typeof generatedBy === "object" && !Array.isArray(generatedBy)
      && typeof (generatedBy as Record<string, unknown>).compilerBatchId === "string"
      ? (generatedBy as Record<string, unknown>).compilerBatchId as string
      : undefined;
    pending.push({
      proposalId: summary.id,
      ...(batchId ? { compilerBatchId: batchId } : {}),
      entity,
      evidenceAssertionIds: new Set(assertions.map((assertion) => assertion.id)),
    });
  }
  return pending;
}

async function sourceCanonicalEntities(workspaceRoot: string, sourceId: string): Promise<Entity[]> {
  return (await new CanonicalModelStore(workspaceRoot).listEntities()).filter((entity) => {
    const matches = entity.evidence.some((reference) => reference.span.sourceId === sourceId);
    if (matches) assertEvidenceExclusiveToSource(entity.evidence, sourceId, `Canonical entity ${entity.id}`);
    return matches;
  });
}

async function loadEntityMention(
  workspaceRoot: string,
  sourceId: string,
  mentionId: string,
  compilerBatchId?: string,
): Promise<EntityMention> {
  const store = new SourceAnnotationStore(workspaceRoot);
  try {
    const annotation = await store.read(sourceId, mentionId);
    return entityMentionSchema.parse(annotation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const matches: EntityMention[] = [];
  for (const summary of await store.listProposals(sourceId, "pending")) {
    if (compilerBatchId && summary.compilerBatchId !== compilerBatchId) continue;
    const proposal = await store.readProposal(sourceId, "pending", summary.id);
    if (proposal.payload.id === mentionId && proposal.payload.annotationType === "entity-mention") {
      matches.push(entityMentionSchema.parse(proposal.payload));
    }
  }
  if (matches.length !== 1) {
    throw Object.assign(new Error(
      matches.length
        ? `Entity mention ${mentionId} has ${matches.length} active proposals; resolve the duplicate before candidate generation.`
        : `Entity mention not found: ${mentionId}`,
    ), { code: "ENOENT" });
  }
  return matches[0]!;
}

async function readActiveResolutionProposal(
  store: EntityResolutionStore,
  sourceId: string,
  proposalId: string,
): Promise<IdentityResolutionProposal> {
  try {
    return await store.readProposal(sourceId, "pending", proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return store.readProposal(sourceId, "accepted", proposalId);
  }
}

function normalizeEntitySurface(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function uniqueParsedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => idSchema.parse(value)))].sort();
}

function proposalIdentity(proposal: IdentityResolutionProposal): Omit<IdentityResolutionProposal, "createdAt"> {
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
      throw new Error(`Immutable identity resolution already exists with different content: ${filePath}`);
    }
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
