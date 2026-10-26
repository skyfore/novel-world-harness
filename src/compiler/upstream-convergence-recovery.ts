import { AsyncLocalStorage } from "node:async_hooks";

/** Internal read-verification scope only. Staging/authorization do not consult
 * it, so it can never renew a model attempt or permit a changed proposal. The
 * ledger owner creates it only after finding the original completed receipt. */
const recovery = new AsyncLocalStorage<{ root: string; planHash: string; stopRef: string }>();
export const isCompletedUpstreamRecovery = (root: string, planHash: string) => {
  const active = recovery.getStore(); return active?.root === root && active.planHash === planHash;
};
export const withCompletedUpstreamRecovery = <T>(root: string, planHash: string, stopRef: string, work: () => Promise<T>) =>
  recovery.run({ root, planHash, stopRef }, work);
