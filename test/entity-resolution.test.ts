import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  EntityResolutionStore,
  generateEntityResolutionCandidates,
} from "../src/compiler/entity-resolution.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
const context = {} as ExtensionContext;

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("entity mention resolution", () => {
  it("blocks direct canonical acceptance when an activated mention inventory has no identity trace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entity-resolution-bypass-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Lone arrived.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-mention-only`, fixture.source.id);
    await toolset.tools.find((tool) => tool.name === "propose_entity_mention")!.execute("mention", {
      proposal_id: "proposal-mention-lone",
      annotation_id: "mention-lone",
      selector: { segment_id: fixture.segmentId, exact: "Lone" },
      surface: "Lone",
      form: "proper",
      kind_candidates: ["character"],
      confidence: 1,
    } as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Recorded the mention without forcing identity.");

    await new CompilerProposalService(root).submit("entity", {
      proposalId: "direct-entity-lone",
      payload: {
        id: "lone",
        kind: "character",
        canonicalName: "Lone",
        aliases: [],
        evidence: fixture.evidence("Lone"),
      },
      generatedBy: { worker: "bypass-test" },
    });
    await expect(new CompilerCommitService(root).accept("entity", "direct-entity-lone"))
      .resolves.toMatchObject({
        accepted: false,
        errors: [expect.objectContaining({ code: "MISSING_ENTITY_RESOLUTION_TRACE" })],
      });
    await expect(new CanonicalModelStore(root).listEntities()).resolves.toEqual([]);
  });

  it("requires canonical names and aliases to trace through explicit new-entity resolutions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entity-resolution-new-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero, known as the traveler, arrived.\n");
    const batchId = `batch-${fixture.source.id}-entity-resolution`;
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "resolution-model" });
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const mention = toolset.tools.find((tool) => tool.name === "propose_entity_mention")!;
    const entity = toolset.tools.find((tool) => tool.name === "propose_entity")!;
    const resolve = toolset.tools.find((tool) => tool.name === "propose_entity_resolution")!;
    const findCandidates = toolset.tools.find((tool) => tool.name === "find_entity_resolution_candidates")!;
    const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;

    await mention.execute("hero-mention", {
      proposal_id: "proposal-mention-hero",
      annotation_id: "mention-hero",
      selector: { segment_id: fixture.segmentId, exact: "Hero" },
      surface: "Hero",
      form: "proper",
      kind_candidates: ["character"],
      confidence: 1,
    } as never, undefined, undefined, context);
    await mention.execute("traveler-mention", {
      proposal_id: "proposal-mention-traveler",
      annotation_id: "mention-traveler",
      selector: { segment_id: fixture.segmentId, exact: "the traveler" },
      surface: "the traveler",
      form: "nominal",
      kind_candidates: ["character"],
      confidence: 0.95,
    } as never, undefined, undefined, context);
    await entity.execute("hero-entity", {
      proposal_id: "proposal-entity-hero",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: ["the traveler"],
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);

    const lexical = JSON.parse(resultText(await findCandidates.execute("find-traveler", {
      mention_id: "mention-traveler",
    } as never, undefined, undefined, context))) as {
      candidates: Array<{ entityId: string; matchedText: string; match: string; status: string }>;
    };
    expect(lexical.candidates).toContainEqual({
      entityId: "hero",
      matchedText: "the traveler",
      match: "exact-alias",
      status: "pending",
      entityKind: "character",
      canonicalName: "Hero",
    });

    await resolve.execute("resolve-hero", resolutionInput({
      proposalId: "proposal-resolution-hero",
      resolutionId: "resolution-hero",
      mentionId: "mention-hero",
      status: "new-entity",
      entityId: "hero",
      confidence: 0.99,
    }) as never, undefined, undefined, context);
    await expect(finish.execute("finish-without-alias-trace", finishInput(
      fixture.segmentId,
      "The canonical name is resolved but the alias is not yet classified.",
    ) as never, undefined, undefined, context)).rejects.toThrow("alias 'the traveler'");

    await resolve.execute("resolve-traveler", {
      ...resolutionInput({
        proposalId: "proposal-resolution-traveler",
        resolutionId: "resolution-traveler",
        mentionId: "mention-traveler",
        status: "new-entity",
        entityId: "hero",
        confidence: 0.95,
      }),
      alias_type: "other",
    } as never, undefined, undefined, context);
    await expect(finish.execute("finish-with-trace", finishInput(
      fixture.segmentId,
      "Both canonical and alias surfaces have explicit mention-to-entity decisions.",
    ) as never, undefined, undefined, context)).resolves.toMatchObject({
      details: {
        compilerBatchFinished: true,
        proposalIds: [
          "proposal-entity-hero",
          "proposal-mention-hero",
          "proposal-mention-traveler",
          "proposal-resolution-hero",
          "proposal-resolution-traveler",
        ],
      },
    });
    await expect(new CanonicalModelStore(root).listEntities()).resolves.toEqual([]);
    await expect(new CompilerCommitService(root).accept("entity", "proposal-entity-hero"))
      .resolves.toMatchObject({ accepted: true, errors: [] });
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({
      canonicalName: "Hero",
      aliases: ["the traveler"],
    });
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      resolutions: {
        entityMentions: 2,
        resolved: 0,
        newEntities: 2,
        ambiguous: 0,
        unresolved: 0,
        missing: 0,
        pending: 0,
        invalid: 0,
      },
      coverage: { entityResolution: 1 },
      readiness: { resolution: "ready" },
    });
  });

  it("generates deterministic kind-compatible lexical candidates and preserves ambiguity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entity-resolution-ambiguous-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Alice and Bob were both called Captain. Captain entered.\n");
    const canonical = new CanonicalModelStore(root);
    await canonical.putEntity({
      id: "alice",
      kind: "character",
      canonicalName: "Alice",
      aliases: ["Captain"],
      evidence: fixture.evidence("Alice and Bob were both called Captain"),
    });
    await canonical.putEntity({
      id: "bob",
      kind: "character",
      canonicalName: "Bob",
      aliases: ["Captain"],
      evidence: fixture.evidence("Alice and Bob were both called Captain"),
    });
    await canonical.putEntity({
      id: "captains-room",
      kind: "location",
      canonicalName: "Captain",
      aliases: [],
      evidence: fixture.evidence("Captain", 0),
    });
    const batchId = `batch-${fixture.source.id}-ambiguous`;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const mention = toolset.tools.find((tool) => tool.name === "propose_entity_mention")!;
    const resolve = toolset.tools.find((tool) => tool.name === "propose_entity_resolution")!;
    await mention.execute("captain-mention", {
      proposal_id: "proposal-mention-captain",
      annotation_id: "mention-captain",
      selector: { segment_id: fixture.segmentId, exact: "Captain", occurrence: 2 },
      surface: "Captain",
      form: "title",
      kind_candidates: ["character"],
      confidence: 0.8,
    } as never, undefined, undefined, context);

    const generated = await generateEntityResolutionCandidates(root, fixture.source.id, "mention-captain", batchId);
    expect(generated.candidates.map(({ entityId }) => entityId)).toEqual(["alice", "bob"]);
    expect(generated.candidates.every((candidate) => candidate.match === "exact-alias")).toBe(true);

    await resolve.execute("ambiguous-captain", {
      proposal_id: "proposal-resolution-captain-ambiguous",
      resolution_id: "resolution-captain-ambiguous",
      mention_id: "mention-captain",
      status: "ambiguous",
      candidates: [
        candidate("alice", "mention-captain", 0.5),
        candidate("bob", "mention-captain", 0.5),
      ],
      rationale: "The repeated title is compatible with either previously introduced captain.",
    } as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Preserved the title's two-way ambiguity.");

    const ambiguous = await new EntityResolutionStore(root).currentForMention(fixture.source.id, "mention-captain");
    expect(ambiguous).toMatchObject({ status: "ambiguous" });
    expect(ambiguous).not.toHaveProperty("entityId");
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      resolutions: { ambiguous: 1, missing: 0 },
      coverage: { entityResolution: 0 },
      readiness: { resolution: "not-ready" },
    });
  });

  it("requires immutable superseding revisions and restores the prior ambiguous decision on rollback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entity-resolution-revision-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Alice and Bob heard Captain.\n");
    const canonical = new CanonicalModelStore(root);
    for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]] as const) {
      await canonical.putEntity({
        id,
        kind: "character",
        canonicalName: name,
        aliases: ["Captain"],
        evidence: fixture.evidence(`${name}`),
      });
    }
    const firstBatch = `batch-${fixture.source.id}-resolution-one`;
    const first = createCompilerProposalToolset(root);
    await first.beginBatch([fixture.segmentId], firstBatch, fixture.source.id);
    await first.tools.find((tool) => tool.name === "propose_entity_mention")!.execute("mention", {
      proposal_id: "proposal-mention-captain",
      annotation_id: "mention-captain",
      selector: { segment_id: fixture.segmentId, exact: "Captain" },
      surface: "Captain",
      form: "title",
      kind_candidates: ["character"],
      confidence: 0.7,
    } as never, undefined, undefined, context);
    await first.tools.find((tool) => tool.name === "propose_entity_resolution")!.execute("ambiguous", {
      proposal_id: "proposal-resolution-ambiguous",
      resolution_id: "resolution-ambiguous",
      mention_id: "mention-captain",
      status: "ambiguous",
      candidates: [candidate("alice", "mention-captain", 0.5), candidate("bob", "mention-captain", 0.5)],
      rationale: "The title alone is ambiguous.",
    } as never, undefined, undefined, context);
    await finishOnly(first, fixture.segmentId, "Stored the ambiguity.");

    const secondBatch = `batch-${fixture.source.id}-resolution-two`;
    const second = createCompilerProposalToolset(root);
    await second.beginBatch([fixture.segmentId], secondBatch, fixture.source.id);
    const resolve = second.tools.find((tool) => tool.name === "propose_entity_resolution")!;
    await resolve.execute("invalid-in-place-revision", {
      proposal_id: "proposal-resolution-invalid-revision",
      resolution_id: "resolution-ambiguous",
      mention_id: "mention-captain",
      status: "resolved",
      entity_id: "alice",
      candidates: [candidate("alice", "mention-captain", 0.9)],
      supersedes_resolution_id: "resolution-ambiguous",
      rationale: "Later local context identifies Alice.",
    } as never, undefined, undefined, context);
    const finish = second.tools.find((tool) => tool.name === "finish_compiler_batch")!;
    await expect(finish.execute("finish-invalid-revision", finishInput(
      fixture.segmentId,
      "Attempted an in-place revision.",
    ) as never, undefined, undefined, context)).rejects.toThrow("must use a new resolution id");
    await second.tools.find((tool) => tool.name === "withdraw_compiler_proposal")!.execute("withdraw-invalid", {
      proposal_id: "proposal-resolution-invalid-revision",
      reason: "A resolution revision must have a new immutable logical ID.",
    } as never, undefined, undefined, context);
    await resolve.execute("valid-revision", {
      proposal_id: "proposal-resolution-alice",
      resolution_id: "resolution-captain-alice",
      mention_id: "mention-captain",
      status: "resolved",
      entity_id: "alice",
      candidates: [candidate("alice", "mention-captain", 0.9)],
      supersedes_resolution_id: "resolution-ambiguous",
      rationale: "Later local context identifies Alice.",
    } as never, undefined, undefined, context);
    await finishOnly(second, fixture.segmentId, "Superseded the ambiguity with Alice.");
    const store = new EntityResolutionStore(root);
    await expect(store.currentForMention(fixture.source.id, "mention-captain"))
      .resolves.toMatchObject({ id: "resolution-captain-alice", status: "resolved", entityId: "alice" });

    await expect(store.rejectBatch(secondBatch)).resolves.toEqual(["proposal-resolution-alice"]);
    await expect(store.currentForMention(fixture.source.id, "mention-captain"))
      .resolves.toMatchObject({ id: "resolution-ambiguous", status: "ambiguous" });
  });

  it("exposes source-scoped paged resolution retrieval and unresolved queues", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entity-resolution-retrieval-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Someone waited.\n");
    const batchId = `batch-${fixture.source.id}-unresolved`;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    await toolset.tools.find((tool) => tool.name === "propose_entity_mention")!.execute("someone", {
      proposal_id: "proposal-mention-someone",
      annotation_id: "mention-someone",
      selector: { segment_id: fixture.segmentId, exact: "Someone" },
      surface: "Someone",
      form: "nominal",
      kind_candidates: ["character"],
      confidence: 0.5,
    } as never, undefined, undefined, context);
    await toolset.tools.find((tool) => tool.name === "propose_entity_resolution")!.execute("unresolved", {
      proposal_id: "proposal-resolution-someone",
      resolution_id: "resolution-someone-unresolved",
      mention_id: "mention-someone",
      status: "unresolved",
      candidates: [],
      rationale: "x".repeat(1_500),
    } as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Preserved an unresolved nominal mention.");

    const find = toolset.tools.find((tool) => tool.name === "find_identity_resolutions")!;
    const read = toolset.tools.find((tool) => tool.name === "read_identity_resolution")!;
    const found = JSON.parse(resultText(await find.execute("find-unresolved", {
      query: "*",
      resolution_status: "unresolved",
    } as never, undefined, undefined, context))) as { results: Array<{ ref: string }>; returned: number };
    expect(found.returned).toBe(1);
    const firstPage = JSON.parse(resultText(await read.execute("read-one", {
      ref: found.results[0]!.ref,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { chunk: string; nextOffset: number };
    expect(firstPage.chunk).toHaveLength(1_000);
    const secondPage = JSON.parse(resultText(await read.execute("read-two", {
      ref: found.results[0]!.ref,
      offset: firstPage.nextOffset,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { chunk: string; nextOffset?: number };
    expect(secondPage.chunk.length).toBeGreaterThan(0);
    expect(secondPage.nextOffset).toBe(2_000);
    const thirdPage = JSON.parse(resultText(await read.execute("read-three", {
      ref: found.results[0]!.ref,
      offset: secondPage.nextOffset,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { chunk: string; nextOffset?: number };
    expect(thirdPage.chunk.length).toBeGreaterThan(0);
    expect(thirdPage.nextOffset).toBeUndefined();
  });
});

function resolutionInput(input: {
  proposalId: string;
  resolutionId: string;
  mentionId: string;
  status: "new-entity" | "resolved";
  entityId: string;
  confidence: number;
}) {
  return {
    proposal_id: input.proposalId,
    resolution_id: input.resolutionId,
    mention_id: input.mentionId,
    status: input.status,
    entity_id: input.entityId,
    candidates: [candidate(input.entityId, input.mentionId, input.confidence)],
    rationale: `The source context maps ${input.mentionId} to ${input.entityId}.`,
  };
}

function candidate(entityId: string, mentionId: string, confidence: number) {
  return {
    entity_id: entityId,
    confidence,
    basis_mention_ids: [mentionId],
    evidence_assertion_ids: [],
    rationale: `Mention ${mentionId} is compatible with ${entityId}.`,
  };
}

function finishInput(segmentId: string, summary: string) {
  return {
    outcome: "complete",
    reviewed_segments: [{ segment_id: segmentId, disposition: "proposed", summary }],
    summary,
  };
}

async function finishOnly(
  toolset: ReturnType<typeof createCompilerProposalToolset>,
  segmentId: string,
  summary: string,
): Promise<void> {
  await toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!
    .execute(`finish-${summary}`, finishInput(segmentId, summary) as never, undefined, undefined, context);
}

function resultText(result: { content: readonly unknown[] }): string {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected a text tool result.");
  return first.text;
}
