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
  // The roster is a typed historical consumer alongside two live consumers.
  f.intent.consumerShards.splice(1, 0, { index: 1, refs: ["roster/src"] });
  f.intent.consumerShards[2]!.index = 2;
  const refs = f.intent.consumerShards.flatMap(s => s.refs);
  const payloads = new Map([["canonical-event:consumer", { id: "consumer" }], ["staged-role:role-old", { id: "role-old" }]]);
  const live = { payloads, activeRevisions: new Map([...payloads].map(([k, v]) => [k, h(v)])) };
  let receipt = h("first receipt");
  const binding = (ref: string) => ({ ref, receiptFingerprint: receipt, upstreamPlanHash: h(receipt),
    currentRevisionHash: h(payloads.get(ref === refs[0] ? "canonical-event:consumer" : "staged-role:role-old")) });
  const results = new Map<string, ReturnType<typeof binding> & { status: string }>();
  const attempts: Array<ReturnType<typeof binding> & { directory: string }> = [];
  vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.records);
  const inspect = vi.fn(async (_root: string, _source: string, { ref }: { ref: string }) => ({ sourceId: "src", taskId: f.intent.taskId,
    intentHash: h(f.intent), inventoryHash: f.intent.inventoryHash, selected: { ref, reason: "typed-consumer" },
    summary: { consumerRevalidation: { attempts, reviews: [...results.values()] } } }));
  const review = vi.fn(async (args: any) => {
    if (args.inspectExecution) {
      const saved = results.get(args.ref);
      if (saved?.receiptFingerprint === receipt && saved.currentRevisionHash !== binding(args.ref).currentRevisionHash)
        throw Error("Frozen consumer revalidation dependencies changed");
      return { status: "ready" };
    }
    const status = args.ref === refs[0] ? "blocked" : "revalidated";
    results.set(args.ref, { ...binding(args.ref), status }); return { status };
  });
  const deps: any = { inspect, review, currentRepair: async () => ({ receipt: { fingerprint: receipt }, upstream: { plan: { planHash: h(receipt) } }, current: live }) }, args = { root, sourceId: "src", taskId: f.intent.taskId, authorizationRef: "user:restart the original loop" };
  try {
    const first = await runIdentityConsumerQueue({ ...args, limit: 1 }, deps);
    expect(first.state.status).toBe("yielded");
    expect(first.progress).toMatchObject({ originalTotalConsumers: 3, blocked: 2, waiting: 1, certificationGranted: false });
    const saved = await inspectConsumerQueue(root, "src", f.intent.taskId);
    expect(saved.plan?.refs).toEqual(refs);
    const resumed = await runIdentityConsumerQueue(args, deps);
    expect(resumed.state.status).toBe("reviewed");
    expect(resumed.progress).toMatchObject({ recorded: 1, blocked: 2, waiting: 0 });
    expect(review.mock.calls.filter(([args]) => !args.inspectExecution)).toHaveLength(2);
    const before = await fs.readFile(path.join(first.directory, "plan.json"), "utf8");
    await expect(runIdentityConsumerQueue({ ...args, authorizationRef: "silently replaced" }, deps)).rejects.toThrow(/Frozen queue/);
    expect(await fs.readFile(path.join(first.directory, "plan.json"), "utf8")).toBe(before);
    attempts.push({ ...binding(refs[0]!), directory: path.join(root, "superseded-attempt") });
    receipt = h("successor receipt");
    await runIdentityConsumerQueue(args, deps);
    expect(review.mock.calls.filter(([args]) => !args.inspectExecution)).toHaveLength(4);
    payloads.set("canonical-event:consumer", { id: "changed" });
    live.activeRevisions.set("canonical-event:consumer", h({ id: "changed" }));
    await expect(runIdentityConsumerQueue(args, deps)).rejects.toThrow("Frozen consumer revalidation dependencies changed");
    expect(review.mock.calls.filter(([args]) => !args.inspectExecution)).toHaveLength(4);
    payloads.set("canonical-event:consumer", { id: "consumer" });
    live.activeRevisions.set("canonical-event:consumer", h({ id: "consumer" }));
    expect(review.mock.calls.some(([args]) => args.ref === "roster/src")).toBe(false);
    // A previous scheduling success never replaces fresh ledger discovery.
    results.delete(refs[2]!);
    review.mockImplementation(async () => ({ status: "orphaned" }));
    await expect(runIdentityConsumerQueue(args, deps)).rejects.toThrow(/orphaned/);
    const stopped = await inspectConsumerQueue(root, "src", f.intent.taskId);
    expect(stopped.state?.status).toBe("stopped");
    expect(stopped.progress).toMatchObject({ recorded: 0, blocked: 2, waiting: 1 });
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});
