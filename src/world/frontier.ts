import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import type {
  BranchEventRelationProposal,
  BranchId,
  CommitId,
  EventProposal,
  EvidenceRef,
  Possibility,
  PossibilityCausalLink,
  PossibilityKind,
  RelationOperationality,
  StoryTime,
  WorldState,
} from "./model.js";
import { dueNormInstances, type NormTemplate } from "./norm-ontology.js";
import type { NormState } from "./norm-effects.js";
import { dueProcessInstances, processOwnerEntityIds, type ProcessTemplate } from "./process-ontology.js";
import type { ProcessState } from "./process-effects.js";
import { evaluatePredicate } from "./state.js";
import { comparableStoryTime } from "./time.js";
import { worldStorageRoot } from "./paths.js";

export type PossibilityStatus = "latent" | "eligible" | "blocked" | "expired" | "superseded" | "invalidated" | "adapted" | "realized";
export type SchedulerTier = 0 | 1 | 2 | 3 | 4;
export type SchedulerFactors = {
  tier: SchedulerTier;
  dueTime: number | null;
  pressure: number;
  causalSupport: number;
  sceneRelevance: number;
  cooldownPenalty: number;
  novelty: number;
  canonAffinity: number;
  conditionStrength: number;
};
export type SchedulerTuple = {
  tier: SchedulerTier;
  dueTime: number | null;
  pressure: number;
  causalSupport: number;
  sceneRelevance: number;
  cooldownPenalty: number;
  novelty: number;
  canonAffinity: number;
  stableId: string;
};
export type SchedulerGateTrace = {
  gate: "realization" | "expiry" | "state-blocker" | "necessary-cause" | "causal-blocker" | "precondition" | "time" | "scene";
  outcome: "pass" | "fail" | "info";
  detail: string;
};
export type SchedulerCausalTrace = {
  relationId: string;
  sourceEventId: string;
  type: PossibilityCausalLink["type"];
  operationality: RelationOperationality;
  motivatedActorIds?: string[];
  goalIds?: string[];
  resolution: "fulfilled" | "waiting" | "superseded" | "inactive-blocker" | "active-blocker" | "ignored";
  resolvedSourceEventId?: string;
  detail: string;
};
export type SchedulerTrace = {
  candidateSource: PossibilityKind;
  gates: SchedulerGateTrace[];
  causalLinks: SchedulerCausalTrace[];
  tuple: SchedulerTuple;
};
export type EvaluatedPossibility = {
  possibility: Possibility;
  status: PossibilityStatus;
  reasons: string[];
  factors: SchedulerFactors;
  /** Human-facing summary only. Selection is exclusively lexicographic by trace.tuple. */
  score: number;
  trace: SchedulerTrace;
};
export type FrontierTemporalMode = "current-window" | "advance";
export type Frontier = {
  version: 2;
  branchId: BranchId;
  commitId: CommitId;
  temporalMode: FrontierTemporalMode;
  evaluated: EvaluatedPossibility[];
};

type FrontierEvaluationOptions = {
  realizedIds?: ReadonlySet<string>;
  adaptedIds?: ReadonlySet<string>;
  supersededIds?: ReadonlySet<string>;
  realizationEventIds?: ReadonlyMap<string, string>;
  canonAffinity?: number;
  temporalMode?: FrontierTemporalMode;
  temporalAnchor?: StoryTime;
  activeEntityIds?: ReadonlySet<string>;
  rootEvidenceSupported?: boolean;
  cooldownPenalty?: number;
  novelty?: number;
};

export function evaluatePossibility(
  state: WorldState,
  possibility: Possibility,
  options: FrontierEvaluationOptions = {},
): EvaluatedPossibility {
  const reasons: string[] = [];
  const gates: SchedulerGateTrace[] = [];
  const links = causalLinksFor(possibility);
  const causalTrace = links.map((link) => resolveCausalLink(link, options));
  const unresolvedNecessary = causalTrace.filter((item) => item.operationality === "necessary" && item.resolution === "waiting");
  const supersededNecessary = causalTrace.filter((item) => item.operationality === "necessary" && item.resolution === "superseded");
  const activeCausalBlockers = causalTrace.filter((item) => item.operationality === "blocking" && item.resolution === "active-blocker");
  const supportive = causalTrace.filter((item) => item.operationality === "necessary" || item.operationality === "contributory");
  const fulfilledSupport = supportive.filter((item) => item.resolution === "fulfilled");
  const causalSupport = supportive.length ? fulfilledSupport.length / supportive.length : 0;
  const temporal = assessTemporalCompatibility(
    options.temporalAnchor ?? state.logicalTime.storyTime,
    possibility.candidateWindow,
    options.temporalMode ?? "current-window",
    fulfilledSupport.length > 0,
    !possibility.canonicalEventId && possibility.kind !== "canon-analogue",
  );
  const rootSceneSupported = !possibility.canonicalEventId
    || links.some((link) => link.operationality === "necessary" || link.operationality === "contributory")
    || possibility.preconditions.length > 0
    || options.rootEvidenceSupported === true
    || (options.rootEvidenceSupported === undefined && (
      options.activeEntityIds === undefined
      || possibility.participants.some((participant) => options.activeEntityIds!.has(participant))
    ));
  const satisfiedPreconditions = possibility.preconditions.filter((predicate) => evaluatePredicate(state, predicate)).length;
  const conditionStrength = possibility.preconditions.length ? satisfiedPreconditions / possibility.preconditions.length : 1;
  const motivationalPressure = causalTrace.filter((item) => item.operationality === "motivational" && item.resolution === "fulfilled").length * 0.25;
  const factors: SchedulerFactors = {
    tier: schedulerTier(possibility, causalTrace, state.logicalTime.elapsedDays ?? 0),
    dueTime: schedulerDueTime(possibility),
    pressure: clampFactor(possibility.pressure + motivationalPressure),
    causalSupport,
    sceneRelevance: clampFactor(possibility.relevance),
    cooldownPenalty: clampFactor(options.cooldownPenalty ?? 0),
    novelty: clampFactor(options.novelty ?? 1),
    canonAffinity: possibility.canonicalEventId ? clampFactor(options.canonAffinity ?? 1) : 0,
    conditionStrength,
  };
  const tuple = schedulerTuple(possibility.id, factors);
  let status: PossibilityStatus;

  if (options.realizedIds?.has(possibility.id)) {
    status = "realized";
    reasons.push("linked event is committed");
    gates.push({ gate: "realization", outcome: "fail", detail: "candidate already realized" });
  } else if (options.adaptedIds?.has(possibility.id)) {
    status = "adapted";
    reasons.push("a committed functional analogue fulfills this canonical development");
    gates.push({ gate: "realization", outcome: "fail", detail: "candidate already fulfilled by an analogue" });
  } else if (options.supersededIds?.has(possibility.id)) {
    status = "superseded";
    reasons.push("replaced by another committed development");
    gates.push({ gate: "realization", outcome: "fail", detail: "candidate was explicitly superseded" });
  } else if (supersededNecessary.length) {
    status = "invalidated";
    reasons.push(`required cause was superseded: ${supersededNecessary.map((item) => item.sourceEventId).join(", ")}`);
    gates.push({ gate: "necessary-cause", outcome: "fail", detail: reasons.at(-1)! });
  } else if (activeCausalBlockers.length) {
    status = "invalidated";
    reasons.push(`blocking event occurred: ${activeCausalBlockers.map((item) => item.sourceEventId).join(", ")}`);
    gates.push({ gate: "causal-blocker", outcome: "fail", detail: reasons.at(-1)! });
  } else if (possibility.expiry?.some((predicate) => evaluatePredicate(state, predicate))) {
    status = "expired";
    reasons.push("an expiry condition is true");
    gates.push({ gate: "expiry", outcome: "fail", detail: reasons.at(-1)! });
  } else {
    const activeBlockers = possibility.blockers.filter((predicate) => evaluatePredicate(state, predicate));
    if (activeBlockers.length) {
      status = "blocked";
      reasons.push(`${activeBlockers.length} state blocker(s) are active`);
      gates.push({ gate: "state-blocker", outcome: "fail", detail: reasons.at(-1)! });
    } else if (unresolvedNecessary.length) {
      status = "latent";
      reasons.push(`waiting for necessary cause(s): ${unresolvedNecessary.map((item) => item.sourceEventId).join(", ")}`);
      gates.push({ gate: "necessary-cause", outcome: "fail", detail: reasons.at(-1)! });
    } else if (satisfiedPreconditions !== possibility.preconditions.length) {
      status = "latent";
      reasons.push(`${satisfiedPreconditions}/${possibility.preconditions.length} preconditions are satisfied`);
      gates.push({ gate: "precondition", outcome: "fail", detail: reasons.at(-1)! });
    } else if (!rootSceneSupported) {
      status = "latent";
      reasons.push("root canonical development has no participant, condition, or structural causal support in the active scene");
      gates.push({ gate: "scene", outcome: "fail", detail: reasons.at(-1)! });
    } else if (!temporal.allowed) {
      status = "latent";
      reasons.push(temporal.reason ?? "candidate time is outside the active scene window");
      gates.push({ gate: "time", outcome: "fail", detail: reasons.at(-1)! });
    } else {
      status = "eligible";
      reasons.push("deterministic eligibility gates passed");
      if (temporal.reason) reasons.push(temporal.reason);
      gates.push({ gate: "necessary-cause", outcome: "pass", detail: "all necessary causes are fulfilled" });
      gates.push({ gate: "causal-blocker", outcome: "pass", detail: "no typed blocking cause has occurred" });
      gates.push({ gate: "precondition", outcome: "pass", detail: "all state preconditions are satisfied" });
      gates.push({ gate: "time", outcome: "pass", detail: temporal.reason ?? "candidate has no conflicting time bound" });
      gates.push({ gate: "scene", outcome: "pass", detail: "candidate is supported in the active scene or by structural conditions" });
    }
  }

  for (const relation of causalTrace) reasons.push(relation.detail);
  const score = status === "eligible"
    ? 5 - factors.tier + factors.pressure * 0.1 + factors.causalSupport * 0.01 + factors.sceneRelevance * 0.001
    : 0;
  return {
    possibility,
    status,
    reasons,
    factors,
    score,
    trace: { candidateSource: possibility.kind, gates, causalLinks: causalTrace, tuple },
  };
}

export function buildFrontier(branchId: BranchId, commitId: CommitId, state: WorldState, templates: readonly Possibility[], options: {
  realizedIds?: ReadonlySet<string>;
  adaptedIds?: ReadonlySet<string>;
  supersededIds?: ReadonlySet<string>;
  realizationEventIds?: ReadonlyMap<string, string>;
  canonAffinity?: ReadonlyMap<string, number>;
  cooldownPenalty?: ReadonlyMap<string, number>;
  novelty?: ReadonlyMap<string, number>;
  temporalMode?: FrontierTemporalMode;
  temporalAnchor?: StoryTime;
  activeEntityIds?: ReadonlySet<string>;
  activeEvidence?: readonly EvidenceRef[];
} = {}): Frontier {
  const rootEvidenceSupport = canonicalRootEvidenceSupport(templates, options.activeEvidence);
  const evaluated = templates.map((template) => {
    const possibility: Possibility = { ...template, branchId, evaluatedAtCommit: commitId };
    return evaluatePossibility(state, possibility, {
      realizedIds: options.realizedIds,
      adaptedIds: options.adaptedIds,
      supersededIds: options.supersededIds,
      realizationEventIds: options.realizationEventIds,
      canonAffinity: possibility.canonicalEventId ? options.canonAffinity?.get(possibility.canonicalEventId) : undefined,
      cooldownPenalty: options.cooldownPenalty?.get(possibility.id),
      novelty: options.novelty?.get(possibility.id),
      temporalMode: options.temporalMode,
      temporalAnchor: options.temporalAnchor,
      activeEntityIds: options.activeEntityIds,
      rootEvidenceSupported: rootEvidenceSupport.get(possibility.id),
    });
  });
  propagateInvalidatedDescendants(evaluated);
  evaluated.sort(compareEvaluatedPossibilities);
  return { version: 2, branchId, commitId, temporalMode: options.temporalMode ?? "current-window", evaluated };
}

export function deriveDuePossibilities(input: {
  branchId: BranchId;
  commitId: CommitId;
  state: WorldState;
  processes: ProcessState;
  norms: NormState;
  processTemplates: ReadonlyMap<string, ProcessTemplate>;
  normTemplates: ReadonlyMap<string, NormTemplate>;
}): Possibility[] {
  const elapsedDays = input.state.logicalTime.elapsedDays ?? 0;
  const possibilities: Possibility[] = [];
  for (const norm of dueNormInstances(input.norms, elapsedDays)) {
    const template = input.normTemplates.get(norm.templateId);
    if (!template) continue;
    const id = `due-norm-${contentHash({ normId: norm.id, dueAt: norm.dueAtElapsedDays }).slice(0, 24)}`;
    possibilities.push({
      id,
      branchId: input.branchId,
      evaluatedAtCommit: input.commitId,
      kind: "due-process",
      title: `Deadline: ${template.name}`,
      preconditions: [],
      blockers: [],
      participants: [...new Set([norm.subjectActorId, ...(norm.beneficiaryActorId ? [norm.beneficiaryActorId] : [])])],
      causalLinks: [],
      causalParents: [],
      dueAtElapsedDays: norm.dueAtElapsedDays,
      sourceActorId: norm.subjectActorId,
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      proposedNorms: {
        version: 1,
        operations: [{
          op: "violate-norm",
          normRef: norm.id,
          byActorId: norm.subjectActorId,
          reasonId: "deadline-expired",
        }],
      },
      evidence: template.evidence,
    });
  }
  for (const process of dueProcessInstances(input.processes, elapsedDays)) {
    const template = input.processTemplates.get(process.templateId);
    if (!template) continue;
    const transition = template.transitions
      .filter((item) => item.fromPhaseId === process.phaseId && item.onDue)
      .sort((left, right) => left.toPhaseId.localeCompare(right.toPhaseId))[0];
    if (!transition?.onDue) continue;
    const amount = Math.min(transition.onDue.advanceBy, 1 - process.progress);
    if (amount <= 0 || process.progress + amount < transition.minimumProgress) continue;
    const operations: NonNullable<Possibility["proposedProcesses"]>["operations"] = [{
      op: "advance-process",
      processRef: process.id,
      amount,
      phaseId: transition.toPhaseId,
    }];
    if (transition.onDue.outcomeId) operations.push({ op: "finish-process", processRef: process.id, outcomeId: transition.onDue.outcomeId });
    const id = `due-process-${contentHash({ processId: process.id, phaseId: process.phaseId, dueAt: process.dueAtElapsedDays }).slice(0, 24)}`;
    possibilities.push({
      id,
      branchId: input.branchId,
      evaluatedAtCommit: input.commitId,
      kind: "due-process",
      title: `Due process: ${template.name}`,
      preconditions: [],
      blockers: [],
      participants: processOwnerEntityIds(process),
      causalLinks: [],
      causalParents: [],
      dueAtElapsedDays: process.dueAtElapsedDays,
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      proposedProcesses: { version: 1, operations },
      evidence: template.evidence,
    });
  }
  return possibilities.sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalRootEvidenceSupport(templates: readonly Possibility[], activeEvidence: readonly EvidenceRef[] | undefined): ReadonlyMap<string, boolean> {
  const anchors = new Map<string, number>();
  for (const reference of activeEvidence ?? []) {
    anchors.set(reference.span.sourceId, Math.max(anchors.get(reference.span.sourceId) ?? Number.NEGATIVE_INFINITY, reference.span.endLine));
  }
  const earliest = new Map<string, number>();
  for (const possibility of templates) {
    if (!possibility.canonicalEventId || hasStructuralCausalLink(possibility) || possibility.preconditions.length) continue;
    for (const reference of possibility.evidence) {
      earliest.set(reference.span.sourceId, Math.min(earliest.get(reference.span.sourceId) ?? Number.POSITIVE_INFINITY, reference.span.startLine));
    }
  }
  const result = new Map<string, boolean>();
  for (const possibility of templates) {
    if (!possibility.canonicalEventId || hasStructuralCausalLink(possibility) || possibility.preconditions.length) continue;
    if (!possibility.evidence.length) continue;
    result.set(possibility.id, possibility.evidence.some((reference) => {
      const anchor = anchors.get(reference.span.sourceId);
      if (anchor !== undefined) return reference.span.startLine <= anchor;
      return reference.span.startLine === earliest.get(reference.span.sourceId);
    }));
  }
  return result;
}

export function selectEligible(frontier: Frontier, limit = 10, options: { includePlayerChoices?: boolean } = {}): EvaluatedPossibility[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Scheduler limit must be a non-negative integer");
  return frontier.evaluated
    .filter((entry) => entry.status === "eligible" && (options.includePlayerChoices || !["player-choice", "actor-plan"].includes(entry.possibility.kind)))
    .slice(0, limit);
}

export function possibilityToProposal(entry: EvaluatedPossibility, actorId?: string): EventProposal | null {
  const possibility = entry.possibility;
  const hasEffect = Boolean(
    possibility.proposedDelta?.operations.length
    || possibility.proposedKnowledge?.operations.length
    || possibility.proposedSemantics?.operations.length
    || possibility.proposedProcesses?.operations.length
    || possibility.proposedNorms?.operations.length
    || possibility.timeAdvance
    || possibility.kind === "due-process",
  );
  if (entry.status !== "eligible" || !hasEffect || possibility.canonicalScaffold) return null;
  const causalRelations = entry.trace.causalLinks.flatMap((item): BranchEventRelationProposal[] => {
    if (item.resolution !== "fulfilled" || !item.resolvedSourceEventId) return [];
    if (!["causes", "enables", "motivates", "explains"].includes(item.type)) return [];
    if (!["necessary", "contributory", "motivational", "explanatory"].includes(item.operationality)) return [];
    return [{
      fromEventId: item.resolvedSourceEventId,
      type: item.type as BranchEventRelationProposal["type"],
      operationality: item.operationality as BranchEventRelationProposal["operationality"],
      ...(item.operationality === "motivational" && (possibility.sourceActorId ?? item.motivatedActorIds?.[0])
        ? { actorId: possibility.sourceActorId ?? item.motivatedActorIds?.[0] }
        : {}),
      ...(item.operationality === "motivational" && (possibility.sourceGoalId ?? item.goalIds?.[0])
        ? { goalId: possibility.sourceGoalId ?? item.goalIds?.[0] }
        : {}),
      description: item.detail,
    }];
  });
  return {
    proposalId: `poss-${contentHash({ id: possibility.id, at: possibility.evaluatedAtCommit }).slice(0, 24)}`,
    branchId: possibility.branchId,
    expectedParentCommit: possibility.evaluatedAtCommit,
    source: possibility.kind === "canon-analogue" ? "canon-candidate" : actorId ? "actor" : "background",
    ...(actorId ? { actorId } : possibility.sourceActorId ? { actorId: possibility.sourceActorId } : {}),
    title: possibility.title,
    participants: possibility.participants,
    ...(possibility.participantPresence ? { participantPresence: structuredClone(possibility.participantPresence) } : {}),
    proposedTime: possibility.candidateWindow ?? { kind: "unknown" },
    ...(possibility.timeAdvance ? { timeAdvance: possibility.timeAdvance } : {}),
    preconditions: possibility.preconditions,
    proposedDelta: possibility.proposedDelta ?? { version: 1, operations: [] },
    ...(possibility.proposedKnowledge ? { proposedKnowledge: possibility.proposedKnowledge } : {}),
    ...(possibility.proposedSemantics ? { proposedSemantics: possibility.proposedSemantics } : {}),
    ...(possibility.proposedProcesses ? { proposedProcesses: possibility.proposedProcesses } : {}),
    ...(possibility.proposedNorms ? { proposedNorms: possibility.proposedNorms } : {}),
    ...(possibility.action ? { action: structuredClone(possibility.action) } : {}),
    causalRelations,
    causalParents: causalRelations.map((relation) => relation.fromEventId),
    evidence: possibility.evidence,
    possibilityId: possibility.id,
  };
}

export class FrontierStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(worldStorageRoot(workspaceRoot), "frontier"); }
  async write(frontier: Frontier): Promise<void> {
    const filePath = this.filePath(frontier.branchId, frontier.commitId, frontier.temporalMode);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(frontier, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
  async read(branchId: BranchId, commitId: CommitId, temporalMode: FrontierTemporalMode = "current-window"): Promise<Frontier | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath(branchId, commitId, temporalMode), "utf8")) as Frontier;
      if (value.version !== 2 || value.branchId !== branchId || value.commitId !== commitId || value.temporalMode !== temporalMode) {
        throw new Error(`Invalid frontier cache for ${branchId}@${commitId}`);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private filePath(branchId: BranchId, commitId: CommitId, temporalMode: FrontierTemporalMode): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Invalid branch id: ${branchId}`);
    if (!/^[a-f0-9]{64}$/.test(commitId)) throw new Error(`Invalid commit id: ${commitId}`);
    return path.join(this.root, branchId, `${commitId}.${temporalMode}.json`);
  }
}

function resolveCausalLink(link: PossibilityCausalLink, options: FrontierEvaluationOptions): SchedulerCausalTrace {
  const aliases = possibilityIdAliases(link.sourceEventId);
  const resolvedSourceEventId = aliases.map((id) => options.realizationEventIds?.get(id)).find((id): id is string => Boolean(id));
  const fulfilled = aliases.some((id) => options.realizedIds?.has(id) || options.adaptedIds?.has(id));
  const superseded = !fulfilled && aliases.some((id) => options.supersededIds?.has(id));
  if (link.operationality === "explanatory" || link.operationality === "non-operational") {
    return { ...link, resolution: "ignored", ...(resolvedSourceEventId ? { resolvedSourceEventId } : {}), detail: `${link.operationality} relation ${link.relationId} does not affect eligibility` };
  }
  if (link.operationality === "blocking") {
    return {
      ...link,
      resolution: fulfilled ? "active-blocker" : "inactive-blocker",
      ...(resolvedSourceEventId ? { resolvedSourceEventId } : {}),
      detail: fulfilled ? `blocking relation ${link.relationId} is active because ${link.sourceEventId} occurred` : `blocking relation ${link.relationId} is inactive`,
    };
  }
  if (fulfilled) {
    return { ...link, resolution: "fulfilled", resolvedSourceEventId: resolvedSourceEventId ?? link.sourceEventId, detail: `${link.operationality} relation ${link.relationId} is fulfilled` };
  }
  if (superseded) return { ...link, resolution: "superseded", detail: `${link.operationality} relation ${link.relationId} source was superseded` };
  return {
    ...link,
    resolution: "waiting",
    detail: link.operationality === "necessary"
      ? `necessary relation ${link.relationId} is waiting for ${link.sourceEventId}`
      : `${link.operationality} relation ${link.relationId} is currently unsupported but does not gate eligibility`,
  };
}

function causalLinksFor(possibility: Possibility): PossibilityCausalLink[] {
  if (possibility.causalLinks !== undefined) return possibility.causalLinks;
  return possibility.causalParents.map((sourceEventId, index) => ({
    relationId: `legacy-cause-${contentHash({ possibilityId: possibility.id, sourceEventId, index }).slice(0, 24)}`,
    sourceEventId,
    type: "causes",
    operationality: "necessary",
  }));
}

function hasStructuralCausalLink(possibility: Possibility): boolean {
  return causalLinksFor(possibility).some((link) => link.operationality === "necessary" || link.operationality === "contributory");
}

function schedulerTier(possibility: Possibility, causal: readonly SchedulerCausalTrace[], elapsedDays: number): SchedulerTier {
  if (possibility.kind === "direct-response" || possibility.kind === "due-process"
    || (possibility.dueAtElapsedDays !== undefined && possibility.dueAtElapsedDays <= elapsedDays)) return 0;
  if (possibility.kind === "causal-consequence"
    || causal.some((item) => item.resolution === "fulfilled" && item.operationality === "necessary")) return 1;
  if (["player-choice", "actor-plan", "obligation"].includes(possibility.kind)) return 2;
  if (["background-pressure", "institutional-pressure", "environmental", "generated"].includes(possibility.kind)) return 3;
  return 4;
}

function schedulerDueTime(possibility: Possibility): number | null {
  if (possibility.dueAtElapsedDays !== undefined) return possibility.dueAtElapsedDays;
  return comparableStoryTime(possibility.candidateWindow)?.min ?? null;
}

function schedulerTuple(stableId: string, factors: SchedulerFactors): SchedulerTuple {
  return {
    tier: factors.tier,
    dueTime: factors.dueTime,
    pressure: factors.pressure,
    causalSupport: factors.causalSupport,
    sceneRelevance: factors.sceneRelevance,
    cooldownPenalty: factors.cooldownPenalty,
    novelty: factors.novelty,
    canonAffinity: factors.canonAffinity,
    stableId,
  };
}

function compareEvaluatedPossibilities(left: EvaluatedPossibility, right: EvaluatedPossibility): number {
  if (left.status === "eligible" && right.status !== "eligible") return -1;
  if (left.status !== "eligible" && right.status === "eligible") return 1;
  if (left.status !== "eligible" || right.status !== "eligible") return left.possibility.id.localeCompare(right.possibility.id);
  const a = left.trace.tuple;
  const b = right.trace.tuple;
  return a.tier - b.tier
    || nullableOrder(a.dueTime) - nullableOrder(b.dueTime)
    || b.pressure - a.pressure
    || b.causalSupport - a.causalSupport
    || b.sceneRelevance - a.sceneRelevance
    || a.cooldownPenalty - b.cooldownPenalty
    || b.novelty - a.novelty
    || b.canonAffinity - a.canonAffinity
    || a.stableId.localeCompare(b.stableId);
}

function nullableOrder(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function clampFactor(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function assessTemporalCompatibility(
  current: StoryTime | undefined,
  candidate: StoryTime | undefined,
  mode: FrontierTemporalMode,
  causallySupported: boolean,
  unwindowedIsImmediate: boolean,
): { allowed: boolean; reason?: string } {
  const currentRange = comparableStoryTime(current);
  const candidateRange = comparableStoryTime(candidate);
  if (current && !currentRange) {
    return causallySupported
      ? { allowed: true, reason: "candidate time is admitted by an already-realized typed causal relation" }
      : unwindowedIsImmediate && !candidate
        ? { allowed: true, reason: "an unwindowed non-canonical development is treated as immediate" }
        : { allowed: false, reason: "the active story-time anchor is present but cannot be compared safely" };
  }
  if (!currentRange) return { allowed: true, reason: "the branch has no active story-time anchor" };
  if (!candidateRange || candidateRange.scale !== currentRange.scale) {
    return causallySupported
      ? { allowed: true, reason: "candidate time is admitted by an already-realized typed causal relation" }
      : unwindowedIsImmediate && !candidate
        ? { allowed: true, reason: "an unwindowed non-canonical development is treated as immediate" }
        : { allowed: false, reason: "candidate time cannot be placed safely relative to the active scene" };
  }
  if (candidateRange.max < currentRange.min) return { allowed: false, reason: "candidate window is earlier than committed branch time" };
  if (mode === "current-window" && candidateRange.min > currentRange.max) {
    return { allowed: false, reason: "candidate window is later than the active scene; explicit time advancement is required" };
  }
  return {
    allowed: true,
    reason: candidateRange.min > currentRange.max ? "candidate is the earliest eligible forward development" : "candidate window overlaps committed branch time",
  };
}

function possibilityIdAliases(id: string): string[] {
  return id.startsWith("canon-") ? [id, id.slice("canon-".length)] : [id, `canon-${id}`];
}

function propagateInvalidatedDescendants(evaluated: EvaluatedPossibility[]): void {
  const byId = new Map<string, EvaluatedPossibility>();
  for (const entry of evaluated) {
    byId.set(entry.possibility.id, entry);
    if (entry.possibility.canonicalEventId && entry.possibility.id === `canon-${entry.possibility.canonicalEventId}`) byId.set(entry.possibility.canonicalEventId, entry);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of evaluated) {
      if (["realized", "adapted", "superseded", "expired", "invalidated"].includes(entry.status)) continue;
      const invalidParent = causalLinksFor(entry.possibility)
        .filter((link) => link.operationality === "necessary")
        .map((link) => byId.get(link.sourceEventId) ?? byId.get(`canon-${link.sourceEventId}`))
        .find((parent) => parent && ["superseded", "expired", "invalidated"].includes(parent.status));
      if (!invalidParent) continue;
      entry.status = "invalidated";
      entry.score = 0;
      entry.reasons = [`necessary causal source ${invalidParent.possibility.id} is ${invalidParent.status}`];
      entry.trace.gates.push({ gate: "necessary-cause", outcome: "fail", detail: entry.reasons[0]! });
      changed = true;
    }
  }
}
