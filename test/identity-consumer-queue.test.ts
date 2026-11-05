import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it, expect, vi } from "vitest";
import { identityFixture } from "./helpers/identity-fixture.js";
import { contentHash as h } from "../src/world/canonical.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { runIdentityConsumerQueue, inspectConsumerQueue } from "../src/workflow/identity-consumer-queue.js";

it("keeps blocked consumers and the undispatched tail through resume, continues independent work, and never trusts scheduling receipts as semantic clearance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-queue-")), f = identityFixture();
  const refs = f.intent.consumerShards.flatMap(s => s.refs), results = new Map<string, string>();
  vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.records);
  const inspect = vi.fn(async (_root: string, _source: string, { ref }: any) => ({ sourceId: "src", taskId: f.intent.taskId,
    intentHash: h(f.intent), inventoryHash: f.intent.inventoryHash, selected: { ref, reason: "typed-consumer" },
    summary: { consumerRevalidation: { attempts: [], reviews: [...results].map(([ref, status]) => ({ ref, status })) } } }));
  const review = vi.fn(async (args: any) => {
    if (args.inspectExecution) return { status: "ready" };
    const status = args.ref === refs[0] ? "blocked" : "revalidated";
    results.set(args.ref, status); return { status };
  });
  const deps: any = { inspect, review }, args = { root, sourceId: "src", taskId: f.intent.taskId, authorizationRef: "user:restart the original loop" };
  try {
    const first = await runIdentityConsumerQueue({ ...args, limit: 1 }, deps);
    expect(first.state.status).toBe("yielded");
    expect(first.progress).toMatchObject({ originalTotalConsumers: 2, blocked: 1, waiting: 1, certificationGranted: false });
    const saved = await inspectConsumerQueue(root, "src", f.intent.taskId);
    expect(saved.plan?.refs).toEqual(refs);
    const resumed = await runIdentityConsumerQueue(args, deps);
    expect(resumed.state.status).toBe("reviewed");
    expect(resumed.progress).toMatchObject({ recorded: 1, blocked: 1, waiting: 0 });
    expect(review.mock.calls.filter(([args]) => !args.inspectExecution)).toHaveLength(2);
    const before = await fs.readFile(path.join(first.directory, "plan.json"), "utf8");
    await expect(runIdentityConsumerQueue({ ...args, authorizationRef: "silently replaced" }, deps)).rejects.toThrow(/Frozen queue/);
    expect(await fs.readFile(path.join(first.directory, "plan.json"), "utf8")).toBe(before);
    // A previous scheduling success never replaces fresh ledger discovery.
    results.delete(refs[1]!);
    review.mockImplementation(async () => ({ status: "orphaned" }));
    await expect(runIdentityConsumerQueue(args, deps)).rejects.toThrow(/orphaned/);
    const stopped = await inspectConsumerQueue(root, "src", f.intent.taskId);
    expect(stopped.state?.status).toBe("stopped");
    expect(stopped.progress).toMatchObject({ recorded: 0, blocked: 1, waiting: 1 });
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});
