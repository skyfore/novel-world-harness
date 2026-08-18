import fs from "node:fs/promises";
import { stdout } from "node:process";
import { z } from "zod";
import { validateEventProposal } from "../world/engine.js";
import { diffWorldBranches } from "../world/diff.js";
import { fsckWorld } from "../world/fsck.js";
import { KnowledgeProjector } from "../world/knowledge.js";
import { eventProposalSchema, predicateSchema, stateDeltaSchema, type CommitId } from "../world/model.js";
import { NarrativeRenderer } from "../world/narrative.js";
import { runIsolatedCanonReplay } from "../world/replay.js";
import { WorldSnapshotStore } from "../world/snapshot.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { createWorldBranch } from "../world/instance.js";

export { createWorldBranch } from "../world/instance.js";

async function openWorld(root: string) {
  const { engine, runtime, actorModels } = await openWorkspaceWorld(root);
  return { engine, actors: actorModels, runtime };
}

export async function worldCreateCommand(root: string, branchId: string, seedPath?: string, sourceId?: string, cacheRoot?: string): Promise<void> {
  const created = await createWorldBranch(root, branchId, seedPath, sourceId, cacheRoot);
  stdout.write(`${branchId}\t${created.head}${created.usedCanonicalInitial ? "\t[canonical initial world]" : ""}${created.preparedRevisionHash ? `\trevision=${created.preparedRevisionHash}` : ""}\n`);
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
  stdout.write(`${JSON.stringify(await new KnowledgeProjector(engine).view(actorId, head), null, 2)}\n`);
}

export async function worldActorCommand(root: string, branchId: string, actorId: string): Promise<void> {
  const { engine, actors } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const context = await engine.contextForCommit(head);
  const [model, goals, view] = await Promise.all([
    context.actorModels ? context.actorModels.get(actorId) : actors.getModel(actorId),
    context.actorGoals?.filter((goal) => goal.actorId === actorId) ?? actors.listGoals(actorId),
    new KnowledgeProjector(engine).view(actorId, head),
  ]);
  stdout.write(`${JSON.stringify({ actorId, model, goals, view }, null, 2)}\n`);
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

const proposalFileSchema = eventProposalSchema.omit({ branchId: true, expectedParentCommit: true });

export async function worldValidateCommand(root: string, branchId: string, proposalPath: string): Promise<void> {
  const { engine } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const context = await engine.contextForCommit(head);
  const payload = proposalFileSchema.parse(JSON.parse(await fs.readFile(proposalPath, "utf8")));
  const proposal = eventProposalSchema.parse({ ...payload, branchId, expectedParentCommit: head });
  const state = await engine.projector.project(head);
  stdout.write(`${JSON.stringify(validateEventProposal(proposal, head, state, context).report, null, 2)}\n`);
}

export async function worldMoveCommand(root: string, branchId: string, proposalPath: string | undefined, maxActors: number, maxBackground: number): Promise<void> {
  const { engine, runtime } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const playerProposal = proposalPath
    ? eventProposalSchema.parse({ ...proposalFileSchema.parse(JSON.parse(await fs.readFile(proposalPath, "utf8"))), branchId, expectedParentCommit: head })
    : undefined;
  const result = await runtime.move({
    branchId,
    ...(playerProposal ? { playerProposal } : {}),
    maxActorCandidates: maxActors,
    maxBackgroundCandidates: maxBackground,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function worldDiffCommand(root: string, leftBranch: string, rightBranch: string): Promise<void> {
  const { engine } = await openWorld(root);
  stdout.write(`${JSON.stringify(await diffWorldBranches(engine, leftBranch, rightBranch), null, 2)}\n`);
}

const replayFileSchema = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), expected: z.array(predicateSchema) }).strict());
export async function worldReplayCommand(root: string, branchId: string, checkpointPath: string, maxMoves: number, outputBranch?: string): Promise<void> {
  const { runtime } = await openWorld(root);
  const checkpoints = replayFileSchema.parse(JSON.parse(await fs.readFile(checkpointPath, "utf8")));
  const sourceHead = await runtime.engine.branches.readHead(branchId);
  const replayBranch = outputBranch ?? `replay-${branchId}-${sourceHead.slice(0, 8)}-${Date.now().toString(36)}`;
  const result = await runIsolatedCanonReplay(runtime, branchId, replayBranch, checkpoints, maxMoves);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 3;
}

export async function worldSnapshotCommand(root: string, branchId: string): Promise<void> {
  const { engine } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const state = await engine.projector.project(head);
  const snapshot = await new WorldSnapshotStore(root).write(head, state);
  stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function worldFsckCommand(root: string): Promise<void> {
  const { engine } = await openWorld(root);
  const report = await fsckWorld(engine);
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 4;
}
