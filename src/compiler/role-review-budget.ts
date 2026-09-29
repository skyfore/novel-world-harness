import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { ModelRequestBudget, type ModelRequestLimits } from "../runtime/model-request-budget.js";
const counter = z.number().int().nonnegative();
const stateSchema = z.object({ usage: z.object({ modelCalls: counter, payloads: counter, totalPayloadBytes: counter, largestRequestBytes: counter }).strict(), blocked: z.boolean() }).strict();
/** Charged before transport. A crash may overcount one request, never grant free
 * retries. The compiler's parent lock serializes all writers to this work. */
export function roleReviewBudget(root: string, planHash: string, workId: string, limits: ModelRequestLimits, requireExisting = false) {
  const directory = path.join(worldStorageRoot(root), "compiler", "role-review-work", "budgets", planHash);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, `${contentHash(workId)}.json`), temporary = `${file}.pending`;
  if (fs.existsSync(temporary)) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: uncertain budget publication. Stop; inspect the retained pending charge, never reset usage or retry in a fresh session.");
  let initial: z.infer<typeof stateSchema> | undefined;
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (stored.planHash !== planHash || stored.workId !== workId || contentHash(stored.limits) !== contentHash(limits)) throw new Error("Role work budget scope changed; stop for host review");
    initial = stateSchema.parse(stored.state);
    if (stored.hash !== contentHash({planHash, workId, limits, state: initial})) throw new Error("Role work budget integrity mismatch; stop for host review");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!initial && requireExisting) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: prior work has no retained usage record. Stop; recover its original usage from trace before any retry, never assume zero usage.");
  const save = (state: z.infer<typeof stateSchema>) => {
    const record = {planHash, workId, limits, state};
    fs.writeFileSync(temporary, JSON.stringify({...record, hash: contentHash(record)}), {flag: "wx", mode: 0o600});
    fs.renameSync(temporary, file);
  };
  if (!initial) {
    initial = {usage:{modelCalls:0,payloads:0,totalPayloadBytes:0,largestRequestBytes:0},blocked:false};
    save(initial);
  }
  return new ModelRequestBudget(limits, {initial, save});
}
