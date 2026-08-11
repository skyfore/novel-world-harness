import fs from "node:fs/promises";
import { stdout } from "node:process";
import { z } from "zod";
import { canonicalPossibilitySource } from "../world/canon-runtime.js";
import { loadWorldContext } from "../world/context.js";
import { WorldEngine } from "../world/engine.js";
import { InitialWorldStore } from "../world/initial.js";
import { KnowledgeProjector } from "../world/knowledge.js";
import { predicateSchema, stateDeltaSchema, type CommitId } from "../world/model.js";
import { NarrativeRenderer } from "../world/narrative.js";
import { runCanonReplay } from "../world/replay.js";
import { WorldRuntime } from "../world/runtime.js";

async function openWorld(root: string) {
  const { canon, context } = await loadWorldContext(root);
  const engine = new WorldEngine(root, context);
  const runtime = new WorldRuntime(engine, canonicalPossibilitySource(canon));
  return { canon, context, engine, runtime };
}

export async function worldCreateCommand(root: string, branchId: string, seedPath?: string): Promise<void> {
  const { engine } = await openWorld(root);
  const canonicalInitial = seedPath ? null : await new InitialWorldStore(root).get();
  const seed = seedPath
    ? stateDeltaSchema.parse(JSON.parse(await fs.readFile(seedPath, "utf8")))
    : canonicalInitial?.delta ?? { version: 1 as const, operations: [] };
  const head = await engine.createBranch(branchId, branchId, seed);
  stdout.write(`${branchId}\t${head}${canonicalInitial && !seedPath ? "\t[canonical initial world]" : ""}\n`);
}

export async function worldShowCommand(root: string, branchId: string): Promise<void> {
  const { engine } = await openWorld(root);
  const branch = await engine.branches.read(branchId);
  const state = await engine.projector.project(branch.headCommitId);
  stdout.write(`${JSON.stringify({ branch, state }, null, 2)}\n`);
}

export async function worldHistoryCommand(root: string, branchId: string): Promise<void> {
  const { engine } = await openWorld(root);
  let cursor: CommitId | undefined = await engine.branches.readHead(branchId);
  const commits: Array<{ id: CommitId; step: number; events: Array<{ hash: string; title: string; eventId: string; possibilityId?: string }> }> = [];
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    const events = [];
    for (const hash of commit.eventHashes) {
      const event = await engine.objects.getEvent(hash);
      events.push({ hash, title: event.title, eventId: event.eventId, ...(event.possibilityId ? { possibilityId: event.possibilityId } : {}) });
    }
    commits.push({ id: cursor, step: commit.logicalTime.step, events });
    cursor = commit.parentCommitId;
  }
  commits.reverse();
  for (const commit of commits) {
    stdout.write(`${commit.step}\t${commit.id}\n`);
    for (const event of commit.events) stdout.write(`  ${event.hash}\t${event.title}${event.possibilityId ? `\t[${event.possibilityId}]` : ""}\n`);
  }
}

export async function worldFrontierCommand(root: string, branchId: string): Promise<void> {
  const { runtime } = await openWorld(root);
  const frontier = await runtime.refreshFrontier(branchId);
  for (const entry of frontier.evaluated) {
    stdout.write(`${entry.status}\t${entry.score.toFixed(4)}\t${entry.possibility.id}\t${entry.possibility.title}\n`);
    for (const reason of entry.reasons) stdout.write(`  - ${reason}\n`);
  }
}

export async function worldKnowledgeCommand(root: string, branchId: string, actorId: string): Promise<void> {
  const { engine } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const view = await new KnowledgeProjector(engine).view(actorId, head);
  stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

export async function worldForkCommand(root: string, parentBranchId: string, newBranchId: string, fromCommit?: string): Promise<void> {
  const { engine, runtime } = await openWorld(root);
  const forkCommit = fromCommit ?? (await engine.branches.readHead(parentBranchId));
  await runtime.forkBranch(parentBranchId, forkCommit, newBranchId, newBranchId);
  stdout.write(`${newBranchId}\t${forkCommit}\n`);
}

export async function worldRenderCommand(root: string, branchId: string, actorId?: string, tone?: string): Promise<void> {
  const { engine } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const renderer = new NarrativeRenderer(engine);
  const style = actorId ? { pointOfView: "actor" as const, actorId, ...(tone ? { tone } : {}) } : { pointOfView: "omniscient" as const, ...(tone ? { tone } : {}) };
  stdout.write(`${await renderer.render(branchId, head, style)}\n`);
}

const replayFileSchema = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), expected: z.array(predicateSchema) }).strict());
export async function worldReplayCommand(root: string, branchId: string, checkpointPath: string, maxMoves: number): Promise<void> {
  const { runtime } = await openWorld(root);
  const checkpoints = replayFileSchema.parse(JSON.parse(await fs.readFile(checkpointPath, "utf8")));
  const result = await runCanonReplay(runtime, branchId, checkpoints, maxMoves);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 3;
}
