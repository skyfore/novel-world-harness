import { initialWorldSchema } from "../world/initial.js";
import { modelEvidenceSelectorsSchema } from "./text-anchors.js";

const modelPayload = initialWorldSchema.omit({ evidence: true });

/** Pure input checks: aggregate independent failures before any proposal write. */
export function initialWorldInputIssues(input: { payload: unknown; evidence_selectors?: unknown }): string[] {
  const issues: string[] = [];
  if (!input || typeof input !== "object") return ["Input must be an object with proposal_id, payload and evidence_segment_ids."];
  const payload = modelPayload.safeParse(input.payload);
  if (!payload.success) issues.push(...payload.error.issues.map(issue =>
    `payload.${issue.path.join(".")}: ${issue.message}`));
  const selectors = modelEvidenceSelectorsSchema.optional().safeParse(input.evidence_selectors);
  if (!selectors.success) issues.push(...selectors.error.issues.map(issue =>
    `evidence_selectors.${issue.path.join(".")}: ${issue.message}`));
  return issues;
}

export const INITIAL_WORLD_INPUT_GUIDANCE = "For readerContext, include focal-identity, time-place, causal-premise, actor-stance and immediate-pressure facts. "
  + "An actor-stance requires holderEntityId and stance (positive, negative, neutral, ambivalent or indifferent); social-stakes requires holderEntityId. "
  + "Include the holder in entityIds. causalFactIds alone does not replace a causal-premise fact. "
  + "Omitted focalKnowledgeClaimIds/dependsOnFactIds default to empty arrays; focal-knowledge still requires actual seeded claim IDs. "
  + "Use preview_initial_world before submission when available; it checks input and exact evidence without staging a proposal, but does not certify graph closure or playability.";
