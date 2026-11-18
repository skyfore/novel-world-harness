import path from "node:path";
import { PreparedNovelCache, type PreparedNovelBundle } from "../compiler/prepared-cache.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { bundleCanonTimeline, timelineBlockedFromIndex, TIMELINE_BLOCKING_CODES } from "../world/canon-timeline.js";
import type { ValidationIssue } from "../world/model.js";
import { resolveNovelSource } from "../world/play-experience.js";
import { minimumAdmissionTierFor } from "../config/load.js";
import { tierAtLeast } from "../compiler/cut-admission-schema.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

export type NovelCutsReport = {
  sourceId: string;
  bundle: { origin: "candidate" | "revision"; bundleHash?: string; frozenTimeline: boolean; baselineIssues: ValidationIssue[] };
  timeline: {
    hash: string;
    subjectHash: string;
    events: number;
    ordered: number;
    cycles: number;
    blockedFromIndex?: number;
    assumedPairs: number;
    issueCounts: Record<string, number>;
    issues: ValidationIssue[];
    entries: Array<{
      index: number;
      eventId: string;
      title: string;
      discourseByte: number;
      basis: "discourse" | "constraint";
      mode: string;
      sceneIds: string[];
      constraintIds: string[];
      aliasOf?: string;
    }>;
  };
};

/** Pure summary of a bundle's chronology. Read-only; no model calls. */
export function summarizeNovelCuts(bundle: PreparedNovelBundle, origin: NovelCutsReport["bundle"]["origin"] = "candidate", options: { bundleHash?: string; baselineIssues?: ValidationIssue[] } = {}): NovelCutsReport {
  const timeline = bundleCanonTimeline(bundle);
  const events = new Map(bundle.canonical.events.map((event) => [event.id, event]));
  const scenesByEvent = new Map<string, Set<string>>();
  for (const scene of bundle.canonical.sceneOccurrences) for (const eventId of scene.eventIds) scenesByEvent.set(eventId, (scenesByEvent.get(eventId) ?? new Set()).add(scene.id));
  for (const event of bundle.canonical.events) for (const sceneId of event.sceneOccurrenceIds ?? []) scenesByEvent.set(event.id, (scenesByEvent.get(event.id) ?? new Set()).add(sceneId));
  const issueCounts: Record<string, number> = {};
  for (const issue of timeline.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  const cycleMembers = new Set(timeline.issues.filter((issue) => TIMELINE_BLOCKING_CODES.has(issue.code)).map((issue) => issue.path));
  const blockedFromIndex = timelineBlockedFromIndex(timeline);
  return {
    sourceId: bundle.source.id,
    bundle: { origin, ...(options.bundleHash ? { bundleHash: options.bundleHash } : {}), frozenTimeline: Boolean(bundle.canonical.timeline), baselineIssues: options.baselineIssues ?? [] },
    timeline: {
      hash: timeline.hash,
      subjectHash: timeline.subjectHash,
      events: bundle.canonical.events.length,
      ordered: timeline.entries.length,
      cycles: countCycles(timeline.issues),
      ...(blockedFromIndex === undefined ? {} : { blockedFromIndex }),
      assumedPairs: timeline.assumedPairs.length,
      issueCounts,
      issues: timeline.issues,
      entries: timeline.entries.map((entry) => {
        const event = events.get(entry.eventId);
        return {
          index: entry.index,
          eventId: entry.eventId,
          title: event?.title ?? entry.eventId,
          discourseByte: entry.discourseByte,
          basis: entry.basis,
          mode: event?.narrativeContext?.mode ?? "unspecified",
          sceneIds: [...(scenesByEvent.get(entry.eventId) ?? [])].sort(),
          constraintIds: entry.constraintIds,
          ...(entry.aliasOf ? { aliasOf: entry.aliasOf } : {}),
          ...(cycleMembers.has(`event/${entry.eventId}`) ? { cycle: true } : {}),
        };
      }),
    },
  };
}

/** One cycle issue is emitted per member; distinct member sets identify cycles. */
function countCycles(issues: readonly ValidationIssue[]): number {
  return new Set(issues.filter((issue) => TIMELINE_BLOCKING_CODES.has(issue.code)).map((issue) => issue.message)).size;
}

export type NovelCutsOptions = { root: string; sourceId?: string; revision?: string };

/** Load the workspace candidate (or an exact cached revision) without writes, migrations or model calls. */
export async function loadNovelCutsBundle(options: NovelCutsOptions): Promise<{ source: SourceDocument; bundle: PreparedNovelBundle; origin: NovelCutsReport["bundle"]["origin"]; bundleHash?: string; baselineIssues: ValidationIssue[] }> {
  const root = path.resolve(options.root);
  const workspace = await WorkspaceStore.openReadOnly(root);
  const sources = await workspace.listSources();
  const source = options.sourceId
    ? await resolveNovelSource(workspace, options.sourceId)
    : sources.length === 1 ? sources[0]! : undefined;
  if (!source) throw new Error(`Select one novel with --source. Registered sources: ${sources.map((item) => item.id).join(", ") || "none"}.`);
  const cache = new PreparedNovelCache(root);
  if (options.revision) {
    const revision = await cache.loadRevision(source, options.revision, { allowIncompatible: true });
    if (!revision) throw new Error(`Prepared revision ${options.revision} is not cached for ${source.id}.`);
    return { source, bundle: revision.bundle, origin: "revision", bundleHash: revision.bundleHash, baselineIssues: [] };
  }
  const { bundle, baselineIssues } = await cache.repairCandidateSnapshot(source);
  return { source, bundle, origin: "candidate", baselineIssues };
}

export async function inspectNovelCuts(options: NovelCutsOptions): Promise<NovelCutsReport> {
  const loaded = await loadNovelCutsBundle(options);
  return summarizeNovelCuts(loaded.bundle, loaded.origin, { ...(loaded.bundleHash ? { bundleHash: loaded.bundleHash } : {}), baselineIssues: loaded.baselineIssues });
}

export async function novelCutsCommand(options: NovelCutsOptions): Promise<void> {
  console.log(JSON.stringify(await inspectNovelCuts(options), null, 2));
}

export type NovelAdmitOptions = { root: string; sourceId?: string; configPath?: string; activate?: boolean; cacheRoot?: string };

/**
 * Freeze the current candidate with its closure assessment and per-cut
 * admission manifest, and optionally activate it. Publishes only when the
 * revision is fully certified or admits at least one entry at the configured
 * minimum tier.
 */
export async function novelAdmitCommand(options: NovelAdmitOptions): Promise<void> {
  const root = path.resolve(options.root);
  const minimumAdmissionTier = await minimumAdmissionTierFor(root, options.configPath);
  const summary = await withWorkspaceOperationLock(root, "compiler", async () => {
    const workspace = await WorkspaceStore.openReadOnly(root);
    const sources = await workspace.listSources();
    const source = options.sourceId ? await resolveNovelSource(workspace, options.sourceId) : sources.length === 1 ? sources[0]! : undefined;
    if (!source) throw new Error(`Select one novel with --source. Registered sources: ${sources.map((item) => item.id).join(", ") || "none"}.`);
    const cache = new PreparedNovelCache(root, options.cacheRoot);
    const admitted = await cache.admitCandidate(source, { minimumAdmissionTier });
    if (options.activate) await cache.activate(source, admitted.bundleHash!, { minimumAdmissionTier });
    const tiers: Record<string, number> = {};
    for (const cut of admitted.admission.cuts) tiers[cut.tier] = (tiers[cut.tier] ?? 0) + 1;
    return {
      sourceId: source.id, bundleHash: admitted.bundleHash, activated: Boolean(options.activate), minimumAdmissionTier,
      horizonIndex: admitted.admission.horizonIndex, cutTiers: tiers,
      admitted: admitted.admission.cuts.flatMap((cut) => cut.actors.filter((actor) => tierAtLeast(actor.tier, minimumAdmissionTier))
        .map((actor) => ({ cutId: cut.cutId, sceneId: cut.sceneId, beforeEventId: cut.beforeEventId, actorId: actor.actorId, tier: actor.tier }))),
    };
  });
  console.log(JSON.stringify(summary, null, 2));
}
