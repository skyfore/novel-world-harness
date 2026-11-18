import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import * as certification from "../../src/compiler/certification.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../../src/compiler/batches.js";
import { PreparedNovelCache } from "../../src/compiler/prepared-cache.js";
import { ActorModelStore } from "../../src/world/actors.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import { InitialWorldStore } from "../../src/world/initial.js";
import type { CanonicalEvent } from "../../src/world/model.js";
import { createEvidenceFixture } from "./evidence.js";
import { selfActionFixture } from "./entry-action.js";

/**
 * A real workspace and prepared cache with an admitted, activated revision:
 * an opening (Hero, Courier), two replayable events and a later checkpoint
 * entry for Later. Accounting locality has dedicated cut-admission tests, so
 * admission here replaces only the accounting validation.
 */
export async function createAdmittedWorkspace(prefix = "nwh-admitted-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
  const accounting = vi.spyOn(certification, "validateFrozenAccounting").mockReturnValue([]);
  try {
    const admitted = await cache.admitCandidate(fixture.source);
    await cache.activate(fixture.source, admitted.bundleHash!);
    return { root, cacheRoot, cache, source: fixture.source, admitted };
  } finally { accounting.mockRestore(); }
}
