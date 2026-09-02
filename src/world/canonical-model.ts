import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { worldStorageRoot } from "./paths.js";
import {
  artifactProposalSchema,
  attributionSchema,
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  eventParticipationSchema,
  eventRelationSchema,
  propositionSchema,
  worldRuleSchema,
  type ArtifactProposal,
  type Attribution,
  type CanonicalEvent,
  type Claim,
  type Entity,
  type EventParticipation,
  type EventRelation,
  type Proposition,
  type ValidationIssue,
  type WorldRule,
} from "./model.js";
import { characterOntologyEvidence } from "./character-ontology.js";
import { spatialRelationSchema, type SpatialRelation } from "./spatial-ontology.js";
import { sceneOccurrenceSchema, type SceneOccurrence } from "./scene-occurrence.js";
import { eventFrameSchema, type EventFrame } from "./event-frame.js";
import { actionSchemaSchema, type ActionSchema } from "./action-ontology.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type CanonicalKind = "entities" | "propositions" | "attributions" | "claims" | "events" | "event-participations" | "event-relations" | "spatial-relations" | "scene-occurrences" | "event-frames" | "action-schemas" | "rules";
export type CanonicalRevisionRef = { id: string; hash: string };
type StoredCanonicalRef = { version: 1; id: string; hash: string };
export type ProposalStatus = "pending" | "accepted" | "rejected";
export type ProposalSummary = { id: string; kind: string; schemaVersion: number; createdAt: string; worker: string };
export type ProposalRejectionReport = {
  version: 1;
  proposalId: string;
  kind: string;
  rejectedAt: string;
  errors: ValidationIssue[];
};

function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe artifact id: ${id}`);
  return id;
}
async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Canonical artifact already exists with different content: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export class CanonicalModelStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(worldStorageRoot(workspaceRoot), "canon"); }
  putEntity(entity: Entity): Promise<void> { const value = entitySchema.parse(entity); return this.put("entities", value.id, value); }
  putProposition(proposition: Proposition): Promise<void> { const value = propositionSchema.parse(proposition); return this.put("propositions", value.id, value); }
  putAttribution(attribution: Attribution): Promise<void> { const value = attributionSchema.parse(attribution); return this.put("attributions", value.id, value); }
  putClaim(claim: Claim): Promise<void> { const value = claimSchema.parse(claim); return this.put("claims", value.id, value); }
  putEvent(event: CanonicalEvent): Promise<void> { const value = canonicalEventSchema.parse(event); return this.put("events", value.id, value); }
  putEventParticipation(participation: EventParticipation): Promise<void> { const value = eventParticipationSchema.parse(participation); return this.put("event-participations", value.id, value); }
  putEventRelation(relation: EventRelation): Promise<void> { const value = eventRelationSchema.parse(relation); return this.put("event-relations", value.id, value); }
  putSpatialRelation(relation: SpatialRelation): Promise<void> { const value = spatialRelationSchema.parse(relation); return this.put("spatial-relations", value.id, value); }
  putSceneOccurrence(scene: SceneOccurrence): Promise<void> { const value = sceneOccurrenceSchema.parse(scene); return this.put("scene-occurrences", value.id, value); }
  putEventFrame(frame: EventFrame): Promise<void> { const value = eventFrameSchema.parse(frame); return this.put("event-frames", value.id, value); }
  putActionSchema(schema: ActionSchema): Promise<void> { const value = actionSchemaSchema.parse(schema); return this.put("action-schemas", value.id, value); }
  putRule(rule: WorldRule): Promise<void> { const value = worldRuleSchema.parse(rule); return this.put("rules", value.id, value); }
  ensureEntityRevision(entity: Entity): Promise<void> { const value = entitySchema.parse(entity); return this.ensureRevision("entities", value.id, value); }
  ensurePropositionRevision(proposition: Proposition): Promise<void> { const value = propositionSchema.parse(proposition); return this.ensureRevision("propositions", value.id, value); }
  ensureAttributionRevision(attribution: Attribution): Promise<void> { const value = attributionSchema.parse(attribution); return this.ensureRevision("attributions", value.id, value); }
  ensureClaimRevision(claim: Claim): Promise<void> { const value = claimSchema.parse(claim); return this.ensureRevision("claims", value.id, value); }
  ensureEventRevision(event: CanonicalEvent): Promise<void> { const value = canonicalEventSchema.parse(event); return this.ensureRevision("events", value.id, value); }
  ensureEventParticipationRevision(participation: EventParticipation): Promise<void> { const value = eventParticipationSchema.parse(participation); return this.ensureRevision("event-participations", value.id, value); }
  ensureEventRelationRevision(relation: EventRelation): Promise<void> { const value = eventRelationSchema.parse(relation); return this.ensureRevision("event-relations", value.id, value); }
  ensureSpatialRelationRevision(relation: SpatialRelation): Promise<void> { const value = spatialRelationSchema.parse(relation); return this.ensureRevision("spatial-relations", value.id, value); }
  ensureSceneOccurrenceRevision(scene: SceneOccurrence): Promise<void> { const value = sceneOccurrenceSchema.parse(scene); return this.ensureRevision("scene-occurrences", value.id, value); }
  ensureEventFrameRevision(frame: EventFrame): Promise<void> { const value = eventFrameSchema.parse(frame); return this.ensureRevision("event-frames", value.id, value); }
  ensureActionSchemaRevision(schema: ActionSchema): Promise<void> { const value = actionSchemaSchema.parse(schema); return this.ensureRevision("action-schemas", value.id, value); }
  ensureRuleRevision(rule: WorldRule): Promise<void> { const value = worldRuleSchema.parse(rule); return this.ensureRevision("rules", value.id, value); }
  getEntity(id: string): Promise<Entity> { return this.get("entities", id, entitySchema); }
  getProposition(id: string): Promise<Proposition> { return this.get("propositions", id, propositionSchema); }
  getAttribution(id: string): Promise<Attribution> { return this.get("attributions", id, attributionSchema); }
  getClaim(id: string): Promise<Claim> { return this.get("claims", id, claimSchema); }
  getEvent(id: string): Promise<CanonicalEvent> { return this.get("events", id, canonicalEventSchema); }
  getEventParticipation(id: string): Promise<EventParticipation> { return this.get("event-participations", id, eventParticipationSchema); }
  getEventRelation(id: string): Promise<EventRelation> { return this.get("event-relations", id, eventRelationSchema); }
  getSpatialRelation(id: string): Promise<SpatialRelation> { return this.get("spatial-relations", id, spatialRelationSchema); }
  getSceneOccurrence(id: string): Promise<SceneOccurrence> { return this.get("scene-occurrences", id, sceneOccurrenceSchema); }
  getEventFrame(id: string): Promise<EventFrame> { return this.get("event-frames", id, eventFrameSchema); }
  getActionSchema(id: string): Promise<ActionSchema> { return this.get("action-schemas", id, actionSchemaSchema); }
  getRule(id: string): Promise<WorldRule> { return this.get("rules", id, worldRuleSchema); }
  getEntityRevision(id: string, hash: string): Promise<Entity> { return this.getRevision("entities", id, hash, entitySchema); }
  getPropositionRevision(id: string, hash: string): Promise<Proposition> { return this.getRevision("propositions", id, hash, propositionSchema); }
  getAttributionRevision(id: string, hash: string): Promise<Attribution> { return this.getRevision("attributions", id, hash, attributionSchema); }
  getClaimRevision(id: string, hash: string): Promise<Claim> { return this.getRevision("claims", id, hash, claimSchema); }
  getEventRevision(id: string, hash: string): Promise<CanonicalEvent> { return this.getRevision("events", id, hash, canonicalEventSchema); }
  getEventParticipationRevision(id: string, hash: string): Promise<EventParticipation> { return this.getRevision("event-participations", id, hash, eventParticipationSchema); }
  getEventRelationRevision(id: string, hash: string): Promise<EventRelation> { return this.getRevision("event-relations", id, hash, eventRelationSchema); }
  getSpatialRelationRevision(id: string, hash: string): Promise<SpatialRelation> { return this.getRevision("spatial-relations", id, hash, spatialRelationSchema); }
  getSceneOccurrenceRevision(id: string, hash: string): Promise<SceneOccurrence> { return this.getRevision("scene-occurrences", id, hash, sceneOccurrenceSchema); }
  getEventFrameRevision(id: string, hash: string): Promise<EventFrame> { return this.getRevision("event-frames", id, hash, eventFrameSchema); }
  getActionSchemaRevision(id: string, hash: string): Promise<ActionSchema> { return this.getRevision("action-schemas", id, hash, actionSchemaSchema); }
  getRuleRevision(id: string, hash: string): Promise<WorldRule> { return this.getRevision("rules", id, hash, worldRuleSchema); }
  listEntities(): Promise<Entity[]> { return this.list("entities", entitySchema); }
  listPropositions(): Promise<Proposition[]> { return this.list("propositions", propositionSchema); }
  listAttributions(): Promise<Attribution[]> { return this.list("attributions", attributionSchema); }
  listClaims(): Promise<Claim[]> { return this.list("claims", claimSchema); }
  listEvents(): Promise<CanonicalEvent[]> { return this.list("events", canonicalEventSchema); }
  listEventParticipations(): Promise<EventParticipation[]> { return this.list("event-participations", eventParticipationSchema); }
  listEventRelations(): Promise<EventRelation[]> { return this.list("event-relations", eventRelationSchema); }
  listSpatialRelations(): Promise<SpatialRelation[]> { return this.list("spatial-relations", spatialRelationSchema); }
  listSceneOccurrences(): Promise<SceneOccurrence[]> { return this.list("scene-occurrences", sceneOccurrenceSchema); }
  listEventFrames(): Promise<EventFrame[]> { return this.list("event-frames", eventFrameSchema); }
  listActionSchemas(): Promise<ActionSchema[]> { return this.list("action-schemas", actionSchemaSchema); }
  listRules(): Promise<WorldRule[]> { return this.list("rules", worldRuleSchema); }
  async currentRevision(kind: CanonicalKind, idInput: string): Promise<CanonicalRevisionRef | null> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (ref) return { id, hash: ref.hash };
    const legacy = await this.readLegacy(kind, id);
    return legacy === null ? null : { id, hash: contentHash(legacy) };
  }
  async listRevisions(kind: CanonicalKind, idInput: string): Promise<CanonicalRevisionRef[]> {
    const id = safeId(idInput);
    const hashes = new Set<string>();
    const directory = path.join(this.root, kind, "revisions", id);
    try {
      for (const name of await fs.readdir(directory)) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) hashes.add(name.slice(0, -5));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const legacy = await this.readLegacy(kind, id);
    if (legacy !== null) hashes.add(contentHash(legacy));
    return [...hashes].sort().map((hash) => ({ id, hash }));
  }
  async removeCurrent(kind: CanonicalKind, idInput: string): Promise<void> {
    const id = safeId(idInput);
    const legacy = await this.readLegacy(kind, id);
    if (legacy !== null) {
      await writeImmutable(this.revisionPath(kind, id, contentHash(legacy)), legacy);
      await fs.rm(this.legacyPath(kind, id), { force: true });
    }
    await fs.rm(this.refPath(kind, id), { force: true });
  }
  private async put(kind: CanonicalKind, idInput: string, value: unknown): Promise<void> {
    const id = safeId(idInput);
    const legacy = await this.readLegacy(kind, id);
    if (legacy !== null) {
      const legacyHash = contentHash(legacy);
      await writeImmutable(this.revisionPath(kind, id, legacyHash), legacy);
    }
    const hash = contentHash(value);
    await writeImmutable(this.revisionPath(kind, id, hash), value);
    await atomicJson(this.refPath(kind, id), { version: 1, id, hash } satisfies StoredCanonicalRef);
  }
  private async ensureRevision(kind: CanonicalKind, idInput: string, value: unknown): Promise<void> {
    const id = safeId(idInput);
    await writeImmutable(this.revisionPath(kind, id, contentHash(value)), value);
  }
  private async get<T>(kind: CanonicalKind, idInput: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (!ref) {
      const legacy = await this.readLegacy(kind, id);
      if (legacy === null) throw Object.assign(new Error(`Canonical ${kind} artifact not found: ${id}`), { code: "ENOENT" });
      return schema.parse(legacy);
    }
    const value = schema.parse(JSON.parse(await fs.readFile(this.revisionPath(kind, id, ref.hash), "utf8")));
    if (contentHash(value) !== ref.hash) throw new Error(`Corrupt canonical ${kind} revision ${id}@${ref.hash}`);
    return value;
  }
  private async getRevision<T>(kind: CanonicalKind, idInput: string, hashInput: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    if (!/^[a-f0-9]{64}$/.test(hashInput)) throw new Error(`Invalid canonical revision hash: ${hashInput}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.revisionPath(kind, id, hashInput), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.readLegacy(kind, id);
      if (legacy === null || contentHash(legacy) !== hashInput) {
        throw Object.assign(new Error(`Canonical ${kind} revision not found: ${id}@${hashInput}`), { code: "ENOENT" });
      }
      raw = legacy;
    }
    const value = schema.parse(raw);
    if (contentHash(value) !== hashInput) throw new Error(`Corrupt canonical ${kind} revision ${id}@${hashInput}`);
    return value;
  }
  private async list<T>(kind: CanonicalKind, schema: z.ZodType<T>): Promise<T[]> {
    const ids = new Set<string>();
    for (const directory of [path.join(this.root, kind, "refs"), path.join(this.root, kind)]) {
      try {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json")) ids.add(entry.name.slice(0, -5));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const values: T[] = [];
    for (const id of [...ids].sort()) values.push(await this.get(kind, id, schema));
    return values;
  }
  private refPath(kind: CanonicalKind, id: string): string { return path.join(this.root, kind, "refs", `${id}.json`); }
  private revisionPath(kind: CanonicalKind, id: string, hash: string): string { return path.join(this.root, kind, "revisions", id, `${hash}.json`); }
  private legacyPath(kind: CanonicalKind, id: string): string { return path.join(this.root, kind, `${id}.json`); }
  private async readRef(kind: CanonicalKind, id: string): Promise<StoredCanonicalRef | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.refPath(kind, id), "utf8")) as StoredCanonicalRef;
      if (value.version !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error(`Invalid canonical ref: ${kind}/${id}`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async readLegacy(kind: CanonicalKind, id: string): Promise<unknown | null> {
    try { return JSON.parse(await fs.readFile(this.legacyPath(kind, id), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

export class ProposalStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(worldStorageRoot(workspaceRoot), "proposals"); }
  async writePending<T>(proposal: ArtifactProposal<T>, payloadSchema: z.ZodType<T>): Promise<void> {
    const parsed = artifactProposalSchema(payloadSchema).parse(proposal);
    const filePath = this.proposalPath("pending", parsed.id);
    try {
      const existing = artifactProposalSchema(payloadSchema).parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (canonicalJson(proposalIdentity(existing)) === canonicalJson(proposalIdentity(parsed))) return;
      throw new Error(`Pending proposal ${parsed.id} already exists with different content; submit the correction under a new proposal id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const status of ["accepted", "rejected"] as const) {
      try {
        await fs.access(this.proposalPath(status, parsed.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Proposal ${parsed.id} already exists in ${status} history; submit a new proposal id.`);
    }
    await writeImmutable(filePath, parsed);
  }
  async read<T>(status: ProposalStatus, id: string, payloadSchema: z.ZodType<T>): Promise<ArtifactProposal<T>> {
    return artifactProposalSchema(payloadSchema).parse(JSON.parse(await fs.readFile(this.proposalPath(status, id), "utf8"))) as ArtifactProposal<T>;
  }
  async readEnvelope(status: ProposalStatus, id: string): Promise<Record<string, unknown>> {
    const value = JSON.parse(await fs.readFile(this.proposalPath(status, id), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid proposal envelope: ${id}`);
    return value as Record<string, unknown>;
  }
  async list(status: ProposalStatus = "pending", sourceId?: string): Promise<ProposalSummary[]> {
    const directory = path.join(this.root, status);
    let names: string[];
    try { names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const summaries: ProposalSummary[] = [];
    for (const name of names) {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>;
      if (sourceId) {
        const sourceIds = proposalEvidenceSourceIds(value);
        if (sourceIds.length > 1) {
          throw new Error(`Proposal ${typeof value.id === "string" ? value.id : name} mixes evidence from multiple novel sources: ${sourceIds.join(", ")}.`);
        }
        if (sourceIds[0] !== sourceId) continue;
      }
      const generatedBy = value.generatedBy as Record<string, unknown> | undefined;
      if (typeof value.id !== "string" || typeof value.kind !== "string" || typeof value.schemaVersion !== "number" || typeof value.createdAt !== "string" || typeof generatedBy?.worker !== "string") {
        throw new Error(`Invalid proposal envelope: ${name}`);
      }
      summaries.push({ id: value.id, kind: value.kind, schemaVersion: value.schemaVersion, createdAt: value.createdAt, worker: generatedBy.worker });
    }
    return summaries;
  }
  async transition(id: string, from: ProposalStatus, to: Exclude<ProposalStatus, "pending">): Promise<void> {
    const source = this.proposalPath(from, id);
    const target = this.proposalPath(to, id);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.rename(source, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Proposal not found: ${id}`); throw error; }
  }
  async reject(id: string, errors: readonly ValidationIssue[]): Promise<ProposalRejectionReport> {
    const envelope = await this.readEnvelope("pending", id);
    const kind = typeof envelope.kind === "string" ? envelope.kind : "unknown";
    // Persist the immutable reason first. If the process stops between these
    // operations, a retry can complete the transition without ever producing
    // a rejected proposal whose diagnostic was lost.
    const report = await this.recordRejection(id, kind, errors);
    await this.transition(id, "pending", "rejected");
    return report;
  }
  async recordRejection(
    proposalIdInput: string,
    kind: string,
    errorsInput: readonly ValidationIssue[],
  ): Promise<ProposalRejectionReport> {
    const proposalId = safeId(proposalIdInput);
    const filePath = path.join(this.root, "rejection-reports", `${proposalId}.json`);
    try {
      return parseProposalRejectionReport(JSON.parse(await fs.readFile(filePath, "utf8")), proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const report: ProposalRejectionReport = {
      version: 1,
      proposalId,
      kind,
      rejectedAt: new Date().toISOString(),
      errors: errorsInput.length
        ? structuredClone(errorsInput) as ValidationIssue[]
        : [{ code: "UNSPECIFIED_REJECTION", message: "Proposal was moved to rejected history without a supplied diagnostic." }],
    };
    await writeImmutable(filePath, report);
    return report;
  }
  async readRejection(proposalIdInput: string): Promise<ProposalRejectionReport | null> {
    const proposalId = safeId(proposalIdInput);
    try {
      return parseProposalRejectionReport(
        JSON.parse(await fs.readFile(path.join(this.root, "rejection-reports", `${proposalId}.json`), "utf8")),
        proposalId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async listRejections(): Promise<ProposalRejectionReport[]> {
    const directory = path.join(this.root, "rejection-reports");
    let names: string[];
    try { names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.map(async (name) => parseProposalRejectionReport(
      JSON.parse(await fs.readFile(path.join(directory, name), "utf8")),
      name.slice(0, -5),
    )));
  }
  async removeForSource(sourceId: string): Promise<number> {
    let removed = 0;
    for (const status of ["pending", "accepted", "rejected"] as const) {
      for (const summary of await this.list(status, sourceId)) {
        await fs.rm(this.proposalPath(status, summary.id), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
  private proposalPath(status: ProposalStatus, id: string): string { return path.join(this.root, status, `${safeId(id)}.json`); }
}

function parseProposalRejectionReport(value: unknown, expectedProposalId: string): ProposalRejectionReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid proposal rejection report: ${expectedProposalId}`);
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.proposalId !== expectedProposalId || typeof record.kind !== "string"
    || typeof record.rejectedAt !== "string" || !Array.isArray(record.errors) || !record.errors.length) {
    throw new Error(`Invalid proposal rejection report: ${expectedProposalId}`);
  }
  const errors: ValidationIssue[] = record.errors.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Invalid proposal rejection report: ${expectedProposalId}`);
    const issue = candidate as Record<string, unknown>;
    if (typeof issue.code !== "string" || typeof issue.message !== "string"
      || (issue.path !== undefined && typeof issue.path !== "string")) {
      throw new Error(`Invalid proposal rejection report: ${expectedProposalId}`);
    }
    return issue.path === undefined
      ? { code: issue.code, message: issue.message }
      : { code: issue.code, message: issue.message, path: issue.path };
  });
  return {
    version: 1,
    proposalId: expectedProposalId,
    kind: record.kind,
    rejectedAt: record.rejectedAt,
    errors,
  };
}

function proposalEvidenceSourceIds(value: Record<string, unknown>): string[] {
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
    ? value.payload as Record<string, unknown>
    : undefined;
  const candidates = [value.evidence, payload?.evidence, payload?.counterEvidence, characterOntologyEvidence(payload)];
  const sourceIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate)) throw new Error("Proposal evidence must be an array.");
    for (const reference of candidate) {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
        throw new Error("Proposal evidence contains an invalid reference.");
      }
      const span = (reference as Record<string, unknown>).span;
      if (!span || typeof span !== "object" || Array.isArray(span)
        || typeof (span as Record<string, unknown>).sourceId !== "string") {
        throw new Error("Proposal evidence contains an invalid source span.");
      }
      sourceIds.add((span as Record<string, unknown>).sourceId as string);
    }
  }
  if (value.evidenceAssertions !== undefined) {
    if (!Array.isArray(value.evidenceAssertions)) throw new Error("Proposal evidenceAssertions must be an array.");
    for (const assertion of value.evidenceAssertions) {
      if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
        throw new Error("Proposal evidenceAssertions contains an invalid assertion.");
      }
      const anchors = (assertion as Record<string, unknown>).anchors;
      if (!Array.isArray(anchors)) throw new Error("Proposal evidence assertion anchors must be an array.");
      for (const anchor of anchors) {
        if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)
          || typeof (anchor as Record<string, unknown>).sourceId !== "string") {
          throw new Error("Proposal evidence assertion contains an invalid anchor.");
        }
        sourceIds.add((anchor as Record<string, unknown>).sourceId as string);
      }
    }
  }
  return [...sourceIds].sort();
}

function proposalIdentity<T>(proposal: ArtifactProposal<T>): Omit<ArtifactProposal<T>, "createdAt"> {
  const { createdAt: _createdAt, ...identity } = proposal;
  return identity;
}

export class CanonicalCompiler {
  constructor(private readonly proposals: ProposalStore, private readonly canon: CanonicalModelStore) {}
  async acceptEntity(id: string): Promise<Entity> { const proposal = await this.proposals.read("pending", id, entitySchema); await this.canon.putEntity(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptProposition(id: string): Promise<Proposition> { const proposal = await this.proposals.read("pending", id, propositionSchema); await this.canon.putProposition(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptAttribution(id: string): Promise<Attribution> { const proposal = await this.proposals.read("pending", id, attributionSchema); await this.canon.putAttribution(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptClaim(id: string): Promise<Claim> { const proposal = await this.proposals.read("pending", id, claimSchema); await this.canon.putClaim(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptEvent(id: string): Promise<CanonicalEvent> { const proposal = await this.proposals.read("pending", id, canonicalEventSchema); await this.canon.putEvent(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptEventParticipation(id: string): Promise<EventParticipation> { const proposal = await this.proposals.read("pending", id, eventParticipationSchema); await this.canon.putEventParticipation(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptEventRelation(id: string): Promise<EventRelation> { const proposal = await this.proposals.read("pending", id, eventRelationSchema); await this.canon.putEventRelation(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptSceneOccurrence(id: string): Promise<SceneOccurrence> { const proposal = await this.proposals.read("pending", id, sceneOccurrenceSchema); await this.canon.putSceneOccurrence(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptEventFrame(id: string): Promise<EventFrame> { const proposal = await this.proposals.read("pending", id, eventFrameSchema); await this.canon.putEventFrame(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptActionSchema(id: string): Promise<ActionSchema> { const proposal = await this.proposals.read("pending", id, actionSchemaSchema); await this.canon.putActionSchema(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptRule(id: string): Promise<WorldRule> { const proposal = await this.proposals.read("pending", id, worldRuleSchema); await this.canon.putRule(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async reject(id: string): Promise<void> {
    await this.proposals.reject(id, [{ code: "CANONICAL_COMPILER_REJECTION", message: "Proposal was explicitly rejected by the canonical compiler." }]);
  }
}
