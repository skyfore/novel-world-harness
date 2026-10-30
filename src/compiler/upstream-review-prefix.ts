import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { UpstreamRepairRecord } from "./upstream-repair-ledger.js";

/** Derived evaluations do not change a frozen source/consumer review intent.
 * Any appended execution or authority record still requires its own handoff. */
export function retainedUpstreamReviewPrefix(records: UpstreamRepairRecord[], retained?: { length: number; head: string }) {
  const prefix = retained ?? { length: records.length, head: records.at(-1)?.hash ?? "" };
  if (!prefix.length || records[prefix.length - 1]?.hash !== prefix.head
    || records.slice(prefix.length).some(r => !["evaluated", "evaluation-invalidated"].includes(r.payload.kind)))
    throw prerequisiteStop("Original upstream review prefix or execution authority changed; inspect the same source/task ledger and retained intent, do not repin, renew a grant or retry unchanged");
  return prefix;
}
