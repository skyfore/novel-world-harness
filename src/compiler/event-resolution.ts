import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import {
  canonicalEventSchema,
  evidenceAssertionSchema,
  idSchema,
  type CanonicalEvent,
  type EvidenceAssertion,
} from "../world/model.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import {
  SourceAnnotationStore,
  entityMentionSchema,
  eventMentionSchema,
  type EntityMention,
  type EventMention,
} from "./annotations.js";
import {
  EntityResolutionStore,
  type IdentityResolution,
} from "./entity-resolution.js";
import { EvidenceAssertionStore, evidenceAssertionSourceIds } from "./evidence-assertions.js";

export const EVENT_RESOLUTION_ONTOLOGY_VERSION = "event-resolution-v1" as const;

export const eventResolutionRelationSchema = z.enum(["coreference", "subevent"]);
export type EventResolutionRelation = z.infer<typeof eventResolutionRelationSchema>;

export const eventResolutionCandidateSchema = z.object({
  canonicalEventId: idSchema,
  relation: eventResolutionRelationSchema,
  confidence: z.number().min(0).max(1),
  basisEventMentionIds: z.array(idSchema).min(1).max(64)
    .refine((values) => new Set(values).size === values.length, "basisEventMentionIds must be unique"),
  evidenceAssertionIds: z.array(idSchema).max(64)
    .refine((values) => new Set(values).size === values.length, "evidenceAssertionIds must be unique"),
  rationale: z.string().trim().min(1).max(1_000),
}).strict();
export type EventResolutionCandidate = z.infer<typeof eventResolutionCandidateSchema>;

export const eventResolutionSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  eventMentionIds: z.array(idSchema).min(1).max(64)
    .refine((values) => new Set(values).size === values.length, "eventMentionIds must be unique"),
  status: z.enum(["resolved", "new-event", "ambiguous", "unresolved", "non-referential"]),
  canonicalEventId: idSchema.optional(),
  relation: eventResolutionRelationSchema.optional(),
  candidates: z.array(eventResolutionCandidateSchema).max(64),
  supersedesResolutionIds: z.array(idSchema).max(64)
    .refine((values) => new Set(values).size === values.length, "supersedesResolutionIds must be unique"),
  rationale: z.string().trim().min(1).max(2_000),
  derivation: z.object({
    runId: z.string().min(1).max(300),
    worker: z.string().min(1),
    compilerBatchId: idSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
    ontologyVersion: z.literal(EVENT_RESOLUTION_ONTOLOGY_VERSION),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const candidateKeys = value.candidates.map((candidate) => `${candidate.canonicalEventId}:${candidate.relation}`);
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "Event candidates must have unique event/relation pairs" });
  }
  const selected = value.status === "resolved" || value.status === "new-event";
  if (selected) {
    if (!value.canonicalEventId || !value.relation) {
      ctx.addIssue({ code: "custom", path: ["canonicalEventId"], message: `${value.status} requires canonicalEventId and relation` });
    } else if (!candidateKeys.includes(`${value.canonicalEventId}:${value.relation}`)) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "The selected canonical event/relation must appear in candidates" });
    }
  } else if (value.canonicalEventId || value.relation) {
    ctx.addIssue({ code: "custom", path: ["canonicalEventId"], message: `${value.status} cannot select a canonical event or relation` });
  }
  if (value.status === "ambiguous" && value.candidates.length < 2) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "Ambiguous event resolution requires at least two candidates" });
  }
  if (value.status === "new-event") {
    if (value.candidates.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["candidates"], message: "A new-event resolution must identify exactly one proposed event" });
    }
    if (value.relation !== "coreference") {
      ctx.addIssue({ code: "custom", path: ["relation"], message: "A new canonical event must be grounded by a coreference resolution" });
    }
  }
  if (value.status === "non-referential" && value.candidates.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "A non-referential event mention cannot retain canonical-event candidates" });
  }
});
export type EventResolution = z.infer<typeof eventResolutionSchema>;

export const eventResolutionProposalSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  payload: eventResolutionSchema,
  generatedBy: z.object({
    worker: z.string().min(1),
    compilerBatchId: idSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
  }).strict(),
  createdAt: z.string().min(1),
}).strict();
export type EventResolutionProposal = z.infer<typeof eventResolutionProposalSchema>;
export type EventResolutionProposalStatus = "pending" | "accepted" | "rejected";
export type EventResolutionProposalSummary = {
  id: string;
  resolutionId: string;
  eventMentionIds: string[];
  status: EventResolution["status"];
  compilerBatchId?: string;
  createdAt: string;
};

const storedEventResolutionRefSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  eventMentionId: idSchema,
  resolutionId: idSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type StoredEventResolutionRef = z.infer<typeof storedEventResolutionRefSchema>;

/**
 * Event mentions are partitioned into explicit resolution clusters. Each
 * mention has a current ref, while cluster payloads remain immutable. Moving a
 * mention between clusters is therefore a visible merge/split revision.
 */
export class EventResolutionStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(
      worldStorageRoot(workspaceRoot),
      "compiler",
      "resolutions",
      "v1",
      "events",
    );
  }

  async stage(sourceIdInput: string, proposalInput: EventResolutionProposal): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposal = eventResolutionProposalSchema.parse(proposalInput);
    if (proposal.payload.sourceId !== sourceId) {
      throw new Error(`Event-resolution proposal ${proposal.id} belongs to ${proposal.payload.sourceId}, not ${sourceId}.`);
    }
    const filePath = this.proposalPath(sourceId, "pending", proposal.id);
    try {
      const existing = eventResolutionProposalSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (canonicalJson(proposalIdentity(existing)) === canonicalJson(proposalIdentity(proposal))) return;
      throw new Error(`Pending event-resolution proposal ${proposal.id} already exists with different content; use a new proposal id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const status of ["accepted", "rejected"] as const) {
      if (await exists(this.proposalPath(sourceId, status, proposal.id))) {
        throw new Error(`Event-resolution proposal ${proposal.id} already exists in ${status} history; use a new proposal id.`);
      }
    }
    await writeImmutable(filePath, proposal);
  }

  async readProposal(
    sourceIdInput: string,
    status: EventResolutionProposalStatus,
    proposalIdInput: string,
  ): Promise<EventResolutionProposal> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    return eventResolutionProposalSchema.parse(
      JSON.parse(await fs.readFile(this.proposalPath(sourceId, status, proposalId), "utf8")),
    );
  }

  async listProposals(
    sourceIdInput: string,
    status: EventResolutionProposalStatus = "pending",
  ): Promise<EventResolutionProposalSummary[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    let names: string[];
    try {
      names = (await fs.readdir(this.proposalDirectory(sourceId, status))).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: EventResolutionProposalSummary[] = [];
    for (const name of names) {
      const proposal = eventResolutionProposalSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.proposalDirectory(sourceId, status), name), "utf8")),
      );
      summaries.push({
        id: proposal.id,
        resolutionId: proposal.payload.id,
        eventMentionIds: structuredClone(proposal.payload.eventMentionIds),
        status: proposal.payload.status,
        ...(proposal.generatedBy.compilerBatchId ? { compilerBatchId: proposal.generatedBy.compilerBatchId } : {}),
        createdAt: proposal.createdAt,
      });
    }
    return summaries;
  }

  async listBatchProposals(sourceId: string, compilerBatchId: string): Promise<EventResolutionProposalSummary[]> {
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

  async commitProposals(sourceIdInput: string, proposalIdsInput: readonly string[]): Promise<EventResolution[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalIds = uniqueParsedIds(proposalIdsInput);
    const proposals = await Promise.all(proposalIds.map(async (proposalId) => {
      try {
        return { status: "pending" as const, proposal: await this.readProposal(sourceId, "pending", proposalId) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { status: "accepted" as const, proposal: await this.readProposal(sourceId, "accepted", proposalId) };
      }
    }));
    const assigned = new Set<string>();
    for (const { proposal } of proposals) {
      for (const mentionId of proposal.payload.eventMentionIds) {
        if (assigned.has(mentionId)) throw new Error(`Event mention ${mentionId} appears in more than one active event-resolution proposal.`);
        assigned.add(mentionId);
      }
    }
    const supersededIds = new Set(proposals.flatMap(({ proposal }) => proposal.payload.supersedesResolutionIds));
    for (const current of await this.list(sourceId)) {
      if (!supersededIds.has(current.id)) continue;
      for (const mentionId of current.eventMentionIds) await this.removeRefIfCurrent(sourceId, mentionId, current.id);
    }
    for (const { proposal } of proposals) await this.bindResolution(sourceId, proposal.payload);
    for (const { status, proposal } of proposals) {
      if (status === "pending") await this.transition(sourceId, proposal.id, "pending", "accepted");
    }
    return proposals.map(({ proposal }) => structuredClone(proposal.payload));
  }

  async currentForMention(sourceIdInput: string, eventMentionIdInput: string): Promise<EventResolution | null> {
    const sourceId = idSchema.parse(sourceIdInput);
    const eventMentionId = idSchema.parse(eventMentionIdInput);
    const ref = await this.readRef(sourceId, eventMentionId);
    if (!ref) return null;
    const resolution = eventResolutionSchema.parse(
      JSON.parse(await fs.readFile(this.revisionPath(sourceId, ref.resolutionId, ref.hash), "utf8")),
    );
    if (!resolution.eventMentionIds.includes(eventMentionId) || contentHash(resolution) !== ref.hash) {
      throw new Error(`Corrupt event resolution ${ref.resolutionId}@${ref.hash}.`);
    }
    return resolution;
  }

  async list(sourceIdInput: string): Promise<EventResolution[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    let names: string[];
    try {
      names = (await fs.readdir(this.refsDirectory(sourceId))).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const resolutions = new Map<string, EventResolution>();
    for (const name of names) {
      const resolution = await this.currentForMention(sourceId, name.slice(0, -5));
      if (resolution) resolutions.set(`${resolution.id}:${contentHash(resolution)}`, resolution);
    }
    return [...resolutions.values()].sort((left, right) => left.eventMentionIds[0]!.localeCompare(right.eventMentionIds[0]!)
      || left.id.localeCompare(right.id));
  }

  /** Replace materialized mention refs exactly while preserving immutable history. */
  async replaceCurrent(sourceIdInput: string, resolutionsInput: readonly EventResolution[]): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    const resolutions = resolutionsInput.map((resolution) => eventResolutionSchema.parse(resolution));
    if (resolutions.some((resolution) => resolution.sourceId !== sourceId)) {
      throw new Error(`Event-resolution snapshot contains a decision outside source ${sourceId}.`);
    }
    const assigned = new Set<string>();
    for (const resolution of resolutions) {
      for (const mentionId of resolution.eventMentionIds) {
        if (assigned.has(mentionId)) {
          throw new Error(`Event-resolution snapshot for ${sourceId} assigns mention ${mentionId} more than once.`);
        }
        assigned.add(mentionId);
      }
    }
    await fs.rm(this.refsDirectory(sourceId), { recursive: true, force: true });
    for (const resolution of resolutions) await this.bindResolution(sourceId, resolution);
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
      const accepted = (await this.listProposals(sourceId, "accepted"))
        .filter((summary) => summary.compilerBatchId === compilerBatchId);
      if (accepted.length) {
        const proposals = await Promise.all(accepted.map((summary) => this.readProposal(sourceId, "accepted", summary.id)));
        await this.rollbackAcceptedBatch(sourceId, proposals);
        for (const proposal of proposals) {
          await this.transition(sourceId, proposal.id, "accepted", "rejected");
          rejected.push(proposal.id);
        }
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

  /** Remove invalid current bindings while preserving their immutable proposal/revision history. */
  async rejectAcceptedResolutionIds(
    sourceIdInput: string,
    resolutionIdsInput: readonly string[],
  ): Promise<string[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const resolutionIds = new Set(resolutionIdsInput.map((id) => idSchema.parse(id)));
    if (!resolutionIds.size) return [];
    const proposals: EventResolutionProposal[] = [];
    for (const summary of await this.listProposals(sourceId, "accepted")) {
      if (!resolutionIds.has(summary.resolutionId)) continue;
      proposals.push(await this.readProposal(sourceId, "accepted", summary.id));
    }
    if (!proposals.length) return [];
    await this.rollbackAcceptedBatch(sourceId, proposals);
    for (const proposal of proposals) {
      await this.transition(sourceId, proposal.id, "accepted", "rejected");
    }
    return proposals.map((proposal) => proposal.id).sort();
  }

  async removeSource(sourceIdInput: string): Promise<void> {
    await fs.rm(this.sourceDirectory(idSchema.parse(sourceIdInput)), { recursive: true, force: true });
  }

  private async rollbackAcceptedBatch(sourceId: string, proposals: readonly EventResolutionProposal[]): Promise<void> {
    const newIds = new Set(proposals.map((proposal) => proposal.payload.id));
    const affectedMentionIds = new Set(proposals.flatMap((proposal) => proposal.payload.eventMentionIds));
    const supersededIds = new Set(proposals.flatMap((proposal) => proposal.payload.supersedesResolutionIds));
    const priors: EventResolution[] = [];
    for (const resolutionId of supersededIds) {
      const prior = await this.readUniqueRevision(sourceId, resolutionId);
      priors.push(prior);
      for (const mentionId of prior.eventMentionIds) affectedMentionIds.add(mentionId);
    }
    for (const mentionId of affectedMentionIds) {
      const ref = await this.readRef(sourceId, mentionId);
      if (ref && !newIds.has(ref.resolutionId)) return;
    }
    for (const mentionId of affectedMentionIds) await fs.rm(this.refPath(sourceId, mentionId), { force: true });
    for (const prior of priors) await this.bindResolution(sourceId, prior);
  }

  private async readUniqueRevision(sourceId: string, resolutionId: string): Promise<EventResolution> {
    const directory = path.join(this.sourceDirectory(sourceId), "revisions", idSchema.parse(resolutionId));
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    if (names.length !== 1) throw new Error(`Event resolution ${resolutionId} has ${names.length} immutable revisions; expected one.`);
    return eventResolutionSchema.parse(JSON.parse(await fs.readFile(path.join(directory, names[0]!), "utf8")));
  }

  private async bindResolution(sourceId: string, resolutionInput: EventResolution): Promise<void> {
    const resolution = eventResolutionSchema.parse(resolutionInput);
    if (resolution.sourceId !== sourceId) throw new Error(`Event resolution ${resolution.id} escapes source ${sourceId}.`);
    const hash = contentHash(resolution);
    await writeImmutable(this.revisionPath(sourceId, resolution.id, hash), resolution);
    for (const eventMentionId of resolution.eventMentionIds) {
      await atomicJson(this.refPath(sourceId, eventMentionId), {
        version: 1,
        sourceId,
        eventMentionId,
        resolutionId: resolution.id,
        hash,
      });
    }
  }

  private async readRef(sourceId: string, eventMentionId: string): Promise<StoredEventResolutionRef | null> {
    try {
      const ref = storedEventResolutionRefSchema.parse(
        JSON.parse(await fs.readFile(this.refPath(sourceId, eventMentionId), "utf8")),
      );
      if (ref.sourceId !== sourceId || ref.eventMentionId !== eventMentionId) {
        throw new Error(`Invalid event-resolution ref for mention ${eventMentionId}.`);
      }
      return ref;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async removeRefIfCurrent(sourceId: string, eventMentionId: string, resolutionId: string): Promise<void> {
    const ref = await this.readRef(sourceId, eventMentionId);
    if (ref?.resolutionId === resolutionId) await fs.rm(this.refPath(sourceId, eventMentionId), { force: true });
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
    from: EventResolutionProposalStatus,
    to: Exclude<EventResolutionProposalStatus, "pending">,
  ): Promise<void> {
    const source = this.proposalPath(sourceId, from, proposalId);
    const target = this.proposalPath(sourceId, to, proposalId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`Event-resolution proposal not found: ${proposalId}`), { code: "ENOENT" });
      }
      throw error;
    }
  }

  private sourceDirectory(sourceId: string): string { return path.join(this.root, sourceId); }
  private proposalDirectory(sourceId: string, status: EventResolutionProposalStatus): string {
    return path.join(this.sourceDirectory(sourceId), "proposals", status);
  }
  private proposalPath(sourceId: string, status: EventResolutionProposalStatus, proposalId: string): string {
    return path.join(this.proposalDirectory(sourceId, status), `${idSchema.parse(proposalId)}.json`);
  }
  private refsDirectory(sourceId: string): string { return path.join(this.sourceDirectory(sourceId), "refs"); }
  private refPath(sourceId: string, eventMentionId: string): string {
    return path.join(this.refsDirectory(sourceId), `${idSchema.parse(eventMentionId)}.json`);
  }
  private revisionPath(sourceId: string, resolutionId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid event-resolution revision hash: ${hash}`);
    return path.join(this.sourceDirectory(sourceId), "revisions", idSchema.parse(resolutionId), `${hash}.json`);
  }
}

export type DeterministicEventResolutionCandidate = {
  canonicalEventId: string;
  title: string;
  status: "canonical" | "pending";
  signals: Array<"evidence-overlap" | "exact-title-trigger" | "normalized-title-trigger" | "participant-overlap">;
  participantEntityIds: string[];
  matchedParticipantEntityIds: string[];
  relationCandidates: EventResolutionRelation[];
};

/** Host-derived candidate generation. Signals rank candidates but never merge them. */
export async function generateEventResolutionCandidates(
  workspaceRoot: string,
  sourceIdInput: string,
  eventMentionIdInput: string,
  compilerBatchId?: string,
): Promise<{ mention: EventMention; candidates: DeterministicEventResolutionCandidate[] }> {
  const sourceId = idSchema.parse(sourceIdInput);
  const eventMentionId = idSchema.parse(eventMentionIdInput);
  const mention = await loadEventMention(workspaceRoot, sourceId, eventMentionId, compilerBatchId);
  const [events, identities] = await Promise.all([
    sourceEventCatalog(workspaceRoot, sourceId),
    loadIdentityCatalogForBatch(workspaceRoot, sourceId, compilerBatchId),
  ]);
  const participantEntityIds = resolvedParticipantEntityIds(mention, identities);
  const normalizedTrigger = normalizeEventText(mention.trigger);
  const candidates: DeterministicEventResolutionCandidate[] = [];
  for (const entry of events) {
    const signals: DeterministicEventResolutionCandidate["signals"] = [];
    if (entry.ranges.some((range) => mention.extentAnchors.some((anchor) => rangesOverlap(range, anchor)))) {
      signals.push("evidence-overlap");
    }
    const normalizedTitle = normalizeEventText(entry.event.title);
    if (normalizedTitle === normalizedTrigger) signals.push("exact-title-trigger");
    else if (normalizedTrigger.length >= 2 && normalizedTitle.length >= 2
      && (normalizedTitle.includes(normalizedTrigger) || normalizedTrigger.includes(normalizedTitle))) {
      signals.push("normalized-title-trigger");
    }
    const matchedParticipantEntityIds = participantEntityIds.filter((entityId) => entry.event.participants.includes(entityId));
    if (matchedParticipantEntityIds.length) signals.push("participant-overlap");
    if (!signals.length) continue;
    candidates.push({
      canonicalEventId: entry.event.id,
      title: entry.event.title,
      status: entry.status,
      signals,
      participantEntityIds,
      matchedParticipantEntityIds,
      relationCandidates: ["coreference", "subevent"],
    });
  }
  const signalRank = (candidate: DeterministicEventResolutionCandidate) =>
    (candidate.signals.includes("evidence-overlap") ? 8 : 0)
    + (candidate.signals.includes("exact-title-trigger") ? 4 : 0)
    + (candidate.signals.includes("normalized-title-trigger") ? 2 : 0)
    + candidate.matchedParticipantEntityIds.length;
  return {
    mention,
    candidates: candidates.sort((left, right) => signalRank(right) - signalRank(left)
      || left.status.localeCompare(right.status)
      || left.canonicalEventId.localeCompare(right.canonicalEventId)),
  };
}

export async function validateEventResolutionClosure(
  workspaceRoot: string,
  sourceIdInput: string,
  eventResolutionProposalIdsInput: readonly string[],
  annotationProposalIdsInput: readonly string[],
  entityResolutionProposalIdsInput: readonly string[],
  worldProposalIdsInput: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const proposalIds = uniqueParsedIds(eventResolutionProposalIdsInput);
  if (!proposalIds.length) return [];
  const store = new EventResolutionStore(workspaceRoot);
  const [current, allPending, annotations, identities, events] = await Promise.all([
    store.list(sourceId),
    store.listProposals(sourceId, "pending"),
    loadAnnotationCatalog(workspaceRoot, sourceId, annotationProposalIdsInput),
    loadIdentityCatalog(workspaceRoot, sourceId, entityResolutionProposalIdsInput),
    loadResolutionEventCatalog(workspaceRoot, sourceId, worldProposalIdsInput),
  ]);
  const currentByMention = indexEventResolutions(current);
  const currentById = new Map(current.map((resolution) => [resolution.id, resolution]));
  const staged: EventResolutionProposal[] = [];
  const issues = new Set<string>();
  for (const proposalId of proposalIds) {
    try {
      staged.push(await readActiveEventResolutionProposal(store, sourceId, proposalId));
    } catch {
      issues.add(`${proposalId}: active event-resolution proposal is missing`);
    }
  }
  const stagedResolutionIds = new Set<string>();
  const stagedMentionOwners = new Map<string, string>();
  for (const proposal of staged) {
    if (stagedResolutionIds.has(proposal.payload.id)) issues.add(`${proposal.id}: duplicate event resolution id ${proposal.payload.id}`);
    stagedResolutionIds.add(proposal.payload.id);
    for (const mentionId of proposal.payload.eventMentionIds) {
      const owner = stagedMentionOwners.get(mentionId);
      if (owner) issues.add(`${mentionId}: event mention appears in more than one active resolution (${owner}, ${proposal.id})`);
      else stagedMentionOwners.set(mentionId, proposal.id);
      const competing = allPending
        .filter((summary) => summary.id !== proposal.id && !proposalIds.includes(summary.id) && summary.eventMentionIds.includes(mentionId))
        .map((summary) => summary.id);
      if (competing.length) issues.add(`${mentionId}: active event resolution(s) outside this finish handshake (${competing.join(", ")})`);
    }
  }
  const replacementCoverage = new Map<string, Set<string>>();
  for (const proposal of staged) {
    const resolution = proposal.payload;
    const mentions: EventMention[] = [];
    for (const mentionId of resolution.eventMentionIds) {
      const mention = annotations.eventMentions.get(mentionId);
      if (!mention) issues.add(`${proposal.id}: eventMentionIds references unknown event mention '${mentionId}'`);
      else mentions.push(mention);
    }
    const currentIds = [...new Set(resolution.eventMentionIds
      .map((mentionId) => currentByMention.get(mentionId)?.id)
      .filter((value): value is string => Boolean(value)))].sort();
    const alreadyCurrent = currentIds.length === 1
      && currentIds[0] === resolution.id
      && resolution.eventMentionIds.every((mentionId) => {
        const prior = currentByMention.get(mentionId);
        return prior?.id === resolution.id && contentHash(prior) === contentHash(resolution);
      });
    if (!alreadyCurrent) {
      if (currentIds.includes(resolution.id)) issues.add(`${proposal.id}: an event resolution revision must use a new resolution id`);
      if (canonicalJson(currentIds) !== canonicalJson([...resolution.supersedesResolutionIds].sort())) {
        issues.add(`${proposal.id}: supersedesResolutionIds must exactly match current resolution(s): ${currentIds.join(", ") || "(none)"}`);
      }
    }
    if (!alreadyCurrent) {
      for (const supersededId of resolution.supersedesResolutionIds) {
        if (!currentById.has(supersededId)) issues.add(`${proposal.id}: supersedes unknown current resolution '${supersededId}'`);
        const coverage = replacementCoverage.get(supersededId) ?? new Set<string>();
        resolution.eventMentionIds.forEach((mentionId) => coverage.add(mentionId));
        replacementCoverage.set(supersededId, coverage);
      }
    }
    for (const candidate of resolution.candidates) {
      for (const mentionId of resolution.eventMentionIds) {
        if (!candidate.basisEventMentionIds.includes(mentionId)) {
          issues.add(`${proposal.id}: candidate ${candidate.canonicalEventId}/${candidate.relation} omits cluster mention ${mentionId} from its basis`);
        }
      }
      for (const basisMentionId of candidate.basisEventMentionIds) {
        if (!annotations.eventMentions.has(basisMentionId)) {
          issues.add(`${proposal.id}: candidate ${candidate.canonicalEventId} uses unknown basis event mention ${basisMentionId}`);
        }
      }
      const event = events.all.get(candidate.canonicalEventId);
      if (!event) issues.add(`${proposal.id}: candidate references unknown canonical event '${candidate.canonicalEventId}'`);
      const knownEvidenceIds = events.evidenceAssertionIds.get(candidate.canonicalEventId) ?? new Set<string>();
      for (const assertionId of candidate.evidenceAssertionIds) {
        if (!knownEvidenceIds.has(assertionId)) {
          issues.add(`${proposal.id}: candidate ${candidate.canonicalEventId} cites unknown exact-evidence assertion ${assertionId}`);
        }
      }
      if (event
        && (resolution.status === "resolved" || resolution.status === "new-event")
        && candidate.canonicalEventId === resolution.canonicalEventId
        && candidate.relation === resolution.relation) {
        validateResolvedEventParticipants(issues, proposal.id, mentions, identities, event);
      }
    }
    if (resolution.status === "resolved" && resolution.canonicalEventId && !events.canonical.has(resolution.canonicalEventId)) {
      issues.add(`${proposal.id}: resolved event '${resolution.canonicalEventId}' must already be canonical; use new-event for a same-finish proposal`);
    }
    if (resolution.status === "new-event" && resolution.canonicalEventId && !events.selectedPending.has(resolution.canonicalEventId)) {
      issues.add(`${proposal.id}: new-event '${resolution.canonicalEventId}' requires a same-finish canonical-event proposal`);
    }
    if ((resolution.status === "ambiguous" || resolution.status === "unresolved")
      && resolution.candidates.some((candidate) => !events.canonical.has(candidate.canonicalEventId))) {
      issues.add(`${proposal.id}: ${resolution.status} candidates must refer to existing canonical events`);
    }
  }
  for (const [supersededId, coveredMentionIds] of replacementCoverage) {
    const prior = currentById.get(supersededId);
    if (!prior) continue;
    const missing = prior.eventMentionIds.filter((mentionId) => !coveredMentionIds.has(mentionId));
    if (missing.length) issues.add(`${supersededId}: split/merge revision leaves prior cluster mention(s) unassigned: ${missing.join(", ")}`);
  }
  return [...issues].sort();
}

export async function validateEventProposalResolutionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  worldProposalIdsInput: readonly string[],
  annotationProposalIdsInput: readonly string[],
  entityResolutionProposalIdsInput: readonly string[],
  eventResolutionProposalIdsInput: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [annotations, identities, resolutions, events] = await Promise.all([
    loadAnnotationCatalog(workspaceRoot, sourceId, annotationProposalIdsInput),
    loadIdentityCatalog(workspaceRoot, sourceId, entityResolutionProposalIdsInput),
    loadEventResolutionCatalog(workspaceRoot, sourceId, eventResolutionProposalIdsInput),
    loadSelectedEventProposals(workspaceRoot, sourceId, worldProposalIdsInput),
  ]);
  if (!annotations.eventMentions.size || !events.size) return [];
  const canonicalIds = new Set((await sourceCanonicalEvents(workspaceRoot, sourceId)).map((event) => event.id));
  return eventTraceIssues(events.values(), annotations.eventMentions, identities, resolutions, canonicalIds);
}

export async function validateCommittedEventResolutionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  eventInput: CanonicalEvent,
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const event = canonicalEventSchema.parse(eventInput);
  const annotations = await loadAnnotationCatalog(workspaceRoot, sourceId, []);
  if (!annotations.eventMentions.size) return [];
  const [identities, eventResolutions, canonicalEvents] = await Promise.all([
    loadIdentityCatalog(workspaceRoot, sourceId, []),
    new EventResolutionStore(workspaceRoot).list(sourceId),
    sourceCanonicalEvents(workspaceRoot, sourceId),
  ]);
  return eventTraceIssues(
    [event],
    annotations.eventMentions,
    identities,
    indexEventResolutions(eventResolutions),
    new Set(canonicalEvents.map((candidate) => candidate.id)),
  );
}

export type EventResolutionCoverage = {
  sourceId: string;
  eventMentions: number;
  majorEventMentions: number;
  resolved: number;
  newEvents: number;
  ambiguous: number;
  unresolved: number;
  nonReferential: number;
  missing: number;
  pending: number;
  majorResolved: number;
  majorNonReferential: number;
  majorIncomplete: number;
  missingMentionIds: string[];
  invalidResolutionIds: string[];
  errors: string[];
};

export async function inspectEventResolutionCoverage(
  workspaceRoot: string,
  sourceIdInput: string,
): Promise<EventResolutionCoverage> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [annotations, resolutions, pending, catalog] = await Promise.all([
    loadAnnotationCatalog(workspaceRoot, sourceId, []),
    new EventResolutionStore(workspaceRoot).list(sourceId),
    new EventResolutionStore(workspaceRoot).listProposals(sourceId, "pending"),
    sourceEventCatalog(workspaceRoot, sourceId),
  ]);
  const events = new Map(catalog.map(({ event }) => [event.id, event]));
  const byMention = indexEventResolutions(resolutions);
  const errors: string[] = [];
  const invalidResolutionIds = new Set<string>();
  for (const resolution of resolutions) {
    for (const mentionId of resolution.eventMentionIds) {
      if (!annotations.eventMentions.has(mentionId)) {
        errors.push(`${resolution.id}: current resolution refers to missing event mention ${mentionId}`);
        invalidResolutionIds.add(resolution.id);
      }
    }
    for (const candidate of resolution.candidates) {
      if (!events.has(candidate.canonicalEventId)) {
        errors.push(`${resolution.id}: candidate refers to missing canonical event ${candidate.canonicalEventId}`);
        invalidResolutionIds.add(resolution.id);
      }
      for (const basisMentionId of candidate.basisEventMentionIds) {
        if (!annotations.eventMentions.has(basisMentionId)) {
          errors.push(`${resolution.id}: candidate basis refers to missing event mention ${basisMentionId}`);
          invalidResolutionIds.add(resolution.id);
        }
      }
    }
  }
  const mentionValues = [...annotations.eventMentions.values()];
  const statusCount = (status: EventResolution["status"]) => mentionValues
    .filter((mention) => byMention.get(mention.id)?.status === status).length;
  const missingMentionIds = mentionValues.filter((mention) => !byMention.has(mention.id)).map((mention) => mention.id).sort();
  const majorMentions = mentionValues.filter((mention) => mention.salience === "major");
  const majorResolved = majorMentions.filter((mention) => {
    const resolution = byMention.get(mention.id);
    return resolution?.status === "resolved" || resolution?.status === "new-event";
  }).length;
  const majorNonReferential = majorMentions.filter((mention) =>
    byMention.get(mention.id)?.status === "non-referential").length;
  return {
    sourceId,
    eventMentions: mentionValues.length,
    majorEventMentions: majorMentions.length,
    resolved: statusCount("resolved"),
    newEvents: statusCount("new-event"),
    ambiguous: statusCount("ambiguous"),
    unresolved: statusCount("unresolved"),
    nonReferential: statusCount("non-referential"),
    missing: missingMentionIds.length,
    pending: pending.length,
    majorResolved,
    majorNonReferential,
    majorIncomplete: majorMentions.length - majorResolved - majorNonReferential,
    missingMentionIds,
    invalidResolutionIds: [...invalidResolutionIds].sort(),
    errors: errors.sort(),
  };
}

function eventTraceIssues(
  events: Iterable<CanonicalEvent>,
  mentions: ReadonlyMap<string, EventMention>,
  identities: ReadonlyMap<string, IdentityResolution>,
  resolutions: ReadonlyMap<string, EventResolution>,
  canonicalIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const uniqueResolutions = new Map<string, EventResolution>();
  for (const resolution of resolutions.values()) uniqueResolutions.set(`${resolution.id}:${contentHash(resolution)}`, resolution);
  for (const event of events) {
    const traces = [...uniqueResolutions.values()].filter((resolution) =>
      (resolution.status === "resolved" || resolution.status === "new-event")
      && resolution.relation === "coreference"
      && resolution.canonicalEventId === event.id);
    if (!traces.length) {
      issues.push(`Canonical event ${event.id} has no coreferential resolved source event mention.`);
      continue;
    }
    if (!canonicalIds.has(event.id) && !traces.some((resolution) => resolution.status === "new-event")) {
      issues.push(`New canonical event ${event.id} must be established by a new-event resolution.`);
    }
    const participantIds = new Set<string>();
    for (const resolution of traces) {
      for (const mentionId of resolution.eventMentionIds) {
        const mention = mentions.get(mentionId);
        if (!mention) continue;
        for (const participantMentionId of mention.participantMentionIds) {
          const identity = identities.get(participantMentionId);
          if ((identity?.status === "resolved" || identity?.status === "new-entity" || identity?.status === "misidentified") && identity.entityId) {
            participantIds.add(identity.entityId);
          }
        }
      }
    }
    event.participants.forEach((participantId, index) => {
      if (!participantIds.has(participantId)) {
        issues.push(`Canonical event ${event.id} participant '${participantId}' at participants.${index} has no resolved participant mention in its event trace.`);
      }
    });
  }
  return issues.sort();
}

function validateResolvedEventParticipants(
  issues: Set<string>,
  proposalId: string,
  mentions: readonly EventMention[],
  identities: ReadonlyMap<string, IdentityResolution>,
  event: CanonicalEvent,
): void {
  for (const mention of mentions) {
    for (const participantMentionId of mention.participantMentionIds) {
      const identity = identities.get(participantMentionId);
      if (!identity || (identity.status !== "resolved" && identity.status !== "new-entity" && identity.status !== "misidentified") || !identity.entityId) {
        issues.add(`${proposalId}: participant mention ${participantMentionId} must have a selected entity identity before resolving the event`);
      } else if (!event.participants.includes(identity.entityId)) {
        issues.add(`${proposalId}: resolved participant ${identity.entityId} is absent from canonical event ${event.id}`);
      }
    }
  }
}

type AnnotationCatalog = {
  entityMentions: Map<string, EntityMention>;
  eventMentions: Map<string, EventMention>;
};

async function loadAnnotationCatalog(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<AnnotationCatalog> {
  const store = new SourceAnnotationStore(workspaceRoot);
  const values = await store.list(sourceId);
  const entityMentions = new Map<string, EntityMention>();
  const eventMentions = new Map<string, EventMention>();
  const add = (value: (typeof values)[number]) => {
    if (value.annotationType === "entity-mention") entityMentions.set(value.id, entityMentionSchema.parse(value));
    if (value.annotationType === "event-mention") eventMentions.set(value.id, eventMentionSchema.parse(value));
  };
  values.forEach(add);
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    let proposal;
    try {
      proposal = await store.readProposal(sourceId, "pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      proposal = await store.readProposal(sourceId, "accepted", proposalId);
    }
    add(proposal.payload);
  }
  return { entityMentions, eventMentions };
}

async function loadIdentityCatalog(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, IdentityResolution>> {
  const store = new EntityResolutionStore(workspaceRoot);
  const catalog = new Map((await store.list(sourceId)).map((resolution) => [resolution.mentionId, resolution]));
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    let proposal;
    try {
      proposal = await store.readProposal(sourceId, "pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      proposal = await store.readProposal(sourceId, "accepted", proposalId);
    }
    catalog.set(proposal.payload.mentionId, proposal.payload);
  }
  return catalog;
}

async function loadIdentityCatalogForBatch(
  workspaceRoot: string,
  sourceId: string,
  compilerBatchId?: string,
): Promise<Map<string, IdentityResolution>> {
  const store = new EntityResolutionStore(workspaceRoot);
  const catalog = new Map((await store.list(sourceId)).map((resolution) => [resolution.mentionId, resolution]));
  if (!compilerBatchId) return catalog;
  for (const summary of await store.listBatchProposals(sourceId, compilerBatchId)) {
    let proposal;
    try {
      proposal = await store.readProposal(sourceId, "pending", summary.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      proposal = await store.readProposal(sourceId, "accepted", summary.id);
    }
    catalog.set(proposal.payload.mentionId, proposal.payload);
  }
  return catalog;
}

async function loadResolutionEventCatalog(
  workspaceRoot: string,
  sourceId: string,
  worldProposalIds: readonly string[],
): Promise<{
  canonical: Map<string, CanonicalEvent>;
  selectedPending: Map<string, CanonicalEvent>;
  all: Map<string, CanonicalEvent>;
  evidenceAssertionIds: Map<string, Set<string>>;
}> {
  const canonical = new Map((await sourceCanonicalEvents(workspaceRoot, sourceId)).map((event) => [event.id, event]));
  const selectedPending = await loadSelectedEventProposals(workspaceRoot, sourceId, worldProposalIds);
  const evidenceAssertionIds = new Map<string, Set<string>>();
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  for (const eventId of canonical.keys()) {
    const assertions = await exactEvidence.listForArtifact("canonical-event", eventId);
    assertAssertionSource(assertions, sourceId, `Canonical event ${eventId}`);
    evidenceAssertionIds.set(eventId, new Set(assertions.map((assertion) => assertion.id)));
  }
  const proposals = new ProposalStore(workspaceRoot);
  for (const proposalId of uniqueParsedIds(worldProposalIds)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = await proposals.readEnvelope("pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (envelope.kind !== "canonical-event") continue;
    const event = canonicalEventSchema.parse(envelope.payload);
    const assertions = evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []);
    assertAssertionSource(assertions, sourceId, `Canonical-event proposal ${proposalId}`);
    evidenceAssertionIds.set(event.id, new Set(assertions.map((assertion) => assertion.id)));
  }
  return { canonical, selectedPending, all: new Map([...canonical, ...selectedPending]), evidenceAssertionIds };
}

async function loadSelectedEventProposals(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, CanonicalEvent>> {
  const store = new ProposalStore(workspaceRoot);
  const selected = new Map<string, CanonicalEvent>();
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = await store.readEnvelope("pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (envelope.kind !== "canonical-event") continue;
    const event = canonicalEventSchema.parse(envelope.payload);
    assertEvidenceExclusiveToSource(event.evidence, sourceId, `Canonical-event proposal ${proposalId}`);
    selected.set(event.id, event);
  }
  return selected;
}

async function loadEventResolutionCatalog(
  workspaceRoot: string,
  sourceId: string,
  proposalIds: readonly string[],
): Promise<Map<string, EventResolution>> {
  const store = new EventResolutionStore(workspaceRoot);
  const catalog = indexEventResolutions(await store.list(sourceId));
  for (const proposalId of uniqueParsedIds(proposalIds)) {
    const proposal = await readActiveEventResolutionProposal(store, sourceId, proposalId);
    for (const mentionId of proposal.payload.eventMentionIds) catalog.set(mentionId, proposal.payload);
  }
  return catalog;
}

async function sourceCanonicalEvents(workspaceRoot: string, sourceId: string): Promise<CanonicalEvent[]> {
  return (await new CanonicalModelStore(workspaceRoot).listEvents()).filter((event) => {
    const matches = event.evidence.some((reference) => reference.span.sourceId === sourceId);
    if (matches) assertEvidenceExclusiveToSource(event.evidence, sourceId, `Canonical event ${event.id}`);
    return matches;
  });
}

type EventCatalogEntry = {
  event: CanonicalEvent;
  status: "canonical" | "pending";
  ranges: Array<{ startByte: number; endByte: number }>;
};

async function sourceEventCatalog(workspaceRoot: string, sourceId: string): Promise<EventCatalogEntry[]> {
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  const entries = new Map<string, EventCatalogEntry>();
  for (const event of await sourceCanonicalEvents(workspaceRoot, sourceId)) {
    const assertions = await exactEvidence.listForArtifact("canonical-event", event.id);
    entries.set(event.id, { event, status: "canonical", ranges: evidenceRanges(event, assertions) });
  }
  const proposals = new ProposalStore(workspaceRoot);
  for (const summary of await proposals.list("pending", sourceId)) {
    if (summary.kind !== "canonical-event") continue;
    const envelope = await proposals.readEnvelope("pending", summary.id);
    const event = canonicalEventSchema.parse(envelope.payload);
    const assertions = evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []);
    entries.set(event.id, { event, status: "pending", ranges: evidenceRanges(event, assertions) });
  }
  return [...entries.values()];
}

function evidenceRanges(event: CanonicalEvent, assertions: readonly EvidenceAssertion[]): Array<{ startByte: number; endByte: number }> {
  const exact = assertions.flatMap((assertion) => assertion.anchors.map((anchor) => ({
    startByte: anchor.startByte,
    endByte: anchor.endByte,
  })));
  if (exact.length) return exact;
  return event.evidence.flatMap((reference) => reference.span.startByte === undefined || reference.span.endByte === undefined
    ? []
    : [{ startByte: reference.span.startByte, endByte: reference.span.endByte }]);
}

async function loadEventMention(
  workspaceRoot: string,
  sourceId: string,
  mentionId: string,
  compilerBatchId?: string,
): Promise<EventMention> {
  const store = new SourceAnnotationStore(workspaceRoot);
  try {
    return eventMentionSchema.parse(await store.read(sourceId, mentionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const matches: EventMention[] = [];
  for (const summary of await store.listProposals(sourceId, "pending")) {
    if (compilerBatchId && summary.compilerBatchId !== compilerBatchId) continue;
    const proposal = await store.readProposal(sourceId, "pending", summary.id);
    if (proposal.payload.id === mentionId && proposal.payload.annotationType === "event-mention") {
      matches.push(eventMentionSchema.parse(proposal.payload));
    }
  }
  if (matches.length !== 1) {
    throw Object.assign(new Error(matches.length
      ? `Event mention ${mentionId} has ${matches.length} active proposals; resolve the duplicate first.`
      : `Event mention not found: ${mentionId}`), { code: "ENOENT" });
  }
  return matches[0]!;
}

function indexEventResolutions(resolutions: readonly EventResolution[]): Map<string, EventResolution> {
  const byMention = new Map<string, EventResolution>();
  for (const resolution of resolutions) {
    for (const mentionId of resolution.eventMentionIds) byMention.set(mentionId, resolution);
  }
  return byMention;
}

function resolvedParticipantEntityIds(
  mention: EventMention,
  identities: ReadonlyMap<string, IdentityResolution>,
): string[] {
  return [...new Set(mention.participantMentionIds.flatMap((mentionId) => {
    const resolution = identities.get(mentionId);
    return resolution && (resolution.status === "resolved" || resolution.status === "new-entity" || resolution.status === "misidentified") && resolution.entityId
      ? [resolution.entityId]
      : [];
  }))].sort();
}

async function readActiveEventResolutionProposal(
  store: EventResolutionStore,
  sourceId: string,
  proposalId: string,
): Promise<EventResolutionProposal> {
  try {
    return await store.readProposal(sourceId, "pending", proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return store.readProposal(sourceId, "accepted", proposalId);
  }
}

function assertAssertionSource(assertions: readonly EvidenceAssertion[], sourceId: string, label: string): void {
  const sourceIds = evidenceAssertionSourceIds(assertions);
  if (sourceIds.length && (sourceIds.length !== 1 || sourceIds[0] !== sourceId)) {
    throw new Error(`${label} has exact evidence outside source ${sourceId}.`);
  }
}

function rangesOverlap(
  left: { startByte: number; endByte: number },
  right: { startByte: number; endByte: number },
): boolean {
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

function normalizeEventText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function uniqueParsedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => idSchema.parse(value)))].sort();
}

function proposalIdentity(proposal: EventResolutionProposal): Omit<EventResolutionProposal, "createdAt"> {
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
      throw new Error(`Immutable event resolution already exists with different content: ${filePath}`);
    }
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
