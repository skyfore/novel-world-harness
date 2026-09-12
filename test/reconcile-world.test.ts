import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler, type CompilerAuditReport } from "../src/compiler/audit.js";
import {
  buildWorldReconciliationPrompt,
  hasWorldReconciliationTargets,
  graphAdjudicationIterationFromBatchId,
  narrativeGraphNearNavigable,
  narrativeGraphRepairIsTargetable,
  narrativeGraphRepairIterations,
  reparseReconciliationIterations,
  semanticEventRegressionIssues,
  semanticInitialWorldRegressionIssues,
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
  stateFieldCatalog: typeof DEFAULT_STATE_FIELDS;
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
  it("rejects semantic event replacements that erase established readiness", () => {
    const current = {
      id: "arrival",
      title: "Arrival",
      participants: ["hero"],
      storyTime: { kind: "ordinal", orderHint: 2 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }] },
      readerSummary: "Hero arrives.",
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      characterEntryCheckpoints: [{
        actorId: "hero",
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }] },
      }],
      evidence: [],
      causalParents: [],
      confidence: 1,
    } as Parameters<typeof semanticEventRegressionIssues>[0];
    const candidate = {
      ...current,
      storyTime: { kind: "unknown" },
      observedOutcome: { version: 1, operations: [] },
      readerSummary: undefined,
      participantPresence: [],
      characterEntryCheckpoints: [],
    } as Parameters<typeof semanticEventRegressionIssues>[1];

    expect(semanticEventRegressionIssues(current, candidate)).toEqual(expect.arrayContaining([
      "removes an existing comparable story-time anchor",
      "removes all existing typed state/knowledge effects",
      "removes the existing reader summary",
      "removes all existing participant-presence records",
      "removes the complete entry checkpoint for hero",
    ]));
  });

  it("requires an initial-world repair to establish a deterministically comparable time", () => {
    const current = {
      version: 1,
      checkpoint: { mode: "chronological", storyTime: { kind: "exact", value: "春天下午" } },
      delta: { version: 1, operations: [] },
      evidence: [],
    } as Parameters<typeof semanticInitialWorldRegressionIssues>[0];
    const stillIncomparable = structuredClone(current);
    const ordinal = {
      ...current,
      checkpoint: { ...current.checkpoint, storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } },
    } as Parameters<typeof semanticInitialWorldRegressionIssues>[1];

    expect(semanticInitialWorldRegressionIssues(current, stillIncomparable)).toContain(
      "does not establish the required comparable opening story-time anchor",
    );
    expect(semanticInitialWorldRegressionIssues(current, ordinal)).toEqual([]);
  });

  it("routes a temporal causal regression to semantic event repair above the timeline threshold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-reconcile-temporal-regression-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The train arrives before the examination begins.\n");
    const canon = new CanonicalModelStore(root);
    const evidence = fixture.evidence("The train arrives before the examination begins.");
    for (const event of [
      { id: "train", title: "Train arrives", orderHint: 5 },
      { id: "exam", title: "Examination begins", orderHint: 1 },
    ]) {
      await canon.putEvent({
        id: event.id,
        title: event.title,
        participants: [],
        storyTime: { kind: "ordinal", label: event.title, orderHint: event.orderHint },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence,
        causalParents: [],
        confidence: 1,
      });
    }
    await canon.putEventRelation({
      id: "train-enables-exam",
      fromEventId: "train",
      toEventId: "exam",
      type: "enables",
      operationality: "necessary",
      status: "explicit",
      confidence: 1,
      mechanism: "Arrival enables the examination to begin.",
      evidence,
    });

    const audit = await auditCompiler(root, { sourceId: fixture.source.id });
    expect(audit.coverage.timelineAnchoring).toBe(1);
    expect(audit.consistency.temporalRegressions).toEqual([{ eventId: "exam", parentId: "train" }]);
    expect(audit.semanticRepairTargets.eventIds).toContain("exam");
    expect(audit.consistency.semanticReady).toBeNull();
    expect(semanticRepairIsIsolated(audit)).toBe(true);
    expect(semanticRepairIsIsolated({
      ...audit,
      consistency: { ...audit.consistency, semanticReady: true },
    })).toBe(true);
    const context = reconciliationContext(await buildWorldReconciliationPrompt(
      root,
      fixture.source.id,
      audit,
      1,
    ));
    expect(context.weakEventCandidates).toContainEqual(expect.objectContaining({
      id: "exam",
      weaknesses: expect.arrayContaining(["story-time-precedes-causal-parent"]),
    }));
    expect(context.weakEventCandidates).toHaveLength(1);
    expect(context.weakCharacterCandidates).toEqual([]);
    expect(context.repairPlan).toMatchObject({ targetCount: 1, requireAutonomousDriver: false });
    expect(context).not.toHaveProperty("initialWorld");

    for (const invalidConsistency of [
      { causalCycles: [["train", "exam", "train"]] },
      { missingCausalParents: [{ eventId: "exam", parentId: "missing" }] },
    ]) {
      const blocked = { ...audit, consistency: { ...audit.consistency, ...invalidConsistency } };
      expect(semanticRepairIsIsolated(blocked)).toBe(false);
      expect(semanticRepairRequiresReparse(blocked)).toBe(false);
    }

    const largeTemporalRepair = {
      ...audit,
      consistency: { ...audit.consistency, semanticReady: true },
      semanticRepairTargets: {
        ...audit.semanticRepairTargets,
        eventIds: ["exam", ...Array.from({ length: 160 }, (_, index) => `child-${index}`)],
      },
    };
    expect(semanticRepairIsIsolated(largeTemporalRepair)).toBe(false);
    expect(semanticRepairRequiresReparse(largeTemporalRepair)).toBe(true);
    expect(reparseReconciliationIterations(largeTemporalRepair)).toBe(11);
  });

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
    expect(first.stateFieldCatalog).toEqual(DEFAULT_STATE_FIELDS);
    expect(first.stateFieldCatalog.find(field => field.key === "artifact.condition")).toMatchObject({ valueType: "number", minimum: 0, maximum: 1 });
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
    // A resumed first shard must not rebind its existing finish receipt to new targets.
    await canon.putEvent({ ...(await canon.getEvent("event-01")), id: "event-00" });
    const resumed = reconciliationContext(await buildWorldReconciliationPrompt(root, fixture.source.id, audit, 1));
    expect(resumed.repairPlan.proposalIdSuffix).toBe(first.repairPlan.proposalIdSuffix);
    expect(resumed.weakEventCandidates.map(({ id }) => id)).toEqual(firstIds);
    const fresh = reconciliationContext(await buildWorldReconciliationPrompt(root, fixture.source.id, audit, 1, { proposalIdSuffixTail: "reviewed-new-round" }));
    expect(fresh.weakEventCandidates.map(({ id }) => id)).toContain("event-00");
    expect(fresh.repairPlan.proposalIdSuffix).not.toBe(first.repairPlan.proposalIdSuffix);
    const originalSecond = reconciliationContext(await buildWorldReconciliationPrompt(root, fixture.source.id, audit, 2));
    expect(originalSecond.weakEventCandidates.map(({ id }) => id)).toEqual(secondIds);
    expect(await hasWorldReconciliationTargets(root, fixture.source.id, "bounded", 3)).toBe(false);
    expect(await hasWorldReconciliationTargets(root, fixture.source.id, "bounded", 3, "reviewed-new-round")).toBe(true);
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
    await proposals.submit("canonical-event", {
      proposalId: "outside-field-change",
      payload: {
        ...events[0],
        title: "Changed title",
        preconditions: [{ op: "after-step", step: 1 }],
      },
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
      ["no-op-root-replacement", "outside-field-change", "outgoing-only-link", "duplicate-link"],
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("changes neither preconditions nor sceneOccurrenceIds"),
      expect.stringContaining("outside preconditions/sceneOccurrenceIds: title"),
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

    const nearGraph = {
      ...systemic,
      canonical: { ...systemic.canonical, events: 47 },
      consistency: {
        ...systemic.consistency,
        narrativeGraphNavigable: false,
        unconditionalRootEvents: Array.from({ length: 20 }, (_value, index) => `root-${index + 1}`),
      },
    };
    expect(narrativeGraphNearNavigable(nearGraph)).toBe(true);
    expect(semanticRepairRequiresReparse(nearGraph)).toBe(true);
    const boundedGraphFallback = {
      ...nearGraph,
      consistency: {
        ...nearGraph.consistency,
        unconditionalRootEvents: [...nearGraph.consistency.unconditionalRootEvents, "root-21"],
      },
    };
    expect(narrativeGraphNearNavigable(boundedGraphFallback)).toBe(false);
    expect(semanticRepairRequiresReparse(boundedGraphFallback)).toBe(true);
  });
});
