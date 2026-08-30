import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler } from "../src/compiler/audit.js";
import { quarantineInvalidResolutionBindings } from "../src/compiler/converge.js";
import {
  EventResolutionStore,
  generateEventResolutionCandidates,
} from "../src/compiler/event-resolution.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import type { CanonicalEvent } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
const context = {} as ExtensionContext;

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("event mention resolution", () => {
  it("quarantines an accepted event resolution when its canonical event did not survive convergence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-dangling-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Rain began.\n");
    const store = new EventResolutionStore(root);
    await store.stage(fixture.source.id, {
      version: 1,
      id: "dangling-event-resolution-proposal",
      payload: {
        version: 1,
        id: "dangling-event-resolution",
        sourceId: fixture.source.id,
        eventMentionIds: ["missing-event-mention"],
        status: "new-event",
        canonicalEventId: "event-that-was-rejected",
        relation: "coreference",
        candidates: [{
          canonicalEventId: "event-that-was-rejected",
          relation: "coreference",
          confidence: 1,
          basisEventMentionIds: ["missing-event-mention"],
          evidenceAssertionIds: [],
          rationale: "The proposal originally selected this event.",
        }],
        supersedesResolutionIds: [],
        rationale: "Exercise deterministic dangling-reference cleanup.",
        derivation: {
          runId: "dangling-resolution-test",
          worker: "test",
          ontologyVersion: "event-resolution-v1",
        },
      },
      generatedBy: { worker: "test" },
      createdAt: new Date(0).toISOString(),
    });
    await store.commitProposals(fixture.source.id, ["dangling-event-resolution-proposal"]);
    await expect(store.list(fixture.source.id)).resolves.toHaveLength(1);

    await expect(quarantineInvalidResolutionBindings(root, fixture.source.id)).resolves.toEqual([{
      id: "dangling-event-resolution-proposal",
      kind: "event-resolution",
    }]);

    await expect(store.list(fixture.source.id)).resolves.toEqual([]);
    await expect(store.listProposals(fixture.source.id, "accepted")).resolves.toEqual([]);
    await expect(store.listProposals(fixture.source.id, "rejected")).resolves.toEqual([
      expect.objectContaining({ id: "dangling-event-resolution-proposal" }),
    ]);
  });

  it("blocks direct canonical-event acceptance when event mentions have no identity trace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-bypass-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Rain began.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-event-mention-only`, fixture.source.id);
    await proposeEventMention(toolset, fixture.segmentId, {
      proposalId: "proposal-mention-rain",
      mentionId: "mention-rain-began",
      trigger: "began",
      extent: "Rain began.",
      types: ["natural-process", "state-change"],
      salience: "major",
    });
    await finishOnly(toolset, fixture.segmentId, "Recorded an event mention without forcing event identity.");

    await new CompilerProposalService(root).submit("canonical-event", {
      proposalId: "direct-event-rain",
      payload: canonicalEvent(fixture, "rain-begins", "Rain begins", "Rain began."),
      generatedBy: { worker: "bypass-test" },
    });
    await expect(new CompilerCommitService(root).accept("canonical-event", "direct-event-rain"))
      .resolves.toMatchObject({
        accepted: false,
        errors: [expect.objectContaining({ code: "MISSING_EVENT_RESOLUTION_TRACE" })],
      });
    await expect(new CanonicalModelStore(root).listEvents()).resolves.toEqual([]);
  });

  it("rejects a canonical participant that is absent from the resolved event-mention cluster", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-participant-trace-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero opened the gate.\n");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-missing-event-participant`, fixture.source.id);
    await proposeEventMention(toolset, fixture.segmentId, {
      proposalId: "proposal-mention-open-without-hero",
      mentionId: "mention-open-without-hero",
      trigger: "opened",
      extent: "Hero opened the gate.",
      types: ["state-change"],
      participantMentionIds: [],
      salience: "major",
    });
    await toolset.tools.find((tool) => tool.name === "propose_canonical_event")!.execute("event", {
      proposal_id: "proposal-event-with-untraced-hero",
      payload: {
        id: "event-with-untraced-hero",
        title: "Hero opens the gate",
        participants: ["hero"],
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        causalParents: [],
        confidence: 0.9,
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);
    await toolset.tools.find((tool) => tool.name === "propose_event_resolution")!.execute("resolution", eventResolutionInput({
      proposalId: "proposal-resolution-without-hero",
      resolutionId: "resolution-without-hero",
      mentionIds: ["mention-open-without-hero"],
      status: "new-event",
      canonicalEventId: "event-with-untraced-hero",
      relation: "coreference",
    }) as never, undefined, undefined, context);
    await expect(finishOnly(toolset, fixture.segmentId, "Attempted an event without participant mention trace."))
      .rejects.toThrow("participant 'hero'");
    await expect(new EventResolutionStore(root).list(fixture.source.id)).resolves.toEqual([]);
  });

  it("grounds a new canonical event and all participants through same-finish mention resolutions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-new-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero opened the gate.\n");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const batchId = `batch-${fixture.source.id}-event-new`;
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "event-resolution-model" });
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const entityMention = toolset.tools.find((tool) => tool.name === "propose_entity_mention")!;
    const identity = toolset.tools.find((tool) => tool.name === "propose_entity_resolution")!;
    const eventProposal = toolset.tools.find((tool) => tool.name === "propose_canonical_event")!;
    const eventResolution = toolset.tools.find((tool) => tool.name === "propose_event_resolution")!;

    await entityMention.execute("hero", {
      proposal_id: "proposal-mention-hero-event",
      annotation_id: "mention-hero-event",
      selector: { segment_id: fixture.segmentId, exact: "Hero" },
      surface: "Hero",
      form: "proper",
      kind_candidates: ["character"],
      confidence: 1,
    } as never, undefined, undefined, context);
    await identity.execute("resolve-hero", {
      proposal_id: "proposal-identity-hero-event",
      resolution_id: "identity-hero-event",
      mention_id: "mention-hero-event",
      status: "resolved",
      entity_id: "hero",
      candidates: [{
        entity_id: "hero",
        confidence: 1,
        basis_mention_ids: ["mention-hero-event"],
        evidence_assertion_ids: [],
        rationale: "The exact proper name matches the canonical character.",
      }],
      rationale: "The source mention identifies Hero.",
    } as never, undefined, undefined, context);
    await proposeEventMention(toolset, fixture.segmentId, {
      proposalId: "proposal-mention-open-gate",
      mentionId: "mention-open-gate",
      trigger: "opened",
      extent: "Hero opened the gate.",
      types: ["state-change"],
      participantMentionIds: ["mention-hero-event"],
      salience: "major",
    });
    await eventProposal.execute("event", {
      proposal_id: "proposal-event-open-gate",
      payload: {
        id: "hero-opens-gate",
        title: "Hero opens the gate",
        participants: ["hero"],
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        causalParents: [],
        confidence: 0.98,
      },
      evidence_segment_ids: [fixture.segmentId],
    } as never, undefined, undefined, context);

    const generated = await generateEventResolutionCandidates(
      root,
      fixture.source.id,
      "mention-open-gate",
      batchId,
    );
    expect(generated.candidates).toContainEqual(expect.objectContaining({
      canonicalEventId: "hero-opens-gate",
      status: "pending",
      participantEntityIds: ["hero"],
      matchedParticipantEntityIds: ["hero"],
      signals: expect.arrayContaining(["evidence-overlap", "participant-overlap"]),
    }));

    await eventResolution.execute("resolve-event", eventResolutionInput({
      proposalId: "proposal-resolution-open-gate",
      resolutionId: "resolution-open-gate",
      mentionIds: ["mention-open-gate"],
      status: "new-event",
      canonicalEventId: "hero-opens-gate",
      relation: "coreference",
    }) as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Resolved the participant and event occurrence explicitly.");
    const retry = createCompilerProposalToolset(root, { provider: "test", model: "event-resolution-model" });
    await retry.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    await finishOnly(retry, fixture.segmentId, "Recovered the already committed resolution handshake.");
    await expect(new CanonicalModelStore(root).listEvents()).resolves.toEqual([]);
    await expect(new CompilerCommitService(root).accept("canonical-event", "proposal-event-open-gate"))
      .resolves.toMatchObject({ accepted: true, errors: [] });
    await expect(new CanonicalModelStore(root).getEvent("hero-opens-gate"))
      .resolves.toMatchObject({ participants: ["hero"] });
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      eventResolutions: {
        eventMentions: 1,
        majorEventMentions: 1,
        resolved: 0,
        newEvents: 1,
        ambiguous: 0,
        unresolved: 0,
        missing: 0,
        pending: 0,
        majorResolved: 1,
        majorIncomplete: 0,
        invalid: 0,
      },
      coverage: { majorEventResolution: 1 },
      readiness: { resolution: "ready" },
    });
  });

  it("preserves ambiguous candidates instead of merging events from overlap alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-ambiguous-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The chronicle said the bell rang.\n");
    const canon = new CanonicalModelStore(root);
    await canon.putEvent(canonicalEvent(fixture, "bell-rings-first", "The bell rings", "the bell rang"));
    await canon.putEvent(canonicalEvent(fixture, "bell-rings-again", "The bell rings again", "the bell rang"));
    const batchId = `batch-${fixture.source.id}-event-ambiguous`;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    await proposeEventMention(toolset, fixture.segmentId, {
      proposalId: "proposal-mention-bell",
      mentionId: "mention-bell-rang",
      trigger: "rang",
      extent: "the bell rang",
      types: ["natural-process"],
      salience: "major",
    });
    const generated = await generateEventResolutionCandidates(root, fixture.source.id, "mention-bell-rang", batchId);
    expect(generated.candidates.map((candidate) => candidate.canonicalEventId))
      .toEqual(["bell-rings-again", "bell-rings-first"]);

    const resolve = toolset.tools.find((tool) => tool.name === "propose_event_resolution")!;
    await resolve.execute("ambiguous", {
      proposal_id: "proposal-resolution-bell-ambiguous",
      resolution_id: "resolution-bell-ambiguous",
      event_mention_ids: ["mention-bell-rang"],
      status: "ambiguous",
      candidates: [
        eventCandidate("bell-rings-first", ["mention-bell-rang"], "coreference", 0.5),
        eventCandidate("bell-rings-again", ["mention-bell-rang"], "coreference", 0.5),
      ],
      supersedes_resolution_ids: [],
      rationale: "The chronicle does not identify which ringing occurrence it repeats.",
    } as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Preserved two plausible event identities.");
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      eventResolutions: { ambiguous: 1, missing: 0, majorIncomplete: 1 },
      coverage: { majorEventResolution: 0 },
      readiness: { resolution: "not-ready" },
    });
  });

  it("completes a diffuse summary as non-referential without inventing an occurrence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-non-referential-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Many challenges followed.\n");
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], `batch-${fixture.source.id}-non-referential-event`, fixture.source.id);
    await proposeEventMention(toolset, fixture.segmentId, {
      proposalId: "proposal-mention-challenges",
      mentionId: "mention-challenges",
      trigger: "challenges followed",
      extent: "Many challenges followed.",
      types: ["other"],
      salience: "major",
      interpretation: "A diffuse summary covering no single narrated occurrence.",
    });
    await toolset.tools.find((tool) => tool.name === "propose_event_resolution")!.execute("resolution", {
      proposal_id: "proposal-resolution-challenges",
      resolution_id: "resolution-challenges",
      event_mention_ids: ["mention-challenges"],
      status: "non-referential",
      candidates: [],
      supersedes_resolution_ids: [],
      rationale: "The exact summary phrase intentionally ranges over multiple developments and has no single canonical-event referent.",
    } as never, undefined, undefined, context);
    await finishOnly(toolset, fixture.segmentId, "Adjudicated the diffuse summary without creating an occurrence.");

    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      eventResolutions: {
        eventMentions: 1,
        majorEventMentions: 1,
        nonReferential: 1,
        majorNonReferential: 1,
        majorIncomplete: 0,
        ambiguous: 0,
        unresolved: 0,
        missing: 0,
      },
      coverage: { majorEventResolution: 1 },
      readiness: { resolution: "ready" },
    });
  });

  it("splits and rolls back immutable event clusters while exposing paged retrieval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-resolution-split-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The battle began. Later, witnesses recalled the battle.\n");
    await new CanonicalModelStore(root).putEvent(canonicalEvent(fixture, "battle", "The battle", "The battle began"));
    const firstBatch = `batch-${fixture.source.id}-event-cluster-one`;
    const first = createCompilerProposalToolset(root);
    await first.beginBatch([fixture.segmentId], firstBatch, fixture.source.id);
    await proposeEventMention(first, fixture.segmentId, {
      proposalId: "proposal-mention-battle-one",
      mentionId: "mention-battle-one",
      trigger: "battle",
      triggerOccurrence: 1,
      extent: "The battle began.",
      types: ["conflict"],
      salience: "major",
    });
    await proposeEventMention(first, fixture.segmentId, {
      proposalId: "proposal-mention-battle-two",
      mentionId: "mention-battle-two",
      trigger: "battle",
      triggerOccurrence: 2,
      extent: "witnesses recalled the battle",
      types: ["conflict"],
      salience: "supporting",
      interpretation: "This may be a recollective mention of the same battle.",
    });
    await first.tools.find((tool) => tool.name === "propose_event_resolution")!.execute("cluster", {
      proposal_id: "proposal-resolution-battle-cluster",
      resolution_id: "resolution-battle-cluster",
      event_mention_ids: ["mention-battle-one", "mention-battle-two"],
      status: "resolved",
      canonical_event_id: "battle",
      relation: "coreference",
      candidates: [eventCandidate("battle", ["mention-battle-one", "mention-battle-two"], "coreference", 0.85)],
      supersedes_resolution_ids: [],
      rationale: "Both textual mentions currently describe the same canonical battle.",
    } as never, undefined, undefined, context);
    await finishOnly(first, fixture.segmentId, "Created one two-mention event cluster.");

    const secondBatch = `batch-${fixture.source.id}-event-cluster-two`;
    const second = createCompilerProposalToolset(root);
    await second.beginBatch([fixture.segmentId], secondBatch, fixture.source.id);
    const resolve = second.tools.find((tool) => tool.name === "propose_event_resolution")!;
    await resolve.execute("split-one", {
      ...eventResolutionInput({
        proposalId: "proposal-resolution-battle-main",
        resolutionId: "resolution-battle-main",
        mentionIds: ["mention-battle-one"],
        status: "resolved",
        canonicalEventId: "battle",
        relation: "coreference",
      }),
      supersedes_resolution_ids: ["resolution-battle-cluster"],
    } as never, undefined, undefined, context);
    await resolve.execute("split-two", {
      ...eventResolutionInput({
        proposalId: "proposal-resolution-battle-recollection",
        resolutionId: "resolution-battle-recollection",
        mentionIds: ["mention-battle-two"],
        status: "resolved",
        canonicalEventId: "battle",
        relation: "subevent",
      }),
      supersedes_resolution_ids: ["resolution-battle-cluster"],
      rationale: "The recollection describes a represented component rather than grounding the battle occurrence.",
    } as never, undefined, undefined, context);
    await finishOnly(second, fixture.segmentId, "Split coreference and subevent readings.");
    const store = new EventResolutionStore(root);
    await expect(store.list(fixture.source.id)).resolves.toHaveLength(2);

    const find = second.tools.find((tool) => tool.name === "find_event_resolutions")!;
    const read = second.tools.find((tool) => tool.name === "read_event_resolution")!;
    const found = JSON.parse(resultText(await find.execute("find-subevent", {
      query: "*",
      relation: "subevent",
    } as never, undefined, undefined, context))) as { results: Array<{ ref: string }>; returned: number };
    expect(found.returned).toBe(1);
    const page = JSON.parse(resultText(await read.execute("read-subevent", {
      ref: found.results[0]!.ref,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { chunk: string };
    expect(page.chunk).toContain("resolution-battle-recollection");

    await expect(store.rejectBatch(secondBatch)).resolves.toEqual([
      "proposal-resolution-battle-main",
      "proposal-resolution-battle-recollection",
    ]);
    await expect(store.list(fixture.source.id)).resolves.toEqual([
      expect.objectContaining({
        id: "resolution-battle-cluster",
        eventMentionIds: ["mention-battle-one", "mention-battle-two"],
        relation: "coreference",
      }),
    ]);
  });
});

function canonicalEvent(
  fixture: Awaited<ReturnType<typeof createEvidenceFixture>>,
  id: string,
  title: string,
  evidenceText: string,
): CanonicalEvent {
  return {
    id,
    title,
    participants: [],
    storyTime: { kind: "unknown" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: fixture.evidence(evidenceText),
    causalParents: [],
    confidence: 0.9,
  };
}

async function proposeEventMention(
  toolset: ReturnType<typeof createCompilerProposalToolset>,
  segmentId: string,
  input: {
    proposalId: string;
    mentionId: string;
    trigger: string;
    triggerOccurrence?: number;
    extent: string;
    types: string[];
    participantMentionIds?: string[];
    salience: "major" | "supporting" | "minor";
    interpretation?: string;
  },
): Promise<void> {
  await toolset.tools.find((tool) => tool.name === "propose_event_mention")!.execute(input.proposalId, {
    proposal_id: input.proposalId,
    annotation_id: input.mentionId,
    trigger_selector: {
      segment_id: segmentId,
      exact: input.trigger,
      ...(input.triggerOccurrence ? { occurrence: input.triggerOccurrence } : {}),
    },
    trigger: input.trigger,
    extent_selectors: [{ segment_id: segmentId, exact: input.extent }],
    event_type_candidates: input.types,
    participant_mention_ids: input.participantMentionIds ?? [],
    salience: input.salience,
    confidence: 0.9,
    ...(input.interpretation ? { interpretation: input.interpretation } : {}),
  } as never, undefined, undefined, context);
}

function eventResolutionInput(input: {
  proposalId: string;
  resolutionId: string;
  mentionIds: string[];
  status: "resolved" | "new-event";
  canonicalEventId: string;
  relation: "coreference" | "subevent";
}) {
  return {
    proposal_id: input.proposalId,
    resolution_id: input.resolutionId,
    event_mention_ids: input.mentionIds,
    status: input.status,
    canonical_event_id: input.canonicalEventId,
    relation: input.relation,
    candidates: [eventCandidate(input.canonicalEventId, input.mentionIds, input.relation, 0.95)],
    supersedes_resolution_ids: [],
    rationale: `The source cluster maps to ${input.canonicalEventId} as ${input.relation}.`,
  };
}

function eventCandidate(
  canonicalEventId: string,
  mentionIds: string[],
  relation: "coreference" | "subevent",
  confidence: number,
) {
  return {
    canonical_event_id: canonicalEventId,
    relation,
    confidence,
    basis_event_mention_ids: mentionIds,
    evidence_assertion_ids: [],
    rationale: `The mention cluster is compatible with ${canonicalEventId} as ${relation}.`,
  };
}

async function finishOnly(
  toolset: ReturnType<typeof createCompilerProposalToolset>,
  segmentId: string,
  summary: string,
): Promise<void> {
  await toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!.execute(`finish-${summary}`, {
    outcome: "complete",
    reviewed_segments: [{ segment_id: segmentId, disposition: "proposed", summary }],
    summary,
  } as never, undefined, undefined, context);
}

function resultText(result: { content: readonly unknown[] }): string {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected a text tool result.");
  return first.text;
}
