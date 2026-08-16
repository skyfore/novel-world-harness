import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import type { CanonicalEvent, EvidenceRef, StoryTime } from "../world/model.js";
import { SegmentStore } from "./segments.js";
import { EvidenceVerifier } from "./evidence.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";

export type CompilerAuditReport = {
  version: 1;
  sources: {
    registered: number;
    segmented: number;
    segments: number;
    changedSinceIngest: string[];
  };
  proposals: {
    pending: number;
    accepted: number;
    rejected: number;
    pendingByKind: Record<string, number>;
  };
  canonical: {
    entities: number;
    claims: number;
    events: number;
    rules: number;
    initialWorld: boolean;
    characterGoals: number;
    characterModels: number;
  };
  evidence: {
    artifactsChecked: number;
    referencesChecked: number;
    invalidReferences: number;
    validBindingRatio: number | null;
    errors: Array<{ artifact: string; code: string; message: string }>;
  };
  consistency: {
    causalGraphValid: boolean | null;
    narrativeGraphNavigable: boolean | null;
    causalCycles: string[][];
    missingCausalParents: Array<{ eventId: string; parentId: string }>;
    temporalRegressions: Array<{ eventId: string; parentId: string }>;
    causalComponents: number;
    largestCausalComponent: number;
    unconditionalRootEvents: string[];
  };
  coverage: {
    sourceIndexing: number | null;
    evidenceBinding: number | null;
    temporalConsistency: number | null;
    stateDeltaExplicitness: number | null;
    causalityConsistency: number | null;
    entityResolution: null;
    majorEventResolution: null;
    epistemicCoverage: null;
  };
  notes: string[];
};

export async function auditCompiler(
  workspaceRoot: string,
  options: { sourceId?: string } = {},
): Promise<CompilerAuditReport> {
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const registeredSources = await workspace.listSources();
  const sources = options.sourceId
    ? registeredSources.filter((source) => source.id === options.sourceId)
    : registeredSources;
  if (options.sourceId && !sources.length) throw new Error(`Unknown source id: ${options.sourceId}`);
  const segments = new SegmentStore(workspaceRoot);
  let segmented = 0;
  let segmentCount = 0;
  let indexedBytes = 0;
  let sourceBytes = 0;
  const changedSinceIngest: string[] = [];
  for (const source of sources) {
    sourceBytes += source.bytes;
    const manifest = await segments.readManifest(source.id);
    if (manifest?.sourceSha256 === source.contentSha256) {
      segmented += 1;
      segmentCount += manifest.segments.length;
      indexedBytes += manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    }
    try {
      await readSourceMaterial(workspaceRoot, source);
    } catch {
      changedSinceIngest.push(source.id);
    }
  }

  const proposalStore = new ProposalStore(workspaceRoot);
  const [pending, accepted, rejected] = await Promise.all([
    proposalStore.list("pending", options.sourceId),
    proposalStore.list("accepted", options.sourceId),
    proposalStore.list("rejected", options.sourceId),
  ]);
  const pendingByKind: Record<string, number> = {};
  for (const proposal of pending) pendingByKind[proposal.kind] = (pendingByKind[proposal.kind] ?? 0) + 1;

  const canon = new CanonicalModelStore(workspaceRoot);
  const actorStore = new ActorModelStore(workspaceRoot);
  const [allEntities, allClaims, allEvents, allRules, storedInitialWorld, allGoals, allModels] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    new InitialWorldStore(workspaceRoot).get(),
    actorStore.listGoals(),
    actorStore.listModels(),
  ]);
  const belongsToSelectedSource = (item: { evidence: readonly EvidenceRef[] }) =>
    !options.sourceId || item.evidence.some((reference) => reference.span.sourceId === options.sourceId);
  const entities = allEntities.filter(belongsToSelectedSource);
  const claims = allClaims.filter(belongsToSelectedSource);
  const events = allEvents.filter(belongsToSelectedSource);
  const rules = allRules.filter(belongsToSelectedSource);
  const initialWorld = storedInitialWorld && belongsToSelectedSource(storedInitialWorld) ? storedInitialWorld : null;
  const goals = allGoals.filter(belongsToSelectedSource);
  const models = allModels.filter(belongsToSelectedSource);

  const evidenceVerifier = new EvidenceVerifier(workspaceRoot);
  const evidenceArtifacts: Array<{ name: string; evidence: EvidenceRef[] }> = [
    ...entities.map((item) => ({ name: `entity:${item.id}`, evidence: item.evidence })),
    ...claims.map((item) => ({ name: `claim:${item.id}`, evidence: item.evidence })),
    ...events.map((item) => ({ name: `event:${item.id}`, evidence: item.evidence })),
    ...rules.map((item) => ({ name: `rule:${item.id}`, evidence: item.evidence })),
    ...(initialWorld ? [{ name: "initial-world", evidence: initialWorld.evidence }] : []),
    ...goals.map((item) => ({ name: `goal:${item.id}`, evidence: item.evidence })),
    ...models.map((item) => ({ name: `model:${item.actorId}`, evidence: item.evidence })),
  ];
  const evidenceErrors: CompilerAuditReport["evidence"]["errors"] = [];
  let referencesChecked = 0;
  for (const artifact of evidenceArtifacts) {
    referencesChecked += artifact.evidence.length;
    const result = await evidenceVerifier.verifyAll(artifact.evidence);
    for (const issue of result.issues) evidenceErrors.push({ artifact: artifact.name, code: issue.code, message: issue.message });
  }

  const graph = auditCausalGraph(events);
  const narrativeGraphNavigable = events.length ? graphNavigable(events, graph) : null;
  const eventsWithExplicitDelta = events.filter((event) => event.observedOutcome.operations.length > 0).length;
  const sourceIndexing = sources.length
    ? changedSinceIngest.length
      ? 0
      : sourceBytes === 0
        ? 1
        : Math.min(1, indexedBytes / sourceBytes)
    : null;
  const validBindingRatio = referencesChecked ? Math.max(0, 1 - evidenceErrors.length / referencesChecked) : null;

  return {
    version: 1,
    sources: { registered: sources.length, segmented, segments: segmentCount, changedSinceIngest },
    proposals: { pending: pending.length, accepted: accepted.length, rejected: rejected.length, pendingByKind },
    canonical: {
      entities: entities.length,
      claims: claims.length,
      events: events.length,
      rules: rules.length,
      initialWorld: Boolean(initialWorld),
      characterGoals: goals.length,
      characterModels: models.length,
    },
    evidence: {
      artifactsChecked: evidenceArtifacts.length,
      referencesChecked,
      invalidReferences: evidenceErrors.length,
      validBindingRatio,
      errors: evidenceErrors,
    },
    consistency: {
      causalGraphValid: events.length ? graph.cycles.length === 0 && graph.missing.length === 0 && graph.temporalRegressions.length === 0 : null,
      narrativeGraphNavigable,
      causalCycles: graph.cycles,
      missingCausalParents: graph.missing,
      temporalRegressions: graph.temporalRegressions,
      causalComponents: graph.components.length,
      largestCausalComponent: Math.max(0, ...graph.components.map((component) => component.length)),
      unconditionalRootEvents: graph.unconditionalRoots,
    },
    coverage: {
      sourceIndexing,
      evidenceBinding: validBindingRatio,
      temporalConsistency: events.length ? (graph.cycles.length || graph.temporalRegressions.length ? 0 : 1) : null,
      stateDeltaExplicitness: events.length ? eventsWithExplicitDelta / events.length : null,
      causalityConsistency: events.length ? (graph.cycles.length || graph.missing.length || narrativeGraphNavigable === false ? 0 : 1) : null,
      entityResolution: null,
      majorEventResolution: null,
      epistemicCoverage: null,
    },
    notes: [
      ...(options.sourceId ? [`Audit is scoped to source ${options.sourceId}; unrelated registered sources and artifacts are excluded.`] : []),
      "Null coverage values are intentional: the compiler does not have a trustworthy denominator for those dimensions yet.",
      "Canonical artifact counts are inventory, not full-book semantic coverage.",
      ...(narrativeGraphNavigable === false
        ? ["The canonical event graph is dominated by unconditional disconnected roots; recurring characters alone are not enough to make later canon active at the opening."]
        : []),
      "Source indexing measures indexed source bytes and may be below 1 when blank-only gaps are intentionally omitted.",
    ],
  };
}

function auditCausalGraph(events: readonly CanonicalEvent[]): {
  cycles: string[][];
  missing: Array<{ eventId: string; parentId: string }>;
  temporalRegressions: Array<{ eventId: string; parentId: string }>;
  components: string[][];
  unconditionalRoots: string[];
} {
  const byId = new Map(events.map((event) => [event.id, event]));
  const missing: Array<{ eventId: string; parentId: string }> = [];
  for (const event of events) {
    for (const parentId of event.causalParents) if (!byId.has(parentId)) missing.push({ eventId: event.id, parentId });
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const parent of byId.get(id)?.causalParents ?? []) if (byId.has(parent)) visit(parent);
    stack.pop();
    active.delete(id);
  };
  for (const event of events) visit(event.id);
  const temporalRegressions: Array<{ eventId: string; parentId: string }> = [];
  for (const event of events) {
    for (const parentId of event.causalParents) {
      const parent = byId.get(parentId);
      if (parent && storyTimeDefinitelyBefore(event.storyTime, parent.storyTime)) temporalRegressions.push({ eventId: event.id, parentId });
    }
  }
  const adjacency = new Map(events.map((event) => [event.id, new Set<string>()]));
  for (const event of events) {
    for (const parentId of event.causalParents) {
      if (!byId.has(parentId)) continue;
      adjacency.get(event.id)!.add(parentId);
      adjacency.get(parentId)!.add(event.id);
    }
  }
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const eventId of [...byId.keys()].sort()) {
    if (assigned.has(eventId)) continue;
    const component: string[] = [];
    const pending = [eventId];
    assigned.add(eventId);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component.sort());
  }
  const unconditionalRoots = events
    .filter((event) => event.causalParents.length === 0 && event.preconditions.length === 0)
    .map((event) => event.id)
    .sort();
  return { cycles, missing, temporalRegressions, components, unconditionalRoots };
}

function graphNavigable(
  events: readonly CanonicalEvent[],
  graph: ReturnType<typeof auditCausalGraph>,
): boolean {
  if (events.length <= 8) return true;
  const rootLimit = Math.max(8, Math.ceil(events.length * 0.4));
  const largest = Math.max(0, ...graph.components.map((component) => component.length));
  return graph.unconditionalRoots.length <= rootLimit || largest / events.length >= 0.6;
}

function storyTimeDefinitelyBefore(left: StoryTime, right: StoryTime): boolean {
  const comparable = (value: StoryTime): { scale: "year" | "ordinal"; min: number; max: number } | undefined => {
    if (value.kind === "ordinal" && typeof value.orderHint === "number") return { scale: "ordinal", min: value.orderHint, max: value.orderHint };
    const values = value.kind === "exact" ? [value.value] : value.kind === "range" ? [value.earliest, value.latest] : [];
    const years = values.flatMap((entry) => [...entry.matchAll(/(?:^|\D)(\d{3,4})(?:s)?(?=\D|$)/g)].map((match) => Number(match[1])));
    return years.length ? { scale: "year", min: Math.min(...years), max: Math.max(...years.map((year) => year + 9)) } : undefined;
  };
  const leftRange = comparable(left);
  const rightRange = comparable(right);
  return Boolean(leftRange && rightRange && leftRange.scale === rightRange.scale && leftRange.max < rightRange.min);
}
