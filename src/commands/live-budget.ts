import { stdout } from "node:process";
import {
  LIVE_TOKEN_BUDGET_HARD_LIMIT,
  LiveTokenLedger,
  type LiveTokenBudgetStatus,
} from "../agent/live-token-ledger.js";

export async function liveBudgetStatusCommand(options: {
  ledgerPath: string;
  tokenBudget?: number;
  campaignId?: string;
}): Promise<LiveTokenBudgetStatus> {
  const ledger = await LiveTokenLedger.open({
    filePath: options.ledgerPath,
    campaignId: options.campaignId ?? "nwh-white-box",
    limit: options.tokenBudget ?? LIVE_TOKEN_BUDGET_HARD_LIMIT,
  });
  const status = await ledger.status();
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return status;
}

export async function liveBudgetLockCommand(filePath: string): Promise<void> {
  const owner = await LiveTokenLedger.inspectLock(filePath);
  stdout.write(owner ? `${JSON.stringify(owner, null, 2)}\n` : "No live-token ledger lock exists.\n");
}

export async function liveBudgetRepairLockCommand(filePath: string, expectedOwnerId: string): Promise<void> {
  const repaired = await LiveTokenLedger.repairStaleLock({ filePath, expectedOwnerId });
  stdout.write(repaired ? "Removed the verified stale live-token ledger lock.\n" : "No lock existed.\n");
}
