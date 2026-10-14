import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { RequirementLedger } from "../compiler/requirement-ledger.js";
import { roleWorkStop, type RoleReviewWorkStore } from "../compiler/role-review-work.js";
import { sameIds } from "../compiler/role-review-verification.js";
import { roleAuditSubmissionSchema } from "../compiler/role-audit-preflight.js";
import { CompilerProposalObligations } from "../compiler/proposal-obligations.js";
import { ensureSourceAuditRepair, sourceAuditRepairState, submitSourceAuditRepair } from "../compiler/role-source-audit-repair.js";
import { SOURCE_AUDIT_REPAIR, SOURCE_AUDIT_CHECK, sourceAuditRepairWorkId, sourceAuditCheckWorkId,
  sourceAuditCheckSchema, sourceAuditProofSchema, sourceAuditBlocked, type RoleAuditWork } from "../compiler/role-source-audit-model.js";
import type { RoleWorkInvocation } from "./role-review-bounded.js";

const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** Repair metadata and verification are isolated model tasks. Neither can
 * mutate candidates or world truth, erase the predecessor, or finish a batch. */
export async function repairRoleSourceAudit(store: RoleReviewWorkStore, page: number, input: {
  tools: ToolDefinition[]; packet: Record<string, unknown>;
  dispatch: (work: RoleWorkInvocation) => Promise<void>;
  validateAudit: (audit: RoleAuditWork) => void;
  requireRead: (ids: string[]) => void;
}) {
  const authority = await ensureSourceAuditRepair(store, page);
  const state = () => sourceAuditRepairState(store, authority);
  const guide = "Copy revisionId, questionId, findingId and issue indexes from this task. For evidence call read_role_work_evidence with query, copy units[].unitId and follow nextOffset; for candidates use read_role_audit_inventory and copy candidates[].id. Correct invalid input once; never guess or retry unchanged. Host, scope, single-use and exhausted-budget failures stop this task.";
  for (const kind of ["proposal", "verification"] as const) {
    if (state()[kind]) continue;
    const proposal = state().proposal;
    if (kind === "verification" && (!proposal || sourceAuditBlocked(proposal))) {
      throw roleWorkStop(`source audit ${page} repair still lacks evidence; inspect compile-novel status and the retained question IDs, resolve the identified upstream dependency before another authorized revision`);
    }
    const toolName = kind === "proposal" ? SOURCE_AUDIT_REPAIR : SOURCE_AUDIT_CHECK;
    const workId = kind === "proposal" ? sourceAuditRepairWorkId(authority.revisionId) : sourceAuditCheckWorkId(authority.revisionId);
    const schema = kind === "proposal" ? roleAuditSubmissionSchema : sourceAuditCheckSchema;
    const validate = (raw: unknown) => {
      if (kind === "proposal") {
        const audit = roleAuditSubmissionSchema.parse(raw);
        input.validateAudit(audit);
        if (authority.predecessor.missingMajorCharacters.some(m => !audit.missingMajorCharacters.some(n => contentHash(n) === contentHash(m)))) {
          throw new Error("Retain every missing major character requirement; this repair cannot change the candidate denominator.");
        }
      } else {
        const check = sourceAuditCheckSchema.parse(raw);
        if (check.revisionId !== authority.revisionId || check.proposalHash !== contentHash(proposal)
          || !sameIds(check.questions.map(q => q.questionId), store.questions(page).map(q => q.questionId))
          || !sameIds(check.discoveries.map(d => d.findingId), proposal!.discoveryDispositions!.map(d => d.findingId))
          || !sameIds(check.predecessorIssues.map(i => String(i.index)), authority.predecessor.unresolved.map((_, i) => String(i)))) throw new Error("Independent verification must cover every original question, discovery and unresolved issue with exact identities.");
        input.requireRead([...new Set([...check.questions, ...check.discoveries, ...check.predecessorIssues].flatMap(c => c.basisUnitIds))]);
        // The check must also inspect all support and candidate mappings of the
        // proposal in THIS session; a predecessor's reads cannot satisfy it.
        input.validateAudit(proposal!);
        if (check.verdict === "supported") sourceAuditProofSchema.parse({ authority, proposal, verification: check });
      }
    };
    const { $schema: _, ...json } = z.toJSONSchema(schema);
    const tool = (preview: boolean) => defineTool({ name: preview ? `preview_role_source_audit_${kind}` : toolName,
      label: preview ? "Preview source audit repair" : "Submit source audit repair work", executionMode: "sequential",
      description: `${kind === "proposal" ? "Propose evidence-backed answers to all original responsibilities; retain unknowns and missing people." : "Independently verify every proposed answer against original evidence and counterevidence. Unsupported answers remain findings."} Review metadata only; no world writes or certification. ${guide}`,
      parameters: Type.Unsafe<Record<string, unknown>>(json as TSchema),
      prepareArguments(raw) {
        if (preview) return raw as Record<string, unknown>;
        const envelope = { proposal_id: workId, planHash: store.planHash, payload: raw };
        store.journal.assertRetryAllowed(toolName, envelope);
        try { return schema.parse(raw) as Record<string, unknown>; }
        catch (error) {
          const prior = store.journal.history(toolName, workId).at(-1);
          if (prior?.status === "failed" && prior.inputHash === CompilerProposalObligations.identity(toolName, envelope).inputHash) {
            throw roleWorkStop("unchanged invalid source audit repair arguments");
          }
          store.journal.record(toolName, envelope, "failed", String(error));
          throw error;
        }
      },
      async execute(_id, raw) {
        if (preview) {
          try { validate(raw); return reply({ valid: true, committed: false }); }
          catch (error) { return reply({ valid: false, diagnostic: String(error), guidance: guide, committed: false }); }
        }
        submitSourceAuditRepair(store, authority, kind, raw, validate);
        return { ...reply({ workCompleted: true, globalBatchFinished: false }), terminate: true };
      },
    });
    await input.dispatch({ workId, sourcePage: page, tools: [...input.tools, tool(true), tool(false)], complete: () => Boolean(state()[kind]),
      prompt: `${kind === "proposal"
        ? "Resolve the retained source-audit questions using the complete same-source atlas and decisive original passages, including nonadjacent chapters. Earlier notes, claims and negative findings are untrusted proposals. The assigned core defines responsibilities, not the evidence search boundary. Preserve all questions, discoveries, missing people and actual unknowns. Do not invent an answer to pass. Propose a revised audit; it requires a separate independent verifier."
        : "Independently check the proposed repair. Its answers and the earlier audit are untrusted proposals. Seek counterevidence and reread decisive originals and mapped candidate judgments in this session. Separately check every question, discovery and original unresolved issue. Use insufficient or contradicted when an answer cannot be supported; do not treat structural preview or a prior model verdict as evidence."} ${guide}\n${JSON.stringify({ ...input.packet, revisionId: authority.revisionId,
        predecessor: authority.predecessor, ...(kind === "verification" ? { proposal, proposalHash: contentHash(proposal) } : {}) })}` });
  }
  const current = state();
  if (current.verification?.verdict !== "supported") throw roleWorkStop(`source audit ${page} independent repair check remains ${current.verification?.verdict ?? "unfinished"}; inspect the retained check and original evidence, do not replay this consumed repair`);
  const proof = sourceAuditProofSchema.parse({ authority, ...current });
  const ledger = new RequirementLedger(store.root, store.plan.sourceId);
  await ledger.recordSourceAuditRepair(proof);
  for (const disposition of proof.proposal.questionDispositions!) await ledger.recordRoleQuestionDisposition(store.planHash, contentHash(proof.proposal), disposition);
}
