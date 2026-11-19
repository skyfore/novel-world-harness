import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPiActorReasoner } from "../agent/pi-actor-reasoner.js";
import { createPiCanonicalAttachmentResolver } from "../agent/pi-canonical-attachment.js";
import { createPiNpcReactionReasoner } from "../agent/pi-npc-reaction.js";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import { createPiPlayerWorldAdjudicator } from "../agent/pi-player-world-adjudicator.js";
import { createPiPlayerWorldResponseResolver } from "../agent/pi-player-world-response.js";
import { admittedEntries } from "../compiler/cut-admission.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { loadOptionalConfig, minimumAdmissionTierFor, profileForRole } from "../config/load.js";
import { ActProbeStore, defaultActProbeScript, fakeActProbeReasoners, runActProbe, summarizeActProbes, type ActProbeReasoners, type ActProbeReport } from "../eval/act-probe.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { createWorldBranch } from "../world/instance.js";
import { resolveNovelSource } from "../world/play-experience.js";

export type NovelProbeOptions = {
  root: string; sourceId?: string; cutId?: string; live?: boolean; turns?: number;
  configPath?: string; model?: string; cacheRoot?: string; signal?: AbortSignal;
};

/**
 * Run the act probe on every admitted cut x actor of the active revision (or
 * one cut). Each entry plays in an isolated scratch workspace bound to the
 * same immutable source and prepared cache, so the user's play catalog and
 * branches are untouched; the report is saved beside evaluation records.
 */
export async function runNovelProbe(options: NovelProbeOptions) {
  const root = path.resolve(options.root);
  const workspace = await WorkspaceStore.openReadOnly(root);
  const sources = await workspace.listSources();
  const source = options.sourceId ? await resolveNovelSource(workspace, options.sourceId) : sources.length === 1 ? sources[0]! : undefined;
  if (!source) throw new Error(`Select one novel with --source. Registered sources: ${sources.map((item) => item.id).join(", ") || "none"}.`);
  const minimumTier = await minimumAdmissionTierFor(root, options.configPath);
  const active = await new PreparedNovelCache(root, options.cacheRoot).loadFreshActive(source, { minimumAdmissionTier: minimumTier });
  if (!active) throw new Error(`ACT_PROBE_NO_ACTIVE_REVISION: activate an admitted revision first (nwh compile-novel admit --source ${source.id} --activate).`);
  const entries = admittedEntries(active.bundle, minimumTier).filter(({ cut }) => !options.cutId || cut.cutId === options.cutId);
  const config = await loadOptionalConfig(options.configPath ?? path.join(root, "novel-harness.yaml"));
  const pi = { root, ...(options.model ? { model: options.model } : {}), ...(config ? { profile: profileForRole(config, "player").profile } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const live: ActProbeReasoners | undefined = options.live ? {
    translator: createPiPlayerActionTranslator(pi), adjudicator: createPiPlayerWorldAdjudicator(pi), npcResponseReasoner: createPiNpcReactionReasoner(pi),
    actorReasoner: createPiActorReasoner(pi), worldResponseResolver: createPiPlayerWorldResponseResolver(pi), canonicalAttachmentResolver: createPiCanonicalAttachmentResolver(pi),
  } : undefined;
  const reports: ActProbeReport[] = [];
  const failures: Array<{ cutId: string; actorId: string; error: string }> = [];
  for (const [index, { cut, actor }] of entries.entries()) {
    options.signal?.throwIfAborted();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-act-probe-"));
    try {
      const bytes = await new SourceMaterialStore().read(source);
      if (!bytes) throw new Error("ACT_PROBE_SOURCE_MISSING: the immutable source bytes are unavailable");
      const registered = await (await WorkspaceStore.create(scratch)).registerSourceContent(source.title, bytes);
      if (registered.id !== source.id) throw new Error(`ACT_PROBE_SOURCE_MISMATCH: scratch registration produced ${registered.id}, not ${source.id}`);
      const branchId = `act-probe-${index + 1}`;
      await createWorldBranch(scratch, branchId, undefined, source.id, options.cacheRoot, actor.actorId, active.bundleHash, actor.entryCutHash, { entryCutId: cut.cutId, minimumAdmissionTier: minimumTier });
      reports.push(await runActProbe({ root: scratch, branchId, actorId: actor.actorId, cutId: cut.cutId, sourceId: source.id, mode: live ? "live" : "fake",
        script: defaultActProbeScript(options.turns ?? 1), reasoners: live ? () => live : fakeActProbeReasoners }));
    } catch (error) {
      failures.push({ cutId: cut.cutId, actorId: actor.actorId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  const manifest = active.bundle.admission!;
  const summary = {
    sourceId: source.id, bundleHash: active.bundleHash, mode: live ? "live" : "fake", minimumTier, admittedEntries: entries.length,
    horizonIndex: manifest.horizonIndex, cutTiers: manifest.cuts.reduce<Record<string, number>>((counts, cut) => ({ ...counts, [cut.tier]: (counts[cut.tier] ?? 0) + 1 }), {}),
    ...summarizeActProbes(reports), failures,
  };
  const reportPath = await new ActProbeStore(root).write(source.id, reports, summary);
  return { summary, reportPath, reports };
}

export async function novelProbeCommand(options: NovelProbeOptions): Promise<void> {
  const { summary, reportPath } = await runNovelProbe(options);
  console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
}
