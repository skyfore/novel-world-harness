import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../../world/canonical.js";
import { prerequisiteStop } from "../../compiler/role-source-prerequisites.js";
import type { IdentityContextRecovery } from "../../compiler/identity-context-recovery.js";
import { captureRecordTree, fileHash } from "./dedicated-session.js";
import { digest } from "./workspace.js";
import { read } from "./state.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const usageSchema = z.object({ commands: z.number().int().nonnegative().safe(), engineeringTurns: z.number().int().nonnegative().safe() }).strict();
const stoppedSchema = usageSchema.extend({ phase: z.literal("BREAK"), childPid: z.null(), workerDispatches: z.literal(0) }).strip();
const lineageSchema = z.object({
  version: z.literal(1), scope: z.object({ sourceId: z.string(), taskId: hash, originalSpecHash: hash }).strict(),
  predecessorHash: hash, mode: z.enum(["local", "cumulative"]), inherited: usageSchema, local: usageSchema,
}).strict();
export type IdentityEngineeringUsage = z.infer<typeof usageSchema>;
export type IdentityEngineeringLineage = z.infer<typeof lineageSchema>;
const scope = (proof: IdentityContextRecovery) => ({ sourceId: proof.sourceId, taskId: proof.taskId, originalSpecHash: proof.originalSpecHash });
const add = (a: IdentityEngineeringUsage, b: IdentityEngineeringUsage) => usageSchema.parse({ commands: a.commands + b.commands, engineeringTurns: a.engineeringTurns + b.engineeringTurns });
const same = (a: unknown, b: unknown) => contentHash(a) === contentHash(b);
const stoppedUsage = (raw: unknown) => { const { commands, engineeringTurns } = stoppedSchema.parse(raw); return { commands, engineeringTurns }; };

/** The request's local/cumulative label is only a consistency assertion. Charge
 * immutable, scoped deltas whose predecessor binds the entire retained prefix.
 * Unknown legacy counters cannot be relabelled or guessed into a new allowance. */
export function identityEngineeringHistory(proof: IdentityContextRecovery, engineering: string) {
  try { return readHistory(proof, engineering); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("ROLE_PREREQUISITE_HOST_REVIEW")) throw error;
    throw prerequisiteStop(`Engineering accounting evidence cannot be verified: ${String(error)}. Preserve the original receipts and inspect their producer; no guessed counters, dispatch or retry`);
  }
}

function readHistory(proof: IdentityContextRecovery, engineering: string) {
  if (proof.version !== 2) throw prerequisiteStop("Legacy proof has no engineering accounting lineage; preserve the original and every later receipt, no dispatch or retry");
  const original = read(path.join(engineering, "state.json"));
  if (fs.realpathSync(engineering) !== engineering || digest(original) !== proof.engineeringStateHash
    || fileHash(path.join(engineering, "state.json")) !== proof.retainedEngineeringFiles["state.json"])
    throw prerequisiteStop("Original engineering accounting changed; preserve its exact state, no repinning or retry");
  let usage = stoppedUsage(original);
  let head = contentHash({ protocol: "identity-engineering-history/v1", scope: scope(proof), directory: engineering,
    stateHash: proof.retainedEngineeringFiles["state.json"], filesHash: contentHash(proof.retainedEngineeringFiles), usage });
  const seen = new Set([engineering]);
  for (const receipt of proof.engineeringHistory) {
    if (!path.isAbsolute(receipt.directory) || fs.realpathSync(receipt.directory) !== receipt.directory || seen.has(receipt.directory)
      || engineering.startsWith(receipt.directory + path.sep) || receipt.directory.startsWith(path.join(engineering, "host-recovery") + path.sep)
      || receipt.directory === path.join(engineering, "host-recovery") || path.isAbsolute(receipt.stateFile)
      || path.normalize(receipt.stateFile) !== receipt.stateFile || receipt.stateFile.split(path.sep).includes("..") || !receipt.files[receipt.stateFile]
      || !same(captureRecordTree(receipt.directory), receipt.files))
      throw prerequisiteStop("Engineering receipt changed, overlaps its owner or was counted twice; preserve all original attempts, no retry");
    seen.add(receipt.directory);
    const raw = read<Record<string, unknown>>(path.join(receipt.directory, receipt.stateFile));
    const next = stoppedUsage(raw), parsed = lineageSchema.safeParse(raw.budgetLineage);
    if (!parsed.success) throw prerequisiteStop("Engineering accounting lineage is missing or unknown; inspect the original producer and receipts, never edit old evidence, guess counts or relabel local/cumulative; no dispatch");
    const lineage = parsed.data;
    if (!same(lineage.scope, scope(proof)) || lineage.predecessorHash !== head || !same(lineage.inherited, usage)
      || lineage.mode !== receipt.accounting || !same(next, lineage.mode === "local" ? lineage.local : add(usage, lineage.local)))
      throw prerequisiteStop("Engineering accounting lineage, scope or cumulative total disagrees with its retained prefix; no omitted attempts, counter reset or retry");
    usage = add(usage, lineage.local);
    head = contentHash({ predecessorHash: head, receipt, usage });
  }
  return { usage, head };
}

export function inheritedIdentityEngineering(proof: IdentityContextRecovery, engineering: string) {
  return identityEngineeringHistory(proof, engineering).usage;
}

/** Written by the owning host at each charge, never reconstructed by an importer. */
export function identityEngineeringLineage(proof: IdentityContextRecovery, predecessorHash: string, inherited: IdentityEngineeringUsage,
  total: IdentityEngineeringUsage): IdentityEngineeringLineage {
  return lineageSchema.parse({ version: 1, scope: scope(proof), predecessorHash, mode: "cumulative", inherited,
    local: { commands: total.commands - inherited.commands, engineeringTurns: total.engineeringTurns - inherited.engineeringTurns } });
}
