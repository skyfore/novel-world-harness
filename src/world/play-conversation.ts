import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import type { WorldEngine } from "./engine.js";
import { idSchema } from "./model.js";

const MAX_BRANCH_MESSAGES = 50_000;
const MAX_MESSAGE_CHARS = 50_000;
export const RECENT_PLAY_MESSAGE_LIMIT = 10;

const nonBlankTextSchema = z.string().min(1).max(MAX_MESSAGE_CHARS).refine(
  (value) => value.trim().length > 0,
  "Play conversation messages cannot be blank",
);

export const playConversationMessageSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  branchId: idSchema,
  actorId: idSchema,
  atCommit: idSchema,
  eventId: idSchema.optional(),
  runId: idSchema.optional(),
  playerMoveId: idSchema.optional(),
  role: z.enum(["player", "scene"]),
  status: z.enum(["accepted", "rejected", "rendered"]),
  text: nonBlankTextSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  if (value.role === "scene" && value.status !== "rendered") {
    ctx.addIssue({ code: "custom", message: "Scene messages must have rendered status", path: ["status"] });
  }
  if (value.role === "player" && value.status === "rendered") {
    ctx.addIssue({ code: "custom", message: "Player messages must be accepted or rejected", path: ["status"] });
  }
});
export type PlayConversationMessage = z.infer<typeof playConversationMessageSchema>;

const playConversationFileSchema = z.object({
  version: z.literal(1),
  branchId: idSchema,
  messages: z.array(playConversationMessageSchema).max(MAX_BRANCH_MESSAGES),
}).strict();

export type ModelPlayConversationMessage = {
  role: "player" | "scene";
  text: string;
  worldStatus: PlayConversationMessage["status"];
  authority: "untrusted-player-text" | "presentation-only";
  order: number;
};

/** Durable presentation memory. It is never a source of world truth. */
export class PlayConversationStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "play", "conversations");
  }

  async list(branchIdValue: string): Promise<PlayConversationMessage[]> {
    const branchId = idSchema.parse(branchIdValue);
    try {
      const parsed = playConversationFileSchema.parse(JSON.parse(await fs.readFile(this.filePath(branchId), "utf8")));
      if (parsed.branchId !== branchId) {
        throw new Error(`Play conversation '${branchId}' contains branch '${parsed.branchId}'.`);
      }
      return structuredClone(parsed.messages);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async append(input: {
    branchId: string;
    actorId: string;
    atCommit: string;
    eventId?: string;
    runId?: string;
    playerMoveId?: string;
    role: PlayConversationMessage["role"];
    status: PlayConversationMessage["status"];
    text: string;
  }): Promise<PlayConversationMessage> {
    const branchId = idSchema.parse(input.branchId);
    const previous = await this.list(branchId);
    if (previous.length >= MAX_BRANCH_MESSAGES) {
      throw new Error(`Play conversation '${branchId}' exceeds ${MAX_BRANCH_MESSAGES} messages.`);
    }
    const message = playConversationMessageSchema.parse({
      version: 1,
      id: `message-${crypto.randomUUID()}`,
      ...input,
      branchId,
      sequence: previous.length ? previous.at(-1)!.sequence + 1 : 0,
      createdAt: new Date().toISOString(),
    });
    const value = playConversationFileSchema.parse({
      version: 1,
      branchId,
      messages: [...previous, message],
    });
    await this.atomicWrite(this.filePath(branchId), value);
    return structuredClone(message);
  }

  async remove(branchIdValue: string): Promise<void> {
    const branchId = idSchema.parse(branchIdValue);
    await fs.rm(this.filePath(branchId), { force: true });
  }

  private filePath(branchId: string): string {
    return path.join(this.root, `${branchId}.json`);
  }

  private async atomicWrite(filePath: string, value: z.infer<typeof playConversationFileSchema>): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
}

/** Read only this actor's messages on the selected branch lineage and commit ancestry. */
export async function playConversationAtCommit(
  engine: WorldEngine,
  branchId: string,
  commitId: string,
  actorId: string,
): Promise<PlayConversationMessage[]> {
  const selectedActorId = idSchema.parse(actorId);
  const ancestry = await commitAncestry(engine, commitId);
  const lineage: Array<Awaited<ReturnType<WorldEngine["branches"]["read"]>>> = [];
  const seen = new Set<string>();
  let cursor: string | undefined = branchId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Branch lineage cycle detected at ${cursor}`);
    seen.add(cursor);
    const branch = await engine.branches.read(cursor);
    lineage.push(branch);
    cursor = branch.parentBranchId;
  }
  lineage.reverse();
  const lineageOrder = new Map(lineage.map((branch, index) => [branch.id, index]));
  const inheritedBefore = new Map<string, number>();
  for (let index = 0; index + 1 < lineage.length; index += 1) {
    const childCreatedAt = lineage[index + 1]?.createdAt;
    if (childCreatedAt) inheritedBefore.set(lineage[index]!.id, Date.parse(childCreatedAt));
  }
  const store = new PlayConversationStore(engine.workspaceRoot);
  const messages = (await Promise.all(lineage.map((branch) => store.list(branch.id))))
    .flat()
    .filter((message) => message.actorId === selectedActorId)
    .filter((message) => ancestry.has(message.atCommit))
    .filter((message) => {
      const cutoff = inheritedBefore.get(message.branchId);
      return cutoff === undefined || Date.parse(message.createdAt) <= cutoff;
    });
  const unique = new Map(messages.map((message) => [message.id, message]));
  return [...unique.values()].sort((left, right) =>
    (ancestry.get(left.atCommit) ?? Number.MAX_SAFE_INTEGER) - (ancestry.get(right.atCommit) ?? Number.MAX_SAFE_INTEGER)
    || (lineageOrder.get(left.branchId) ?? Number.MAX_SAFE_INTEGER) - (lineageOrder.get(right.branchId) ?? Number.MAX_SAFE_INTEGER)
    || left.sequence - right.sequence
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.id.localeCompare(right.id));
}

export function modelPlayConversation(
  messages: readonly PlayConversationMessage[],
): ModelPlayConversationMessage[] {
  return messages.map((message, order) => ({
    role: message.role,
    text: message.text,
    worldStatus: message.status,
    authority: message.role === "player" ? "untrusted-player-text" : "presentation-only",
    order,
  }));
}

export function recentPlayConversation(
  messages: readonly PlayConversationMessage[],
  limit = RECENT_PLAY_MESSAGE_LIMIT,
): PlayConversationMessage[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Recent play message limit must be an integer between 1 and 100.");
  }
  return structuredClone(messages.slice(-limit));
}

async function commitAncestry(engine: WorldEngine, commitId: string): Promise<Map<string, number>> {
  const reverse: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = commitId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    reverse.push(cursor);
    const commit = await engine.objects.getCommit(cursor);
    cursor = commit.parentCommitId;
    if (reverse.length > 100_000) throw new Error("Commit ancestry exceeds safety limit");
  }
  reverse.reverse();
  return new Map(reverse.map((id, index) => [id, index]));
}
