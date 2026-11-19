import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as certification from "../src/compiler/certification.js";
import { ActorModelStore } from "../src/world/actors.js";
import type { CanonicalEvent } from "../src/world/model.js";
import { selfActionFixture } from "./helpers/entry-action.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { createWorldBranch } from "../src/world/instance.js";
import { BranchStore } from "../src/world/store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("keeps an unreviewed candidate unpublished and rejects an uncertified archive at activate, restore and fresh creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-certification-gate-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits in the hall.\n");
  await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: fixture.evidence("Hero waits in the hall.") });
  const batches = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
  const cacheRoot = path.join(root, "prepared-cache"), cache = new PreparedNovelCache(root, cacheRoot);
  const inspected = await cache.inspectCandidate(fixture.source);
  expect(inspected.assessment.fullNovelReady).toBe(false);
  expect(inspected.assessment.issues.map((issue) => issue.code)).toContain("NOVEL_EVALUATION_NOT_RUN");
  await expect(cache.publish(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  expect(await cache.listRevisions(fixture.source)).toEqual([]);
  const archive = await cache.publish(fixture.source, { allowSemanticDebtForRollback: true });
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  const canonical = new CanonicalModelStore(root);
  const original = (await canonical.listEntities())[0]!;
  await canonical.putEntity({ ...original, aliases: ["Staging repair"] });
  await cache.restoreCompilerCheckpoint(fixture.source, archive.bundleHash!);
  expect((await canonical.listEntities())[0]!.aliases).toEqual([]);
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  await expect(cache.activate(fixture.source, archive.bundleHash!)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  // A replaced on-disk pointer is not a certificate and cannot bypass any public read gate.
  const activeFile = path.join(path.dirname(path.dirname(archive.cachePath)), "active.json");
  const pointer = JSON.stringify({ version: 1, contentMd5: archive.contentMd5, bundleHash: archive.bundleHash, updatedAt: new Date().toISOString() });
  await fs.writeFile(activeFile, pointer);
  await expect(cache.restore(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  await expect(createWorldBranch(root, "play", undefined, fixture.source.id, cacheRoot, "hero")).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  expect(await new BranchStore(root).listIds()).toEqual([]);
  expect(await fs.readFile(activeFile, "utf8")).toBe(pointer);
});

it("activates a partially admitted revision and starts play only at an admitted cut", async () => {
  // Accounting locality has dedicated cut-admission tests; this regression isolates the
  // publication, activation and Genesis gates on a real workspace and prepared cache.
  const accounting = vi.spyOn(certification, "validateFrozenAccounting").mockReturnValue([]);
  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-partial-admission-")); roots.push(root);
    const text = "Hero and Courier wait in the hall.\nCourier brings a letter.\nHero runs to the street.\nLater arrives in the street.\n";
    const fixture = await createEvidenceFixture(root, text);
    const canon = new CanonicalModelStore(root);
    for (const [id, kind, name] of [["hero", "character", "Hero"], ["courier", "character", "Courier"], ["later", "character", "Later"], ["hall", "location", "hall"], ["street", "location", "street"]] as const) {
      await canon.putEntity({ id, kind, canonicalName: name, aliases: [], evidence: fixture.evidence(name) });
    }
    await canon.putActionSchema(selfActionFixture());
    await new ActorModelStore(root).putGoal({ id: "courier-goal", actorId: "courier", description: "Deliver the letter", priority: 1, requiresKnowledge: [], evidence: fixture.evidence("Hero and Courier wait in the hall."),
      candidateAction: { title: "Courier chooses the next delivery", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" }] } } });
    const event = (id: string, title: string, quote: string, actor: string, operations: CanonicalEvent["observedOutcome"]["operations"], extra: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
      id, title, readerSummary: title, participants: [actor], participantPresence: [{ entityId: actor, mode: "physical" }], storyTime: { kind: "unknown" },
      narrativeContext: { layerId: "main", discourseOrder: 0, mode: "scene" }, preconditions: [], observedOutcome: { version: 1, operations },
      evidence: fixture.evidence(quote), causalParents: [], confidence: 1, ...extra,
    });
    await canon.putEvent(event("letter", "Courier brings a letter", "Courier brings a letter.", "courier", []));
    // A move without a travel mode cannot be replayed: every later cut is blocked.
    await canon.putEvent(event("flight", "Hero runs to the street", "Hero runs to the street.", "hero", [{ op: "set", entityId: "hero", field: "character.location", value: "street" }]));
    await canon.putEvent(event("later-arrives", "Later arrives", "Later arrives in the street.", "later", [], {
      characterEntryCheckpoints: [{ actorId: "later", readerSetup: "Later is about to arrive in the street.", actorObservation: "The street lies ahead.", participantPresence: [{ entityId: "later", mode: "physical" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "later", field: "character.alive", value: true }, { op: "set", entityId: "later", field: "character.location", value: "street" }, { op: "set", entityId: "later", field: "character.plan", value: "Carry a letter" }] } }],
    }));
    await new InitialWorldStore(root).put({ version: 1, evidence: fixture.evidence("Hero and Courier wait in the hall."),
      participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "courier", mode: "physical" }],
      delta: { version: 1, operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "Carry a letter" },
        { op: "set", entityId: "courier", field: "character.alive", value: true }, { op: "set", entityId: "courier", field: "character.location", value: "hall" }] },
      projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 } });
    const batches = await prepareCompilerBatches(root, fixture.source);
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const cacheRoot = path.join(root, "prepared-cache"), cache = new PreparedNovelCache(root, cacheRoot);

    const admitted = await cache.admitCandidate(fixture.source);
    expect(admitted.admission.horizonIndex).toBe(1);
    const opening = admitted.admission.cuts.find((cut) => cut.beforeEventId === "letter")!;
    expect(opening.actors.find((actor) => actor.actorId === "hero")?.tier).toMatch(/enterable|reviewed/);
    const blocked = admitted.admission.cuts.find((cut) => cut.beforeEventId === "later-arrives")!;
    expect(blocked).toMatchObject({ tier: "blocked", blocking: [expect.objectContaining({ code: "CUT_PREFIX_REPLAY_FAILED", path: "event/flight" })] });
    expect((await cache.lookup(fixture.source)).status).toBe("miss");
    await cache.activate(fixture.source, admitted.bundleHash!);
    await expect(cache.activate(fixture.source, admitted.bundleHash!, { minimumAdmissionTier: "certified" })).rejects.toThrow("CUT_ADMISSION_EMPTY");
    expect((await cache.loadFreshActive(fixture.source))?.bundleHash).toBe(admitted.bundleHash);
    await expect(createWorldBranch(root, "late", undefined, fixture.source.id, cacheRoot, "later")).rejects.toThrow("MAJOR_ROLE_NOT_CERTIFIED");
    const created = await createWorldBranch(root, "play", undefined, fixture.source.id, cacheRoot, "hero");
    expect(created.preparedRevisionHash).toBe(admitted.bundleHash);
    expect(await new BranchStore(root).listIds()).toEqual(["play"]);
  } finally { accounting.mockRestore(); }
});
