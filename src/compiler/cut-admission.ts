import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { bundleCanonTimeline, openingTimelineIndex, timelineBlockedFromIndex, timelineGroupStart, timelineIndex, TIMELINE_ADVISORY_CODES, type CanonTimeline } from "../world/canon-timeline.js";
import { WorldContextStore } from "../world/context.js";
import { WorldEngine } from "../world/engine.js";
import { deriveCharacterEntryOptions, deriveCharacterEntrySeed, type CharacterEntrySeed } from "../world/entry-context.js";
import type { ValidationIssue } from "../world/model.js";
import { WorldRuntime } from "../world/runtime.js";
import { CanonReplayError, executeSceneEvent } from "../world/source-history.js";
import { assertPreparedReadiness, preparedSubjectHash, validateFrozenAccounting } from "./certification.js";
import { buildPreparedClosure, type ClosureGraph } from "./closure.js";
import { issueAttributionCatalog, partitionIssueAttribution } from "./issue-attribution.js";
import { probeEntry } from "./playability.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { assessSemanticSupport } from "./semantic-support.js";

export * from "./cut-admission-schema.js";
import { admissionManifestSchema, cutAdmissionSchema, DEFAULT_MINIMUM_ADMISSION_TIER, tierAtLeast, type ActorAdmission, type AdmissionManifest, type AdmissionTier, type CutAdmission } from "./cut-admission-schema.js";

/** A playable entry candidate at one cut. M3 adds derived scene entries for every present actor. */
export type CutEntryCandidate = { actorId: string; entryBasis: ActorAdmission["entryBasis"]; seed: () => CharacterEntrySeed };
export type CutDescriptor = Pick<CutAdmission, "cutId" | "beforeEventId" | "sceneIds" | "index">;

export type AdmissionOptions = {
  /** Issues retained from inputs or the closure assessment; attributed ones block cuts whose closure contains their node. */
  inputIssues?: readonly ValidationIssue[];
  /** Run the seven deterministic probes per cut x actor (default true). */
  probe?: boolean;
  /** Entry candidates per cut; defaults to each actor's grounded opening or checkpoint entry. */
  entryCandidates?: (bundle: PreparedNovelBundle, cut: CutDescriptor) => CutEntryCandidate[];
};

/** Deterministic cut identity within one frozen timeline. */
export function cutIdFor(beforeEventId: string, timelineHash: string): string {
  return contentHash({ beforeEventId, timelineHash });
}

/** Analyse a bundle under its frozen timeline (a derived one only for legacy candidates). */
export function withFrozenTimeline(bundle: PreparedNovelBundle): PreparedNovelBundle {
  return bundle.canonical.timeline ? bundle : { ...bundle, canonical: { ...bundle.canonical, timeline: bundleCanonTimeline(bundle) } };
}

export type PositionBlocker = { from: number; issue: ValidationIssue };

/**
 * First blocked timeline position for each source of blocking. Position i is
 * the world just before entries[i]; position n is after the last event.
 * A position is replayable when it is at or after the opening and no blocker
 * applies; the horizon is the contiguous replayable run from the opening.
 */
export function horizonFromBlockers(baseline: number, size: number, blockers: readonly PositionBlocker[]): number {
  const first = Math.min(size + 1, ...blockers.map((blocker) => blocker.from));
  return first <= baseline ? baseline - 1 : first - 1;
}

/** Positions from which a blocking source unit (starting before the position's discourse byte) applies. */
export function accountingBlockers(timeline: Pick<CanonTimeline, "entries">, units: ReadonlyArray<{ startByte: number; issue: ValidationIssue }>): PositionBlocker[] {
  if (!units.length) return [];
  const earliest = [...units].sort((a, b) => a.startByte - b.startByte)[0]!;
  const from = timeline.entries.find((entry) => entry.discourseByte > earliest.startByte)?.index ?? timeline.entries.length;
  const { code, message, path } = earliest.issue;
  return [{ from, issue: { code: "CUT_SOURCE_UNACCOUNTED", message: `Source before this cut is not accounted for (${code}: ${message})`, ...(path ? { path } : {}) } }];
}

export async function buildAdmissionManifest(input: PreparedNovelBundle, options: AdmissionOptions = {}): Promise<AdmissionManifest> {
  const bundle = withFrozenTimeline(input);
  const timeline = bundle.canonical.timeline!;
  const index = timelineIndex(timeline);
  const size = timeline.entries.length;
  const baseline = openingTimelineIndex(timeline, bundle.canonical.initialWorld);
  const subjectHash = preparedSubjectHash(bundle);
  const catalog = issueAttributionCatalog(bundle);
  const blockers: PositionBlocker[] = [];

  // 1. One forward replay from the opening through every event.
  const replay: AdmissionManifest["replay"] = { limitIndex: size };
  const last = timeline.entries.at(-1);
  if (last) {
    const event = bundle.canonical.events.find((item) => item.id === last.eventId)!;
    // History before a cut is replayed the way play commits canon: as canonical occurrences.
    try { executeSceneEvent(bundle, event, undefined, { canonOccurrences: true }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CanonReplayError) {
        replay.limitIndex = timelineGroupStart(timeline, error.eventId, index) ?? baseline;
        replay.failedEventId = error.eventId;
      } else replay.limitIndex = -1;
      replay.failure = message;
      blockers.push({ from: replay.limitIndex + 1, issue: { code: "CUT_PREFIX_REPLAY_FAILED", message: replay.failedEventId ? `Canonical event ${replay.failedEventId} fails engine validation on replay: ${message}` : `The opening cannot be replayed: ${message}`, ...(replay.failedEventId ? { path: `event/${replay.failedEventId}` } : {}) } });
    }
  }

  // 2. Source accounting before the cut's discourse position.
  const unitStart = new Map(bundle.compilerSnapshot.structure?.units.map((unit) => [unit.id, unit.anchor.startByte]) ?? []);
  let accounting: ValidationIssue[] = [];
  try { accounting = validateFrozenAccounting(bundle); } catch (error) { accounting = [{ code: "SOURCE_PARTITION_INVALID", message: String(error) }]; }
  const accountingSplit = partitionIssueAttribution(accounting, catalog);
  blockers.push(...accountingBlockers(timeline, accountingSplit.attributed.flatMap((issue) => {
    const start = unitStart.get(issue.node.slice("unit/".length));
    return issue.node.startsWith("unit/") && start !== undefined ? [{ startByte: start, issue }] : [];
  })));

  // 3. Dangling or invalid dependencies inside the cut's closure.
  const graph = buildPreparedClosure(bundle);
  const closure = new ClosureIndex(graph);
  const inputSplit = partitionIssueAttribution([...graph.issues, ...(options.inputIssues ?? [])], catalog);
  const openingNodes = closure.reachable([`initial/${bundle.source.id}`]);
  const prefixNodes: Array<Set<string>> = [];
  let growing = new Set(openingNodes);
  for (let position = 0; position <= size; position++) {
    prefixNodes.push(growing);
    if (position < size) growing = new Set([...growing, ...closure.reachable([`event/${timeline.entries[position]!.eventId}`])]);
  }
  for (const issue of inputSplit.attributed) {
    const from = prefixNodes.findIndex((nodes) => nodes.has(issue.node));
    if (from >= 0) blockers.push({ from, issue: { code: "CUT_DEPENDENCY_INVALID", message: `${issue.code}: ${issue.message}`, path: issue.node } });
  }

  // 4. Constraint cycles block every later cut.
  const blockedFrom = timelineBlockedFromIndex(timeline);
  if (blockedFrom !== undefined) blockers.push({ from: blockedFrom + 1, issue: { code: "TIMELINE_CONSTRAINT_CYCLE", message: `A temporal constraint cycle at timeline index ${blockedFrom} must be reconciled first`, path: `event/${timeline.entries[blockedFrom]!.eventId}` } });

  const horizonIndex = horizonFromBlockers(baseline, size, blockers);
  const support = partitionIssueAttribution(assessSemanticSupport(bundle, bundle.readiness?.quality?.supportReviews).issues, catalog).attributed;
  let certified = false;
  try { assertPreparedReadiness(input); certified = true; } catch { certified = false; }

  // 5. Cuts: scene starts, the opening position and grounded entry checkpoints.
  const descriptors = new Map<string, CutDescriptor>();
  const addCut = (position: number, sceneId?: string) => {
    const entry = timeline.entries[position];
    if (!entry) return;
    const cutId = cutIdFor(entry.eventId, timeline.hash);
    const cut = descriptors.get(cutId) ?? { cutId, beforeEventId: entry.eventId, sceneIds: [], index: position };
    if (sceneId && !cut.sceneIds.includes(sceneId)) cut.sceneIds = [...cut.sceneIds, sceneId].sort();
    descriptors.set(cutId, cut);
  };
  for (const scene of bundle.canonical.sceneOccurrences) {
    const starts = bundle.canonical.events.filter((event) => scene.eventIds.includes(event.id) || event.sceneOccurrenceIds?.includes(scene.id))
      .map((event) => timelineGroupStart(timeline, event.id, index)).filter((value): value is number => value !== undefined);
    if (starts.length) addCut(Math.min(...starts), scene.id);
  }
  addCut(baseline);
  for (const event of bundle.canonical.events) if (event.characterEntryCheckpoints?.length) {
    const start = timelineGroupStart(timeline, event.id, index);
    if (start !== undefined) addCut(start);
  }

  const candidates = options.entryCandidates ?? defaultEntryCandidates(baseline);
  const probing = options.probe !== false ? await ProbeWorld.open(bundle, subjectHash) : undefined;
  const cuts: CutAdmission[] = [];
  try {
    for (const cut of [...descriptors.values()].sort((a, b) => a.index - b.index)) {
      const blocking = blockers.filter((blocker) => cut.index >= blocker.from).map((blocker) => blocker.issue);
      if (cut.index < baseline) blocking.push({ code: "CUT_BEFORE_OPENING", message: "This cut precedes the frozen opening; replay needs a complete historical checkpoint" });
      const sceneNodes = cut.sceneIds.map((id) => `scene/${id}`);
      const nodes = new Set([...prefixNodes[cut.index]!, ...closure.reachable(sceneNodes)]);
      for (const issue of inputSplit.attributed) if (sceneNodes.includes(issue.node)) blocking.push({ code: "CUT_DEPENDENCY_INVALID", message: `${issue.code}: ${issue.message}`, path: issue.node });
      const completed = timeline.entries.slice(0, cut.index).map((entry) => entry.eventId);
      const advisories = timeline.issues.filter((issue) => TIMELINE_ADVISORY_CODES.has(issue.code) && completed.some((id) => issue.path === `event/${id}`));
      const unreviewed = support.filter((issue) => nodes.has(issue.node));
      const actors: ActorAdmission[] = [];
      for (const candidate of candidates(bundle, cut)) {
        const actor: ActorAdmission = { actorId: candidate.actorId, tier: "blocked", entryBasis: candidate.entryBasis, probes: [], issues: [] };
        actors.push(actor);
        if (blocking.length) { actor.issues.push({ code: "CUT_NOT_REPLAYABLE", message: "The cut itself is not replayable" }); continue; }
        let seed: CharacterEntrySeed;
        try { seed = candidate.seed(); actor.entryCutHash = seed.cut.hash; }
        catch (error) { actor.issues.push({ code: "ENTRY_CONTEXT_MISSING", message: error instanceof Error ? error.message : String(error) }); continue; }
        if (!probing) { actor.tier = "replayable"; continue; }
        const result = await probing.probe(seed, candidate.actorId, `cut-${cut.index}-${candidate.actorId}`);
        actor.probes = result.probes;
        actor.issues.push(...result.issues);
        if (result.status !== "ready") { actor.tier = "replayable"; continue; }
        actor.tier = unreviewed.length ? "enterable" : certified ? "certified" : "reviewed";
        if (unreviewed.length) actor.issues.push({ code: "CUT_MECHANISM_SUPPORT_UNREVIEWED", message: `${unreviewed.length} executable field(s) in this cut's closure lack independent mechanism review` });
      }
      const best = actors.reduce<AdmissionTier>((tier, actor) => tierAtLeast(actor.tier, tier) ? actor.tier : tier, "replayable");
      cuts.push(cutAdmissionSchema.parse({
        ...cut, ...(cut.sceneIds[0] ? { sceneId: cut.sceneIds[0] } : {}),
        discourseByte: timeline.entries[cut.index]!.discourseByte,
        tier: blocking.length ? "blocked" : best,
        actors: actors.sort((a, b) => a.actorId.localeCompare(b.actorId)),
        blocking: dedupeIssues(blocking), advisories,
        dependsOn: [...nodes].filter((node) => node.startsWith("event/") || node.startsWith("scene/")).sort(),
        closureHash: contentHash([...nodes].sort().map((node) => [node, closure.revision(node) ?? null])),
      }));
    }
  } finally {
    await probing?.close();
  }

  return admissionManifestSchema.parse({
    version: 1, sourceId: bundle.source.id, subjectHash, timelineHash: timeline.hash, baselineIndex: baseline, horizonIndex,
    replay, cuts, globalIssues: dedupeIssues([...accountingSplit.global, ...inputSplit.global]),
  });
}

/** Each actor's grounded opening or first checkpoint entry, placed at its cut. */
function defaultEntryCandidates(baseline: number): NonNullable<AdmissionOptions["entryCandidates"]> {
  let options: ReturnType<typeof deriveCharacterEntryOptions> | undefined;
  return (bundle, cut) => (options ??= deriveCharacterEntryOptions(bundle)).flatMap((option): CutEntryCandidate[] => {
    const here = option.entry.kind === "opening" ? cut.index === baseline : option.entry.canonicalEventId !== undefined && cut.beforeEventId === option.entry.canonicalEventId;
    return here ? [{ actorId: option.actorId, entryBasis: option.entry.kind === "opening" ? "opening" : "checkpoint", seed: () => deriveCharacterEntrySeed(bundle, option.actorId) }] : [];
  });
}

/** Freshness of a frozen manifest against the bundle it claims to describe. */
export function admissionManifestIssues(bundle: PreparedNovelBundle, manifest: AdmissionManifest | null | undefined): string[] {
  if (!manifest) return ["CUT_ADMISSION_MISSING: this revision has no frozen cut admission manifest"];
  const issues: string[] = [];
  if (manifest.sourceId !== bundle.source.id) issues.push("CUT_ADMISSION_SOURCE_MISMATCH: manifest belongs to another source");
  if (!bundle.canonical.timeline) issues.push("CUT_ADMISSION_TIMELINE_MISSING: the revision has no frozen canonical timeline");
  else if (manifest.timelineHash !== bundle.canonical.timeline.hash) issues.push("CUT_ADMISSION_STALE: the canonical timeline changed after admission");
  if (manifest.subjectHash !== preparedSubjectHash(bundle)) issues.push("CUT_ADMISSION_STALE: prepared inputs changed after admission");
  return issues;
}

/** Every admitted cut x actor at or above the minimum tier, in timeline order. */
export function admittedEntries(bundle: PreparedNovelBundle, minimum: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER): Array<{ cut: CutAdmission; actor: ActorAdmission }> {
  const manifest = bundle.admission;
  if (!manifest || admissionManifestIssues(bundle, manifest).length) return [];
  return manifest.cuts.flatMap((cut) => cut.tier === "blocked" ? [] : cut.actors.filter((actor) => tierAtLeast(actor.tier, minimum)).map((actor) => ({ cut, actor })));
}

/** Fail-closed gate for starting play at one cut as one actor. */
export function assertCutAdmission(bundle: PreparedNovelBundle, cutId: string, actorId: string, minimum: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER): { cut: CutAdmission; actor: ActorAdmission } {
  const freshness = admissionManifestIssues(bundle, bundle.admission);
  if (freshness.length) throw new Error(`CUT_NOT_ADMITTED: ${freshness.join("; ")}`);
  const cut = bundle.admission!.cuts.find((item) => item.cutId === cutId);
  if (!cut) throw new Error(`CUT_NOT_ADMITTED: unknown cut ${cutId}; list cuts and copy cutId before retrying once`);
  if (cut.tier === "blocked") throw new Error(`CUT_NOT_ADMITTED: cut ${cutId} is blocked (${cut.blocking.map((issue) => issue.code).join(", ")})`);
  const actor = cut.actors.find((item) => item.actorId === actorId);
  if (!actor) throw new Error(`CUT_NOT_ADMITTED: ${actorId} has no admitted entry at cut ${cutId}`);
  if (!tierAtLeast(actor.tier, minimum)) throw new Error(`CUT_NOT_ADMITTED: ${actorId} at cut ${cutId} is ${actor.tier}; ${minimum} is required (${actor.issues.map((issue) => issue.code).join(", ") || "no probe evidence"})`);
  return { cut, actor };
}

/** A revision is playable when it is fully certified or admits at least one entry at the minimum tier. */
export function assertPlayableRevision(bundle: PreparedNovelBundle, minimum: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER): "certified" | "admitted" {
  let readinessError: unknown;
  try { assertPreparedReadiness(bundle); return "certified"; } catch (error) { readinessError = error; }
  if (admittedEntries(bundle, minimum).length) return "admitted";
  const freshness = admissionManifestIssues(bundle, bundle.admission);
  throw new Error(`${readinessError instanceof Error ? readinessError.message : String(readinessError)}${freshness.length ? `; ${freshness.join("; ")}` : `; CUT_ADMISSION_EMPTY: no cut admits an entry at ${minimum} or above`}`);
}

function dedupeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...new Map(issues.map((issue) => [`${issue.code}/${issue.path ?? ""}/${issue.message}`, issue])).values()];
}

/** Memoized transitive dependencies over the closure graph. */
class ClosureIndex {
  private readonly edges = new Map<string, string[]>();
  private readonly revisions = new Map<string, string>();
  private readonly memo = new Map<string, Set<string>>();
  constructor(graph: ClosureGraph) {
    for (const node of graph.nodes) {
      const key = `${node.kind}/${node.id}`;
      this.revisions.set(key, node.revisionHash);
      this.edges.set(key, node.dependsOn.map((ref) => `${ref.kind}/${ref.id}`));
    }
  }
  revision(node: string): string | undefined { return this.revisions.get(node); }
  reachable(roots: readonly string[]): Set<string> {
    const result = new Set<string>();
    for (const root of roots) for (const node of this.from(root)) result.add(node);
    return result;
  }
  private from(root: string): Set<string> {
    const cached = this.memo.get(root);
    if (cached) return cached;
    const seen = new Set<string>([root]);
    const pending = [root];
    while (pending.length) for (const next of this.edges.get(pending.pop()!) ?? []) {
      if (seen.has(next)) continue;
      const known = this.memo.get(next);
      if (known) { for (const node of known) seen.add(node); continue; }
      seen.add(next);
      pending.push(next);
    }
    this.memo.set(root, seen);
    return seen;
  }
}

/** A scratch world on the production engine for deterministic entry probes. */
class ProbeWorld {
  private constructor(
    private readonly scratch: string,
    private readonly engine: WorldEngine,
    private readonly runtime: WorldRuntime,
    private readonly context: Awaited<ReturnType<WorldContextStore["capturePrepared"]>>,
    private readonly bundle: PreparedNovelBundle,
    private readonly subjectHash: string,
  ) {}
  static async open(bundle: PreparedNovelBundle, subjectHash: string): Promise<ProbeWorld> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-cut-admission-"));
    try {
      const context = await new WorldContextStore(scratch).capturePrepared(bundle.source.id, subjectHash, bundle.canonical);
      const engine = new WorldEngine(scratch, context);
      return new ProbeWorld(scratch, engine, new WorldRuntime(engine, async () => []), context, bundle, subjectHash);
    } catch (error) {
      await fs.rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  probe(seed: CharacterEntrySeed, actorId: string, branchId: string) {
    return probeEntry({ engine: this.engine, runtime: this.runtime, context: this.context, scratch: this.scratch, bundle: this.bundle,
      subjectSnapshotHash: this.subjectHash, actorId, seed, branchId, name: branchId });
  }
  async close(): Promise<void> {
    await fs.rm(workspaceStateDir(this.scratch), { recursive: true, force: true });
    await fs.rm(this.scratch, { recursive: true, force: true });
  }
}
