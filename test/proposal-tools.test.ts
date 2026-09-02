import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalTools, createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { EvidenceVerifier } from "../src/compiler/evidence.js";
import { segmentEvidenceRef, SegmentStore } from "../src/compiler/segments.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { entitySchema, eventRelationSchema, worldRuleSchema } from "../src/world/model.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SourceStructureStore } from "../src/compiler/structure.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { characterModelSchema } from "../src/world/actors.js";
import { spatialRelationSchema } from "../src/world/spatial-ontology.js";
import { initialWorldSchema } from "../src/world/initial.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("compiler proposal tools", () => {
  it("exposes payload semantics but only host-issued evidence handles to the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-schema-"));
    roots.push(root);
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity");
    expect(tool).toBeDefined();

    const schema = JSON.stringify(tool?.parameters);
    expect(schema).toContain("canonicalName");
    expect(schema).toContain("evidence_segment_ids");
    expect(schema).toContain("evidence_selectors");
    expect(schema).toContain("target_path");
    expect(schema).toContain('"exact"');
    expect(schema).not.toContain("quoteHash");
    expect(schema).not.toContain("exactHash");
    expect(schema).not.toContain("startByte");
    expect(schema).not.toContain('"evidence":');
    expect(schema).not.toContain('"payload":{}');
  });

  it("resolves field-level quotes into host-trusted assertions and commits their binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-exact-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters the village.\n");
    const batchId = `batch-${fixture.source.id}-exact`;
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "anchor-model" });
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;

    await entity.execute("exact-entity", {
      proposal_id: "entity-hero-exact",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "Hero",
        target_path: "/canonicalName",
        relation: "supports",
        strength: "explicit",
      }, {
        segment_id: fixture.segmentId,
        exact: "Hero enters the village",
        target_path: "/kind",
        relation: "supports",
        strength: "strong-inference",
        interpretation: "The narrated agent is modeled as a character rather than a place or object.",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "entity-hero-exact", entitySchema);
    expect(pending.schemaVersion).toBe(2);
    expect(pending.evidenceAssertions).toHaveLength(2);
    expect(pending.evidenceAssertions?.map((assertion) => assertion.target.jsonPointer))
      .toEqual(["/canonicalName", "/kind"]);
    expect(pending.evidenceAssertions?.[1]).toMatchObject({
      strength: "strong-inference",
      interpretation: expect.stringContaining("modeled as a character"),
      derivation: {
        runId: batchId,
        compilerBatchId: batchId,
        worker: "propose_entity",
        provider: "test",
        model: "anchor-model",
        ontologyVersion: "evidence-v1",
      },
    });
    await expect(new EvidenceVerifier(root).verifyAssertions(pending.evidenceAssertions ?? []))
      .resolves.toMatchObject({ valid: true, issues: [] });

    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await expect(finish.execute("finish-exact-entity", {
      outcome: "complete",
      reviewed_segments: [{
        segment_id: fixture.segmentId,
        disposition: "proposed",
        summary: "Recorded the source-backed character mention and classification.",
      }],
      summary: "Exact evidence resolves the represented source unit.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });
    const structure = await new SourceStructureStore(root).read(fixture.source.id);
    expect(structure).not.toBeNull();
    await expect(new SourceAccountingStore(root).summarize(structure!)).resolves.toMatchObject({
      unitCoverage: 1,
      byteCoverage: 1,
      blockingUnits: 0,
      statusCounts: { represented: 1 },
    });

    expect((await new CompilerCommitService(root).accept("entity", "entity-hero-exact")).accepted).toBe(true);
    const binding = await new EvidenceAssertionStore(root).bindingForArtifact("entity", "hero");
    expect(binding?.assertions).toHaveLength(2);
    expect(binding?.assertions[0]?.target).toMatchObject({
      artifactKind: "entity",
      artifactId: "hero",
      jsonPointer: "/canonicalName",
    });
    const readArtifact = toolset.tools.find((candidate) => candidate.name === "read_compiler_artifact")!;
    const retrieval = await readArtifact.execute("read-exact-entity", {
      ref: "canonical:entity:hero",
    } as never, undefined, undefined, {} as ExtensionContext);
    const retrievalText = (retrieval.content[0] as { type: "text"; text: string }).text;
    const retrievalEnvelope = JSON.parse(retrievalText) as { chunk: string };
    expect(retrievalEnvelope.chunk).toContain('"evidenceAssertions"');
    expect(retrievalEnvelope.chunk).toContain('"jsonPointer":"/canonicalName"');

    await new CompilerProposalService(root).submit("entity", {
      proposalId: "entity-hero-legacy-revision",
      payload: pending.payload,
      generatedBy: { worker: "legacy-test" },
    });
    expect((await new CompilerCommitService(root).accept("entity", "entity-hero-legacy-revision")).accepted).toBe(true);
    await expect(new EvidenceAssertionStore(root).listForArtifact("entity", "hero")).resolves.toEqual([]);
  });

  it("lets the dedicated opening pass recover Longzu-style pre-checkpoint cause and stance from later discourse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-whole-source-context-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, [
      "序章",
      "Hero watches a grey avatar flicker on the screen.",
      "第一章",
      "Hero is a student living with his aunt.",
      "His aunt submitted American university applications for him after earlier rejections.",
      "Hero himself is indifferent to studying abroad.",
      "The Chicago decision is still pending.",
      "",
    ].join("\n"));
    const segments = await new SegmentStore(root).list(fixture.source.id);
    expect(segments).toHaveLength(2);
    const [openingSegment, laterSegment] = segments;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch(
      [openingSegment!.id],
      `opening-batch-${fixture.source.id}-reader-context`,
      fixture.source.id,
    );
    const initial = toolset.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const selector = (segmentId: string, exact: string, targetPath: string) => ({
      segment_id: segmentId,
      exact,
      target_path: targetPath,
      relation: "supports",
      strength: "explicit",
    });

    await expect(initial.execute("opening-context", {
      proposal_id: "opening-context",
      payload: {
        version: 1,
        readerSetup: "Hero is waiting at home while an overseas application arranged by his aunt remains unresolved.",
        readerContext: {
          version: 1,
          focalActorId: "hero",
          facts: [
            { id: "focal", kind: "focal-identity", summary: "Hero is a student living with his aunt.", temporalClass: "later-discourse-preexisting", basis: "source-narrator-established", entityIds: ["hero"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "time", kind: "time-place", summary: "Hero is at home during the opening wait.", temporalClass: "at-checkpoint", basis: "checkpoint-state", entityIds: ["hero"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "cause", kind: "causal-premise", summary: "His aunt submitted American university applications after earlier rejections.", temporalClass: "later-discourse-preexisting", basis: "source-narrator-established", entityIds: ["hero", "aunt"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "stance", kind: "actor-stance", summary: "Hero is indifferent to studying abroad.", temporalClass: "later-discourse-preexisting", basis: "source-narrator-established", entityIds: ["hero"], holderEntityId: "hero", stance: "indifferent", focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "pressure", kind: "immediate-pressure", summary: "The Chicago decision remains pending.", temporalClass: "at-checkpoint", basis: "source-narrator-established", entityIds: ["hero"], focalKnowledgeClaimIds: [], dependsOnFactIds: ["cause"] },
          ],
          entityGlosses: [{ entityId: "aunt", relationshipToFocal: "Hero's guardian aunt", whyRelevantNow: "She initiated the American applications", factIds: ["cause"] }],
          immediateSituation: {
            summary: "An application arranged by Hero's aunt is awaiting Chicago's decision.",
            causalFactIds: ["cause"],
            pressureFactIds: ["pressure"],
            unresolvedFactIds: ["pressure"],
            outcomePolicy: "withhold-post-checkpoint-outcomes",
          },
        },
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        actorObservations: [{ actorId: "hero", summary: "Hero sees the grey avatar flicker on the screen." }],
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "wait" }] },
      },
      evidence_segment_ids: [openingSegment!.id, laterSegment!.id],
      evidence_selectors: [
        selector(laterSegment!.id, "His aunt submitted American university applications for him after earlier rejections.", "/readerSetup"),
        selector(laterSegment!.id, "Hero is a student living with his aunt.", "/readerContext/facts/0/summary"),
        selector(openingSegment!.id, "Hero watches a grey avatar flicker on the screen.", "/readerContext/facts/1/summary"),
        selector(laterSegment!.id, "His aunt submitted American university applications for him after earlier rejections.", "/readerContext/facts/2/summary"),
        selector(laterSegment!.id, "Hero himself is indifferent to studying abroad.", "/readerContext/facts/3/summary"),
        selector(laterSegment!.id, "The Chicago decision is still pending.", "/readerContext/facts/4/summary"),
        selector(laterSegment!.id, "living with his aunt", "/readerContext/entityGlosses/0/relationshipToFocal"),
        selector(laterSegment!.id, "His aunt submitted American university applications for him", "/readerContext/entityGlosses/0/whyRelevantNow"),
        selector(laterSegment!.id, "His aunt submitted American university applications for him after earlier rejections.", "/readerContext/immediateSituation/summary"),
        selector(openingSegment!.id, "Hero watches a grey avatar flicker on the screen.", "/actorObservations/0/summary"),
      ],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "opening-context", kind: "initial-world" },
    });

    const pending = await new ProposalStore(root).read("pending", "opening-context", initialWorldSchema);
    expect(new Set(pending.evidenceAssertions?.flatMap((assertion) =>
      assertion.anchors.map((anchor) => anchor.sourceId)))).toEqual(new Set([fixture.source.id]));
    expect(pending.evidenceAssertions?.some((assertion) =>
      assertion.target.jsonPointer === "/readerContext/facts/2/summary"
      && assertion.anchors[0]?.startLine === 5)).toBe(true);
  });

  it("rejects nonexistent evidence targets and inferred selectors without interpretations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-exact-target-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-exact-target`, fixture.source.id);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const base = {
      proposal_id: "entity-hero-bad-anchor",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] },
      evidence_segment_ids: [fixture.segmentId],
    };

    expect(Compile(entity.parameters).Check({
      ...base,
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "Hero",
        target_path: "/kind",
        relation: "supports",
        strength: "strong-inference",
      }],
    })).toBe(false);
    await expect(entity.execute("bad-target", {
      ...base,
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "Hero",
        target_path: "/missing",
        relation: "supports",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("does not exist");
    await expect(new ProposalStore(root).list("pending")).resolves.toEqual([]);
  });

  it("publishes compilable strict schemas for every proposal kind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-all-schemas-"));
    roots.push(root);
    const tools = createCompilerProposalTools(root);
    expect(tools).toHaveLength(44);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "propose_proposition",
      "propose_attribution",
      "propose_event_participation",
      "propose_event_relation",
      "propose_scene_occurrence",
      "propose_event_frame",
      "propose_action_schema",
      "propose_spatial_relation",
      "find_source_accounting_units",
      "account_source_units",
    ]));
    for (const tool of tools.filter((candidate) => candidate.name.startsWith("propose_"))) {
      const validator = Compile(tool.parameters);
      expect(tool.executionMode).toBe("sequential");
      expect(validator.Check({ proposal_id: "valid-id", payload: "{}" }), tool.name).toBe(false);
      expect(JSON.stringify(tool.parameters), tool.name).not.toContain('"payload":{}');
      expect(JSON.stringify(tool.parameters), tool.name).not.toContain("quoteHash");
      expect(JSON.stringify(tool.parameters), tool.name).not.toContain('"evidence":');
    }
    for (const name of ["propose_entity_mention", "propose_quotation", "propose_discourse_segment"]) {
      const schema = JSON.stringify(tools.find((tool) => tool.name === name)?.parameters);
      expect(schema, name).toContain('"exact"');
      expect(schema, name).not.toContain("startByte");
      expect(schema, name).not.toContain("exactHash");
      expect(schema, name).not.toContain("entityId");
    }
  });

  it("resolves contested event-relation counter-evidence without exposing trusted spans to the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-relation-counter-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "The door opened. Yet the witness denied that the opening happened.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-relation-counter`, fixture.source.id);
    const relation = toolset.tools.find((candidate) => candidate.name === "propose_event_relation")!;
    const validator = Compile(relation.parameters);
    const payload = {
      id: "door-opening-contested",
      fromEventId: "door-opens",
      toEventId: "witness-reacts",
      type: "before",
      status: "contested",
      confidence: 0.55,
    };

    expect(validator.Check({
      proposal_id: "relation-contested-raw-ref",
      payload: { ...payload, counterEvidence: [{ span: { quoteHash: "forged" }, strength: "explicit" }] },
      evidence_segment_ids: [fixture.segmentId],
    })).toBe(false);

    await relation.execute("relation-contested", {
      proposal_id: "relation-contested",
      payload,
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "The door opened",
        target_path: "/type",
        relation: "supports",
        strength: "explicit",
      }, {
        segment_id: fixture.segmentId,
        exact: "the witness denied that the opening happened",
        target_path: "/type",
        relation: "contradicts",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "relation-contested", eventRelationSchema);
    expect(pending.payload.counterEvidence).toHaveLength(1);
    expect(pending.payload.counterEvidence?.[0]).toMatchObject({
      span: {
        sourceId: fixture.source.id,
        startByte: expect.any(Number),
        endByte: expect.any(Number),
        quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      strength: "explicit",
    });
  });

  it("injects nested character counter-evidence from exact selectors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-character-counter-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "She paused to weigh the risk. On another occasion she rushed ahead.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-character-counter`, fixture.source.id);
    const characterModel = toolset.tools.find((candidate) => candidate.name === "propose_character_model")!;
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "She",
      aliases: [],
      evidence: fixture.evidence("She"),
    });

    await characterModel.execute("character-counter", {
      proposal_id: "character-counter",
      payload: {
        actorId: "hero",
        ontologyVersion: "character-v1",
        traits: {},
        decisionBiases: {},
        dispositions: [{
          id: "hero-deliberation-contested",
          actorId: "hero",
          dimensionId: "deliberation",
          value: 0.6,
          scope: { kind: "global" },
          stability: "situational",
          basis: "inferred-pattern",
          status: "contested",
          confidence: 0.55,
        }],
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "paused to weigh the risk",
        target_path: "/dispositions/0/value",
        relation: "supports",
        strength: "strong-inference",
        interpretation: "Pausing to compare risk supports deliberation in this situation.",
      }, {
        segment_id: fixture.segmentId,
        exact: "rushed ahead",
        target_path: "/dispositions/0/value",
        relation: "contradicts",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "character-counter", characterModelSchema);
    expect(pending.payload.dispositions?.[0]?.evidence).toHaveLength(1);
    expect(pending.payload.dispositions?.[0]?.evidence[0]).toMatchObject({
      span: fixture.evidence("paused to weigh the risk")[0]!.span,
      strength: "strong-inference",
    });
    expect(pending.payload.dispositions?.[0]?.counterEvidence).toHaveLength(1);
    expect(pending.payload.dispositions?.[0]?.counterEvidence?.[0]?.span).toMatchObject({
      sourceId: fixture.source.id,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      startByte: expect.any(Number),
      endByte: expect.any(Number),
    });
    expect((await new CompilerCommitService(root).accept("character-model", "character-counter")).accepted).toBe(true);
    await expect(new EvidenceAssertionStore(root).bindingForArtifact("character-model", "hero"))
      .resolves.toMatchObject({ assertions: expect.arrayContaining([
        expect.objectContaining({ relation: "supports" }),
        expect.objectContaining({ relation: "contradicts" }),
      ]) });
  });

  it("counts exact character support spans instead of coarse compiler segments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-character-exact-support-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "She weighed the first risk before acting. Later she compared the second danger before choosing.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-character-support`, fixture.source.id);
    const characterModel = toolset.tools.find((candidate) => candidate.name === "propose_character_model")!;
    const payload = {
      actorId: "hero",
      ontologyVersion: "character-v1",
      traits: {},
      decisionBiases: {},
      dispositions: [{
        id: "hero-deliberates-repeatedly",
        actorId: "hero",
        dimensionId: "deliberation",
        value: 0.8,
        scope: { kind: "global" },
        stability: "stable",
        basis: "repeated-behavior",
        status: "supported",
        confidence: 0.8,
      }],
    };

    await characterModel.execute("character-support", {
      proposal_id: "character-support",
      payload,
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "weighed the first risk before acting",
        target_path: "/dispositions/0/value",
        relation: "supports",
        strength: "strong-inference",
        interpretation: "The first choice shows deliberate comparison.",
      }, {
        segment_id: fixture.segmentId,
        exact: "compared the second danger before choosing",
        target_path: "/dispositions/0/value",
        relation: "supports",
        strength: "strong-inference",
        interpretation: "A separate later choice repeats the same behavior.",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "character-support", characterModelSchema);
    expect(pending.payload.dispositions?.[0]?.evidence).toHaveLength(2);
    expect(new Set(pending.payload.dispositions?.[0]?.evidence.map((item) => item.span.quoteHash)).size).toBe(2);

    await expect(characterModel.execute("character-support-missing", {
      proposal_id: "character-support-missing",
      payload,
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow();
    await expect(characterModel.execute("character-counter-wrong-path", {
      proposal_id: "character-counter-wrong-path",
      payload: {
        ...payload,
        dispositions: [{ ...payload.dispositions[0], stability: "situational", status: "contested" }],
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "weighed the first risk before acting",
        target_path: "/actorId",
        relation: "contradicts",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("must target one disposition");
  });

  it("injects exact support and counter-evidence into directed relationship policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-relationship-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "She trusted him after the rescue. Yet she still checked his story.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-relationship`, fixture.source.id);
    const characterModel = toolset.tools.find((candidate) => candidate.name === "propose_character_model")!;

    await characterModel.execute("relationship-evidence", {
      proposal_id: "relationship-evidence",
      payload: {
        actorId: "hero",
        traits: {},
        decisionBiases: {},
        relationshipOntologyVersion: "relationship-v1",
        relationshipStances: [{
          id: "hero-trusts-rival",
          actorId: "hero",
          relationshipEntityId: "hero-to-rival",
          targetEntityId: "rival",
          dimensionId: "trust",
          value: 0.6,
          stability: "situational",
          basis: "inferred-pattern",
          status: "contested",
          confidence: 0.6,
        }],
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "trusted him after the rescue",
        target_path: "/relationshipStances/0/value",
        relation: "supports",
        strength: "strong-inference",
        interpretation: "Reliance after rescue supports a positive directed trust stance.",
      }, {
        segment_id: fixture.segmentId,
        exact: "still checked his story",
        target_path: "/relationshipStances/0/value",
        relation: "contradicts",
        strength: "strong-inference",
        interpretation: "Continued verification contests unqualified trust.",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "relationship-evidence", characterModelSchema);
    expect(pending.payload.relationshipStances?.[0]).toMatchObject({
      evidence: [expect.objectContaining({ strength: "strong-inference" })],
      counterEvidence: [expect.objectContaining({ strength: "strong-inference" })],
    });
    expect(pending.evidenceAssertions).toHaveLength(2);
  });

  it("binds a spatial route to exact host-resolved support instead of a coarse segment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-spatial-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "A narrow road led from the village to the harbor, two hours on foot.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-spatial`, fixture.source.id);
    const spatial = toolset.tools.find((candidate) => candidate.name === "propose_spatial_relation")!;
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "village",
      kind: "location",
      canonicalName: "village",
      aliases: [],
      evidence: fixture.evidence("village"),
    });
    await canon.putEntity({
      id: "harbor",
      kind: "location",
      canonicalName: "harbor",
      aliases: [],
      evidence: fixture.evidence("harbor"),
    });

    await spatial.execute("spatial-evidence", {
      proposal_id: "spatial-village-harbor",
      payload: {
        ontologyVersion: "spatial-v1",
        id: "village-harbor-road",
        kind: "route",
        fromLocationId: "village",
        toLocationId: "harbor",
        direction: "two-way",
        modes: ["foot"],
        duration: { minimum: 2, typical: 2, maximum: 2, unit: "hour" },
        basis: "explicit",
        visibility: "public",
        status: "supported",
        confidence: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "road led from the village to the harbor, two hours on foot",
        target_path: "/kind",
        relation: "supports",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "spatial-village-harbor", spatialRelationSchema);
    expect(pending.payload.evidence).toHaveLength(1);
    expect(pending.payload.evidence[0]?.span.startByte).toBeGreaterThan(0);
    expect(pending.evidenceAssertions).toHaveLength(1);
    expect(pending.payload.evidence[0]?.span.quoteHash).toBe(pending.evidenceAssertions[0]?.anchors[0]?.exactHash);
    expect((await new CompilerCommitService(root).accept("spatial-relation", "spatial-village-harbor")).accepted).toBe(true);
    await expect(canon.getSpatialRelation("village-harbor-road")).resolves.toMatchObject({
      kind: "route",
      fromLocationId: "village",
      toLocationId: "harbor",
    });
  });

  it("accepts an independent spatial edge when another pending edge has an invalid endpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-spatial-isolation-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "The road connects Alpha to Beta. Ghost is elsewhere.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-spatial-isolation`, fixture.source.id);
    const spatial = toolset.tools.find((candidate) => candidate.name === "propose_spatial_relation")!;
    const canon = new CanonicalModelStore(root);
    for (const [id, name] of [["alpha", "Alpha"], ["beta", "Beta"]] as const) {
      await canon.putEntity({
        id,
        kind: "location",
        canonicalName: name,
        aliases: [],
        evidence: fixture.evidence(name),
      });
    }
    const common = {
      ontologyVersion: "spatial-v1" as const,
      kind: "route" as const,
      fromLocationId: "alpha",
      direction: "two-way" as const,
      modes: ["foot" as const],
      basis: "explicit" as const,
      visibility: "public" as const,
      status: "supported" as const,
      confidence: 1,
    };
    for (const [proposalId, id, toLocationId, exact] of [
      ["01-valid-spatial", "alpha-beta-road", "beta", "road connects Alpha to Beta"],
      ["02-invalid-spatial", "alpha-ghost-road", "missing-ghost", "Ghost is elsewhere"],
    ] as const) {
      await spatial.execute(proposalId, {
        proposal_id: proposalId,
        payload: { ...common, id, toLocationId },
        evidence_segment_ids: [fixture.segmentId],
        evidence_selectors: [{
          segment_id: fixture.segmentId,
          exact,
          target_path: "/kind",
          relation: "supports",
          strength: "explicit",
        }],
      } as never, undefined, undefined, {} as ExtensionContext);
    }

    const result = await new CompilerCommitService(root).acceptAllValid(fixture.source.id);

    expect(result.accepted).toEqual([{ id: "01-valid-spatial", kind: "spatial-relation" }]);
    expect(result.blocked).toEqual([expect.objectContaining({
      id: "02-invalid-spatial",
      errors: expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_SPATIAL_LOCATION" })]),
    })]);
    await expect(canon.listSpatialRelations()).resolves.toEqual([
      expect.objectContaining({ id: "alpha-beta-road" }),
    ]);
  });

  it("injects separate exact evidence into a controlled rule, its clause, and its exception", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-world-rule-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "The garden was closed by custom. Entry was forbidden. A royal permit was the sole exception.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-world-rule`, fixture.source.id);
    const proposeRule = toolset.tools.find((candidate) => candidate.name === "propose_world_rule")!;
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Entry"),
    });
    await canon.putEntity({
      id: "garden",
      kind: "location",
      canonicalName: "garden",
      aliases: [],
      evidence: fixture.evidence("garden"),
    });

    await proposeRule.execute("world-rule-evidence", {
      proposal_id: "rule-garden-custom",
      payload: {
        ontologyVersion: "world-rule-v2",
        id: "garden-custom",
        name: "The garden is closed by custom",
        kind: "social",
        scope: "global",
        visibility: "public",
        priority: 10,
        defeasible: true,
        clauses: [{
          id: "garden-entry-forbidden",
          modality: "forbid",
          predicate: { op: "fact-equals", entityId: "hero", field: "character.location", value: "garden" },
          basis: "explicit",
          status: "supported",
          confidence: 1,
        }],
        exceptions: [{
          id: "royal-permit-exception",
          appliesWhen: [{ op: "fact-equals", entityId: "hero", field: "character.plan", value: "royal-permit" }],
          basis: "explicit",
          status: "supported",
          confidence: 1,
        }],
        basis: "explicit",
        status: "supported",
        confidence: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
      evidence_selectors: [{
        segment_id: fixture.segmentId,
        exact: "garden was closed by custom",
        target_path: "/name",
        relation: "supports",
        strength: "explicit",
      }, {
        segment_id: fixture.segmentId,
        exact: "Entry was forbidden",
        target_path: "/clauses/0/predicate",
        relation: "supports",
        strength: "explicit",
      }, {
        segment_id: fixture.segmentId,
        exact: "royal permit was the sole exception",
        target_path: "/exceptions/0/appliesWhen",
        relation: "supports",
        strength: "explicit",
      }],
    } as never, undefined, undefined, {} as ExtensionContext);

    const pending = await new ProposalStore(root).read("pending", "rule-garden-custom", worldRuleSchema);
    expect(pending.payload).toMatchObject({
      evidence: [expect.objectContaining({ strength: "explicit" })],
      clauses: [{ evidence: [expect.objectContaining({ strength: "explicit" })] }],
      exceptions: [{ evidence: [expect.objectContaining({ strength: "explicit" })] }],
    });
    expect(pending.evidenceAssertions).toHaveLength(3);
    expect((await new CompilerCommitService(root).accept("world-rule", "rule-garden-custom")).accepted).toBe(true);
    await expect(canon.getRule("garden-custom")).resolves.toMatchObject({ ontologyVersion: "world-rule-v2" });
  });

  it("accepts a model-selected title from opening evidence only at the successful finish handshake", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-title-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "《活着》\n作者：余华\n\n第一章\n福贵回到村里。\n",
      "opaque-upload-name.txt",
    );
    const manifest = await new SegmentStore(root).readManifest(fixture.source.id);
    const opening = manifest!.segments.find((segment) => segment.ordinal === 0)!;
    const batchId = `batch-${fixture.source.id}-00001-title`;
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "semantic-title-model" });
    await toolset.beginBatch([opening.id], batchId, fixture.source.id);
    const inferTitle = toolset.tools.find((candidate) => candidate.name === "propose_novel_title")!;

    await expect(inferTitle.execute("title", {
      proposal_id: "novel-title-huozhe",
      title: "活着",
      evidence_segment_id: opening.id,
      reason: "The model identifies the bracketed work title and excludes the author line.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "novel-title-huozhe", kind: "novel-title" },
    });
    await expect(inferTitle.execute("title-idempotent-retry", {
      proposal_id: "novel-title-huozhe",
      title: "活着",
      evidence_segment_id: opening.id,
      reason: "Provider retried the same semantic title candidate.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "novel-title-huozhe" },
    });
    await expect(WorkspaceStore.create(root)
      .then((store) => store.getSource(fixture.source.id))).resolves.toMatchObject({
      title: "opaque-upload-name.txt",
      pendingTitleProposal: { proposalId: "novel-title-huozhe", title: "活着" },
    });

    // A new toolset simulates provider/session recovery: the pending metadata
    // candidate is rehydrated and still requires a successful finish.
    const retry = createCompilerProposalToolset(root, { provider: "test", model: "semantic-title-model" });
    await retry.beginBatch([opening.id], batchId, fixture.source.id);
    const finish = retry.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await expect(finish.execute("finish-title", {
      outcome: "complete",
      reviewed_segments: [{
        segment_id: opening.id,
        disposition: "proposed",
        summary: "Inferred the evidence-backed novel title.",
      }],
      summary: "Accepted the title metadata after reviewing the opening evidence.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, proposalIds: ["novel-title-huozhe"] },
    });
    await expect(WorkspaceStore.create(root)
      .then((store) => store.getSource(fixture.source.id))).resolves.toMatchObject({
      title: "活着",
      titleInference: {
        title: "活着",
        generatedBy: { provider: "test", model: "semantic-title-model", compilerBatchId: batchId },
      },
    });
  });

  it("rejects a model-inferred title that is absent from its verified opening evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-title-absent-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "《活着》\n作者：余华\n", "opaque.txt");
    const manifest = await new SegmentStore(root).readManifest(fixture.source.id);
    const opening = manifest!.segments[0]!;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([opening.id], `batch-${fixture.source.id}-00001-title`, fixture.source.id);
    const inferTitle = toolset.tools.find((candidate) => candidate.name === "propose_novel_title")!;

    await expect(inferTitle.execute("title-absent", {
      proposal_id: "novel-title-absent",
      title: "许三观卖血记",
      evidence_segment_id: opening.id,
      reason: "Unsupported guess.",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("must occur");
  });

  it("normalizes provider-stringified JSON before strict proposal validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-json-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "刘备在涿县。\n");
    const payload = {
      id: "liu-bei",
      kind: "character",
      canonicalName: "刘备",
      aliases: ["玄德"],
    };
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "stringifying-provider" });
    await toolset.beginBatch([fixture.segmentId], "stringified-json", fixture.source.id);
    const tool = toolset.tools
      .find((candidate) => candidate.name === "propose_entity");
    expect(tool?.prepareArguments).toBeDefined();

    const prepared = tool?.prepareArguments?.({
      proposal_id: "entity-liu-bei",
      payload: JSON.stringify(payload),
      evidence_segment_ids: JSON.stringify([fixture.segmentId]),
    });
    expect(prepared).toMatchObject({
      proposal_id: "entity-liu-bei",
      payload,
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(tool!.parameters).Check(prepared), "prepared arguments satisfy the provider-facing schema").toBe(true);
    await tool?.execute(
      "call-1",
      prepared as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    const stored = await new CompilerProposalService(root).store.read("pending", "entity-liu-bei", entitySchema);
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;
    expect(stored.payload).toEqual({ ...payload, evidence: [segmentEvidenceRef(segment)] });
    expect(stored.evidence).toEqual([]);
    expect(stored.generatedBy).toMatchObject({ provider: "test", model: "stringifying-provider" });
  });

  it("rejects malformed provider-stringified JSON before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-invalid-json-"));
    roots.push(root);
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity");
    expect(() => tool?.prepareArguments?.({ proposal_id: "broken", payload: "{not-json" }))
      .toThrow("payload must be a JSON value");
  });

  it("rejects unknown handles and any attempt to mix handles with model-written evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-host-evidence-boundary-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters the village.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "host-evidence-boundary", fixture.source.id);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const payload = {
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
    };

    await expect(entity.execute("unknown-handle", {
      proposal_id: "entity-hero-unknown",
      payload,
      evidence_segment_ids: ["unknown-segment"],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("Unknown evidence_segment_ids");

    await expect(entity.execute("missing-handle", {
      proposal_id: "entity-hero-raw",
      payload: { ...payload, evidence: fixture.evidence("Hero") },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("require evidence_segment_ids");

    await expect(entity.execute("mixed-evidence", {
      proposal_id: "entity-hero-mixed",
      payload: { ...payload, evidence: fixture.evidence("Hero") },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("must omit payload.evidence");

    await expect(new ProposalStore(root).list("pending")).resolves.toEqual([]);
  });

  it("injects handles into envelope-only and nested evidence shapes without duplication", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-host-evidence-shapes-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "After the oath, Hero becomes resolute.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "host-evidence-shapes", fixture.source.id);
    const expectedEvidence = [segmentEvidenceRef((await new SegmentStore(root).list(fixture.source.id))[0]!)];

    const stateDelta = toolset.tools.find((candidate) => candidate.name === "propose_state_delta")!;
    await stateDelta.execute("state-delta", {
      proposal_id: "delta-host-evidence",
      payload: { version: 1, operations: [] },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(new ProposalStore(root).readEnvelope("pending", "delta-host-evidence")).resolves.toMatchObject({
      payload: { version: 1, operations: [] },
      evidence: expectedEvidence,
    });

    const characterModel = toolset.tools.find((candidate) => candidate.name === "propose_character_model")!;
    const modelPayload = {
      actorId: "hero",
      traits: { resolve: 0.5 },
      decisionBiases: {},
      developmentPhases: [{
        id: "after-oath",
        label: "After the oath",
        activation: {
          preconditions: [],
          afterCanonicalEventIds: ["hero-oath"],
          afterExperiencedCanonicalEventIds: [],
          requiresKnowledge: [],
        },
        traitModifiers: { resolve: 0.3 },
        decisionBiasModifiers: {},
      }],
    };
    const prepared = characterModel.prepareArguments?.({
      proposal_id: "model-hero",
      payload: modelPayload,
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(characterModel.parameters).Check(prepared)).toBe(true);
    await characterModel.execute("character-model", prepared as never, undefined, undefined, {} as ExtensionContext);
    await expect(new ProposalStore(root).readEnvelope("pending", "model-hero")).resolves.toMatchObject({
      payload: {
        ...modelPayload,
        evidence: expectedEvidence,
        developmentPhases: [{ ...modelPayload.developmentPhases[0], evidence: expectedEvidence }],
      },
      evidence: [],
    });
  });

  it("rejects unsafe ids and evidence-free compiler entities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-invalid-payload-"));
    roots.push(root);
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity")!;
    const validator = Compile(tool.parameters);
    const base = {
      kind: "character",
      canonicalName: "刘备",
      aliases: ["玄德"],
    };
    expect(validator.Check({ proposal_id: "entity-liu-bei", payload: { id: "liu-bei", ...base } })).toBe(false);
    expect(validator.Check({ proposal_id: "中文 id", payload: { id: "中文 id", ...base }, evidence_segment_ids: ["segment-1"] })).toBe(false);
    expect(validator.Check({
      proposal_id: "entity-liu-bei",
      payload: { id: "liu-bei", ...base, evidence: [] },
      evidence_segment_ids: ["segment-1"],
    })).toBe(false);
  });

  it("rejects one compiler artifact that mixes evidence from different novels", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-source-boundary-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero enters.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Other hero enters.\n", "second.txt");
    const service = new CompilerProposalService(root);

    await expect(service.submit("entity", {
      proposalId: "mixed-hero",
      payload: {
        id: "mixed-hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
        evidence: [...first.evidence("Hero"), ...second.evidence("Other hero")],
      },
      generatedBy: { worker: "test" },
    })).rejects.toThrow("mixes evidence from multiple novel sources");
  });

  it("rejects evidence outside the host-supplied source segment slice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-segment-boundary-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "第一章 开端\nHero enters the Hall.\n\n第二章 后事\nVillain reveals the future.\n",
    );
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "opening-slice", fixture.source.id);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const segments = await new SegmentStore(root).list(fixture.source.id);
    const futureSegment = segments.find((segment) => segment.id !== fixture.segmentId)!;

    await expect(entity.execute("future-entity", {
      proposal_id: "future-villain",
      payload: {
        id: "future-villain",
        kind: "character",
        canonicalName: "Villain",
        aliases: [],
      },
      evidence_segment_ids: [futureSegment.id],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("outside the host-supplied compiler segment slice");
    await expect(new ProposalStore(root).list("pending")).resolves.toEqual([]);
  });

  it("keeps the host-selected evidence boundary after the persisted manifest changes mid-turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-frozen-slice-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Chapter 1\nAlice waits.\nChapter 2\nBob arrives.\n");
    const store = new SegmentStore(root);
    const manifest = await store.readManifest(fixture.source.id);
    expect(manifest?.segments).toHaveLength(2);
    const [first, second] = manifest!.segments;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([first!.id], "frozen-slice", fixture.source.id);

    await store.write({
      ...manifest!,
      segments: [{
        ...first!,
        endLine: second!.endLine,
        endByte: fixture.source.bytes,
        bytes: fixture.source.bytes - first!.startByte,
        textSha256: "a".repeat(64),
      }],
    });
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    await expect(entity.execute("bob", {
      proposal_id: "entity-bob",
      payload: {
        id: "bob",
        kind: "character",
        canonicalName: "Bob",
        aliases: [],
      },
      evidence_segment_ids: [second!.id],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("outside the host-supplied compiler segment slice");
  });

  it("rejects unregistered or unnamespaced state fields at both tool and service boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-state-field-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐把银钥交给墨砚。\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "state-field", fixture.source.id);
    const tool = toolset.tools.find((candidate) => candidate.name === "propose_canonical_event")!;
    const payload = {
      id: "lin-qi-gives-key",
      title: "林岐交出银钥",
      participants: ["lin-qi", "mo-yan"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "silver-key", field: "owner", value: "mo-yan" }],
      },
      causalParents: [],
      confidence: 1,
    };
    const prepared = tool.prepareArguments?.({
      proposal_id: "event-key",
      payload,
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(tool.parameters).Check(prepared)).toBe(false);
    await expect(tool.execute("call-invalid-field", prepared as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("Unsupported compiler state field 'owner'");

    const valid = tool.prepareArguments?.({
      proposal_id: "event-key",
      payload: {
        ...payload,
        observedOutcome: {
          version: 1,
          operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }],
        },
      },
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(tool.parameters).Check(valid)).toBe(true);
  });

  it("rejects malformed entity references before a proposal becomes a successful submission", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-state-reference-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "商人赠给刘备马匹和金银。\n");
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_canonical_event")!;
    const payload = {
      id: "merchants-supply-liu-bei",
      title: "商人赠送军资",
      participants: ["liu-bei"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{
          op: "set",
          entityId: "liu-bei",
          field: "character.inventory",
          value: ["马五十匹", "金银五百两"],
        }],
      },
      evidence: fixture.evidence("商人赠给刘备马匹和金银。"),
      causalParents: [],
      confidence: 1,
    };

    await expect(tool.execute("invalid-references", {
      proposal_id: "merchants-supplies",
      payload,
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("invalid entity reference '马五十匹'");

    await expect(tool.execute("forward-references", {
      proposal_id: "merchants-supplies-v2",
      payload: {
        ...payload,
        id: "merchants-supply-liu-bei-v2",
        observedOutcome: {
          version: 1,
          operations: [{
            op: "set",
            entityId: "liu-bei",
            field: "character.inventory",
            value: ["horses-50", "gold-silver-500"],
          }],
        },
      },
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "merchants-supplies-v2" },
    });
  });

  it("rejects compiler world rules that map narrative time onto engine steps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-rule-time-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "第七声钟响后，北门必须关闭。\n");
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_world_rule")!;
    const prepared = tool.prepareArguments?.({
      proposal_id: "rule-gate",
      payload: {
        id: "gate-after-bell",
        name: "第七声钟后关门",
        scope: "location",
        appliesWhen: [],
        requires: [{ op: "after-step", step: 7 }],
        forbids: [{ op: "fact-equals", entityId: "gate", field: "location.open", value: true }],
      },
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(tool.parameters).Check(prepared)).toBe(false);
    await expect(tool.execute("rule-time", prepared as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow();
  });

  it("rejects meta-knowledge claims and inert player choices at submission", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-semantics-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "墨砚不知道银钥在林岐手里。\n");
    const tools = createCompilerProposalTools(root);
    const claim = tools.find((candidate) => candidate.name === "propose_claim")!;
    await expect(claim.execute("meta-claim", {
      proposal_id: "meta-claim",
      payload: {
        id: "meta-claim",
        subject: "mo-yan",
        predicate: "does-not-know",
        object: "silver-key",
        epistemicType: "explicit-fact",
        evidence: fixture.evidence("墨砚不知道银钥在林岐手里。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("KnowledgeDelta");

    await expect(claim.execute("natural-language-meta-claim", {
      proposal_id: "natural-language-meta-claim",
      payload: {
        id: "natural-language-meta-claim",
        subject: "mo-yan",
        predicate: "knows both the key and its owner",
        object: null,
        epistemicType: "explicit-fact",
        evidence: fixture.evidence("墨砚不知道银钥在林岐手里。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("KnowledgeDelta");

    const possibility = tools.find((candidate) => candidate.name === "propose_possibility")!;
    await expect(possibility.execute("inert-choice", {
      proposal_id: "inert-choice",
      payload: {
        id: "inert-choice",
        kind: "player-choice",
        title: "Lin Qi refuses",
        preconditions: [],
        blockers: [],
        participants: ["lin-qi"],
        causalParents: [],
        pressure: 1,
        relevance: 1,
        proposedDelta: { version: 1, operations: [] },
        evidence: fixture.evidence("墨砚不知道银钥在林岐手里。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("concrete state or knowledge effect");
  });

  it("accepts quoted knowledge words in observable behavior claims", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-quoted-speech-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "苦根回答‘知道了’，继续向水塘里扔石子。\n");
    const claim = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_claim")!;
    const evidence = fixture.evidence("苦根回答‘知道了’，继续向水塘里扔石子。");

    await expect(claim.execute("observable-claim", {
      proposal_id: "observable-claim",
      payload: {
        id: "observable-reaction",
        subject: "kugen",
        predicate: "answers ‘知道了’ and continues throwing stones into the pond",
        object: null,
        epistemicType: "explicit-fact",
        evidence,
      },
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "observable-claim", kind: "claim" },
    });

    await expect(claim.execute("cognitive-claim", {
      proposal_id: "cognitive-claim",
      payload: {
        id: "cognitive-reaction",
        subject: "kugen",
        predicate: "thinks his father will return",
        object: null,
        epistemicType: "interpretation",
        evidence,
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("KnowledgeDelta");
  });

  it("copies top-level evidence into evidence-backed payloads before validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-evidence-normalization-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters the village.\n");
    const claim = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_claim")!;
    const evidence = fixture.evidence("Hero enters the village.");
    const prepared = claim.prepareArguments?.({
      proposal_id: "hero-arrival",
      payload: {
        id: "hero-arrival",
        subject: "hero",
        predicate: "enters the village",
        object: null,
        epistemicType: "explicit-fact",
      },
      evidence,
    });

    await expect(claim.execute("hero-arrival", prepared as never, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({ details: { proposalId: "hero-arrival", kind: "claim" } });
    await expect(new ProposalStore(root).readEnvelope("pending", "hero-arrival"))
      .resolves.toMatchObject({ payload: { evidence } });
  });

  it("keeps simultaneous effects of one atomic source event together", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-event-atomic-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "墨砚开门并送出停战信。\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "atomic-event", fixture.source.id);
    const tool = toolset.tools.find((candidate) => candidate.name === "propose_canonical_event")!;
    const prepared = tool.prepareArguments?.({
      proposal_id: "combined-event",
      payload: {
        id: "combined-event",
        title: "开门并送信",
        participants: ["mo-yan", "north-gate", "ceasefire-letter"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: {
          version: 1,
          operations: [
            { op: "set", entityId: "north-gate", field: "location.open", value: true },
            { op: "set", entityId: "ceasefire-letter", field: "artifact.delivered", value: true },
          ],
        },
        causalParents: [],
        confidence: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
    });
    expect(Compile(tool.parameters).Check(prepared)).toBe(true);
    await expect(tool.execute("combined-event", prepared as never, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({ details: { proposalId: "combined-event", kind: "canonical-event" } });
  });

  it("automatically finishes every active successful submission without model-side id bookkeeping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-finish-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    expect(JSON.stringify(finish.parameters)).not.toContain("proposal_ids");
    const input = {
      proposal_id: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
    };
    await entity.execute("proposal", input as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("bad-finish", {
      outcome: "no-artifacts",
      reviewed_segments: [],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("no-artifacts cannot be used");
    await expect(finish.execute("finish", {
      outcome: "complete",
      reviewed_segments: [],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, outcome: "complete", proposalIds: ["entity-linqi"] },
    });
    await expect(entity.execute("late-proposal", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");
  });

  it("refuses to finish a batch whose entity names are not grounded in verified evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-grounding-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "刘备来到涿县。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([fixture.segmentId], "grounding-batch", fixture.source.id);
    await entity.execute("liu-bei", {
      proposal_id: "entity-liu-bei",
      payload: {
        id: "liu-bei",
        kind: "character",
        canonicalName: "刘备",
        aliases: ["刘玄德", "刘皇叔"],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(finish.execute("finish", {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded Liu Bei." }],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("UNSUPPORTED_ENTITY_ALIAS at aliases.0");
  });

  it("stops an unchanged finish-error loop with a terminating circuit-breaker result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-circuit-breaker-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await entity.execute("proposal", {
      proposal_id: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    const invalidFinish = {
      outcome: "no-artifacts",
      reviewed_segments: [],
      summary: "done",
    };

    await expect(finish.execute("first-failure", invalidFinish as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("no-artifacts cannot be used");
    await expect(finish.execute("repeated-failure", invalidFinish as never, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({
        terminate: true,
        details: { compilerBatchBlocked: true, finishFailureCount: 2 },
      });
  });

  it("allows more than five distinct finish repairs when each attempt follows proposal progress", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-circuit-hard-cap-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const finish = tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    for (let index = 1; index <= 6; index += 1) {
      await entity.execute(`proposal-${index}`, {
        proposal_id: `entity-${index}`,
        payload: {
          id: `person-${index}`,
          kind: "character",
          canonicalName: `人物${index}`,
          aliases: [],
          evidence: fixture.evidence("众人来到前厅。"),
        },
      } as never, undefined, undefined, {} as ExtensionContext);
      await initial.execute(`opening-${index}`, {
        proposal_id: `opening-${index}`,
        payload: {
          version: 1,
          delta: {
            version: 1,
            operations: [{ op: "set", entityId: `person-${index}`, field: "character.location", value: `missing-location-${index}` }],
          },
          evidence: fixture.evidence("众人来到前厅。"),
        },
      } as never, undefined, undefined, {} as ExtensionContext);
      const attempt = finish.execute(`finish-${index}`, {
        outcome: "complete",
        reviewed_segments: [],
        summary: "incomplete",
      } as never, undefined, undefined, {} as ExtensionContext);
      await expect(attempt).rejects.toThrow("proposal graph is incomplete");
    }

    await expect(entity.execute("proposal-after-six-repairs", {
      proposal_id: "entity-after-six-repairs",
      payload: {
        id: "person-after-six-repairs",
        kind: "character",
        canonicalName: "额外人物",
        aliases: [],
        evidence: fixture.evidence("众人来到前厅。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-after-six-repairs" },
    });
  });

  it("keeps capacity counters host-only and trips only the high tool-call safety fuse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-call-budget-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const withdraw = tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;

    for (let index = 1; index <= 500; index += 1) {
      const recorded = await entity.execute(`proposal-${index}`, {
        proposal_id: `entity-${index}`,
        payload: {
          id: `person-${index}`,
          kind: "character",
          canonicalName: `人物${index}`,
          aliases: [],
          evidence: fixture.evidence("众人来到前厅。"),
        },
      } as never, undefined, undefined, {} as ExtensionContext);
      expect(recorded).toMatchObject({
        details: {
          proposalId: `entity-${index}`,
        },
      });
      if (index === 1) {
        const text = recorded.content.map((item) => item.type === "text" ? item.text : "").join("\n");
        expect(text).toContain("never omit or withdraw valid work merely to conserve execution capacity");
        expect(text).not.toMatch(/remaining|active proposals|budget/iu);
        expect(recorded.details).not.toHaveProperty("remainingToolCalls");
        expect(recorded.details).not.toHaveProperty("activeProposalCount");
        expect(recorded.details).not.toHaveProperty("toolCallCount");
      }
      await expect(withdraw.execute(`withdraw-${index}`, {
        proposal_id: `entity-${index}`,
        reason: "Exercise the bounded total-call circuit breaker.",
      } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
        details: { proposalId: `entity-${index}` },
      });
    }

    await expect(entity.execute("over-budget", {
      proposal_id: "entity-over-budget",
      payload: {
        id: "person-over-budget",
        kind: "character",
        canonicalName: "额外人物",
        aliases: [],
        evidence: fixture.evidence("众人来到前厅。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      terminate: true,
      details: {
        compilerBatchBlocked: true,
        finishFailureCount: 0,
        toolCallCount: 1_001,
      },
    });
  });

  it("reserves one final finish call after the tool-call safety fuse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-finish-grace-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "人物来到前厅。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([], "finish-grace-batch", fixture.source.id);
    const input = {
      proposal_id: "entity-person",
      payload: {
        id: "person",
        kind: "character",
        canonicalName: "人物",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    };

    for (let index = 1; index <= 1_000; index += 1) {
      await entity.execute(`proposal-${index}`, input as never, undefined, undefined, {} as ExtensionContext);
    }

    await expect(finish.execute("reserved-finish", {
      outcome: "complete",
      reviewed_segments: [],
      summary: "Finished using the reserved protocol call.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, proposalIds: ["entity-person"] },
    });
  });

  it("keeps an 800-proposal runaway safety fuse without advertising it as a target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-active-budget-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const entity = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity")!;

    for (let index = 1; index <= 800; index += 1) {
      await entity.execute(`proposal-${index}`, {
        proposal_id: `entity-${index}`,
        payload: {
          id: `person-${index}`,
          kind: "character",
          canonicalName: `人物${index}`,
          aliases: [],
          evidence: fixture.evidence("众人来到前厅。"),
        },
      } as never, undefined, undefined, {} as ExtensionContext);
    }

    await expect(entity.execute("proposal-801", {
      proposal_id: "entity-801",
      payload: {
        id: "person-801",
        kind: "character",
        canonicalName: "人物801",
        aliases: [],
        evidence: fixture.evidence("众人来到前厅。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("800-proposal safety fuse");
  });

  it("does not checkpoint proposals until their logical references form a closed graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = toolset.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([fixture.segmentId], undefined, fixture.source.id);
    await entity.execute("lin-qi", {
      proposal_id: "entity-lin-qi",
      payload: {
        id: "lin-qi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await initial.execute("opening", {
      proposal_id: "opening-world",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "lin-qi", field: "character.location", value: "bell-tower" }],
        },
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    const finishInput = {
      outcome: "complete",
      proposal_ids: ["entity-lin-qi", "opening-world"],
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded the opening." }],
      summary: "done",
    };
    await expect(finish.execute("missing-bell-tower", finishInput as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("unknown entity 'bell-tower'");

    await entity.execute("bell-tower", {
      proposal_id: "entity-bell-tower",
      payload: {
        id: "bell-tower",
        kind: "location",
        canonicalName: "钟楼",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("closed", {
      ...finishInput,
      proposal_ids: [...finishInput.proposal_ids, "entity-bell-tower"],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });
  });

  it("runs deterministic commit semantics at finish before committing resolution metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-finish-commit-preview-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "North Gate is open.\n");
    const toolset = createCompilerProposalToolset(root);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    await toolset.beginBatch([fixture.segmentId], "commit-preview-batch", fixture.source.id);
    await tool("propose_entity").execute("gate", {
      proposal_id: "preview-gate-proposal",
      payload: { id: "preview-gate", kind: "location", canonicalName: "North Gate", aliases: [] },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await tool("propose_proposition").execute("open", {
      proposal_id: "preview-open-proposition",
      payload: {
        id: "preview-gate-open",
        subjectEntityId: "preview-gate",
        relationId: "open",
        object: { kind: "literal", value: true },
        polarity: "positive",
        modality: "asserted",
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await tool("propose_attribution").execute("bad-holder", {
      proposal_id: "preview-bad-holder",
      payload: {
        id: "preview-gate-report",
        propositionId: "preview-gate-open",
        holderKind: "character",
        holderEntityId: "preview-gate",
        attitude: "reports",
        certainty: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    const finishInput = {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded the gate statement." }],
      summary: "done",
    };

    await expect(tool("finish_compiler_batch").execute(
      "invalid-holder-finish",
      finishInput as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow(/Deterministic canonical commit preview.*INVALID_ATTRIBUTION_HOLDER/su);

    await tool("withdraw_compiler_proposal").execute("withdraw-holder", {
      proposal_id: "preview-bad-holder",
      reason: "A location cannot be a character attribution holder.",
    } as never, undefined, undefined, {} as ExtensionContext);
    await tool("propose_attribution").execute("narrator-holder", {
      proposal_id: "preview-narrator-holder",
      payload: {
        id: "preview-gate-report",
        propositionId: "preview-gate-open",
        holderKind: "narrator",
        attitude: "reports",
        certainty: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(tool("finish_compiler_batch").execute(
      "valid-holder-finish",
      finishInput as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).resolves.toMatchObject({ details: { compilerBatchFinished: true } });
  });

  it("reports every independent finish validation section in one diagnostic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-finish-aggregate-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero entered.\n");
    const toolset = createCompilerProposalToolset(root);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    await toolset.beginBatch([fixture.segmentId], "aggregate-finish-batch", fixture.source.id);
    await tool("propose_entity_mention").execute("hero-mention", {
      proposal_id: "aggregate-hero-mention-proposal",
      annotation_id: "aggregate-hero-mention",
      selector: { segment_id: fixture.segmentId, exact: "Hero" },
      surface: "Hero",
      form: "proper",
      kind_candidates: ["character"],
      confidence: 1,
    } as never, undefined, undefined, {} as ExtensionContext);
    await tool("propose_entity").execute("hero-entity", {
      proposal_id: "aggregate-hero-entity-proposal",
      payload: { id: "aggregate-hero", kind: "character", canonicalName: "Hero", aliases: [] },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await tool("propose_initial_world").execute("opening", {
      proposal_id: "aggregate-opening-proposal",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "aggregate-hero", field: "character.location", value: "missing-place" }],
        },
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);

    const error = await tool("finish_compiler_batch").execute("aggregate-finish", {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded the opening actor." }],
      summary: "Validate all graph layers.",
    } as never, undefined, undefined, {} as ExtensionContext).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Compiler batch proposal graph is incomplete");
    expect((error as Error).message).toContain("Canonical entity proposal trace is incomplete");
  });

  it("requires proposition and attribution references to close before batch checkpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposition-attribution-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero reports that the Gate is open.\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const proposition = toolset.tools.find((candidate) => candidate.name === "propose_proposition")!;
    const attribution = toolset.tools.find((candidate) => candidate.name === "propose_attribution")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([fixture.segmentId], "semantic-closure", fixture.source.id);
    await attribution.execute("attribution-first", {
      proposal_id: "hero-reports-gate-open",
      payload: {
        id: "hero-reports-gate-open",
        propositionId: "gate-open",
        holderKind: "character",
        holderEntityId: "hero",
        attitude: "reports",
        certainty: 1,
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    const finishInput = {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded a report." }],
      summary: "done",
    };
    await expect(finish.execute("open-attribution", finishInput as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("unknown proposition 'gate-open'");

    for (const [proposalId, id, kind, canonicalName] of [
      ["hero-entity", "hero", "character", "Hero"],
      ["gate-entity", "gate", "location", "Gate"],
    ] as const) {
      await entity.execute(proposalId, {
        proposal_id: proposalId,
        payload: { id, kind, canonicalName, aliases: [] },
        evidence_segment_ids: [fixture.segmentId],
      } as never, undefined, undefined, {} as ExtensionContext);
    }
    await proposition.execute("gate-open", {
      proposal_id: "gate-open-proposal",
      payload: {
        id: "gate-open",
        subjectEntityId: "gate",
        relationId: "open",
        object: { kind: "literal", value: true },
        polarity: "positive",
        modality: "asserted",
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(finish.execute("closed-attribution", finishInput as never, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({ details: { compilerBatchFinished: true } });
  });

  it("binds quotations to resolved speakers and addressees before committing told knowledge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-quotation-knowledge-trace-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, 'Alice told Bob, "the gate is open."\n');
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], "quotation-knowledge-trace", fixture.source.id);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    const context = {} as ExtensionContext;

    for (const [proposalId, annotationId, exact, form, kind, entityId] of [
      ["mention-alice-proposal", "mention-alice", "Alice", "proper", "character", "alice"],
      ["mention-bob-proposal", "mention-bob", "Bob", "proper", "character", "bob"],
      ["mention-gate-proposal", "mention-gate", "gate", "nominal", "location", "gate"],
    ] as const) {
      await tool("propose_entity_mention").execute(proposalId, {
        proposal_id: proposalId,
        annotation_id: annotationId,
        selector: { segment_id: fixture.segmentId, exact },
        surface: exact,
        form,
        kind_candidates: [kind],
        confidence: 1,
      } as never, undefined, undefined, context);
      await tool("propose_entity_resolution").execute(`resolve-${entityId}`, {
        proposal_id: `resolution-${entityId}-proposal`,
        resolution_id: `resolution-${entityId}`,
        mention_id: annotationId,
        status: "new-entity",
        entity_id: entityId,
        candidates: [{
          entity_id: entityId,
          confidence: 1,
          basis_mention_ids: [annotationId],
          evidence_assertion_ids: [],
          rationale: `${exact} introduces ${entityId}.`,
        }],
        rationale: `${annotationId} resolves to the same-batch entity ${entityId}.`,
      } as never, undefined, undefined, context);
      await tool("propose_entity").execute(`entity-${entityId}`, {
        proposal_id: `entity-${entityId}-proposal`,
        payload: { id: entityId, kind, canonicalName: exact, aliases: [] },
        evidence_segment_ids: [fixture.segmentId],
      } as never, undefined, undefined, context);
    }

    await tool("propose_quotation").execute("quotation", {
      proposal_id: "quotation-gate-open-proposal",
      annotation_id: "quotation-gate-open",
      selector: { segment_id: fixture.segmentId, exact: '"the gate is open."' },
      mode: "direct",
      speaker_mention_id: "mention-alice",
      addressee_mention_ids: ["mention-bob"],
      cue_selector: { segment_id: fixture.segmentId, exact: "Alice told Bob" },
      attribution_confidence: 1,
    } as never, undefined, undefined, context);
    await tool("propose_claim").execute("claim", {
      proposal_id: "gate-open-claim-proposal",
      payload: {
        id: "gate-open-claim",
        subject: "gate",
        predicate: "open",
        object: true,
        epistemicType: "character-claim",
        speaker: "alice",
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);
    await tool("propose_proposition").execute("proposition", {
      proposal_id: "gate-open-proposition-proposal",
      payload: {
        id: "gate-open-proposition",
        subjectEntityId: "gate",
        relationId: "open",
        object: { kind: "literal", value: true },
        polarity: "positive",
        modality: "asserted",
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);
    await tool("propose_attribution").execute("wrong-speaker", {
      proposal_id: "wrong-speaker-attribution-proposal",
      payload: {
        id: "wrong-speaker-attribution",
        propositionId: "gate-open-proposition",
        holderKind: "character",
        holderEntityId: "bob",
        attitude: "reports",
        certainty: 1,
        quotationIds: ["quotation-gate-open"],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);

    const finishInput = {
      outcome: "complete",
      reviewed_segments: [{
        segment_id: fixture.segmentId,
        disposition: "proposed",
        summary: "Recorded the speaker, addressee, quoted proposition, and knowledge transfer.",
      }],
      summary: "Close the quotation-backed knowledge graph.",
    };
    await expect(tool("finish_compiler_batch").execute(
      "wrong-speaker-finish",
      finishInput as never,
      undefined,
      undefined,
      context,
    )).rejects.toThrow(/holder 'bob'.*speaker 'alice'/u);

    await tool("withdraw_compiler_proposal").execute("withdraw-wrong-speaker", {
      proposal_id: "wrong-speaker-attribution-proposal",
      reason: "The quotation speaker resolves to Alice, not Bob.",
    } as never, undefined, undefined, context);
    await tool("propose_attribution").execute("correct-speaker", {
      proposal_id: "alice-attribution-proposal",
      payload: {
        id: "alice-reports-gate-open",
        propositionId: "gate-open-proposition",
        holderKind: "character",
        holderEntityId: "alice",
        attitude: "reports",
        certainty: 1,
        quotationIds: ["quotation-gate-open"],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);

    const eventPayload = (actorId: string) => ({
      id: `${actorId}-hears-gate-open`,
      title: "Alice tells Bob that the gate is open",
      participants: ["alice", "bob"],
      participantPresence: [
        { entityId: "alice", mode: "physical" as const },
        { entityId: "bob", mode: "physical" as const },
      ],
      storyTime: { kind: "unknown" as const },
      preconditions: [],
      observedOutcome: { version: 1 as const, operations: [] },
      observedKnowledge: {
        version: 1 as const,
        operations: [{
          op: "learn" as const,
          actorId,
          claimId: "gate-open-claim",
          propositionId: "gate-open-proposition",
          attributionId: "alice-reports-gate-open",
          acquisitionMode: "told" as const,
          sourceActorId: "alice",
          status: "heard" as const,
          confidence: 1,
        }],
      },
      causalParents: [],
      confidence: 1,
    });
    await tool("propose_canonical_event").execute("wrong-addressee", {
      proposal_id: "wrong-addressee-event-proposal",
      payload: eventPayload("alice"),
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);
    await expect(tool("finish_compiler_batch").execute(
      "wrong-addressee-finish",
      finishInput as never,
      undefined,
      undefined,
      context,
    )).rejects.toThrow(/actor 'alice'.*not a resolved addressee/u);

    await tool("withdraw_compiler_proposal").execute("withdraw-wrong-addressee", {
      proposal_id: "wrong-addressee-event-proposal",
      reason: "Alice is the speaker; Bob is the resolved addressee.",
    } as never, undefined, undefined, context);
    await tool("propose_canonical_event").execute("correct-addressee", {
      proposal_id: "bob-hears-event-proposal",
      payload: eventPayload("bob"),
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);
    await expect(tool("finish_compiler_batch").execute(
      "correct-trace-finish",
      finishInput as never,
      undefined,
      undefined,
      context,
    )).resolves.toMatchObject({ details: { compilerBatchFinished: true } });

    const committed = await new CompilerCommitService(root).acceptAllValid(fixture.source.id);
    expect(committed.blocked).toEqual([]);
    expect(committed.accepted.map((candidate) => candidate.kind)).toEqual([
      "entity",
      "entity",
      "entity",
      "claim",
      "proposition",
      "attribution",
      "canonical-event",
    ]);
  });

  it("rejects non-character or missing event presence before checkpoint and accepts the corrected replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-presence-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const event = toolset.tools.find((candidate) => candidate.name === "propose_canonical_event")!;
    const withdraw = toolset.tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([fixture.segmentId], "presence-batch", fixture.source.id);
    for (const [proposalId, id, kind, canonicalName] of [
      ["presence-character", "lin-qi", "character", "林岐"],
      ["presence-location", "bell-tower", "location", "钟楼"],
    ] as const) {
      await entity.execute(proposalId, {
        proposal_id: proposalId,
        payload: { id, kind, canonicalName, aliases: [] },
        evidence_segment_ids: [fixture.segmentId],
      } as never, undefined, undefined, {} as ExtensionContext);
    }
    const eventPayload = {
      id: "lin-qi-at-bell-tower",
      title: "林岐站在钟楼下",
      readerSummary: "林岐来到钟楼下。",
      participants: ["lin-qi", "bell-tower"],
      participantPresence: [{ entityId: "bell-tower", mode: "physical" }],
      storyTime: { kind: "unknown" as const },
      preconditions: [],
      observedOutcome: { version: 1 as const, operations: [] },
      causalParents: [],
      confidence: 1,
    };
    await event.execute("bad-presence", {
      proposal_id: "bad-presence-event",
      payload: eventPayload,
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    const finishInput = {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded the scene." }],
      summary: "done",
    };
    await expect(finish.execute("reject-presence", finishInput as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow(/participant presence is character-only|missing character participant 'lin-qi'/u);

    await withdraw.execute("withdraw-presence", {
      proposal_id: "bad-presence-event",
      reason: "A location cannot have character presence, and the character presence was omitted.",
    } as never, undefined, undefined, {} as ExtensionContext);
    await event.execute("correct-presence", {
      proposal_id: "correct-presence-event",
      payload: {
        ...eventPayload,
        participantPresence: [{ entityId: "lin-qi", mode: "physical" }],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("finish-presence", finishInput as never, undefined, undefined, {} as ExtensionContext))
      .resolves.toMatchObject({ details: { compilerBatchFinished: true } });
  });

  it("withdraws an irreparable current-batch proposal so a corrected graph can finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-withdraw-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = toolset.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const withdraw = toolset.tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await toolset.beginBatch([fixture.segmentId], undefined, fixture.source.id);
    await entity.execute("linqi", {
      proposal_id: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await initial.execute("broken-opening", {
      proposal_id: "opening-world-broken",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "linqi", field: "character.location", value: "missing-location" }],
        },
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    const review = [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recorded Lin Qi." }];
    await expect(finish.execute("broken-graph", {
      outcome: "complete",
      proposal_ids: ["entity-linqi", "opening-world-broken"],
      reviewed_segments: review,
      summary: "draft",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("unknown entity 'missing-location'");

    await expect(withdraw.execute("withdraw-broken", {
      proposal_id: "opening-world-broken",
      reason: "The location reference is unsupported by the evidence.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerProposalWithdrawn: true, proposalId: "opening-world-broken" },
    });
    await expect(finish.execute("finish-active", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      reviewed_segments: review,
      summary: "finished without the defective opening draft",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });
    await expect(new CompilerProposalService(root).store.list("rejected"))
      .resolves.toContainEqual(expect.objectContaining({ id: "opening-world-broken" }));
  });

  it("recovers active proposals after a failed batch process restarts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-recovery-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const batchId = "batch-source-00001-retry";
    const first = createCompilerProposalToolset(root);
    await first.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const firstEntity = first.tools.find((candidate) => candidate.name === "propose_entity")!;
    const firstInitial = first.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    await firstEntity.execute("linqi", {
      proposal_id: "recovered-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await firstInitial.execute("bad-opening", {
      proposal_id: "recovered-bad-opening",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "linqi", field: "character.location", value: "unsupported-place" }],
        },
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);

    const retry = createCompilerProposalToolset(root);
    await retry.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const withdraw = retry.tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;
    const finish = retry.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await withdraw.execute("withdraw-recovered", {
      proposal_id: "recovered-bad-opening",
      reason: "The failed attempt referenced an unsupported location.",
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("finish-retry", {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recovered the valid entity proposal." }],
      summary: "Recovered and finished.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, proposalIds: ["recovered-linqi"] },
    });
  });

  it("rehydrates legacy full-EvidenceRef drafts while new recovery work uses handles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-legacy-recovery-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits in the Village.\n");
    const batchId = `batch-${fixture.source.id}-00001-legacy`;
    const service = new CompilerProposalService(root);
    await service.submit("entity", {
      proposalId: "legacy-hero",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
        evidence: fixture.evidence("Hero"),
      },
      generatedBy: { worker: "legacy-model", compilerBatchId: batchId },
    });

    const retry = createCompilerProposalToolset(root);
    await retry.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const entity = retry.tools.find((candidate) => candidate.name === "propose_entity")!;
    await entity.execute("new-location", {
      proposal_id: "handle-village",
      payload: {
        id: "village",
        kind: "location",
        canonicalName: "Village",
        aliases: [],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);

    const finish = retry.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    await expect(finish.execute("finish-legacy-recovery", {
      outcome: "complete",
      reviewed_segments: [{
        segment_id: fixture.segmentId,
        disposition: "proposed",
        summary: "Recovered the legacy character and added its location through a host handle.",
      }],
      summary: "Legacy and handle-backed drafts converge in one recovery batch.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: {
        compilerBatchFinished: true,
        proposalIds: ["handle-village", "legacy-hero"],
      },
    });
  });

  it("resets finish state only when the host starts a new compiler batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-batches-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Chapter 1\n林岐来到前厅。\nChapter 2\n王安随后到达。\n");
    const [firstSegment, secondSegment] = await new SegmentStore(root).list(fixture.source.id);
    expect(firstSegment).toBeDefined();
    expect(secondSegment).toBeDefined();
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    const input = {
      proposal_id: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
      },
      evidence_segment_ids: [firstSegment!.id],
    };

    await toolset.beginBatch([firstSegment!.id], undefined, fixture.source.id);
    await entity.execute("batch-1-proposal", input as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("missing-segment-review", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      reviewed_segments: [],
      summary: "first batch",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("account exactly once");
    await finish.execute("batch-1-finish", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      reviewed_segments: [{ segment_id: firstSegment!.id, disposition: "proposed", summary: "Recorded Lin Qi." }],
      summary: "first batch",
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(entity.execute("same-batch-late", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");

    await toolset.beginBatch([secondSegment!.id], undefined, fixture.source.id);
    await expect(entity.execute("batch-2-proposal", {
      proposal_id: "entity-wangan",
      payload: {
        id: "wangan",
        kind: "character",
        canonicalName: "王安",
        aliases: [],
      },
      evidence_segment_ids: [secondSegment!.id],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-wangan", kind: "entity" },
    });
    await expect(finish.execute("batch-2-finish", {
      outcome: "complete",
      proposal_ids: ["entity-wangan"],
      reviewed_segments: [{ segment_id: secondSegment!.id, disposition: "proposed", summary: "Reviewed the second segment." }],
      summary: "second batch",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { reviewedSegmentIds: [secondSegment!.id] },
    });
  });

  it("treats an identical partial-batch retry as idempotent but rejects changed content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-idempotent-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const input = {
      proposal_id: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
    };
    const first = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity")!;
    await first.execute("first-run", input as never, undefined, undefined, {} as ExtensionContext);
    const second = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity")!;
    await expect(second.execute("retry-run", input as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-linqi" },
    });
    await expect(second.execute("changed-run", {
      ...input,
      payload: { ...input.payload, canonicalName: "另一个林岐" },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("different content");
    await expect(new CompilerProposalService(root).store.list("pending")).resolves.toHaveLength(1);
  });

  it("never resurrects a withdrawn immutable proposal id from rejected history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-rejected-id-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const service = new CompilerProposalService(root);
    const input = {
      proposalId: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
      generatedBy: { worker: "test" },
    };
    await service.submit("entity", input);
    await service.withdraw(input.proposalId);
    await expect(service.submit("entity", input)).rejects.toThrow("already exists in rejected history");
  });

  it("versions only the proposal envelope when correcting a stable logical artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-stable-revision-id-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const withdraw = toolset.tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;
    await toolset.beginBatch([], "stable-revision-batch", fixture.source.id);
    const payload = {
      id: "linqi",
      kind: "character",
      canonicalName: "林岐",
      aliases: [],
    };

    await entity.execute("base", {
      proposal_id: "entity-linqi",
      payload,
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await withdraw.execute("withdraw-base", {
      proposal_id: "entity-linqi",
      reason: "The candidate needs a corrected envelope revision.",
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(entity.execute("bad-revision", {
      proposal_id: "entity-linqi-v2",
      payload: { ...payload, id: "linqi-v2" },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("Keep payload.id='linqi'");

    await expect(entity.execute("good-revision", {
      proposal_id: "entity-linqi-v2",
      payload,
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-linqi-v2" },
    });

    const chainedPayload = { ...payload, id: "linqi-alternate-v2" };
    await entity.execute("first-chained-revision", {
      proposal_id: "entity-linqi-alternate-v2",
      payload: chainedPayload,
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext);
    await withdraw.execute("withdraw-chained-revision", {
      proposal_id: "entity-linqi-alternate-v2",
      reason: "The first successful logical identity already carries a revision-looking suffix.",
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(entity.execute("bad-chained-revision", {
      proposal_id: "entity-linqi-alternate-v3",
      payload: { ...chainedPayload, id: "linqi-alternate-v3" },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("Keep payload.id='linqi-alternate-v2'");
  });
});
