import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiCompilerSession, resolvePiCompilerSessionLifecycle } from "../src/compiler/pi-compiler.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("Pi compiler session lifecycle", () => {
  it("keeps an explicit manual compiler conversation persistable", () => {
    expect(resolvePiCompilerSessionLifecycle({})).toEqual({ isolated: false, saveSession: true, includeNwhExtension: true });
    expect(resolvePiCompilerSessionLifecycle({ saveSession: false })).toEqual({ isolated: false, saveSession: false, includeNwhExtension: true });
  });

  it("makes every source-, batch-, slice-, or tool-bounded job fresh and ephemeral", () => {
    for (const options of [
      { sourceId: "source-1" },
      { compilerBatchId: "batch-1" },
      { segmentIds: [] },
      { includeLocalTools: false },
    ] as const) {
      expect(resolvePiCompilerSessionLifecycle(options)).toEqual({ isolated: true, saveSession: false, includeNwhExtension: false });
    }
  });

  it("rejects transcript resume or persistence when a compiler authority boundary is active", () => {
    expect(() => resolvePiCompilerSessionLifecycle({ sourceId: "source-1", sessionId: "old-session" }))
      .toThrow("cannot resume a saved transcript");
    expect(() => resolvePiCompilerSessionLifecycle({ compilerBatchId: "batch-1", saveSession: true }))
      .toThrow("cannot persist its transcript");
  });

  it("preserves other event bindings after an exhausted identity is explicitly adjudicated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-compiler-recovery-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits at the station.\n");
    const batch = (await prepareCompilerBatches(root, fixture.source))
      .find((candidate) => candidate.semanticStage === "executable")!;
    const proposalId = "exhausted-execution";
    const ledger = new CompilerProposalObligations(root, fixture.source.id, batch.id);
    ledger.record("propose_event_execution", {
      proposal_id: proposalId,
      payload: {
        id: proposalId,
        canonicalEventId: "canonical-event",
        actorId: "actor",
        action: {
          lane: "ad-hoc",
          actionKindId: "announce",
          description: "Actor announces boarding.",
          footprint: { reads: [], writes: [], resources: [] },
        },
        roleBindings: [],
      },
      evidence_segment_ids: batch.segmentIds,
    }, "failed", 'Validation failed for tool "propose_event_execution":\n  - payload.action.lane: must be equal to constant');
    const correction = {
      proposal_id: proposalId,
      payload: { id: proposalId, canonicalEventId: "canonical-event", actorId: "actor" },
      evidence_segment_ids: batch.segmentIds,
      evidence_selectors: [{
        segment_id: batch.segmentIds[0]!,
        exact: "Hero waits at the station.",
        target_path: "/payload/canonicalEventId",
        relation: "supports" as const,
        strength: "explicit" as const,
      }],
    };
    ledger.record("propose_event_execution", correction, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
    ledger.record("propose_event_execution", correction, "failed", "Evidence selector 1 target_path '/payload/canonicalEventId' does not exist in the proposal payload.");

    let exposed: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      exposed = options.additionalTools?.map((tool) => tool.name) ?? [];
      return {} as PiAgentSession;
    });

    const options = {
      root,
      sourceId: fixture.source.id,
      compilerBatchId: batch.id,
      segmentIds: batch.segmentIds,
      includeLocalTools: false,
    };

    await expect(createPiCompilerSession(options)).rejects.toThrow("requires host review");
    expect(PiAgentSession.create).not.toHaveBeenCalled();
    ledger.reviewUnsupported("propose_event_execution", proposalId,
      "Reviewed source has no supported mechanism for this occurrence.", "test:host-review");
    await createPiCompilerSession(options);

    expect(exposed).toContain("propose_event_execution");
    expect(exposed).toContain("propose_action_schema");
    expect(exposed).toContain("finish_compiler_batch");
    expect(ledger.history("propose_event_execution", proposalId).map((attempt) => attempt.status))
      .toEqual(["failed", "running", "failed", "unsupported"]);
  });
});
