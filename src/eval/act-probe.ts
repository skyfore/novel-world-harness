import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { timelineIndex, type CanonTimeline } from "../world/canon-timeline.js";
import type { WorldEngine } from "../world/engine.js";
import { KnowledgeProjector } from "../world/knowledge.js";
import { worldStorageRoot } from "../world/paths.js";
import { performPlayTurn, type PerformPlayTurnOptions } from "../world/play-experience.js";
import type { PlayerActionTranslationInput } from "../world/player-action.js";
import { branchCanonResolution } from "../world/read-horizon.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { RuntimeHooks, withRuntimeHooks } from "../runtime/hooks.js";

export const ACT_PROBE_INTENTS = ["observe", "speak", "follow-canon", "deviate", "move", "wait"] as const;
export type ActProbeIntent = (typeof ACT_PROBE_INTENTS)[number];
const LANES = ["player", "npc", "world-response", "canon-step", "actor", "background"] as const;

export const actProbeTurnSchema = z.object({
  intent: z.enum(ACT_PROBE_INTENTS),
  utterance: z.string(),
  accepted: z.boolean(),
  rejectedAt: z.string().optional(),
  issueCodes: z.array(z.string()),
  committedByLane: z.object(Object.fromEntries(LANES.map((lane) => [lane, z.number().int().nonnegative()])) as Record<(typeof LANES)[number], z.ZodNumber>).strict(),
  canonPositionBefore: z.number().int().min(0),
  canonPositionAfter: z.number().int().min(0),
  modelCalls: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  degraded: z.array(z.string()),
}).strict();
export type ActProbeTurn = z.infer<typeof actProbeTurnSchema>;

export const actProbeReportSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  mode: z.enum(["fake", "live"]),
  sourceId: z.string().min(1).optional(),
  cutId: z.string().min(1),
  actorId: z.string().min(1),
  branchId: z.string().min(1),
  turns: z.array(actProbeTurnSchema),
  replayEquivalent: z.boolean(),
  knowledgeViolations: z.number().int().nonnegative(),
  rates: z.object({ accept: z.number().min(0).max(1), worldResponse: z.number().min(0).max(1), canonStep: z.number().min(0).max(1), deadTurn: z.number().min(0).max(1) }).strict(),
  failure: z.string().optional(),
}).strict();
export type ActProbeReport = z.infer<typeof actProbeReportSchema>;

export type ActProbeStep = { intent: ActProbeIntent; utterance: string };
export type ActProbeReasoners = Pick<PerformPlayTurnOptions, "translator" | "adjudicator" | "worldResponseResolver" | "canonicalAttachmentResolver" | "npcResponseReasoner" | "actorReasoner" | "contextResolver">;

/** Player wording per intent class; the live translator interprets it, the fake one is keyed by intent. */
const UTTERANCES: Record<ActProbeIntent, string[]> = {
  "observe": ["我先停下来，仔细观察周围的人和环境。", "我留意眼前每个人的神情。", "我环顾四周，看看有什么变化。"],
  "speak": ["我开口，向身边的人说出心里的想法。", "我问在场的人刚才发生了什么。", "我说出自己的决定。"],
  "follow-canon": ["我照着自己原本打算的那样去做。", "我顺着眼下的局势行动。", "我接着做该做的事。"],
  "deviate": ["我偏偏不按别人期待的去做，转身做出相反的选择。", "我拒绝眼前的安排。", "我做一件谁也想不到的事。"],
  "move": ["我离开这里，去附近另一个地方。", "我往外走。", "我换个地方待着。"],
  "wait": ["我什么也不做，静静等一会儿。", "我继续等待。", "我让时间过去。"],
};

/** Six intent classes, each 1-3 turns. */
export function defaultActProbeScript(turnsPerIntent = 1): ActProbeStep[] {
  const turns = Math.max(1, Math.min(3, Math.floor(turnsPerIntent)));
  return ACT_PROBE_INTENTS.flatMap((intent) => UTTERANCES[intent].slice(0, turns).map((utterance) => ({ intent, utterance })));
}

/**
 * Deterministic reasoners for CI: they exercise the full turn pipeline and its
 * validation without a model. The fake translator maps each intent class to a
 * minimal candidate; follow-canon uses a disclosed single-role mechanism when
 * one exists. World responses select the first eligible response.
 */
export function fakeActProbeReasoners(step: ActProbeStep): ActProbeReasoners {
  return {
    translator: (input: PlayerActionTranslationInput) => fakeCandidate(step, input),
    worldResponseResolver: (input) => input.eligibleResponses[0] ? { decision: "select", possibilityId: input.eligibleResponses[0].possibilityId } : { decision: "none" },
  } as ActProbeReasoners;
}

function fakeCandidate(step: ActProbeStep, input: PlayerActionTranslationInput) {
  const base = { participants: [], preconditions: [], proposedDelta: { version: 1 as const, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [] };
  switch (step.intent) {
    case "observe": return { ...base, title: "观察周围", intent: { kind: "observe" as const, summary: "观察周围的人和环境" } };
    case "wait": return { ...base, title: "等待片刻", intent: { kind: "wait" as const, summary: "静静等待", requestedTimeAdvance: { amount: 10, unit: "minute" as const } } };
    case "speak": return { ...base, title: "开口说话", intent: { kind: "act" as const, summary: "向在场的人说出想法", controlledAct: { eventTitle: "开口说话", actorObservation: "你开口说出自己的想法。" } } };
    case "move": return { ...base, title: "离开此处", intent: { kind: "act" as const, summary: "去附近另一个地方", controlledAct: { eventTitle: "离开此处", actorObservation: "你起身准备离开。" } } };
    case "deviate": return { ...base, title: "拒绝眼前的安排", intent: { kind: "act" as const, summary: "做出与原著相反的选择", controlledAct: { eventTitle: "拒绝眼前的安排", actorObservation: "你拒绝了眼前的安排。" } } };
    case "follow-canon": {
      const mechanism = (input as { context?: { availableActions?: Array<{ schemaId?: string; id?: string; title?: string; proposedDelta?: unknown }> } }).context?.availableActions?.[0];
      return { ...base, title: mechanism?.title ?? "照原本的打算行事", intent: { kind: "act" as const, summary: "按原本的打算行事", controlledAct: { eventTitle: mechanism?.title ?? "照原本的打算行事", actorObservation: "你照着原本的打算去做。" } } };
    }
  }
}

/** Canonical position: one past the furthest realized/adapted/superseded event; the entry cut otherwise. */
export function canonPosition(timeline: Pick<CanonTimeline, "entries">, events: Parameters<typeof branchCanonResolution>[0], floor = 0): number {
  const index = timelineIndex(timeline);
  const resolution = branchCanonResolution(events);
  let position = floor;
  for (const id of [...resolution.resolved, ...resolution.superseded]) {
    const at = index.get(id);
    if (at !== undefined) position = Math.max(position, at + 1);
  }
  return position;
}

/** Claims this actor could only learn from canonical events the branch has not resolved. */
async function futureKnowledgeViolations(engine: WorldEngine, head: string, actorId: string): Promise<number> {
  const [context, projection] = await Promise.all([engine.contextForCommit(head), engine.projections.project(head)]);
  const resolution = branchCanonResolution(projection.history.map((entry) => entry.event));
  const learnable = (event: { observedKnowledge?: { operations: Array<{ op: string; actorId?: string; claimId?: string }> } }) =>
    (event.observedKnowledge?.operations ?? []).filter((operation) => operation.op === "learn" && operation.actorId === actorId).map((operation) => operation.claimId!);
  const past = new Set<string>([...(context.initialWorld?.knowledge?.operations ?? []).flatMap((operation) => operation.op === "learn" && operation.actorId === actorId ? [operation.claimId] : [])]);
  const future = new Set<string>();
  for (const event of context.events?.values() ?? []) {
    for (const claimId of learnable(event)) (resolution.resolved.has(event.id) ? past : future).add(claimId);
  }
  for (const claimId of past) future.delete(claimId);
  const known = (await new KnowledgeProjector(engine).view(actorId, head)).knowledge.map((entry) => entry.fact.claimId);
  return known.filter((claimId) => future.has(claimId)).length;
}

export type RunActProbeInput = {
  root: string;
  branchId: string;
  actorId: string;
  cutId: string;
  sourceId?: string;
  mode: "fake" | "live";
  script?: readonly ActProbeStep[];
  reasoners?: (step: ActProbeStep) => ActProbeReasoners;
  runId?: string;
};

/** Run scripted player turns through the production turn pipeline and measure the world's response. */
export async function runActProbe(input: RunActProbeInput): Promise<ActProbeReport> {
  const script = input.script ?? defaultActProbeScript();
  const reasoners = input.reasoners ?? fakeActProbeReasoners;
  const runId = input.runId ?? `act-probe-${crypto.randomUUID()}`;
  const { engine } = await openWorkspaceWorld(input.root);
  let head = (await engine.branches.read(input.branchId)).headCommitId;
  const genesisContext = await engine.contextForCommit(head);
  const timeline = genesisContext.timeline;
  const positionAt = async (commit: string) => {
    if (!timeline) return 0;
    const projection = await engine.projections.project(commit);
    return canonPosition(timeline, projection.history.map((entry) => entry.event));
  };
  const turns: ActProbeTurn[] = [];
  let failure: string | undefined;
  for (const step of script) {
    const positionBefore = await positionAt(head);
    let modelCalls = 0;
    const hooks = new RuntimeHooks({ onError: () => {} });
    hooks.subscribe((event) => {
      if (event.type === "model.budget" && typeof event.metadata?.modelCalls === "number") modelCalls += event.metadata.modelCalls;
    });
    const startedAt = Date.now();
    try {
      const outcome = await withRuntimeHooks(hooks, () => performPlayTurn({
        root: input.root, branchId: input.branchId, actorId: input.actorId, utterance: step.utterance, expectedHead: head,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}), runId,
        ...(step.intent === "observe" ? { intent: "observe" as const } : step.intent === "wait" ? { intent: "wait" as const } : {}),
        ...reasoners(step),
      }));
      head = outcome.finalHead;
      const committed = { player: outcome.result.accepted ? 1 : 0, npc: outcome.reactionEvents.length, "world-response": outcome.worldResponseEvents.length,
        "canon-step": outcome.canonicalRecoveryEvents.length,
        actor: outcome.runtimeMoveTrace?.candidates.filter((candidate) => candidate.lane === "actor" && candidate.status === "accepted" && candidate.commitBoundary.moved).length ?? 0,
        background: outcome.backgroundEvents.length };
      turns.push(actProbeTurnSchema.parse({
        intent: step.intent, utterance: step.utterance, accepted: outcome.result.accepted,
        ...(outcome.result.accepted ? {} : { rejectedAt: outcome.result.stage }),
        issueCodes: [...new Set(outcome.result.issues.map((issue) => issue.code))].sort(),
        committedByLane: committed, canonPositionBefore: positionBefore, canonPositionAfter: await positionAt(head),
        modelCalls, latencyMs: Date.now() - startedAt,
        degraded: Object.entries({ worldResponse: outcome.worldResponseError, canonicalRecovery: outcome.canonicalRecoveryError, npc: outcome.npcResponseError, background: outcome.backgroundError })
          .flatMap(([lane, error]) => error ? [`${lane}: ${error}`] : []),
      }));
    } catch (error) {
      failure = `${step.intent}: ${error instanceof Error ? error.message : String(error)}`;
      turns.push(actProbeTurnSchema.parse({ intent: step.intent, utterance: step.utterance, accepted: false, rejectedAt: "exception", issueCodes: ["ACT_PROBE_TURN_FAILED"],
        committedByLane: Object.fromEntries(LANES.map((lane) => [lane, 0])), canonPositionBefore: positionBefore, canonPositionAfter: positionBefore,
        modelCalls, latencyMs: Date.now() - startedAt, degraded: [failure] }));
      break;
    }
  }
  const cached = await engine.projections.project(head);
  const fresh = await (await openWorkspaceWorld(input.root)).engine.projections.project(head, { fresh: true, useCheckpoints: false });
  const accepted = turns.filter((turn) => turn.accepted);
  const responded = (turn: ActProbeTurn) => turn.committedByLane.npc + turn.committedByLane["world-response"] + turn.committedByLane["canon-step"] + turn.committedByLane.actor + turn.committedByLane.background > 0;
  const ratio = (count: number, total: number) => total ? count / total : 0;
  return actProbeReportSchema.parse({
    version: 1, runId, mode: input.mode, ...(input.sourceId ? { sourceId: input.sourceId } : {}), cutId: input.cutId, actorId: input.actorId, branchId: input.branchId, turns,
    replayEquivalent: contentHash(cached) === contentHash(fresh),
    knowledgeViolations: await futureKnowledgeViolations(engine, head, input.actorId),
    rates: {
      accept: ratio(accepted.length, turns.length),
      worldResponse: ratio(accepted.filter(responded).length, accepted.length),
      canonStep: ratio(turns.filter((turn) => turn.canonPositionAfter > turn.canonPositionBefore).length, turns.length),
      deadTurn: ratio(accepted.filter((turn) => !responded(turn)).length, accepted.length),
    },
    ...(failure ? { failure } : {}),
  });
}

/** Probe reports persist outside branch truth, beside other evaluation records. */
export class ActProbeStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(worldStorageRoot(workspaceRoot), "eval", "act-probe", "v1"); }
  async write(sourceId: string, reports: readonly ActProbeReport[], summary: unknown): Promise<string> {
    const directory = path.join(this.root, contentHash(sourceId).slice(0, 24));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`);
    await fs.writeFile(file, `${JSON.stringify({ version: 1, sourceId, summary, reports }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return file;
  }
}

/** Aggregate rates and rejection codes over many cut x actor runs. */
export function summarizeActProbes(reports: readonly ActProbeReport[]) {
  const turns = reports.flatMap((report) => report.turns);
  const accepted = turns.filter((turn) => turn.accepted);
  const responded = (turn: ActProbeTurn) => turn.committedByLane.npc + turn.committedByLane["world-response"] + turn.committedByLane["canon-step"] + turn.committedByLane.actor + turn.committedByLane.background > 0;
  const ratio = (count: number, total: number) => total ? count / total : 0;
  const codes: Record<string, number> = {};
  for (const turn of turns) for (const code of turn.accepted ? [] : turn.issueCodes.length ? turn.issueCodes : [turn.rejectedAt ?? "unknown"]) codes[code] = (codes[code] ?? 0) + 1;
  const byIntent = Object.fromEntries(ACT_PROBE_INTENTS.map((intent) => {
    const scoped = turns.filter((turn) => turn.intent === intent);
    return [intent, { turns: scoped.length, accept: ratio(scoped.filter((turn) => turn.accepted).length, scoped.length) }];
  }));
  return {
    entries: reports.length, turns: turns.length,
    rates: {
      accept: ratio(accepted.length, turns.length),
      worldResponse: ratio(accepted.filter(responded).length, accepted.length),
      canonStep: ratio(turns.filter((turn) => turn.canonPositionAfter > turn.canonPositionBefore).length, turns.length),
      deadTurn: ratio(accepted.filter((turn) => !responded(turn)).length, accepted.length),
    },
    replayEquivalent: reports.every((report) => report.replayEquivalent),
    knowledgeViolations: reports.reduce((total, report) => total + report.knowledgeViolations, 0),
    modelCalls: turns.reduce((total, turn) => total + turn.modelCalls, 0),
    medianLatencyMs: median(turns.map((turn) => turn.latencyMs)),
    rejectionCodes: Object.fromEntries(Object.entries(codes).sort(([, a], [, b]) => b - a)),
    byIntent,
  };
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
