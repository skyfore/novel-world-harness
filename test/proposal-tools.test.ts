import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalTools, createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { entitySchema } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("compiler proposal tools", () => {
  it("exposes the actual payload shape to the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-schema-"));
    roots.push(root);
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity");
    expect(tool).toBeDefined();

    const schema = JSON.stringify(tool?.parameters);
    expect(schema).toContain("canonicalName");
    expect(schema).toContain("sourceId");
    expect(schema).toContain("quoteHash");
    expect(schema).not.toContain('"payload":{}');
  });

  it("publishes compilable strict schemas for every proposal kind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-all-schemas-"));
    roots.push(root);
    const tools = createCompilerProposalTools(root);
    expect(tools).toHaveLength(19);
    for (const tool of tools.filter((candidate) => candidate.name.startsWith("propose_"))) {
      const validator = Compile(tool.parameters);
      expect(tool.executionMode).toBe("sequential");
      expect(validator.Check({ proposal_id: "valid-id", payload: "{}" }), tool.name).toBe(false);
      expect(JSON.stringify(tool.parameters), tool.name).not.toContain('"payload":{}');
    }
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
      evidence: fixture.evidence("刘备"),
    };
    const tool = createCompilerProposalTools(root, { provider: "test", model: "stringifying-provider" })
      .find((candidate) => candidate.name === "propose_entity");
    expect(tool?.prepareArguments).toBeDefined();

    const prepared = tool?.prepareArguments?.({
      proposal_id: "entity-liu-bei",
      payload: JSON.stringify(payload),
    });
    expect(prepared).toMatchObject({ proposal_id: "entity-liu-bei", payload });
    expect(Compile(tool!.parameters).Check(prepared), "prepared arguments satisfy the provider-facing schema").toBe(true);
    await tool?.execute(
      "call-1",
      prepared as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    const stored = await new CompilerProposalService(root).store.read("pending", "entity-liu-bei", entitySchema);
    expect(stored.payload).toEqual(payload);
    expect(stored.generatedBy).toMatchObject({ provider: "test", model: "stringifying-provider" });
  });

  it("rejects malformed provider-stringified JSON before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-invalid-json-"));
    roots.push(root);
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity");
    expect(() => tool?.prepareArguments?.({ proposal_id: "broken", payload: "{not-json" }))
      .toThrow("payload must be a JSON value");
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
      evidence: [],
    };
    expect(validator.Check({ proposal_id: "entity-liu-bei", payload: { id: "liu-bei", ...base } })).toBe(false);
    expect(validator.Check({ proposal_id: "中文 id", payload: { id: "中文 id", ...base } })).toBe(false);
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

    await expect(entity.execute("future-entity", {
      proposal_id: "future-villain",
      payload: {
        id: "future-villain",
        kind: "character",
        canonicalName: "Villain",
        aliases: [],
        evidence: fixture.evidence("Villain reveals the future."),
      },
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
        evidence: fixture.evidence("Bob"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("outside the host-supplied compiler segment slice");
  });

  it("rejects unregistered or unnamespaced state fields at both tool and service boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-state-field-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐把银钥交给墨砚。\n");
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_canonical_event")!;
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
      evidence: fixture.evidence("林岐把银钥交给墨砚"),
      causalParents: [],
      confidence: 1,
    };
    const prepared = tool.prepareArguments?.({ proposal_id: "event-key", payload });
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
        evidence: fixture.evidence("第七声钟响后，北门必须关闭。"),
      },
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
    const tool = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_canonical_event")!;
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
        evidence: fixture.evidence("墨砚开门并送出停战信。"),
        causalParents: [],
        confidence: 1,
      },
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
        evidence: fixture.evidence("刘备来到涿县。"),
      },
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

  it("hard-caps finish failures even when each failed attempt follows new proposal activity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-circuit-hard-cap-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const finish = tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    for (let index = 1; index <= 5; index += 1) {
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
      if (index < 5) await expect(attempt).rejects.toThrow("proposal graph is incomplete");
      else {
        await expect(attempt).resolves.toMatchObject({
          terminate: true,
          details: { compilerBatchBlocked: true, finishFailureCount: 5 },
        });
      }
    }
  });

  it("terminates a compiler batch that exceeds its total tool-call budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-call-budget-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const withdraw = tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;

    for (let index = 1; index <= 20; index += 1) {
      await expect(entity.execute(`proposal-${index}`, {
        proposal_id: `entity-${index}`,
        payload: {
          id: `person-${index}`,
          kind: "character",
          canonicalName: `人物${index}`,
          aliases: [],
          evidence: fixture.evidence("众人来到前厅。"),
        },
      } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
        details: {
          proposalId: `entity-${index}`,
          activeProposalCount: 1,
          remainingToolCalls: 40 - (index * 2 - 1),
        },
      });
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
        toolCallCount: 41,
      },
    });
  });

  it("reserves one final finish call after the general tool-call budget", async () => {
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
        evidence: fixture.evidence("人物"),
      },
    };

    for (let index = 1; index <= 40; index += 1) {
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

  it("rejects a 25th active proposal before a dense batch can crowd out finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-active-budget-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "众人来到前厅。\n");
    const entity = createCompilerProposalTools(root).find((candidate) => candidate.name === "propose_entity")!;

    for (let index = 1; index <= 24; index += 1) {
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

    await expect(entity.execute("proposal-25", {
      proposal_id: "entity-25",
      payload: {
        id: "person-25",
        kind: "character",
        canonicalName: "人物25",
        aliases: [],
        evidence: fixture.evidence("众人来到前厅。"),
      },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("already has 24 active proposals");
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
        evidence: fixture.evidence("林岐"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    await initial.execute("opening", {
      proposal_id: "opening-world",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "lin-qi", field: "character.location", value: "bell-tower" }],
        },
        evidence: fixture.evidence("林岐站在钟楼下。"),
      },
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
        evidence: fixture.evidence("钟楼"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(finish.execute("closed", {
      ...finishInput,
      proposal_ids: [...finishInput.proposal_ids, "entity-bell-tower"],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });
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
    for (const [proposalId, id, kind, canonicalName, quote] of [
      ["presence-character", "lin-qi", "character", "林岐", "林岐"],
      ["presence-location", "bell-tower", "location", "钟楼", "钟楼"],
    ] as const) {
      await entity.execute(proposalId, {
        proposal_id: proposalId,
        payload: { id, kind, canonicalName, aliases: [], evidence: fixture.evidence(quote) },
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
      evidence: fixture.evidence("林岐站在钟楼下。"),
      causalParents: [],
      confidence: 1,
    };
    await event.execute("bad-presence", {
      proposal_id: "bad-presence-event",
      payload: eventPayload,
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
        evidence: fixture.evidence("林岐"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    await initial.execute("broken-opening", {
      proposal_id: "opening-world-broken",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "linqi", field: "character.location", value: "missing-location" }],
        },
        evidence: fixture.evidence("林岐站在钟楼下。"),
      },
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
        evidence: fixture.evidence("林岐"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    await firstInitial.execute("bad-opening", {
      proposal_id: "recovered-bad-opening",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "linqi", field: "character.location", value: "unsupported-place" }],
        },
        evidence: fixture.evidence("林岐站在钟楼下。"),
      },
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
        evidence: fixture.evidence("林岐来到前厅。"),
      },
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
        evidence: fixture.evidence("王安随后到达。"),
      },
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
      evidence: fixture.evidence("林岐"),
    };

    await entity.execute("base", { proposal_id: "entity-linqi", payload } as never, undefined, undefined, {} as ExtensionContext);
    await withdraw.execute("withdraw-base", {
      proposal_id: "entity-linqi",
      reason: "The candidate needs a corrected envelope revision.",
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(entity.execute("bad-revision", {
      proposal_id: "entity-linqi-v2",
      payload: { ...payload, id: "linqi-v2" },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("Keep payload.id='linqi'");

    await expect(entity.execute("good-revision", {
      proposal_id: "entity-linqi-v2",
      payload,
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-linqi-v2" },
    });

    const chainedPayload = { ...payload, id: "linqi-alternate-v2" };
    await entity.execute("first-chained-revision", {
      proposal_id: "entity-linqi-alternate-v2",
      payload: chainedPayload,
    } as never, undefined, undefined, {} as ExtensionContext);
    await withdraw.execute("withdraw-chained-revision", {
      proposal_id: "entity-linqi-alternate-v2",
      reason: "The first successful logical identity already carries a revision-looking suffix.",
    } as never, undefined, undefined, {} as ExtensionContext);

    await expect(entity.execute("bad-chained-revision", {
      proposal_id: "entity-linqi-alternate-v3",
      payload: { ...chainedPayload, id: "linqi-alternate-v3" },
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("Keep payload.id='linqi-alternate-v2'");
  });
});
