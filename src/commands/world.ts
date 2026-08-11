import fs from "node:fs/promises";
import { stdout } from "node:process";
import { z } from "zod";
import { validateEventProposal } from "../world/engine.js";
import { fsckWorld } from "../world/fsck.js";
import { InitialWorldStore } from "../world/initial.js";
import { KnowledgeProjector } from "../world/knowledge.js";
import { eventProposalSchema, predicateSchema, stateDeltaSchema, type CommitId, type WorldState } from "../world/model.js";
import { NarrativeRenderer } from "../world/narrative.js";
import { runCanonReplay } from "../world/replay.js";
import { WorldSnapshotStore } from "../world/snapshot.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";

async function openWorld(root: string) {
  const { engine, runtime, actorModels } = await openWorkspaceWorld(root);
  return { context: engine.context, engine, actors: actorModels, runtime };
}

export async function worldCreateCommand(root: string, branchId: string, seedPath?: string): Promise<void> {
  const { engine } = await openWorld(root);
  const canonicalInitial = seedPath ? null : await new InitialWorldStore(root).get();
  const seed = seedPath ? stateDeltaSchema.parse(JSON.parse(await fs.readFile(seedPath, "utf8"))) : canonicalInitial?.delta ?? { version: 1 as const, operations: [] };
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
  stdout.write(`${JSON.stringify(await new KnowledgeProjector(engine).view(actorId, head), null, 2)}\n`);
}

export async function worldActorCommand(root: string, branchId: string, actorId: string): Promise<void> {
  const { engine, actors } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
  const [model, goals, view] = await Promise.all([
    actors.getModel(actorId),
    actors.listGoals(actorId),
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
  const { engine, context } = await openWorld(root);
  const head = await engine.branches.readHead(branchId);
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
  const [leftHead, rightHead] = await Promise.all([engine.branches.readHead(leftBranch), engine.branches.readHead(rightBranch)]);
  const [left, right] = await Promise.all([engine.projector.project(leftHead), engine.projector.project(rightHead)]);
  stdout.write(`${JSON.stringify({ left: { branch: leftBranch, head: leftHead }, right: { branch: rightBranch, head: rightHead }, differences: diffWorldStates(left, right) }, null, 2)}\n`);
}

const replayFileSchema = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), expected: z.array(predicateSchema) }).strict());
export async function worldReplayCommand(root: string, branchId: string, checkpointPath: string, maxMoves: number): Promise<void> {
  const { runtime } = await openWorld(root);
  const checkpoints = replayFileSchema.parse(JSON.parse(await fs.readFile(checkpointPath, "utf8")));
  const result = await runCanonReplay(runtime, branchId, checkpoints, maxMoves);
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

function diffWorldStates(left: WorldState, right: WorldState): Array<{ entityId: string; field: string; left: unknown; right: unknown }> {
  const entityIds = new Set([...Object.keys(left.values), ...Object.keys(right.values)]);
  const differences: Array<{ entityId: string; field: string; left: unknown; right: unknown }> = [];
  for (const entityId of [...entityIds].sort()) {
    const leftFields = left.values[entityId] ?? {};
    const rightFields = right.values[entityId] ?? {};
    const fields = new Set([...Object.keys(leftFields), ...Object.keys(rightFields)]);
    for (const field of [...fields].sort()) {
      const leftValue = leftFields[field];
      const rightValue = rightFields[field];
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) differences.push({ entityId, field, left: leftValue, right: rightValue });
    }
  }
  const leftRules = [...left.activeRuleIds].sort();
  const rightRules = [...right.activeRuleIds].sort();
  if (JSON.stringify(leftRules) !== JSON.stringify(rightRules)) differences.push({ entityId: "$world", field: "activeRuleIds", left: leftRules, right: rightRules });
  return differences;
}
