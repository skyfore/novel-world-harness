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
    expect(tools).toHaveLength(10);
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
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("exactly match");
    await expect(finish.execute("finish", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      summary: "done",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, outcome: "complete" },
    });
    await expect(entity.execute("late-proposal", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");
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

    await entity.execute("batch-1-proposal", input as never, undefined, undefined, {} as ExtensionContext);
    await finish.execute("batch-1-finish", {
      outcome: "complete",
      proposal_ids: ["entity-linqi"],
      summary: "first batch",
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(entity.execute("same-batch-late", input as never, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("already finished");

    toolset.beginBatch();
    await expect(entity.execute("batch-2-proposal", {
      ...input,
      proposal_id: "entity-linqi-second-pass",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { proposalId: "entity-linqi-second-pass", kind: "entity" },
    });
  });
});
