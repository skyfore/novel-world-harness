import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { createAdmittedWorkspace } from "./helpers/admitted-workspace.js";
import { PlayApplicationService } from "../src/application/play-service.js";
import { createWorldBranch } from "../src/world/instance.js";
import { BranchStore } from "../src/world/store.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("lists admitted cuts and starts fresh play at a later admitted cut while old requests keep their first entry", async () => {
  {
    const { root, cacheRoot, source: { id: sourceId }, admitted } = await createAdmittedWorkspace("nwh-scene-play-"); roots.push(root);
    const fixture = { source: { id: sourceId } };
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
  }
});
