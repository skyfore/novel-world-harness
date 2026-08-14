import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import {
  evidenceRefSchema,
  idSchema,
  knowledgeDeltaSchema,
  predicateSchema,
  stateDeltaSchema,
  type EventProposal,
} from "./model.js";

export const characterGoalSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    description: z.string().min(1),
    priority: z.number().min(0).max(1),
    requiresKnowledge: z.array(idSchema),
    blockedByKnowledge: z.array(idSchema).optional(),
    candidateAction: z
      .object({
        title: z.string().min(1),
        participants: z.array(idSchema).optional(),
        preconditions: z.array(predicateSchema),
        proposedDelta: stateDeltaSchema,
        proposedKnowledge: knowledgeDeltaSchema.optional(),
      })
      .strict()
      .optional(),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type CharacterGoal = z.infer<typeof characterGoalSchema>;

export const characterModelSchema = z
  .object({
    actorId: idSchema,
    traits: z.record(z.string(), z.number().min(-1).max(1)),
    decisionBiases: z.record(z.string(), z.number().min(-1).max(1)),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type CharacterModel = z.infer<typeof characterModelSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type ActorArtifactKind = "goals" | "models";
export type ActorRevisionRef = { id: string; hash: string };
type StoredActorRef = { version: 1; id: string; hash: string; updatedAt: string };

export class ActorModelStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon", "actors");
  }

  async putGoal(input: CharacterGoal): Promise<void> {
    const goal = characterGoalSchema.parse(input);
    await this.put("goals", goal.id, goal);
  }

  async putModel(input: CharacterModel): Promise<void> {
    const model = characterModelSchema.parse(input);
    await this.put("models", model.actorId, model);
  }

  async listGoals(actorId?: string): Promise<CharacterGoal[]> {
    const all = await this.list("goals", characterGoalSchema);
    return actorId ? all.filter((goal) => goal.actorId === actorId) : all;
  }

  async getModel(actorId: string): Promise<CharacterModel | null> {
    try {
      return await this.get("models", actorId, characterModelSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listModels(): Promise<CharacterModel[]> {
    return this.list("models", characterModelSchema);
  }

  getGoalRevision(id: string, hash: string): Promise<CharacterGoal> {
    return this.getRevision("goals", id, hash, characterGoalSchema);
  }

  getModelRevision(id: string, hash: string): Promise<CharacterModel> {
    return this.getRevision("models", id, hash, characterModelSchema);
  }

  async currentRevision(kind: ActorArtifactKind, idInput: string): Promise<ActorRevisionRef | null> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (ref) return { id, hash: ref.hash };
    const legacy = await this.readLegacy(kind, id);
    return legacy === null ? null : { id, hash: contentHash(legacy) };
  }

  async removeGoal(id: string): Promise<void> { await this.removeCurrent("goals", id); }
  async removeModel(actorId: string): Promise<void> { await this.removeCurrent("models", actorId); }

  private async put(kind: ActorArtifactKind, idInput: string, value: unknown): Promise<void> {
    const id = safeId(idInput);
    await this.migrateLegacy(kind, id);
    const hash = contentHash(value);
    await writeImmutable(this.revisionPath(kind, id, hash), value);
    await atomicJson(this.refPath(kind, id), { version: 1, id, hash, updatedAt: new Date().toISOString() } satisfies StoredActorRef);
  }

  private async get<T>(kind: ActorArtifactKind, idInput: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (ref) return this.getRevision(kind, id, ref.hash, schema);
    const legacy = await this.readLegacy(kind, id);
    if (legacy === null) throw Object.assign(new Error(`Actor ${kind} artifact not found: ${id}`), { code: "ENOENT" });
    return schema.parse(legacy);
  }

  private async getRevision<T>(kind: ActorArtifactKind, idInput: string, hash: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid actor artifact revision hash: ${hash}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.revisionPath(kind, id, hash), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.readLegacy(kind, id);
      if (legacy === null || contentHash(legacy) !== hash) {
        throw Object.assign(new Error(`Actor ${kind} revision not found: ${id}@${hash}`), { code: "ENOENT" });
      }
      raw = legacy;
    }
    const value = schema.parse(raw);
    if (contentHash(value) !== hash) throw new Error(`Corrupt actor ${kind} revision ${id}@${hash}`);
    return value;
  }

  private async list<T>(kind: ActorArtifactKind, schema: z.ZodType<T>): Promise<T[]> {
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

  private async removeCurrent(kind: ActorArtifactKind, idInput: string): Promise<void> {
    const id = safeId(idInput);
    await this.migrateLegacy(kind, id);
    await fs.rm(this.refPath(kind, id), { force: true });
  }

  private async migrateLegacy(kind: ActorArtifactKind, id: string): Promise<void> {
    const legacy = await this.readLegacy(kind, id);
    if (legacy === null) return;
    await writeImmutable(this.revisionPath(kind, id, contentHash(legacy)), legacy);
    await fs.rm(this.legacyPath(kind, id), { force: true });
  }

  private refPath(kind: ActorArtifactKind, id: string): string { return path.join(this.root, kind, "refs", `${id}.json`); }
  private revisionPath(kind: ActorArtifactKind, id: string, hash: string): string { return path.join(this.root, kind, "revisions", id, `${hash}.json`); }
  private legacyPath(kind: ActorArtifactKind, id: string): string { return path.join(this.root, kind, `${id}.json`); }

  private async readRef(kind: ActorArtifactKind, id: string): Promise<StoredActorRef | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.refPath(kind, id), "utf8")) as StoredActorRef;
      if (value.version !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error(`Invalid actor artifact ref: ${kind}/${id}`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readLegacy(kind: ActorArtifactKind, id: string): Promise<unknown | null> {
    try { return JSON.parse(await fs.readFile(this.legacyPath(kind, id), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Actor artifact revision collision: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export type ActorProposalCandidate = {
  proposal: EventProposal;
  priority: number;
  goalId: string;
};

export type ActorProposalSource = (input: {
  branchId: string;
  commitId: string;
}) => Promise<readonly ActorProposalCandidate[]> | readonly ActorProposalCandidate[];

export function deterministicActorProposalSource(engine: WorldEngine, actors: ActorModelStore): ActorProposalSource {
  const knowledge = new KnowledgeProjector(engine);
  return async ({ branchId, commitId }) => {
    const candidates: ActorProposalCandidate[] = [];
    const context = await engine.contextForCommit(commitId);
    const goals = context.actorGoals ?? await actors.listGoals();
    for (const goal of goals) {
      if (!goal.candidateAction) continue;
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      const view = await knowledge.view(goal.actorId, commitId);
      const known = new Set(view.knowledge.filter((entry) => isActionableKnowledge(entry.fact)).map((entry) => entry.fact.claimId));
      if (goal.requiresKnowledge.some((claimId) => !known.has(claimId))) continue;
      if (goal.blockedByKnowledge?.some((claimId) => known.has(claimId))) continue;
      const action = goal.candidateAction;
      const participants = [...new Set([goal.actorId, ...(action.participants ?? [])])];
      const proposalId = `goal-${contentHash({ goalId: goal.id, branchId, commitId }).slice(0, 24)}`;
      candidates.push({
        goalId: goal.id,
        priority: goal.priority,
        proposal: {
          proposalId,
          branchId,
          expectedParentCommit: commitId,
          source: "actor",
          actorId: goal.actorId,
          title: action.title,
          participants,
          proposedTime: { kind: "unknown" },
          preconditions: action.preconditions,
          proposedDelta: action.proposedDelta,
          ...(action.proposedKnowledge ? { proposedKnowledge: action.proposedKnowledge } : {}),
          causalParents: [],
          evidence: goal.evidence,
        },
      });
    }
    return candidates.sort((left, right) => right.priority - left.priority || left.proposal.proposalId.localeCompare(right.proposal.proposalId));
  };
}

function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe actor artifact id: ${id}`);
  return id;
}
