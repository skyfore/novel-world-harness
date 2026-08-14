import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import type { CanonicalEvent, EvidenceRef } from "../world/model.js";
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
    causalCycles: string[][];
    missingCausalParents: Array<{ eventId: string; parentId: string }>;
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
      causalGraphValid: events.length ? graph.cycles.length === 0 && graph.missing.length === 0 : null,
      causalCycles: graph.cycles,
      missingCausalParents: graph.missing,
    },
    coverage: {
      sourceIndexing,
      evidenceBinding: validBindingRatio,
      temporalConsistency: events.length ? (graph.cycles.length ? 0 : 1) : null,
      stateDeltaExplicitness: events.length ? eventsWithExplicitDelta / events.length : null,
      causalityConsistency: events.length ? (graph.cycles.length || graph.missing.length ? 0 : 1) : null,
      entityResolution: null,
      majorEventResolution: null,
      epistemicCoverage: null,
    },
    notes: [
      ...(options.sourceId ? [`Audit is scoped to source ${options.sourceId}; unrelated registered sources and artifacts are excluded.`] : []),
      "Null coverage values are intentional: the compiler does not have a trustworthy denominator for those dimensions yet.",
      "Canonical artifact counts are inventory, not full-book semantic coverage.",
      "Source indexing measures indexed source bytes and may be below 1 when blank-only gaps are intentionally omitted.",
    ],
  };
}

function auditCausalGraph(events: readonly CanonicalEvent[]): {
  cycles: string[][];
  missing: Array<{ eventId: string; parentId: string }>;
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
  return { cycles, missing };
}
