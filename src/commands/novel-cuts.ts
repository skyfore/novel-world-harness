import path from "node:path";
import { PreparedNovelCache, type PreparedNovelBundle } from "../compiler/prepared-cache.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { bundleCanonTimeline, timelineBlockedFromIndex, TIMELINE_BLOCKING_CODES } from "../world/canon-timeline.js";
import type { ValidationIssue } from "../world/model.js";
import { resolveNovelSource } from "../world/play-experience.js";
import { minimumAdmissionTierFor } from "../config/load.js";
import { DEFAULT_MINIMUM_ADMISSION_TIER, tierAtLeast, type AdmissionManifest, type AdmissionTier } from "../compiler/cut-admission-schema.js";
import { buildAdmissionManifest, sceneLocationCompletionQueue } from "../compiler/cut-admission.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

export type NovelCutAdmissionSummary = {
  origin: "frozen" | "computed";
  probed: boolean;
  baselineIndex: number;
  horizonIndex: number;
  replay: AdmissionManifest["replay"];
  coverage: { cuts: number; tiers: Record<string, number>; scenes: number; scenesAdmissible: number; admittedEntries: number; minimumTier: AdmissionTier };
  globalIssues: ValidationIssue[];
  cuts: Array<{
    cutId: string; index: number; beforeEventId: string; sceneIds: string[]; tier: AdmissionTier;
    firstBlocking?: ValidationIssue; blockingCodes: string[];
    actors: Array<{ actorId: string; tier: AdmissionTier; entryBasis: string; firstIssue?: ValidationIssue }>;
  }>;
};

export type NovelCutsReport = {
  admission?: NovelCutAdmissionSummary;
  /** Scene location contract coverage and the horizon-ordered completion queue. */
  sceneLocations?: { scenes: number; withLocation: number; explicitlyUnknown: number; missing: number; queue: ReturnType<typeof sceneLocationCompletionQueue> };
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

/** Per-cut tiers, first blocking cause and coverage, from a frozen or freshly computed manifest. */
export function summarizeAdmission(manifest: AdmissionManifest, options: { origin: NovelCutAdmissionSummary["origin"]; probed: boolean; scenes: number; minimumTier?: AdmissionTier }): NovelCutAdmissionSummary {
  const minimumTier = options.minimumTier ?? DEFAULT_MINIMUM_ADMISSION_TIER;
  const tiers: Record<string, number> = {};
  for (const cut of manifest.cuts) tiers[cut.tier] = (tiers[cut.tier] ?? 0) + 1;
  const admissibleScenes = new Set(manifest.cuts.filter((cut) => cut.tier !== "blocked").flatMap((cut) => cut.sceneIds));
  return {
    origin: options.origin, probed: options.probed, baselineIndex: manifest.baselineIndex, horizonIndex: manifest.horizonIndex, replay: manifest.replay,
    coverage: {
      cuts: manifest.cuts.length, tiers, scenes: options.scenes, scenesAdmissible: admissibleScenes.size, minimumTier,
      admittedEntries: manifest.cuts.reduce((count, cut) => count + (cut.tier === "blocked" ? 0 : cut.actors.filter((actor) => tierAtLeast(actor.tier, minimumTier)).length), 0),
    },
    globalIssues: manifest.globalIssues,
    cuts: manifest.cuts.map((cut) => ({
      cutId: cut.cutId, index: cut.index, beforeEventId: cut.beforeEventId, sceneIds: cut.sceneIds, tier: cut.tier,
      ...(cut.blocking[0] ? { firstBlocking: cut.blocking[0] } : {}), blockingCodes: [...new Set(cut.blocking.map((issue) => issue.code))],
      actors: cut.actors.map((actor) => ({ actorId: actor.actorId, tier: actor.tier, entryBasis: actor.entryBasis, ...(actor.issues[0] ? { firstIssue: actor.issues[0] } : {}) })),
    })),
  };
}

/** One cycle issue is emitted per member; distinct member sets identify cycles. */
function countCycles(issues: readonly ValidationIssue[]): number {
  return new Set(issues.filter((issue) => TIMELINE_BLOCKING_CODES.has(issue.code)).map((issue) => issue.message)).size;
}

export type NovelCutsOptions = { root: string; sourceId?: string; revision?: string; admission?: boolean; probe?: boolean; configPath?: string };

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
  const report = summarizeNovelCuts(loaded.bundle, loaded.origin, { ...(loaded.bundleHash ? { bundleHash: loaded.bundleHash } : {}), baselineIssues: loaded.baselineIssues });
  if (options.admission === false) return report;
  const minimumTier = await minimumAdmissionTierFor(path.resolve(options.root), options.configPath);
  const scenes = loaded.bundle.canonical.sceneOccurrences.length;
  const frozen = loaded.bundle.admission;
  const admission = frozen
    ? summarizeAdmission(frozen, { origin: "frozen", probed: true, scenes, minimumTier })
    : summarizeAdmission(await buildAdmissionManifest(loaded.bundle, { inputIssues: loaded.baselineIssues, probe: options.probe !== false }), { origin: "computed", probed: options.probe !== false, scenes, minimumTier });
  const scenesList = loaded.bundle.canonical.sceneOccurrences;
  const queue = sceneLocationCompletionQueue(loaded.bundle, admission);
  return { ...report, admission, sceneLocations: {
    scenes: scenesList.length, withLocation: scenesList.filter((scene) => scene.locationId).length,
    explicitlyUnknown: scenesList.filter((scene) => scene.locationUnknown).length, missing: queue.length, queue,
  } };
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
