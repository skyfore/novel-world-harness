import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalTools, createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
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
    expect(tools).toHaveLength(11);
    for (const tool of tools.filter((candidate) => candidate.name.startsWith("propose_"))) {
      const validator = Compile(tool.parameters);
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

  it("requires source compiler events to split independent world-state operations", async () => {
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
    expect(Compile(tool.parameters).Check(prepared)).toBe(false);
    await expect(tool.execute("combined-event", prepared as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("one world-state operation at a time");
  });

  it("requires an explicit finish whose ids exactly match successful submissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-finish-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    const tools = createCompilerProposalTools(root);
    const entity = tools.find((candidate) => candidate.name === "propose_entity")!;
    const finish = tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
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
      outcome: "complete",
      proposal_ids: [],
      reviewed_segments: [],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("exactly match");
    await expect(finish.execute("finish", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      reviewed_segments: [],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, outcome: "complete" },
    });
    await expect(entity.execute("late-proposal", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");
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
      outcome: "complete",
      proposal_ids: [],
      reviewed_segments: [],
      summary: "done",
    };

    await expect(finish.execute("first-failure", invalidFinish as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("exactly match active successful submissions");
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
      const attempt = finish.execute(`finish-${index}`, {
        outcome: "complete",
        proposal_ids: [],
        reviewed_segments: [],
        summary: "incomplete",
      } as never, undefined, undefined, {} as ExtensionContext);
      if (index < 5) await expect(attempt).rejects.toThrow("exactly match active successful submissions");
      else {
        await expect(attempt).resolves.toMatchObject({
          terminate: true,
          details: { compilerBatchBlocked: true, finishFailureCount: 5 },
        });
      }
    }
  });

  it("does not checkpoint proposals until their logical references form a closed graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = toolset.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    toolset.beginBatch([fixture.segmentId]);
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

  it("withdraws an irreparable current-batch proposal so a corrected graph can finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-withdraw-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐站在钟楼下。\n");
    const toolset = createCompilerProposalToolset(root);
    const entity = toolset.tools.find((candidate) => candidate.name === "propose_entity")!;
    const initial = toolset.tools.find((candidate) => candidate.name === "propose_initial_world")!;
    const withdraw = toolset.tools.find((candidate) => candidate.name === "withdraw_compiler_proposal")!;
    const finish = toolset.tools.find((candidate) => candidate.name === "finish_compiler_batch")!;
    toolset.beginBatch([fixture.segmentId]);
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

  it("resets finish state only when the host starts a new compiler batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-tool-batches-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
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

    toolset.beginBatch(["segment-1"]);
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
      reviewed_segments: [{ segment_id: "segment-1", disposition: "proposed", summary: "Recorded Lin Qi." }],
      summary: "first batch",
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(entity.execute("same-batch-late", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");

    toolset.beginBatch(["segment-2"]);
    await expect(entity.execute("batch-2-proposal", {
      ...input,
      proposal_id: "entity-linqi-second-pass",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-linqi-second-pass", kind: "entity" },
    });
    await expect(finish.execute("batch-2-finish", {
      outcome: "complete",
      proposal_ids: ["entity-linqi-second-pass"],
      reviewed_segments: [{ segment_id: "segment-2", disposition: "proposed", summary: "Reviewed the second segment." }],
      summary: "second batch",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { reviewedSegmentIds: ["segment-2"] },
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
});
