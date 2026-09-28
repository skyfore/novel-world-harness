import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { buildRoleRoster, RoleRosterStore } from "../src/compiler/role-roster.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import {
  reviewRoleRosterObligation,
  type RoleRosterObligationReview,
} from "../src/compiler/role-roster-obligation-review.js";
import { WorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { reviewNovelRoles } from "../src/workflow/role-review.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-obligation-review-"));
  roots.push(root);
  const evidence = await createEvidenceFixture(root, "Hero waits. Friend watches.");
  const canonical = new CanonicalModelStore(root);
  for (const name of ["Hero", "Friend"]) {
    await canonical.putEntity({
      id: name.toLowerCase(),
      canonicalName: name,
      kind: "character",
      aliases: [],
      evidence: evidence.evidence(name),
    });
  }
  const structure = await ensureSourceStructure(root, evidence.source);
  const roster = buildRoleRoster({
    sourceId: evidence.source.id,
    sourceSha256: evidence.source.contentSha256,
    unitIds: structure.baseUnitIds,
    entities: await canonical.listEntities(),
    annotations: [],
    resolutions: [],
  });
  await new RoleRosterStore(root).write(roster);
  const batchId = `role-roster-${evidence.source.id}-exhausted`;
  const journal = new CompilerProposalObligations(root, evidence.source.id, batchId);
  const first = { subjectHash: roster.subjectHash, entries: [] };
  const second = {
    subjectHash: roster.subjectHash,
    entries: [{
      candidateId: roster.candidates[0]!.id,
      importance: "major",
      rationale: "Only one candidate was classified.",
      basisUnitIds: roster.unitIds,
      developmentExpectation: {
        kind: "stable",
        rationale: "The short source supports continuity.",
        basisUnitIds: roster.unitIds,
      },
    }],
    missingMajorCharacters: [],
  };
  journal.record("propose_role_roster_review", first, "failed", "entries must contain at least one item");
  journal.record("propose_role_roster_review", second, "running", "Tool result not yet verified");
  journal.record("propose_role_roster_review", second, "failed", "ROSTER_DENOMINATOR_MISMATCH");
  const input = {
    subjectHash: roster.subjectHash,
    entries: roster.candidates.map(candidate => ({
      candidateId: candidate.id,
      importance: "major" as const,
      rationale: `${candidate.name} is causally central in this fixture.`,
      basisUnitIds: roster.unitIds,
      developmentExpectation: {
        kind: "stable" as const,
        rationale: "No lasting dimensional change is supported by this short fixture.",
        basisUnitIds: roster.unitIds,
      },
    })),
    missingMajorCharacters: [],
  };
  const failedInputHashes = [...new Set(journal.history("propose_role_roster_review", "role-roster-review")
    .filter(attempt => attempt.status === "failed").map(attempt => attempt.inputHash))];
  const request: RoleRosterObligationReview = {
    version: 1,
    sourceId: evidence.source.id,
    batchId,
    tool: "propose_role_roster_review",
    proposalId: "role-roster-review",
    failedInputHashes,
    reason: "Host reviewed the complete replacement against the immutable fixture source.",
    auditRef: "test:role-review-exact-recovery",
    input,
  };
  return { root, evidence, roster, batchId, journal, first, second, input, request };
}

describe("host role-roster obligation recovery", () => {
  it("binds all source/roster pages and persists one exact correction through normal proposal and finish", async () => {
    const f = await fixture();
    const before = f.journal.history("propose_role_roster_review", "role-roster-review");
    const preview = await reviewRoleRosterObligation(f.root, f.request);
    expect(preview).toMatchObject({
      status: "verified-preview",
      executableCertification: false,
      binding: {
        sourceId: f.evidence.source.id,
        batchId: f.batchId,
        tool: "propose_role_roster_review",
        proposalId: "role-roster-review",
        historyHash: contentHash(before),
        sourcePageCount: 1,
        rosterPageCount: 1,
        candidateCount: 2,
      },
    });
    expect(preview.sourcePageReceipts).toHaveLength(1);
    expect(preview.rosterPageReceipts).toHaveLength(1);
    expect(await new RoleRosterStore(f.root).read(f.evidence.source.id)).toEqual(f.roster);
    expect((await WorkspaceOperationLock.inspect(f.root)).owner).toBeUndefined();

    const result = await reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true);
    expect(result.status).toBe("finished");
    const receipt = await new CompilerFinishReceipts(f.root, f.evidence.source.id, f.batchId).read();
    expect(receipt).toMatchObject({ state: "completed", fingerprint: result.receiptFingerprint });
    expect(contentHash(receipt!.identity.metadata.roleReview)).toBe(preview.binding.reviewHash);
    const saved = (await new RoleRosterStore(f.root).read(f.evidence.source.id))!;
    expect(saved.reviews).toEqual([preview.review]);
    const history = f.journal.history("propose_role_roster_review", "role-roster-review");
    expect(history.slice(0, before.length)).toEqual(before);
    expect(history.slice(before.length).map(attempt => attempt.status)).toEqual(["running", "succeeded"]);
    expect(history.at(-1)?.hostReview).toMatchObject({
      auditRef: f.request.auditRef,
      roleRosterCorrection: preview.binding,
    });
    expect(f.journal.unresolved()).toEqual([]);
    expect((await WorkspaceOperationLock.inspect(f.root)).owner).toBeUndefined();

    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("finish receipt already exists");
    expect(f.journal.history("propose_role_roster_review", "role-roster-review")).toEqual(history);
  });

  it("rejects stale authority and incomplete or unknown candidate/evidence IDs without changing history", async () => {
    const f = await fixture();
    const preview = await reviewRoleRosterObligation(f.root, f.request);
    f.journal.record("propose_role_roster_review", f.second, "failed", "Retained duplicate diagnostic changes history binding.");
    const changedHistory = f.journal.history("propose_role_roster_review", "role-roster-review");
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("authority changed");
    expect(f.journal.history("propose_role_roster_review", "role-roster-review")).toEqual(changedHistory);

    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      input: { ...f.input, entries: f.input.entries.slice(0, 1) },
    })).rejects.toThrow("ROSTER_DENOMINATOR_MISMATCH");
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      input: {
        ...f.input,
        entries: f.input.entries.map((entry, index) => index ? entry : {
          ...entry,
          candidateId: "unknown-role-candidate",
          basisUnitIds: ["unknown-source-unit"],
        }),
      },
    })).rejects.toThrow(/ROSTER_DENOMINATOR_MISMATCH|ROSTER_UNKNOWN_EVIDENCE_UNIT/);
    expect(f.journal.history("propose_role_roster_review", "role-roster-review")).toEqual(changedHistory);
  });

  it("rejects unchanged corrections, interrupted running state, and any second grant after a failed host attempt", async () => {
    const unchanged = await fixture();
    const validFailed = {
      ...unchanged.input,
      entries: unchanged.input.entries.map(entry => ({ ...entry, rationale: "A complete input that failed before persistence." })),
    };
    unchanged.journal.record("propose_role_roster_review", validFailed, "failed", "Complete input failed before capture.");
    await expect(reviewRoleRosterObligation(unchanged.root, {
      ...unchanged.request,
      failedInputHashes: [...unchanged.request.failedInputHashes,
        CompilerProposalObligations.identity("propose_role_roster_review", validFailed).inputHash],
      input: validFailed,
    })).rejects.toThrow("materially different");

    const interrupted = await fixture();
    interrupted.journal.record("propose_role_roster_review", interrupted.input, "running", "Process ended before result.");
    await expect(reviewRoleRosterObligation(interrupted.root, interrupted.request))
      .rejects.toThrow("latest attempt failed");

    const failed = await fixture();
    const preview = await reviewRoleRosterObligation(failed.root, failed.request);
    await expect(failed.journal.withHostRoleRosterCorrection(
      failed.input,
      preview.binding,
      failed.request.reason,
      failed.request.auditRef,
      async () => {
        failed.journal.record("propose_role_roster_review", failed.input, "running", "Host correction started.");
        failed.journal.record("propose_role_roster_review", failed.input, "failed", "Host correction failed validation.");
        throw new Error("Host correction failed validation.");
      },
    )).rejects.toThrow("Host correction failed validation");
    const consumed = failed.journal.history("propose_role_roster_review", "role-roster-review");
    expect(consumed.at(-1)).toMatchObject({ status: "failed", hostReview: { auditRef: failed.request.auditRef } });
    await expect(failed.journal.withHostRoleRosterCorrection(
      failed.input,
      preview.binding,
      "Second review",
      "test:second-grant",
      async () => undefined,
    )).rejects.toThrow("interrupted, failed, changed, or already replayed");
    expect(failed.journal.history("propose_role_roster_review", "role-roster-review")).toEqual(consumed);
  });

  it("retains a successful capture when finish preparation is interrupted and resumes only that reviewed intent", async () => {
    const f = await fixture();
    const preview = await reviewRoleRosterObligation(f.root, f.request);
    vi.spyOn(CompilerFinishReceipts.prototype, "prepare").mockRejectedValueOnce(new Error("interrupted before prepared finish"));
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("interrupted before prepared finish");
    const captured = f.journal.history("propose_role_roster_review", "role-roster-review");
    expect(captured.slice(-2).map(attempt => attempt.status)).toEqual(["running", "succeeded"]);
    expect(captured.slice(-2).every(attempt =>
      contentHash(attempt.hostReview?.roleRosterCorrection) === contentHash(preview.binding))).toBe(true);
    expect(await new CompilerFinishReceipts(f.root, f.evidence.source.id, f.batchId).read()).toBeUndefined();
    expect((await new RoleRosterStore(f.root).read(f.evidence.source.id))!.reviews).toEqual([]);

    const compile = vi.fn();
    await expect(reviewNovelRoles({ root: f.root, sourceId: f.evidence.source.id }, compile))
      .rejects.toThrow(`retained obligations in ${f.batchId}`);
    expect(compile).not.toHaveBeenCalled();

    const resumed = await reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true);
    expect(resumed.status).toBe("finished");
    const completeHistory = f.journal.history("propose_role_roster_review", "role-roster-review");
    expect(completeHistory.slice(-4).map(attempt => attempt.status))
      .toEqual(["running", "succeeded", "running", "succeeded"]);
    expect((await new CompilerFinishReceipts(f.root, f.evidence.source.id, f.batchId).read())?.state).toBe("completed");
    expect((await new RoleRosterStore(f.root).read(f.evidence.source.id))!.reviews).toEqual([preview.review]);
  });

  it("stops after the one exact pre-receipt capture replay is also interrupted", async () => {
    const f = await fixture();
    const preview = await reviewRoleRosterObligation(f.root, f.request);
    const prepare = vi.spyOn(CompilerFinishReceipts.prototype, "prepare");
    prepare.mockRejectedValueOnce(new Error("first pre-receipt interruption"));
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("first pre-receipt interruption");
    prepare.mockRejectedValueOnce(new Error("second pre-receipt interruption"));
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("second pre-receipt interruption");
    const stopped = f.journal.history("propose_role_roster_review", "role-roster-review");
    expect(stopped.slice(-4).map(attempt => attempt.status))
      .toEqual(["running", "succeeded", "running", "succeeded"]);
    await expect(reviewRoleRosterObligation(f.root, {
      ...f.request,
      expectedAuthorityHash: preview.authorityHash,
    }, true)).rejects.toThrow("already replayed");
    expect(f.journal.history("propose_role_roster_review", "role-roster-review")).toEqual(stopped);
  });
});
