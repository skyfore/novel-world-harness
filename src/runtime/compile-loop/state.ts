import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../../agent/runtime-paths.js";
import { redactTraceSecrets } from "../../trace/redaction.js";
import { digest } from "./workspace.js";

const counter = z.number().int().nonnegative();
export const repairVerdict = z.object({ action: z.enum(["repair", "stop"]), reason: z.string().min(1),
  whyRetryDiffers: z.string(), evidence: z.array(z.string()) }).strict();
export const reviewVerdict = z.object({ architecturePreserved: z.boolean(), checksPreserved: z.boolean(),
  addressesFailure: z.boolean(), reason: z.string().min(1) }).strict();
export const loopStateSchema = z.object({
  version: z.literal(1), root: z.string(), sourceId: z.string(), sourceHash: z.string(), policyHash: z.string(),
  phase: z.enum(["READY", "WORKER", "REPAIR", "VERIFY", "BREAK", "DONE"]),
  workers: counter, repairs: counter, commands: counter, failures: z.record(z.string(), counter),
  childPid: z.number().int().nullable(), reason: z.string(), updatedAt: z.string(),
  engineerSession: z.object({ id: z.string().uuid(), createdAt: z.number() }).nullable(),
  pending: z.object({ key: z.string(), reason: z.string(), baselineFile: z.string(),
    baseline: z.record(z.string(), z.string()), evidenceFile: z.string() }).nullable(),
  legacy: z.object({ file: z.string(), hash: z.string(), resolution: z.string() }).nullable(),
  verifiedPatches: z.array(z.string()),
  // Once a successful worker returns, only delivery verification may continue.
  // A null hash is used solely when adopting a pre-existing DONE record.
  delivery: z.object({ worker: counter.positive(), resultHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().nullable().default(null),
  resolutions: z.array(z.object({ previousStateHash: z.string(), reason: z.string(), at: z.string() })).default([]),
  previousGeneration: z.object({ directory: z.string(), stateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type CompileLoopState = z.infer<typeof loopStateSchema>;
export function compileLoopDirectory(root: string, sourceId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) throw new Error("Invalid source ID; copy sources[].sourceId from compile-novel status once; never guess.");
  return path.join(workspaceStateDir(root), "compile-loops", sourceId);
}
export function activeCompileLoopDirectory(root: string, sourceId: string) {
  const base = compileLoopDirectory(root, sourceId), pointer = path.join(base, "current-generation.json");
  if (!existsSync(pointer)) return base;
  const current = z.object({ version: z.literal(1), generation: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(read(pointer));
  const directory = path.join(base, "generations", current.generation);
  if (!existsSync(path.join(directory, "state.json"))) throw new Error("COMPILE_LOOP_GENERATION_MISSING: inspect the retained current-generation pointer and state; do not reset it or launch another worker.");
  return directory;
}
export function save(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(redactTraceSecrets(value), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}
export function read<T = unknown>(file: string): T { return JSON.parse(readFileSync(file, "utf8")) as T; }
/** Status never creates directories, changes ownership or resumes a stopped child. */
export function inspectCompileLoop(root: string, sourceId: string) {
  const directory = activeCompileLoopDirectory(root, sourceId), file = path.join(directory, "state.json");
  if (!existsSync(file)) return null;
  const state = loopStateSchema.parse(read(file));
  return { directory, phase: state.phase, reason: state.reason, updatedAt: state.updatedAt,
    stateHash: digest(read(file)),
    workers: state.workers, repairs: state.repairs, commands: state.commands, childPid: state.childPid,
    incident: state.pending?.evidenceFile ?? null };
}
