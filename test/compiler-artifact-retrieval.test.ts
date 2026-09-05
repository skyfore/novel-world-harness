import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n");
}

describe("compiler artifact retrieval", () => {
  it("normalizes the event alias and rejects unsupported kinds instead of returning a silent miss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-kind-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The Hall opens. Hero enters the Hall.\n");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    await canon.putEvent({
      id: "hall-opens",
      title: "The Hall opens",
      participants: [],
      storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: fixture.evidence("The Hall opens"),
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "hero-enters",
      title: "Hero enters",
      participants: ["hero"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "entry", orderHint: 2 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: fixture.evidence("Hero enters"),
      causalParents: ["hall-opens"],
      confidence: 1,
    });
    await canon.putEventParticipation({
      id: "hero-enters-hero-agent",
      eventId: "hero-enters",
      entityId: "hero",
      role: "agent",
      presence: "physical",
      confidence: 1,
      evidence: fixture.evidence("Hero enters"),
    });
    await canon.putEventRelation({
      id: "hall-opens-enables-entry",
      fromEventId: "hall-opens",
      toEventId: "hero-enters",
      type: "enables",
      operationality: "necessary",
      status: "explicit",
      confidence: 1,
      mechanism: "The opened Hall permits the Hero to enter.",
      evidence: fixture.evidence("The Hall opens. Hero enters the Hall."),
    });
    await canon.putActionSchema({
      ontologyVersion: "action-schema-v1", initiatorRoleId: "entrant",
      id: "enter-hall",
      name: "Enter the Hall",
      roles: [{ id: "entrant", label: "entrant", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      parameters: [],
      preconditions: [],
      stateEffects: [],
      effectEnvelope: {
        maxStateOperations: 1,
        allowedStateFields: ["character.location"],
        allowsKnowledge: false,
        allowsTimeAdvance: false,
        allowsSceneTransition: true,
      },
      induction: { kind: "source-pattern", supportingEventIds: ["hall-opens", "hero-enters"] },
      evidence: fixture.evidence("The Hall opens. Hero enters the Hall."),
    });
    await canon.putActionConstraint({
      ontologyVersion: "action-constraint-v1",
      id: "hall-must-be-open",
      name: "The Hall must be open before entry",
      actionPattern: { kind: "schema", schemaId: "enter-hall" },
      appliesWhen: [],
      clauses: [{
        id: "open-before-entry",
        timing: "before",
        modality: "require",
        predicate: { op: "fact-equals", entity: { kind: "actor" }, field: "character.alive", value: true },
      }],
      exceptions: [],
      priority: 10,
      defeasible: true,
      overridesConstraintIds: [],
      status: "supported",
      visibility: "public",
      induction: { kind: "source-pattern", supportingEventIds: ["hero-enters"] },
      evidence: fixture.evidence("Hero enters the Hall."),
    });
    await canon.putNormTemplate({
      ontologyVersion: "norm-template-v1",
      id: "enter-only-when-open",
      name: "Enter only when the Hall is open",
      modality: "obligation",
      actionPattern: { kind: "schema", schemaId: "enter-hall" },
      appliesWhen: [],
      exceptions: [],
      reparations: [],
      priority: 10,
      defeasible: true,
      overridesTemplateIds: [],
      status: "supported",
      visibility: "public",
      knownByClaimIds: [],
      induction: { kind: "source-pattern", supportingEventIds: ["hall-opens", "hero-enters"] },
      evidence: fixture.evidence("The Hall opens. Hero enters the Hall."),
    });
    await canon.putProcessTemplate({
      ontologyVersion: "process-template-v1",
      id: "hall-entry",
      name: "Hall entry",
      ownerRoles: [{ id: "entrant", label: "entrant", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "outside", label: "Outside", terminal: false }, { id: "inside", label: "Inside", terminal: true }],
      initialPhaseId: "outside",
      transitions: [{ fromPhaseId: "outside", toPhaseId: "inside", minimumProgress: 1 }],
      outcomeIds: ["inside"],
      visibility: "observable",
      induction: { kind: "source-pattern", supportingEventIds: ["hall-opens", "hero-enters"] },
      evidence: fixture.evidence("The Hall opens. Hero enters the Hall."),
    });
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "batch-kind", fixture.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;

    const result = JSON.parse(resultText(await find.execute(
      "event-alias",
      { query: "Hero enters", kind: "event" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { kind: string; results: Array<{ ref: string; kind: string }> };
    expect(result.kind).toBe("canonical-event");
    expect(result.results).toEqual([
      expect.objectContaining({ ref: "canonical:canonical-event:hero-enters", kind: "canonical-event" }),
    ]);
    const participationResult = JSON.parse(resultText(await find.execute(
      "participation-kind",
      { query: "*", kind: "event-participation" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { results: Array<{ ref: string; kind: string }> };
    expect(participationResult.results).toEqual([
      expect.objectContaining({
        ref: "canonical:event-participation:hero-enters-hero-agent",
        kind: "event-participation",
      }),
    ]);
    const relationResult = JSON.parse(resultText(await find.execute(
      "relation-kind",
      { query: "*", kind: "event-relation" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { results: Array<{ ref: string; kind: string }> };
    expect(relationResult.results).toEqual([
      expect.objectContaining({
        ref: "canonical:event-relation:hall-opens-enables-entry",
        kind: "event-relation",
      }),
    ]);
    for (const [kind, ref] of [
      ["action-constraint", "canonical:action-constraint:hall-must-be-open"],
      ["norm-template", "canonical:norm-template:enter-only-when-open"],
      ["process-template", "canonical:process-template:hall-entry"],
    ] as const) {
      const found = JSON.parse(resultText(await find.execute(
        `find-${kind}`,
        { query: "*", kind } as never,
        undefined,
        undefined,
        {} as ExtensionContext,
      ))) as { results: Array<{ ref: string; kind: string }> };
      expect(found.results).toEqual([expect.objectContaining({ ref, kind })]);
    }
    await expect(find.execute(
      "bad-kind",
      { query: "*", kind: "eventuality" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("Unsupported compiler artifact kind 'eventuality'");
  });

  it("finds and losslessly pages exact artifacts only within the active source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-retrieval-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero enters the Hall.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Villain enters the Lair.\n", "second.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: first.evidence("Hero"),
    });
    await canon.putEntity({
      id: "villain",
      kind: "character",
      canonicalName: "Villain",
      aliases: [],
      evidence: second.evidence("Villain"),
    });
    await canon.putClaim({
      id: "long-note",
      subject: "hero",
      predicate: "carries-note",
      object: `${"x".repeat(1_500)}😀${"x".repeat(33_500)}`,
      epistemicType: "explicit-fact",
      evidence: first.evidence("Hero"),
    });
    await canon.putProposition({
      id: "hero-present",
      subjectEntityId: "hero",
      relationId: "present-at",
      object: { kind: "literal", value: "Hall" },
      polarity: "positive",
      modality: "asserted",
      evidence: first.evidence("Hero enters the Hall"),
    });
    await canon.putAttribution({
      id: "narrator-hero-present",
      propositionId: "hero-present",
      holderKind: "narrator",
      attitude: "asserts",
      certainty: 1,
      evidence: first.evidence("Hero enters the Hall"),
    });

    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "batch-first", first.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;
    const read = toolset.tools.find((tool) => tool.name === "read_compiler_artifact")!;
    const found = resultText(await find.execute(
      "find",
      { query: "*", max_results: 50 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    expect(found).toContain("canonical:entity:hero");
    expect(found).toContain("canonical:proposition:hero-present");
    expect(found).toContain("canonical:attribution:narrator-hero-present");
    expect(found).not.toContain("villain");

    const firstIndexPage = JSON.parse(resultText(await find.execute(
      "find-page",
      { query: "*", offset: 0, max_results: 1 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { returned: number; totalMatches: number; nextOffset?: number };
    expect(firstIndexPage).toMatchObject({ returned: 1, totalMatches: 4, nextOffset: 1 });

    const firstChunk = resultText(await read.execute(
      "read",
      { ref: "canonical:entity:hero", offset: 0, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    const firstEnvelope = JSON.parse(firstChunk) as { ref: string; chunk: string };
    expect(firstEnvelope.ref).toBe("canonical:entity:hero");
    expect(firstEnvelope.chunk).toContain('"canonicalName":"Hero"');
    expect(firstEnvelope.chunk).not.toContain("Villain");

    const paged = resultText(await read.execute(
      "read-long",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    expect(JSON.parse(paged)).toMatchObject({ nextOffset: 1_000, offset: 0, end: 1_000 });
    expect(paged.length).toBeLessThan(1_500);

    const probe = JSON.parse(resultText(await read.execute(
      "probe-unicode",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: 30_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { chunk: string };
    const emojiOffset = probe.chunk.indexOf("😀");
    expect(emojiOffset).toBeGreaterThan(1_000);
    const unicodePage = JSON.parse(resultText(await read.execute(
      "page-unicode",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: emojiOffset + 1 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { end: number; nextOffset: number; chunk: string };
    expect(unicodePage.end).toBe(emojiOffset);
    expect(unicodePage.nextOffset).toBe(emojiOffset);
    expect(unicodePage.chunk.endsWith("\uD83D")).toBe(false);
    await expect(read.execute(
      "split-unicode",
      { ref: "canonical:claim:long-note", offset: emojiOffset + 1, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("splits a Unicode surrogate pair");
  });

  it("refuses retrieval before a source-scoped batch is bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-unbound-"));
    roots.push(root);
    const toolset = createCompilerProposalToolset(root);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;
    await expect(find.execute(
      "find",
      { query: "*" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("active source-scoped batch");
  });

  it("fails closed instead of exposing a legacy artifact with mixed-source evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-mixed-source-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero enters.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Other hero enters.\n", "second.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "legacy-mixed-hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: [...first.evidence("Hero"), ...second.evidence("Other hero")],
    });
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "batch-first", first.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;

    await expect(find.execute(
      "find",
      { query: "*" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("mixes evidence from multiple novel sources");
  });
});
