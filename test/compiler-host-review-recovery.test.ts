import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { createPiCompilerSession } = vi.hoisted(() => ({ createPiCompilerSession: vi.fn() }));
vi.mock("../src/compiler/pi-compiler.js", () => ({ createPiCompilerSession }));
import { compileSourceCommand } from "../src/commands/compile-source.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
beforeEach(() => createPiCompilerSession.mockReset());
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it.each(["persisted", "timeout", "report", "correctable"])("gates session creation using %s state", async (mode) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-host-review-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "A traveler waits at a gate.\n");
  const batch = (await prepareCompilerBatches(root, source))[0]!;
  const journal = new CompilerProposalObligations(root, source.id, batch.id);
  const fail = (page: number) => journal.record("account_source_units", { proposal_id: "old-page", page }, "failed", "page changed");
  if (mode === "persisted") { fail(1); fail(2); }
  let calls = 0;
  const dispose = vi.fn();
  createPiCompilerSession.mockImplementation(async () => ({ abort: vi.fn(), dispose,
    promptWithReport: async () => {
      calls++;
      if (mode === "timeout") { journal.record("account_source_units", { proposal_id: "old-page" }, "running"); throw new Error("request timed out"); }
      if (mode === "correctable" && calls === 2) {
        journal.record("account_source_units", { proposal_id: "old-page", page: 2 }, "succeeded");
        return { assistantStopReason: "stop", proposalSucceeded: 1, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" };
      }
      if (mode === "correctable") fail(1);
      return { assistantStopReason: "stop", proposalSucceeded: 19, proposalFailed: 1, completionSignaled: false,
        ...(mode === "report" ? { hostReviewReason: "account_source_units: Do not retry until host review." } : {}) };
    },
  }));
  const run = compileSourceCommand({ root, sourceId: source.id, configPath: path.join(root, "missing.yaml"),
    allowMissingConfig: true, maxBatches: 1, onProgress() {}, onModelText() {} });
  if (mode === "correctable") await expect(run).resolves.toBeUndefined();
  else await expect(run).rejects.toThrow("host review");
  expect(createPiCompilerSession).toHaveBeenCalledTimes(mode === "persisted" ? 0 : mode === "correctable" ? 2 : 1);
  expect(dispose).toHaveBeenCalledTimes(calls);
  const progress = await new CompilerBatchStore(root).read(source.id);
  expect(progress.completedBatchIds).toEqual(mode === "correctable" ? [batch.id] : []);
});
