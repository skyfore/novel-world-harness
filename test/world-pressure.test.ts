import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { buildFrontier, FrontierStore, selectEligible } from "../src/world/frontier.js";
import { emptyWorldState } from "../src/world/state.js";
import { canonicalEventSchema, possibilitySchema } from "../src/world/model.js";
import { SCHEDULING_POLICY_VERSION } from "../src/world/scheduling-policy.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", text: "Ada will carry the parcel only while the bridge is open. Bo closes the bridge.", field: "route.open" },
  { actor: "neri", text: "The lamp must stay lit for Neri to signal. Venn extinguishes it before the signal.", field: "lamp.lit" },
])("keeps confidence diagnostic and gates broken prerequisites before preference: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-world-pressure-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text);
  const event = canonicalEventSchema.parse({ id: "intended", title: scene.text, participants: [scene.actor], storyTime: { kind: "unknown" }, preconditions: [{ op: "fact-equals", entityId: scene.actor, field: scene.field, value: true }], observedOutcome: { version: 1, operations: [] }, evidence: source.evidence(scene.text), causalParents: [], confidence: 0.1 });
  const state = emptyWorldState("head");
  state.values[scene.actor] = { [scene.field]: true };
  const low = canonicalEventToPossibility(event, "main", "head");
  const high = canonicalEventToPossibility({ ...event, confidence: 1 }, "main", "head");
  expect(possibilitySchema.parse(low).sourceConfidence).toBe(0.1);
  expect(low.pressure).toBe(0);
  expect(high.pressure).toBe(0);
  const evaluate = (candidate: typeof low, affinity = 1) => buildFrontier("main", "head", state, [candidate], { canonAffinity: new Map([[event.id, affinity]]) });
  const before = evaluate(low), changedConfidence = evaluate(high);
  expect(before.evaluated[0]!.status).toBe("eligible");
  expect(before.evaluated[0]!.trace).toMatchObject({ policyVersion: SCHEDULING_POLICY_VERSION, pressureBasis: "unspecified", sourceConfidence: 0.1 });
  expect(changedConfidence.evaluated[0]!.trace.sourceConfidence).toBe(1);
  expect(changedConfidence.evaluated[0]!.trace.tuple).toEqual(before.evaluated[0]!.trace.tuple);
  expect(changedConfidence.evaluated[0]!.factors).toEqual(before.evaluated[0]!.factors);
  // Legacy/external canonical candidates cannot smuggle extraction scores into pressure.
  expect(evaluate({ ...high, pressure: 999 }).evaluated[0]!.factors.pressure).toBe(0);
  state.values[scene.actor]![scene.field] = false;
  for (const affinity of [0, 1]) {
    const broken = evaluate(high, affinity);
    expect(selectEligible(broken)).toEqual([]);
    expect(broken.evaluated[0]!.trace.gates).toContainEqual(expect.objectContaining({ gate: "precondition", outcome: "fail" }));
  }
  delete state.values[scene.actor]![scene.field];
  expect(selectEligible(evaluate(high))).toEqual([]);
  const necessary = { ...high, causalParents: ["cause"], causalLinks: [{ relationId: "required", sourceEventId: "cause", type: "enables" as const, operationality: "necessary" as const }] };
  const brokenCause = buildFrontier("main", "head", state, [necessary], { supersededIds: new Set(["cause"]) });
  expect(brokenCause.evaluated[0]!.status).toBe("invalidated");
  expect(selectEligible(brokenCause)).toEqual([]);
});

it("does not reuse a frontier ranked under the previous policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pressure-cache-")); roots.push(root);
  const head = "a".repeat(64), store = new FrontierStore(root);
  const frontier = buildFrontier("main", head, emptyWorldState(head), []);
  const legacy = { ...frontier }; delete legacy.policyVersion;
  await store.write(legacy);
  expect(await store.read("main", head)).toBeNull();
  await store.write(frontier);
  expect(await store.read("main", head)).toEqual(frontier);
});

it("freezes the policy in new snapshots and rejects old-engine histories without rewriting them", async () => {
  const { WorldContextStore } = await import("../src/world/context.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { WorldEngine } = await import("../src/world/engine.js");
  const { contentHash } = await import("../src/world/canonical.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pressure-version-")); roots.push(root);
  const contexts = new WorldContextStore(root, new CanonicalModelStore(root));
  const context = await contexts.captureCurrent();
  const snapshot = JSON.parse(await fs.readFile(path.join(contexts.root, `${context.canonicalSnapshotHash}.json`), "utf8"));
  expect(snapshot.schedulingPolicyVersion).toBe(SCHEDULING_POLICY_VERSION);
  expect((await contexts.load(context.canonicalSnapshotHash!)).canonicalSnapshotHash).toBe(context.canonicalSnapshotHash);
  const legacy = { ...snapshot }; delete legacy.schedulingPolicyVersion;
  const legacyHash = contentHash(legacy), legacyBytes = JSON.stringify(legacy);
  await fs.writeFile(path.join(contexts.root, `${legacyHash}.json`), legacyBytes);
  expect((await contexts.load(legacyHash)).canonicalSnapshotHash).toBe(legacyHash);
  const previousPolicy = { ...snapshot, schedulingPolicyVersion: "world-pressure-v2" };
  const previousHash = contentHash(previousPolicy);
  await fs.writeFile(path.join(contexts.root, `${previousHash}.json`), JSON.stringify(previousPolicy));
  expect((await contexts.load(previousHash)).canonicalSnapshotHash).toBe(previousHash);
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Current", { version: 1, operations: [] });
  const commit = await engine.objects.getCommit(head);
  const oldHead = await engine.objects.putCommit({ ...commit, engineVersion: "0.6.0" });
  await expect(engine.projector.project(oldHead)).rejects.toThrow("Unsupported engine version 0.6.0");
  expect(await engine.objects.getCommit(head)).toEqual(commit);
  expect(await fs.readFile(path.join(contexts.root, `${legacyHash}.json`), "utf8")).toBe(legacyBytes);
});

it.each([
  { text: "Ada may prepare a letter; Bo may check the gate.", actor: "ada" },
  { text: "Neri may watch the lamp; Venn may tidy the room.", actor: "neri" },
])("does not rank unverified declarations as world pressure: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-declared-pressure-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text);
  const state = emptyWorldState("head");
  const candidate = possibilitySchema.parse({ id: "ordinary", branchId: "main", evaluatedAtCommit: "head", kind: "environmental",
    title: scene.text, participants: [scene.actor], preconditions: [], blockers: [], causalParents: [], pressure: 0,
    relevance: 1, evidence: fixture.evidence(scene.text) });
  const first = buildFrontier("main", "head", state, [candidate]).evaluated[0]!;
  for (const pressure of [0.5, 1, 100]) {
    const changed = buildFrontier("main", "head", state, [{ ...candidate, pressure }]).evaluated[0]!;
    expect(changed.trace.tuple).toEqual(first.trace.tuple);
    expect(changed.trace.pressureBasis).toBe("unspecified");
  }
  const pretendDue = buildFrontier("main", "head", state, [{ ...candidate, kind: "due-process", dueAtElapsedDays: 0, pressure: 100 }]).evaluated[0]!;
  expect(pretendDue.factors.pressure).toBe(0);
  expect(pretendDue.trace.tuple.tier).toBe(4);
  expect(pretendDue.trace.tuple.dueTime).toBeNull();
});
