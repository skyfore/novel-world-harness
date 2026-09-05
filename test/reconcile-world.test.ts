import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler, type CompilerAuditReport } from "../src/compiler/audit.js";
import {
  buildWorldReconciliationPrompt,
  graphAdjudicationIterationFromBatchId,
  narrativeGraphRepairIsTargetable,
  narrativeGraphRepairIterations,
  reparseReconciliationIterations,
  semanticRepairIsIsolated,
  semanticRepairRequiresReparse,
  validateGraphAdjudicationProposalScope,
} from "../src/compiler/reconcile-world.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

type ReconciliationContext = {
  repairPlan: {
    targetCount: number;
    maxIterations: number;
    mode: string;
    requireAutonomousDriver: boolean;
    proposalIdSuffix: string;
  };
  weakEventCandidates: Array<{ id: string; weaknesses: string[] }>;
  weakCharacterCandidates: Array<{ actor: { id: string }; needsExecutableDriver: boolean }>;
  eventRelationIndex: Array<{ ref: string; id: string }>;
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
    expect(first.repairPlan).toMatchObject({ targetCount: 17, maxIterations: 10 });
    expect(second.repairPlan).toMatchObject({ targetCount: 16, maxIterations: 10 });
    expect(first.repairPlan).not.toHaveProperty("estimatedToolCalls");
    expect(first.repairPlan).not.toHaveProperty("toolCallLimit");
    expect(first.repairPlan).not.toHaveProperty("reservedCalls");
    expect(firstPrompt).toContain("Call read_compiler_artifact directly with that ref");
    expect(firstPrompt).toContain("do not spend a find_compiler_artifacts call rediscovering a listed ref");
    expect(firstPrompt).toContain("never omit or withdraw a valid repair merely to save calls");
    expect(firstPrompt).toContain("executable under source-grounded activation/precondition gates at the initial-world checkpoint");
    expect(firstPrompt).toContain("a later-phase goal does not satisfy this repair");
    expect(firstPrompt).toContain("lacks a checkpoint, a comparable storyTime");
    expect(firstPrompt).not.toContain("preserve the reserved tool calls");
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

    expect(narrativeGraphRepairIsTargetable(audit)).toBe(true);
    expect(narrativeGraphRepairIterations(audit)).toBe(2);
    const graphFirstPrompt = await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      1,
      { mode: "graph-adjudication" },
    );
    const graphSecondPrompt = await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      2,
      { mode: "graph-adjudication" },
    );
    const graphFirst = reconciliationContext(graphFirstPrompt);
    const graphSecond = reconciliationContext(graphSecondPrompt);
    expect(graphFirst.repairPlan).toMatchObject({ mode: "graph-adjudication", targetCount: 16 });
    expect(graphFirst.repairPlan.proposalIdSuffix).toMatch(/^reconcile-[a-f0-9]{12}$/u);
    expect(graphFirstPrompt).toContain(`must end with -${graphFirst.repairPlan.proposalIdSuffix}`);
    expect(graphFirst.weakEventCandidates).toHaveLength(16);
    expect(graphSecond.weakEventCandidates).toHaveLength(16);
    expect(graphFirst.weakEventCandidates[0]?.weaknesses).toEqual(["unconditional-disconnected-root"]);
    expect(graphFirstPrompt).toContain("Temporal order, chapter adjacency, shared participants");
    expect(graphFirstPrompt).toContain("Typed event-relation records are the runtime authority for causality");
    expect(graphFirstPrompt).toContain("causalParents is a non-authoritative compatibility field");
    expect(graphFirstPrompt).toContain("A canonical-event proposal is a full replacement, not a patch");
    expect(graphFirstPrompt).toContain("do not submit a canonical-event replacement that leaves its preconditions unchanged");
    expect(graphFirst.weakEventCandidates.some(({ id }) =>
      graphSecond.weakEventCandidates.some((candidate) => candidate.id === id))).toBe(false);
  });

  it("rejects graph-shard no-ops, outgoing-only links, and duplicate typed relations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-reconcile-graph-scope-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "One event causes another while a later event waits.\n");
    const canon = new CanonicalModelStore(root);
    const evidence = fixture.evidence("One event causes another while a later event waits.");
    const events = [];
    for (let index = 1; index <= 10; index += 1) {
      const event = {
        id: `root-${index}`,
        title: `Root ${index}`,
        participants: [],
        storyTime: { kind: "ordinal" as const, label: `root-${index}`, orderHint: index },
        preconditions: [],
        observedOutcome: { version: 1 as const, operations: [] },
        evidence,
        causalParents: [],
        confidence: 1,
      };
      events.push(event);
      await canon.putEvent(event);
    }
    await canon.putEvent({
      id: "conditional-event",
      title: "Conditional event",
      participants: [],
      storyTime: { kind: "ordinal", label: "conditional", orderHint: 11 },
      preconditions: [{ op: "after-step", step: 1 }],
      observedOutcome: { version: 1, operations: [] },
      evidence,
      causalParents: [],
      confidence: 1,
    });
    await canon.putEventRelation({
      id: "existing-contributory-link",
      fromEventId: "root-1",
      toEventId: "root-2",
      type: "causes",
      operationality: "contributory",
      status: "explicit",
      confidence: 1,
      mechanism: "The first event contributes to the second.",
      evidence,
    });

    const audit = await auditCompiler(root, { sourceId: fixture.source.id });
    const prompt = await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      1,
      { mode: "graph-adjudication" },
    );
    const context = reconciliationContext(prompt);
    expect(context.eventRelationIndex).toContainEqual(expect.objectContaining({
      id: "existing-contributory-link",
      ref: "canonical:event-relation:existing-contributory-link",
    }));
    expect(graphAdjudicationIterationFromBatchId(
      `reconcile-${fixture.source.id}-graph-adjudication-v3-1`,
      fixture.source.id,
    )).toBe(1);

    const proposals = new CompilerProposalService(root);
    await proposals.submit("canonical-event", {
      proposalId: "no-op-root-replacement",
      payload: events[0],
      generatedBy: { worker: "test" },
    });
    await proposals.submit("event-relation", {
      proposalId: "outgoing-only-link",
      payload: {
        id: "outgoing-only-link",
        fromEventId: "root-1",
        toEventId: "conditional-event",
        type: "causes",
        operationality: "necessary",
        status: "explicit",
        confidence: 1,
        mechanism: "The root causes a later conditional event.",
        evidence,
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("event-relation", {
      proposalId: "duplicate-link",
      payload: {
        id: "duplicate-link",
        fromEventId: "root-1",
        toEventId: "root-2",
        type: "causes",
        operationality: "necessary",
        status: "explicit",
        confidence: 1,
        mechanism: "The first event is required for the second.",
        evidence,
      },
      generatedBy: { worker: "test" },
    });

    const issues = await validateGraphAdjudicationProposalScope(
      root,
      fixture.source.id,
      1,
      ["no-op-root-replacement", "outgoing-only-link", "duplicate-link"],
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("changes neither preconditions nor sceneOccurrenceIds"),
      expect.stringContaining("outgoing relation from a listed root does not condition that root"),
      expect.stringContaining("already exists as existing-contributory-link"),
    ]));
  });

  it("includes an event with a broken scene backlink in graph adjudication even when it is not a root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-reconcile-scene-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters, and then Hero leaves.\n");
    const canon = new CanonicalModelStore(root);
    for (const [id, quote] of [["entry", "Hero enters"], ["departure", "Hero leaves"]] as const) {
      await canon.putEvent({
        id,
        title: id,
        participants: [],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: fixture.evidence(quote),
        causalParents: id === "departure" ? ["entry"] : [],
        confidence: 1,
      });
    }
    const audit = await auditCompiler(root, { sourceId: fixture.source.id });
    const report: CompilerAuditReport = {
      ...audit,
      consistency: {
        ...audit.consistency,
        causalGraphValid: true,
        narrativeGraphNavigable: false,
        unconditionalRootEvents: ["entry"],
      },
      eventSemantics: {
        ...audit.eventSemantics,
        executableSemanticErrors: [{
          code: "SCENE_EVENT_BACKLINK_REQUIRED",
          message: "Event departure must link back to scene closing-scene",
          path: "scenes.0.eventIds.0",
        }],
      },
    };

    const prompt = await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      report,
      1,
      { mode: "graph-adjudication" },
    );
    const context = reconciliationContext(prompt);
    expect(context.weakEventCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "entry", weaknesses: ["unconditional-disconnected-root"] }),
      expect.objectContaining({
        id: "departure",
        weaknesses: ["executable-graph-error:SCENE_EVENT_BACKLINK_REQUIRED"],
      }),
    ]));
    expect(narrativeGraphRepairIterations(report)).toBe(1);
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
