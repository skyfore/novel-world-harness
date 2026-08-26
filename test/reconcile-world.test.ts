import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler, type CompilerAuditReport } from "../src/compiler/audit.js";
import {
  buildWorldReconciliationPrompt,
  reparseReconciliationIterations,
  semanticRepairIsIsolated,
  semanticRepairRequiresReparse,
} from "../src/compiler/reconcile-world.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

type ReconciliationContext = {
  repairPlan: {
    targetCount: number;
    estimatedToolCalls: number;
    toolCallLimit: number;
    reservedCalls: number;
    maxIterations: number;
    mode: string;
    requireAutonomousDriver: boolean;
  };
  weakEventCandidates: Array<{ id: string; weaknesses: string[] }>;
  weakCharacterCandidates: Array<{ actor: { id: string }; needsExecutableDriver: boolean }>;
};

function reconciliationContext(prompt: string): ReconciliationContext {
  const match = prompt.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u);
  if (!match) throw new Error("Missing reconciliation context");
  return JSON.parse(match[1]!) as ReconciliationContext;
}

describe("world semantic reconciliation", () => {
  it("persists two disjoint bounded target shards and budgets direct exact reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-reconcile-plan-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero crosses the hall.\n");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    for (let index = 1; index <= 32; index += 1) {
      await canon.putEvent({
        id: `event-${String(index).padStart(2, "0")}`,
        title: `Event ${index}`,
        participants: ["hero"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: fixture.evidence("Hero crosses the hall."),
        causalParents: [],
        confidence: 1,
      });
    }
    const audit = await auditCompiler(root, { sourceId: fixture.source.id });

    const firstPrompt = await buildWorldReconciliationPrompt(root, fixture.source.id, audit, 1);
    const secondPrompt = await buildWorldReconciliationPrompt(root, fixture.source.id, audit, 2);
    const first = reconciliationContext(firstPrompt);
    const second = reconciliationContext(secondPrompt);
    const firstIds = first.weakEventCandidates.map(({ id }) => id);
    const secondIds = second.weakEventCandidates.map(({ id }) => id);

    expect(firstIds).toHaveLength(16);
    expect(secondIds).toHaveLength(16);
    expect(firstIds).not.toEqual(secondIds);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    expect(first.weakEventCandidates[0]?.weaknesses).toEqual(expect.arrayContaining([
      "missing-reader-summary",
      "missing-participant-presence:hero",
      "story-time-unknown",
      "no-typed-effect",
    ]));
    expect(first.repairPlan).toMatchObject({ toolCallLimit: 200, maxIterations: 10 });
    expect(first.repairPlan.estimatedToolCalls).toBeLessThanOrEqual(85);
    expect(first.repairPlan.reservedCalls).toBeGreaterThanOrEqual(115);
    expect(second.repairPlan.estimatedToolCalls).toBeLessThanOrEqual(85);
    expect(firstPrompt).toContain("Call read_compiler_artifact directly with that ref");
    expect(firstPrompt).toContain("do not spend a find_compiler_artifacts call rediscovering a listed ref");
    expect(firstPrompt).not.toContain("for every omitted or referenced exact payload");

    const reparseFirst = reconciliationContext(await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      1,
      { mode: "reparse-finalization" },
    ));
    const reparseSecond = reconciliationContext(await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      2,
      { mode: "reparse-finalization" },
    ));
    expect(reparseReconciliationIterations({
      ...audit,
      semanticRepairTargets: {
        eventIds: Array.from({ length: 34 }, (_value, index) => `event-${String(index + 1).padStart(2, "0")}`),
        characterIds: ["hero"],
        ruleIds: [],
        initialWorld: false,
        requiresFullReparse: true,
      },
    })).toBe(3);
    expect(reparseFirst.repairPlan).toMatchObject({ mode: "reparse-finalization", requireAutonomousDriver: true });
    expect(reparseFirst.weakEventCandidates).toHaveLength(16);
    expect(reparseSecond.weakEventCandidates).toHaveLength(16);
    expect(reparseFirst.weakCharacterCandidates).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ id: "hero" }), needsExecutableDriver: true }),
    ]);
    expect(reparseSecond.weakCharacterCandidates).toEqual([]);
    expect(reparseFirst.weakEventCandidates.some(({ id }) =>
      reparseSecond.weakEventCandidates.some((candidate) => candidate.id === id))).toBe(false);
  });

  it("routes catalog-wide semantic migration to reparse but permits a bounded repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-reconcile-routing-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n");
    const base = await auditCompiler(root, { sourceId: fixture.source.id });
    const readyCoverage = {
      ...base.coverage,
      timelineAnchoring: 1,
      eventEffectExplicitness: 1,
      characterDevelopmentCoverage: 1,
      openingCheckpointDeclared: 1,
      participantPresenceCoverage: 1,
      readerSummaryCoverage: 1,
      characterEntryCheckpointCoverage: 1,
      openingReaderSetup: 1,
      openingPhysicalPresence: 1,
      openingActionability: 1,
    };
    const report = (events: number, readerSummaryCoverage: number): CompilerAuditReport => ({
      ...base,
      canonical: { ...base.canonical, events },
      consistency: { ...base.consistency, semanticReady: false, causalGraphValid: true, narrativeGraphNavigable: true },
      evidence: { ...base.evidence, invalidReferences: 0 },
      coverage: { ...readyCoverage, readerSummaryCoverage },
      semanticRepairTargets: {
        eventIds: Array.from(
          { length: Math.round(events * (1 - readerSummaryCoverage)) },
          (_value, index) => `missing-summary-${index + 1}`,
        ),
        characterIds: [],
        ruleIds: [],
        initialWorld: false,
        requiresFullReparse: false,
      },
    });

    const systemic = report(161, 0);
    expect(semanticRepairIsIsolated(systemic)).toBe(false);
    expect(semanticRepairRequiresReparse(systemic)).toBe(true);

    const bounded = report(160, 0);
    expect(semanticRepairIsIsolated(bounded)).toBe(true);
    expect(semanticRepairRequiresReparse(bounded)).toBe(false);

    const ruleMigration = {
      ...bounded,
      semanticRepairTargets: {
        ...bounded.semanticRepairTargets,
        ruleIds: ["legacy-rule"],
      },
    };
    expect(semanticRepairIsIsolated(ruleMigration)).toBe(false);
    expect(semanticRepairRequiresReparse(ruleMigration)).toBe(true);
  });
});
