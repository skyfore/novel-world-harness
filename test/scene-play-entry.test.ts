import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as certification from "../src/compiler/certification.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { PlayApplicationService } from "../src/application/play-service.js";
import { ActorModelStore } from "../src/world/actors.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { createWorldBranch } from "../src/world/instance.js";
import type { CanonicalEvent } from "../src/world/model.js";
import { BranchStore } from "../src/world/store.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { selfActionFixture } from "./helpers/entry-action.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("lists admitted cuts and starts fresh play at a later admitted cut while old requests keep their first entry", async () => {
  // Accounting locality has dedicated cut-admission tests; this regression isolates the play interfaces.
  const accounting = vi.spyOn(certification, "validateFrozenAccounting").mockReturnValue([]);
  try {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-scene-play-")); roots.push(root);
    const text = "Hero and Courier wait in the hall.\nCourier brings a letter.\nHero reads it.\nLater arrives in the hall.\n";
    const fixture = await createEvidenceFixture(root, text);
    const canon = new CanonicalModelStore(root);
    for (const [id, kind, name] of [["hero", "character", "Hero"], ["courier", "character", "Courier"], ["later", "character", "Later"], ["hall", "location", "hall"]] as const) {
      await canon.putEntity({ id, kind, canonicalName: name, aliases: [], evidence: fixture.evidence(name) });
    }
    await canon.putActionSchema(selfActionFixture());
    await new ActorModelStore(root).putGoal({ id: "courier-goal", actorId: "courier", description: "Deliver the letter", priority: 1, requiresKnowledge: [], evidence: fixture.evidence("Hero and Courier wait in the hall."),
      candidateAction: { title: "Courier chooses the next delivery", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" }] } } });
    const event = (id: string, quote: string, actor: string, extra: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
      id, title: quote, readerSummary: quote, participants: [actor], participantPresence: [{ entityId: actor, mode: "physical" }], storyTime: { kind: "unknown" },
      narrativeContext: { layerId: "main", discourseOrder: 0, mode: "scene" }, preconditions: [], observedOutcome: { version: 1, operations: [] },
      evidence: fixture.evidence(quote), causalParents: [], confidence: 1, ...extra,
    });
    await canon.putEvent(event("letter", "Courier brings a letter.", "courier"));
    await canon.putEvent(event("reading", "Hero reads it.", "hero"));
    await canon.putEvent(event("later-arrives", "Later arrives in the hall.", "later", {
      characterEntryCheckpoints: [{ actorId: "later", readerSetup: "Later is about to arrive in the hall.", actorObservation: "The hall door is ahead.", participantPresence: [{ entityId: "later", mode: "physical" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "later", field: "character.location", value: "hall" }, { op: "set", entityId: "later", field: "character.plan", value: "Carry a letter" }] } }],
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
    await cache.activate(fixture.source, admitted.bundleHash!);

    const play = new PlayApplicationService({ root, events: new WebEventBroker(), operations: new OperationManager(new WebEventBroker()), preparedCacheRoot: cacheRoot });
    const listing = await play.listSourceCuts(fixture.source.id);
    expect(listing.preparedRevisionHash).toBe(admitted.bundleHash);
    const late = listing.cuts.find((cut) => cut.beforeEventId === "later-arrives")!;
    const lateEntry = late.actors.find((actor) => actor.actorId === "later")!;
    expect(lateEntry).toMatchObject({ entryBasis: "checkpoint", admitted: true, canonicalName: "Later" });
    expect(late.beforeEventTitle).toBe("Later arrives in the hall.");

    await expect(play.startFreshPlay({ sourceId: fixture.source.id, preparedRevisionHash: admitted.bundleHash!, actorId: "hero", entryCutHash: lateEntry.entryCutHash!, cutId: late.cutId, clientRequestId: "hero-not-at-late" }))
      .rejects.toMatchObject({ statusCode: 400, detail: { code: "CUT_NOT_ADMITTED" } });
    await expect(play.startFreshPlay({ sourceId: fixture.source.id, preparedRevisionHash: admitted.bundleHash!, actorId: "later", entryCutHash: "0".repeat(64), cutId: late.cutId, clientRequestId: "stale-late" }))
      .rejects.toMatchObject({ statusCode: 409, detail: { code: "ENTRY_CUT_STALE" } });
    const started = await play.startFreshPlay({ sourceId: fixture.source.id, preparedRevisionHash: admitted.bundleHash!, actorId: "later", entryCutHash: lateEntry.entryCutHash!, cutId: late.cutId, clientRequestId: "late-start" });
    const branch = await new BranchStore(root).read(started.instance.branchId);
    expect(branch).toMatchObject({ entryActorId: "later", entryCutId: late.cutId, preparedRevisionHash: admitted.bundleHash });

    // Requests without a cut keep starting at the role's first grounded entry.
    const roles = await play.listSourceRoles(fixture.source.id);
    const hero = roles.roles.find((role) => role.actorId === "hero")!;
    const opening = await play.startFreshPlay({ sourceId: fixture.source.id, preparedRevisionHash: admitted.bundleHash!, actorId: "hero", entryCutHash: hero.entryCutHash!, clientRequestId: "hero-opening" });
    expect((await new BranchStore(root).read(opening.instance.branchId)).entryCutId).toBeUndefined();
    await expect(createWorldBranch(root, "direct", undefined, fixture.source.id, cacheRoot, "later", undefined, undefined, { entryCutId: "f".repeat(64) })).rejects.toThrow("CUT_NOT_ADMITTED");
    await expect(createWorldBranch(root, "anonymous", undefined, fixture.source.id, cacheRoot, undefined, undefined, undefined, { entryCutId: late.cutId })).rejects.toThrow("ENTRY_CUT_REQUIRES_ACTOR");
  } finally { accounting.mockRestore(); }
});
