import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runUpstreamRepairSlotCommand } from "../src/commands/upstream-repair.js";
import { WorkspaceOperationLock } from "../src/util/workspace-lock.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it("holds the compiler lock throughout model execution and releases it after host failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-repair-command-")); roots.push(root);
  const run = vi.fn(async () => {
    expect((await WorkspaceOperationLock.inspect(root)).owner?.pid).toBe(process.pid);
    await expect(WorkspaceOperationLock.acquire(root, "compiler")).rejects.toThrow("already active");
    throw new Error("original provider failure");
  });
  const options = { source: "source", plan: "a".repeat(64), kind: "quotation", artifact: "quote-one", model: "selected-model", timeoutMs: 1234 };
  await expect(runUpstreamRepairSlotCommand(root, options, run)).rejects.toThrow("original provider failure");
  expect(run).toHaveBeenCalledWith(root, options.source, options.plan, { kind: "quotation", id: "quote-one" }, { model: "selected-model", timeoutMs: 1234 });
  expect((await WorkspaceOperationLock.inspect(root)).owner).toBeUndefined();
  await expect(runUpstreamRepairSlotCommand(root, { ...options, kind: "entity" }, run)).rejects.toThrow();
  await expect(runUpstreamRepairSlotCommand(root, { ...options, config: path.join(root, "missing-config.json") }, run)).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
});
