import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { canonicalJson } from "./canonical.js";
import {
  artifactProposalSchema,
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  worldRuleSchema,
  type ArtifactProposal,
  type CanonicalEvent,
  type Claim,
  type Entity,
  type WorldRule,
} from "./model.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
type CanonicalKind = "entities" | "claims" | "events" | "rules";
export type ProposalStatus = "pending" | "accepted" | "rejected";
export type ProposalSummary = { id: string; kind: string; schemaVersion: number; createdAt: string; worker: string };

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

export class CanonicalModelStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "canon"); }
  putEntity(entity: Entity): Promise<void> { const value = entitySchema.parse(entity); return this.put("entities", value.id, value); }
  putClaim(claim: Claim): Promise<void> { const value = claimSchema.parse(claim); return this.put("claims", value.id, value); }
  putEvent(event: CanonicalEvent): Promise<void> { const value = canonicalEventSchema.parse(event); return this.put("events", value.id, value); }
  putRule(rule: WorldRule): Promise<void> { const value = worldRuleSchema.parse(rule); return this.put("rules", value.id, value); }
  getEntity(id: string): Promise<Entity> { return this.get("entities", id, entitySchema); }
  getClaim(id: string): Promise<Claim> { return this.get("claims", id, claimSchema); }
  getEvent(id: string): Promise<CanonicalEvent> { return this.get("events", id, canonicalEventSchema); }
  getRule(id: string): Promise<WorldRule> { return this.get("rules", id, worldRuleSchema); }
  listEntities(): Promise<Entity[]> { return this.list("entities", entitySchema); }
  listClaims(): Promise<Claim[]> { return this.list("claims", claimSchema); }
  listEvents(): Promise<CanonicalEvent[]> { return this.list("events", canonicalEventSchema); }
  listRules(): Promise<WorldRule[]> { return this.list("rules", worldRuleSchema); }
  private put(kind: CanonicalKind, id: string, value: unknown): Promise<void> { return writeImmutable(path.join(this.root, kind, `${safeId(id)}.json`), value); }
  private async get<T>(kind: CanonicalKind, id: string, schema: z.ZodType<T>): Promise<T> { return schema.parse(JSON.parse(await fs.readFile(path.join(this.root, kind, `${safeId(id)}.json`), "utf8"))); }
  private async list<T>(kind: CanonicalKind, schema: z.ZodType<T>): Promise<T[]> {
    const directory = path.join(this.root, kind);
    let names: string[];
    try { names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const values: T[] = [];
    for (const name of names) values.push(schema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))));
    return values;
  }
}

export class ProposalStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "proposals"); }
  async writePending<T>(proposal: ArtifactProposal<T>, payloadSchema: z.ZodType<T>): Promise<void> {
    const parsed = artifactProposalSchema(payloadSchema).parse(proposal);
    await writeImmutable(this.proposalPath("pending", parsed.id), parsed);
  }
  async read<T>(status: ProposalStatus, id: string, payloadSchema: z.ZodType<T>): Promise<ArtifactProposal<T>> {
    return artifactProposalSchema(payloadSchema).parse(JSON.parse(await fs.readFile(this.proposalPath(status, id), "utf8"))) as ArtifactProposal<T>;
  }
  async list(status: ProposalStatus = "pending"): Promise<ProposalSummary[]> {
    const directory = path.join(this.root, status);
    let names: string[];
    try { names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const summaries: ProposalSummary[] = [];
    for (const name of names) {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>;
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
  private proposalPath(status: ProposalStatus, id: string): string { return path.join(this.root, status, `${safeId(id)}.json`); }
}

export class CanonicalCompiler {
  constructor(private readonly proposals: ProposalStore, private readonly canon: CanonicalModelStore) {}
  async acceptEntity(id: string): Promise<Entity> { const proposal = await this.proposals.read("pending", id, entitySchema); await this.canon.putEntity(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptClaim(id: string): Promise<Claim> { const proposal = await this.proposals.read("pending", id, claimSchema); await this.canon.putClaim(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptEvent(id: string): Promise<CanonicalEvent> { const proposal = await this.proposals.read("pending", id, canonicalEventSchema); await this.canon.putEvent(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  async acceptRule(id: string): Promise<WorldRule> { const proposal = await this.proposals.read("pending", id, worldRuleSchema); await this.canon.putRule(proposal.payload); await this.proposals.transition(id, "pending", "accepted"); return proposal.payload; }
  reject(id: string): Promise<void> { return this.proposals.transition(id, "pending", "rejected"); }
}
