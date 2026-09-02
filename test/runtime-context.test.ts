import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { admitRuntimeContextProposal, createPiRuntimeContextResolver } from "../src/agent/pi-runtime-context.js";
import {
  createRuntimeSourceEvidenceAccess,
  loadRuntimeSourceCorpus,
  type RuntimeSourceCorpus,
} from "../src/agent/runtime-source-evidence.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { RuntimeCompilerRepairHintStore } from "../src/compiler/runtime-repair-hints.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { createWorldBranch } from "../src/world/instance.js";
import type { CanonicalEvent, Entity, TextAnchor } from "../src/world/model.js";
import { buildActorScopedActionContext, type ActorScopedActionContext } from "../src/world/player-action.js";
import { playerRuntimeContextFrame } from "../src/world/play-opening.js";
import {
  materializeRuntimeContextNeed,
  runtimeContextNeedForIssues,
  runtimeContextSupplementSchema,
} from "../src/world/runtime-context.js";
import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-runtime-context-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "alice", kind: "character", canonicalName: "Alice", aliases: ["A"], evidence: [] },
    { id: "villain", kind: "character", canonicalName: "Villain", aliases: [], evidence: [] },
  ];
  const futureEvent: CanonicalEvent = {
    id: "future-betrayal",
    title: "Villain later betrays Hero",
    participants: ["hero", "villain"],
    storyTime: { kind: "ordinal", label: "later" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const canon = new CanonicalModelStore(root);
  await Promise.all([
    ...entities.map((entity) => canon.putEntity(entity)),
    canon.putEvent(futureEvent),
  ]);
  const contexts = new WorldContextStore(root, canon);
  const context = await contexts.captureCurrent();
  const engine = new WorldEngine(root, context, (hash) => contexts.load(hash));
  const head = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
  });
  const actorContext: ActorScopedActionContext = {
    actorId: "hero",
    atCommit: head,
    selfState: { "character.alive": true },
    ownedEntityState: {},
    knowledge: [],
    presentEntities: [
      { id: "hero", kind: "character", name: "Hero" },
      { id: "alice", kind: "character", name: "Alice" },
    ],
    referenceableEntities: [
      { id: "hero", kind: "character", name: "Hero" },
      { id: "alice", kind: "character", name: "Alice" },
    ],
    writableEntityIds: ["hero"],
    writableStateFields: DEFAULT_STATE_FIELDS.filter((field) => field.appliesTo.includes("character")),
    spatialRelations: [],
    scene: { beat: 0, presentEntityIds: ["hero", "alice"], locationState: {} },
    recentVisibleEvents: [],
    activeThreads: [],
  };
  const anchor = (id: string, startByte: number): TextAnchor => ({
    version: 1,
    sourceId: "novel-source",
    startByte,
    endByte: startByte + 20,
    startLine: startByte + 1,
    endLine: startByte + 1,
    exactHash: id.padEnd(64, "0").slice(0, 64),
    prefixHash: "1".repeat(64),
    suffixHash: "2".repeat(64),
    contextBytes: 64,
    normalization: "source-bytes-v1",
  });
  const alicePassage = {
    ref: "source-unit:alice-introduction",
    unitId: "alice-introduction",
    sourceId: "novel-source",
    anchor: anchor("a", 0),
    text: "Alice was Hero's oldest school friend.",
    accountingStatus: "represented" as const,
    artifacts: [{ kind: "entity", id: "alice" }],
  };
  const futurePassage = {
    ref: "source-unit:future-betrayal",
    unitId: "future-betrayal",
    sourceId: "novel-source",
    anchor: anchor("b", 30),
    text: "Much later, Villain betrayed Hero.",
    accountingStatus: "represented" as const,
    artifacts: [
      { kind: "entity", id: "alice" },
      { kind: "canonical-event", id: "future-betrayal" },
    ],
  };
  const possibilityPassage = {
    ref: "source-unit:uncommitted-possibility",
    unitId: "uncommitted-possibility",
    sourceId: "novel-source",
    anchor: anchor("c", 60),
    text: "Alice may later leave without warning.",
    accountingStatus: "represented" as const,
    artifacts: [
      { kind: "entity", id: "alice" },
      { kind: "possibility", id: "alice-leaves" },
    ],
  };
  const corpus = {
    base: {
      version: 1,
      sourceId: "novel-source",
      sourceContentSha256: "3".repeat(64),
      preparedRevisionHash: "4".repeat(64),
      canonicalSnapshotHash: "5".repeat(64),
    },
    bundle: {
      canonical: {
        entities,
        events: [futureEvent],
        initialWorld: {
          evidence: [{
            span: {
              sourceId: "novel-source",
              startByte: 0,
              endByte: 20,
              startLine: 1,
              endLine: 1,
              quoteHash: "opening-context",
            },
            strength: "explicit",
          }],
        },
      },
    },
    passages: [alicePassage, futurePassage, possibilityPassage],
    passagesByRef: new Map([
      [alicePassage.ref, alicePassage],
      [futurePassage.ref, futurePassage],
      [possibilityPassage.ref, possibilityPassage],
    ]),
    artifactsByKey: new Map([
      ["entity/alice", { kind: "entity", id: "alice", payload: entities[1], label: "entity: Alice" }],
      ["canonical-event/future-betrayal", {
        kind: "canonical-event",
        id: "future-betrayal",
        payload: futureEvent,
        label: "canonical-event: Villain later betrays Hero",
      }],
      ["possibility/alice-leaves", {
        kind: "possibility",
        id: "alice-leaves",
        payload: { id: "alice-leaves", title: "Alice may later leave" },
        label: "possibility: Alice may later leave",
      }],
    ]),
  } as unknown as RuntimeSourceCorpus;
  return { root, engine, head, actorContext, corpus };
}

describe("runtime context admission", () => {
  it("does not admit a paged source-unit ref until the complete unit was read", async () => {
    const { corpus } = await fixture();
    const passage = corpus.passages[0]!;
    passage.text = `${passage.text}${" context".repeat(180)}`;
    const access = createRuntimeSourceEvidenceAccess(corpus);
    await access.tools[1]!.execute(
      "read-first-page",
      { ref: passage.ref, offset: 0, max_chars: 500 },
      undefined,
      undefined,
      {} as never,
    );
    expect(access.readRefs()).not.toContain(passage.ref);
    await access.tools[1]!.execute(
      "read-rest",
      { ref: passage.ref, offset: 500, max_chars: 24_000 },
      undefined,
      undefined,
      {} as never,
    );
    expect(access.readRefs()).toContain(passage.ref);
  });

  it("admits only actor-visible stable identity and keeps exact source access bounded", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    const access = createRuntimeSourceEvidenceAccess(corpus);
    const found = await access.tools[0]!.execute(
      "find",
      { query: "Alice", max_results: 5 },
      undefined,
      undefined,
      {} as never,
    );
    expect(found.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("source-unit:alice-introduction") });
    await access.tools[1]!.execute(
      "read",
      { ref: "source-unit:alice-introduction" },
      undefined,
      undefined,
      {} as never,
    );
    expect(access.readRefs()).toEqual(new Set(["source-unit:alice-introduction"]));

    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "identity",
      question: "Who is Alice?",
      audience: "actor",
      searchTerms: ["Alice"],
    }, "translation");
    const admitted = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      sourceId: "novel-source",
      utterance: "I speak to Alice.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "found",
      summary: "Alice is the named person in the request.",
      findings: [{
        statement: "Alice is Hero's oldest school friend.",
        passageRefs: ["source-unit:alice-introduction"],
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "prior",
        audiences: ["actor", "reader"],
      }],
    }, new Set(["source-unit:alice-introduction"]));

    expect(admitted.record).toMatchObject({ status: "admitted", retryRecommended: true });
    expect(admitted.supplement.translation[0]?.summary).toContain("Alice");
    expect(admitted.supplement.choice).toHaveLength(1);
    expect(admitted.supplement.narrative[0]?.summary).toContain("oldest school friend");
    expect(admitted.repairHints).toEqual([]);
  });

  it("resolves a player-named visible person for this turn without granting character-name knowledge", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    actorContext.referenceableEntities[1] = { id: "alice", kind: "character", name: "Unidentified character 1" };
    actorContext.presentEntities[1] = { id: "alice", kind: "character", name: "Unidentified character 1" };
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "identity",
      question: "Who does Alice refer to here?",
      audience: "actor",
      searchTerms: ["Alice"],
    }, "translation");
    const result = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      sourceId: "novel-source",
      utterance: "I speak to Alice.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "found",
      summary: "The visible person is Alice.",
      findings: [{
        statement: "Alice is Hero's oldest school friend.",
        passageRefs: ["source-unit:alice-introduction"],
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "prior",
        audiences: ["actor", "reader"],
      }],
    }, new Set(["source-unit:alice-introduction"]));

    expect(result.record).toMatchObject({ status: "admitted", retryRecommended: true });
    expect(result.supplement.translation).toEqual([
      expect.objectContaining({ authority: "turn-reference", basis: [{ kind: "entity", id: "alice" }] }),
    ]);
    expect(result.supplement.adjudication).toEqual([]);
    expect(result.supplement.choice).toEqual([]);
    expect(result.supplement.narrative[0]?.summary).toContain("oldest school friend");
  });

  it("never admits an unrealized future canonical event even when a proposal calls it current", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "causality",
      question: "Why is Villain acting strangely?",
      audience: "reader",
      searchTerms: ["Villain"],
    }, "adjudication");
    const result = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      utterance: "I confront Villain.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "found",
      summary: "The source contains a later betrayal.",
      findings: [{
        statement: "Villain will betray Hero.",
        passageRefs: ["source-unit:future-betrayal"],
        // Deliberately omit the linked future-event ref. The host must inspect
        // every artifact linked to the passage rather than trust this selection.
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "current",
        audiences: ["world", "reader"],
      }],
    }, new Set(["source-unit:future-betrayal"]));

    expect(result.record.status).toBe("future-only");
    expect(result.record.retryRecommended).toBe(false);
    expect(result.supplement.translation).toEqual([]);
    expect(result.supplement.adjudication).toEqual([]);
    expect(result.supplement.narrative).toEqual([]);
  });

  it("never narrates an uncommitted possibility through a current entity linked to the same passage", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "relationship",
      question: "What context matters when speaking to Alice?",
      audience: "reader",
      searchTerms: ["Alice"],
    }, "narration");
    const result = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      utterance: "I speak to Alice.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "found",
      summary: "The passage describes a possible later departure.",
      findings: [{
        statement: "Alice may later leave without warning.",
        passageRefs: ["source-unit:uncommitted-possibility"],
        // Selecting only the safe current entity must not hide the possibility
        // artifact that the host linked to the same source unit.
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "current",
        audiences: ["reader"],
      }],
    }, new Set(["source-unit:uncommitted-possibility"]));

    expect(result.record.status).toBe("future-only");
    expect(result.supplement).toEqual({ version: 1, translation: [], adjudication: [], choice: [], narrative: [] });
  });

  it("does not retry or admit any ambiguous proposal findings", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "identity",
      question: "Which Alice is meant?",
      audience: "actor",
      searchTerms: ["Alice"],
    }, "translation");
    const result = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      sourceId: "novel-source",
      utterance: "I speak to Alice.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "ambiguous",
      summary: "The passage does not distinguish two possible readings.",
      findings: [{
        statement: "Alice may be the school friend.",
        passageRefs: ["source-unit:alice-introduction"],
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "prior",
        audiences: ["actor"],
      }],
    }, new Set(["source-unit:alice-introduction"]));

    expect(result.record).toMatchObject({ status: "ambiguous", retryRecommended: false });
    expect(result.supplement).toEqual({ version: 1, translation: [], adjudication: [], choice: [], narrative: [] });
    expect(result.repairHints).toHaveLength(1);
  });

  it("withholds a finding whose temporal relation to the branch head is unknown", async () => {
    const { root, head, actorContext, corpus } = await fixture();
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "relationship",
      question: "Is the relationship already established here?",
      audience: "reader",
      searchTerms: ["Alice"],
    }, "narration");
    const result = await admitRuntimeContextProposal(root, corpus, {
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      utterance: "I speak to Alice.",
      actorContext,
    }, {
      version: 1,
      needId: need.id,
      conclusion: "found",
      summary: "The source passage exists, but its time relative to this branch is unresolved.",
      findings: [{
        statement: "Alice was Hero's oldest school friend.",
        passageRefs: ["source-unit:alice-introduction"],
        artifactRefs: [{ kind: "entity", id: "alice" }],
        temporalClass: "unknown",
        audiences: ["reader"],
      }],
    }, new Set(["source-unit:alice-introduction"]));

    expect(result.record).toMatchObject({ status: "ambiguous", retryRecommended: false });
    expect(result.supplement).toEqual({ version: 1, translation: [], adjudication: [], choice: [], narrative: [] });
    expect(result.repairHints).toHaveLength(1);
  });

  it("classifies only a pure allowlisted failure set as missing context", () => {
    expect(runtimeContextNeedForIssues("translation", "go there", [
      { code: "PLAYER_SPATIAL_ROUTE_UNPROVEN", message: "missing route" },
    ])).toMatchObject({ domain: "spatial", retryAt: "translation" });
    expect(runtimeContextNeedForIssues("translation", "go there", [
      { code: "PLAYER_SPATIAL_ROUTE_UNPROVEN", message: "missing route" },
      { code: "PLAYER_WRITE_OUT_OF_SCOPE", message: "forbidden write" },
    ])).toBeUndefined();
  });

  it("enforces consumer authority separation in the supplement schema", () => {
    const fact = { summary: "Hidden world fact", authority: "committed-world", basis: [{ kind: "entity", id: "alice" }] };
    expect(runtimeContextSupplementSchema.safeParse({
      version: 1,
      translation: [fact],
      adjudication: [],
      choice: [],
      narrative: [],
    }).success).toBe(false);
    expect(runtimeContextSupplementSchema.safeParse({
      version: 1,
      translation: [],
      adjudication: [],
      choice: [{ ...fact, authority: "turn-reference" }],
      narrative: [],
    }).success).toBe(false);
  });

  it("removes evidence and artifact handles at the scene-presentation boundary", () => {
    const frame = playerRuntimeContextFrame({
      version: 1,
      translation: [],
      adjudication: [],
      choice: [{
        summary: "Alice is someone the actor already recognizes.",
        authority: "actor-visible",
        basis: [{ kind: "entity", id: "stable-alice-id" }],
      }],
      narrative: [{
        summary: "Alice and the actor were school friends.",
        authority: "presentation-only",
        evidenceRefs: ["source-unit:stable-evidence-ref"],
        safety: "frozen-current-or-prior-evidence",
      }],
    });
    expect(frame).toEqual({
      choice: [{ summary: "Alice is someone the actor already recognizes.", authority: "actor-visible" }],
      narrative: [{
        summary: "Alice and the actor were school friends.",
        authority: "presentation-only",
        safety: "frozen-current-or-prior-evidence",
      }],
    });
    expect(JSON.stringify(frame)).not.toContain("stable-alice-id");
    expect(JSON.stringify(frame)).not.toContain("stable-evidence-ref");
  });
});

async function preparedCorpusFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-runtime-source-workspace-"));
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-runtime-source-cache-"));
  roots.push(root, cacheRoot);
  const content = "Hero receives a letter from America because his former teacher sent it.\n";
  const source = await createEvidenceFixture(root, content);
  const proposals = new CompilerProposalService(root);
  await proposals.submit("entity", {
    proposalId: "runtime-source-hero",
    payload: {
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: source.evidence("Hero"),
    },
    generatedBy: { worker: "test" },
  });
  await proposals.submit("initial-world", {
    proposalId: "runtime-source-opening",
    payload: {
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
      },
      evidence: source.evidence(content.trim()),
    },
    generatedBy: { worker: "test" },
  });
  const batches = await prepareCompilerBatches(root, source.source);
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, batches.map((batch) => batch.id));
  await convergeWorldProposals(root, source.source.id);
  const published = await new PreparedNovelCache(root, cacheRoot).publish(source.source);
  const created = await createWorldBranch(root, "main", undefined, source.source.id, cacheRoot);
  const corpus = await loadRuntimeSourceCorpus(root, "main", cacheRoot);
  return { root, cacheRoot, content, source, published, head: created.head, corpus };
}

describe("runtime frozen source corpus", () => {
  it("loads exact evidence only from the prepared revision pinned by the branch", async () => {
    const { source, published, corpus } = await preparedCorpusFixture();

    expect(corpus.base).toMatchObject({
      sourceId: source.source.id,
      preparedRevisionHash: published.bundleHash,
    });
    expect(corpus.bundle.version).toBe(3);
    expect(corpus.passages.some((passage) => passage.text.includes("letter from America"))).toBe(true);
    expect(corpus.passages.flatMap((passage) => passage.artifacts)).toContainEqual({ kind: "entity", id: "hero" });
  });

  it("runs a fresh source-only agent turn and admits its cited result through the host", async () => {
    const { root, cacheRoot, source, head, corpus } = await preparedCorpusFixture();
    const passage = corpus.passages.find((candidate) => candidate.text.includes("letter from America"))!;
    const actorContext = await buildActorScopedActionContext(
      (await openWorkspaceWorld(root)).engine,
      "hero",
      head,
      "I inspect the letter.",
      source.source.id,
    );
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "artifact-provenance",
      question: "Why is the letter from America?",
      audience: "reader",
      searchTerms: ["letter", "America"],
    }, "narration");
    let disposed = false;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      expect(options.saveSession).toBe(false);
      expect(options.includeProjectInstructions).toBe(false);
      expect(options.includeLocalTools).toBe(false);
      expect(options.includeNwhExtension).toBe(false);
      expect(options.additionalTools?.map((tool) => tool.name)).toEqual([
        "find_runtime_source_evidence",
        "read_runtime_source_evidence",
        "propose_runtime_context_supplement",
      ]);
      const read = options.additionalTools![1]!;
      const propose = options.additionalTools![2]!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        promptWithReport: async () => {
          await read.execute("read", { ref: passage.ref }, undefined, undefined, {} as never);
          await propose.execute("propose", {
            version: 1,
            needId: need.id,
            conclusion: "found",
            summary: "The source identifies the letter's provenance.",
            findings: [{
              statement: "The former teacher sent the letter from America.",
              passageRefs: [passage.ref],
              artifactRefs: [{ kind: "entity", id: "hero" }],
              temporalClass: "current",
              audiences: ["reader"],
            }],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiRuntimeContextResolver({ root, preparedCacheRoot: cacheRoot })({
      need,
      branchId: "main",
      actorId: "hero",
      expectedHead: head,
      sourceId: source.source.id,
      utterance: "I inspect the letter.",
      actorContext,
    });

    expect(result.record.status).toBe("admitted");
    expect(result.supplement.narrative[0]?.summary).toContain("former teacher");
    expect(disposed).toBe(true);
  });
});

describe("runtime compiler repair hint inbox", () => {
  it("persists one immutable idempotent hint without changing branch truth", async () => {
    const { root, engine, head } = await fixture();
    const need = materializeRuntimeContextNeed({
      decision: "needs-context",
      domain: "artifact-provenance",
      question: "Why is the letter from America?",
      audience: "reader",
      searchTerms: ["letter", "America"],
    }, "narration");
    const hint = {
      version: 1 as const,
      sourceId: "novel-source",
      preparedRevisionHash: "4".repeat(64),
      branchId: "main",
      atCommit: head,
      need,
      summary: "The source passage has provenance that is absent from compiled context.",
      evidenceRefs: ["source-unit:letter-origin"],
      artifactRefs: [],
    };
    const store = new RuntimeCompilerRepairHintStore(root);
    const first = await store.record(hint);
    const second = await store.record(hint);
    expect(second.id).toBe(first.id);
    await expect(store.list("novel-source")).resolves.toEqual([first]);
    await expect(engine.branches.readHead("main")).resolves.toBe(head);
  });
});
