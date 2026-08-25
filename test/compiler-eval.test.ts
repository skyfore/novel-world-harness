import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilerGoldSchema, evaluateCompilerAgainstGold } from "../src/eval/compiler-eval.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("compiler gold evaluation", () => {
  it("computes precision/recall from explicit expected identities and causal edges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-eval-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "extra", kind: "character", canonicalName: "Extra", aliases: [], evidence: [] });
    await canon.putEvent({
      id: "event-a",
      title: "A",
      participants: ["hero"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "event-b",
      title: "B",
      participants: ["hero"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: ["event-a"],
      confidence: 1,
    });

    const report = await evaluateCompilerAgainstGold(root, {
      version: 1,
      name: "tiny-gold",
      expectedEntityIds: ["hero", "missing"],
      expectedEventIds: ["event-a", "event-b"],
      expectedCausalEdges: [{ from: "event-a", to: "event-b" }],
    });
    expect(report.entities.precision).toBe(0.5);
    expect(report.entities.recall).toBe(0.5);
    expect(report.entities.missing).toEqual(["missing"]);
    expect(report.entities.unexpected).toEqual(["extra"]);
    expect(report.events.f1).toBe(1);
    expect(report.causalEdges.f1).toBe(1);
    expect(report.goldVersion).toBe(1);
    expect(report.semanticLayers.mentions.status).toBe("not-annotated");
    expect(report.unavailableDimensions).toEqual([]);
  });

  it("accepts a layered semantic gold denominator without treating unimplemented layers as zero recall", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-eval-layered-"));
    roots.push(root);
    const report = await evaluateCompilerAgainstGold(root, {
      version: 2,
      name: "layered-gold",
      canonical: { expectedEntityIds: ["hero"], expectedEventIds: ["arrival"] },
      semantic: {
        mentions: [
          { id: "mention-hero", kind: "entity", span: { sourceId: "source-a", startByte: 0, endByte: 4 } },
          { id: "mention-arrival", kind: "event", span: { sourceId: "source-a", startByte: 5, endByte: 12 } },
        ],
        entityClusters: [{ id: "entity-hero", mentionIds: ["mention-hero"], canonicalEntityId: "hero" }],
        eventClusters: [{ id: "event-arrival", mentionIds: ["mention-arrival"], canonicalEventId: "arrival" }],
        eventParticipants: [{
          id: "participant-arrival-hero",
          eventClusterId: "event-arrival",
          entityClusterId: "entity-hero",
          role: "agent",
        }],
      },
    });

    expect(report.goldVersion).toBe(2);
    expect(report.entities.recall).toBe(0);
    expect(report.semanticLayers.mentions).toMatchObject({
      status: "not-implemented",
      expected: 2,
      actual: null,
      recall: null,
    });
    expect(report.semanticLayers.entityResolution.status).toBe("not-implemented");
    expect(report.semanticLayers.eventRelations.status).toBe("not-annotated");
    expect(report.unavailableDimensions).toEqual(expect.arrayContaining([
      "mentions",
      "entityResolution",
      "eventResolution",
      "eventParticipants",
    ]));
  });

  it("rejects layered gold with dangling semantic references", () => {
    expect(() => compilerGoldSchema.parse({
      version: 2,
      name: "invalid-layered-gold",
      semantic: {
        entityClusters: [{ id: "hero", mentionIds: ["missing-mention"] }],
      },
    })).toThrow(/Unknown mention 'missing-mention'/);
  });
});
