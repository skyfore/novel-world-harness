import { z } from "zod";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import {
  CompilerProposalObligations,
  roleRosterCorrectionSchema,
  type RoleRosterCorrection,
} from "./proposal-obligations.js";
import { createCompilerProposalToolset, type CompilerProposalToolset } from "./proposal-tools.js";
import {
  loadCurrentRoleRoster,
  roleRosterReviewInputSchema,
} from "./role-roster-tools.js";
import {
  roleCandidateSchema,
  roleRosterReviewSchema,
  validateRosterReview,
  type RoleRoster,
  type RoleRosterReview,
} from "./role-roster.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const roleRosterObligationReviewSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: z.literal("propose_role_roster_review"),
  proposalId: z.literal("role-roster-review"),
  failedInputHashes: z.array(sha256Schema).min(2)
    .refine(values => new Set(values).size === values.length, "Duplicate failed role-review input hash"),
  reason: z.string().trim().min(1),
  auditRef: z.string().trim().min(1),
  input: roleRosterReviewInputSchema,
  expectedAuthorityHash: sha256Schema.optional(),
}).strict();

export type RoleRosterObligationReview = z.infer<typeof roleRosterObligationReviewSchema>;

export type RoleRosterObligationPreview = {
  status: "verified-preview";
  executableCertification: false;
  authorityHash: string;
  binding: RoleRosterCorrection;
  review: RoleRosterReview;
  sourcePageReceipts: Array<{ page: number; totalPages: number; textHash: string; unitIdsHash: string }>;
  rosterPageReceipts: Array<{ offset: number; candidateCount: number; pageHash: string }>;
};

export type RoleRosterObligationResult = RoleRosterObligationPreview | (
  Omit<RoleRosterObligationPreview, "status"> & {
    status: "finished";
    receiptFingerprint: string;
  }
);

const finishInput = Object.freeze({
  outcome: "complete" as const,
  reviewed_segments: [] as [],
  summary: "Host-reviewed exact recovery of the original independent full-source role review.",
});

/**
 * Read-only by default. Apply requires a fresh authority hash, obtains the
 * compiler lock, rereads every candidate/source page through the ordinary role
 * tools, invokes the original proposal identity once, and uses normal finish.
 */
export async function reviewRoleRosterObligation(
  root: string,
  raw: unknown,
  apply = false,
): Promise<RoleRosterObligationResult> {
  const request = roleRosterObligationReviewSchema.parse(raw);
  if (!apply) return buildRoleRosterObligationPreview(root, request);
  if (!request.expectedAuthorityHash) {
    throw new Error("Applying a role-review correction requires expectedAuthorityHash from a fresh read-only preview.");
  }
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const preview = await buildRoleRosterObligationPreview(root, request);
    const current = await loadCurrentRoleRoster(root, request.sourceId);
    const toolset = createCompilerProposalToolset(root, {}, { hostObligationCorrection: true });
    await toolset.beginBatch([], request.batchId, request.sourceId);
    const pageAudit = await readCompleteRoleScope(toolset, current.roster);
    assertPageAuditMatchesBinding(pageAudit, preview.binding);

    const proposalTool = requiredTool(toolset, request.tool);
    const finishTool = requiredTool(toolset, "finish_compiler_batch");
    const journal = new CompilerProposalObligations(root, request.sourceId, request.batchId);
    await journal.withHostRoleRosterCorrection(
      request.input,
      preview.binding,
      request.reason,
      request.auditRef,
      async () => executeTool(proposalTool, "host-role-roster-correction", request.input),
    );
    await executeTool(finishTool, "host-role-roster-finish", finishInput);

    const receipt = await new CompilerFinishReceipts(root, request.sourceId, request.batchId).read();
    if (receipt?.state !== "completed"
      || contentHash(receipt.identity.metadata.roleReview) !== preview.binding.reviewHash) {
      throw new Error("Role-review correction did not persist its exact review through the normal completed finish receipt.");
    }
    const saved = await loadCurrentRoleRoster(root, request.sourceId);
    const committed = saved.roster.reviews.find(review => review.runId === request.batchId);
    if (!committed || contentHash(committed) !== preview.binding.reviewHash) {
      throw new Error("Role-review finish completed without the exact reviewed roster snapshot; stop for host storage inspection.");
    }
    return {
      ...preview,
      status: "finished",
      receiptFingerprint: receipt.fingerprint,
    };
  });
}

export async function buildRoleRosterObligationPreview(
  root: string,
  raw: unknown,
): Promise<RoleRosterObligationPreview> {
  const request = roleRosterObligationReviewSchema.parse(raw);
  if (!request.batchId.startsWith(`role-roster-${request.sourceId}-`)) {
    throw new Error("Role-review recovery must use the exact original dedicated role-roster batch.");
  }
  if (await new CompilerFinishReceipts(root, request.sourceId, request.batchId).read()) {
    throw new Error("A role-review finish receipt already exists; recover that frozen finish instead of replaying the proposal.");
  }
  const current = await loadCurrentRoleRoster(root, request.sourceId);
  if (current.roster.reviews.some(review => review.runId === request.batchId)) {
    throw new Error("The original role-review batch already has persisted output; recover its finish instead of replaying it.");
  }
  const review = completeReview(request, current.roster);
  const issues = validateRosterReview(current.roster, review);
  if (issues.length) {
    throw new Error(`Host role-review replacement is incomplete or invalid: ${issues.map(issue => `${issue.code}: ${issue.message}`).join("; ")}`);
  }

  const toolset = createCompilerProposalToolset(root, {}, { hostObligationCorrection: true });
  await toolset.beginBatch([], request.batchId, request.sourceId);
  const pageAudit = await readCompleteRoleScope(toolset, current.roster);
  const journal = new CompilerProposalObligations(root, request.sourceId, request.batchId);
  const binding = roleRosterCorrectionSchema.parse(journal.inspectRoleRosterCorrection(request.input, {
    sourceSha256: current.source.contentSha256,
    rosterHash: contentHash(current.roster),
    subjectHash: current.roster.subjectHash,
    reviewRevisionId: current.roster.reviewRevisionId ?? null,
    sourcePageCount: pageAudit.sourcePageReceipts.length,
    sourcePagesHash: contentHash(pageAudit.sourcePageReceipts),
    rosterPageCount: pageAudit.rosterPageReceipts.length,
    rosterPagesHash: contentHash(pageAudit.rosterPageReceipts),
    candidateCount: current.roster.candidates.length,
    reviewHash: contentHash(review),
    finishInputHash: contentHash(finishInput),
  }));
  if (contentHash([...binding.failedInputHashes].sort())
    !== contentHash([...request.failedInputHashes].sort())) {
    throw new Error("Host role-review correction must bind every distinct failed input hash.");
  }
  const authorityHash = contentHash(binding);
  if (request.expectedAuthorityHash && request.expectedAuthorityHash !== authorityHash) {
    throw new Error("Role-review correction authority changed; inspect the current history, source pages, and roster before applying.");
  }
  return {
    status: "verified-preview",
    executableCertification: false,
    authorityHash,
    binding,
    review,
    sourcePageReceipts: pageAudit.sourcePageReceipts,
    rosterPageReceipts: pageAudit.rosterPageReceipts,
  };
}

function completeReview(request: RoleRosterObligationReview, roster: RoleRoster): RoleRosterReview {
  return roleRosterReviewSchema.parse({
    version: 2,
    ...(roster.reviewRevisionId ? { reviewRevisionId: roster.reviewRevisionId } : {}),
    runId: request.batchId,
    subjectHash: request.input.subjectHash,
    reviewedUnitIds: roster.unitIds,
    entries: request.input.entries,
    missingMajorCharacters: request.input.missingMajorCharacters,
  });
}

async function readCompleteRoleScope(toolset: CompilerProposalToolset, roster: RoleRoster) {
  const rosterTool = requiredTool(toolset, "read_role_roster");
  const sourceTool = requiredTool(toolset, "read_roster_source_page");
  const rosterPageSchema = z.object({
    subjectHash: sha256Schema,
    reviewRevisionId: idSchema.optional(),
    candidates: z.array(roleCandidateSchema),
    totalCandidates: z.number().int().positive(),
    sourcePages: z.number().int().positive(),
    nextOffset: z.number().int().nonnegative().optional(),
  }).strict();
  const sourcePageSchema = z.object({
    page: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    text: z.string(),
    unitIds: z.array(idSchema),
    nextPage: z.number().int().nonnegative().optional(),
  }).strict();

  const rosterPageReceipts: Array<{ offset: number; candidateCount: number; pageHash: string }> = [];
  const seenCandidates: string[] = [];
  let offset = 0;
  let sourcePages: number | undefined;
  for (;;) {
    const page = rosterPageSchema.parse(await executeJsonTool(rosterTool, `host-role-roster-page-${offset}`, { offset }));
    if (page.subjectHash !== roster.subjectHash || page.reviewRevisionId !== roster.reviewRevisionId
      || page.totalCandidates !== roster.candidates.length || (sourcePages !== undefined && page.sourcePages !== sourcePages)) {
      throw new Error("Role-roster page identity changed during host review.");
    }
    sourcePages = page.sourcePages;
    seenCandidates.push(...page.candidates.map(candidate => candidate.id));
    rosterPageReceipts.push({ offset, candidateCount: page.candidates.length, pageHash: contentHash(page) });
    if (page.nextOffset === undefined) break;
    if (page.nextOffset <= offset) throw new Error("Role-roster pagination did not advance.");
    offset = page.nextOffset;
  }
  if (contentHash(seenCandidates) !== contentHash(roster.candidates.map(candidate => candidate.id))) {
    throw new Error("Role-roster pagination did not return every candidate exactly once in current order.");
  }

  const sourcePageReceipts: Array<{ page: number; totalPages: number; textHash: string; unitIdsHash: string }> = [];
  for (let pageIndex = 0; pageIndex < sourcePages!; pageIndex++) {
    const page = sourcePageSchema.parse(await executeJsonTool(sourceTool, `host-role-source-page-${pageIndex}`, { page: pageIndex }));
    if (page.page !== pageIndex || page.totalPages !== sourcePages
      || page.nextPage !== (pageIndex + 1 < sourcePages ? pageIndex + 1 : undefined)) {
      throw new Error("Role source-page pagination changed or skipped a page during host review.");
    }
    sourcePageReceipts.push({
      page: page.page,
      totalPages: page.totalPages,
      textHash: contentHash(page.text),
      unitIdsHash: contentHash(page.unitIds),
    });
  }
  return { rosterPageReceipts, sourcePageReceipts };
}

function assertPageAuditMatchesBinding(
  audit: Awaited<ReturnType<typeof readCompleteRoleScope>>,
  binding: RoleRosterCorrection,
) {
  if (audit.sourcePageReceipts.length !== binding.sourcePageCount
    || contentHash(audit.sourcePageReceipts) !== binding.sourcePagesHash
    || audit.rosterPageReceipts.length !== binding.rosterPageCount
    || contentHash(audit.rosterPageReceipts) !== binding.rosterPagesHash) {
    throw new Error("Role-review source or roster pages changed after preview; do not apply the stale correction.");
  }
}

function requiredTool(toolset: CompilerProposalToolset, name: string) {
  const tool = toolset.tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Required compiler tool ${name} is unavailable.`);
  return tool;
}

async function executeTool(tool: ReturnType<typeof requiredTool>, callId: string, input: unknown) {
  const prepared = tool.prepareArguments ? await tool.prepareArguments(input) : input;
  return tool.execute(callId, prepared as never, undefined, undefined, {} as never);
}

async function executeJsonTool(tool: ReturnType<typeof requiredTool>, callId: string, input: unknown): Promise<unknown> {
  const result = await executeTool(tool, callId, input);
  const block = result.content.find(item => item.type === "text");
  if (!block || block.type !== "text") throw new Error(`Compiler tool ${tool.name} returned no JSON text result.`);
  return JSON.parse(block.text);
}
