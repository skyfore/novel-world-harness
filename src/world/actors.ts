import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector } from "./knowledge.js";
import {
  evidenceRefSchema,
  knowledgeDeltaSchema,
  predicateSchema,
  stateDeltaSchema,
  type EventProposal,
} from "./model.js";

export const characterGoalSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    description: z.string().min(1),
    priority: z.number().min(0).max(1),
    requiresKnowledge: z.array(z.string()),
    blockedByKnowledge: z.array(z.string()).optional(),
    candidateAction: z
      .object({
        title: z.string().min(1),
        participants: z.array(z.string()).optional(),
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
    actorId: z.string().min(1),
    traits: z.record(z.string(), z.number().min(-1).max(1)),
    decisionBiases: z.record(z.string(), z.number().min(-1).max(1)),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type CharacterModel = z.infer<typeof characterModelSchema>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ActorModelStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "canon", "actors");
  }

  async putGoal(input: CharacterGoal): Promise<void> {
    const goal = characterGoalSchema.parse(input);
    await this.writeImmutable(path.join(this.root, "goals", `${safeId(goal.id)}.json`), goal);
  }

  async putModel(input: CharacterModel): Promise<void> {
    const model = characterModelSchema.parse(input);
    await this.writeImmutable(path.join(this.root, "models", `${safeId(model.actorId)}.json`), model);
  }

  async listGoals(actorId?: string): Promise<CharacterGoal[]> {
    const all = await this.list(path.join(this.root, "goals"), characterGoalSchema);
    return actorId ? all.filter((goal) => goal.actorId === actorId) : all;
  }

  async getModel(actorId: string): Promise<CharacterModel | null> {
    try {
      return characterModelSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, "models", `${safeId(actorId)}.json`), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listModels(): Promise<CharacterModel[]> {
    return this.list(path.join(this.root, "models"), characterModelSchema);
  }

  private async writeImmutable(filePath: string, value: unknown): Promise<void> {
    const serialized = `${canonicalJson(value)}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Actor model artifact already exists with different content: ${filePath}`);
    }
  }

  private async list<T>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values: T[] = [];
    for (const name of names) values.push(schema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))));
    return values;
  }
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
    const goals = await actors.listGoals();
    for (const goal of goals) {
      if (!goal.candidateAction) continue;
      const entity = engine.context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      const view = await knowledge.view(goal.actorId, commitId);
      const known = new Set(view.knowledge.map((entry) => entry.fact.claimId));
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

