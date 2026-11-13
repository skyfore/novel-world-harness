import { initialWorldSchema } from "../world/initial.js";
import { modelEvidenceSelectorsSchema } from "./text-anchors.js";
import { BODILY_STATE_INPUT_GUIDANCE } from "../world/bodily-state.js";

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
  + "Every immediateSituation.causalFactIds entry must reference a causal-premise or completed-prior-beat fact; time-place facts are not causal premises. "
  + "Exact supporting evidence_selectors are required for /readerSetup, /readerContext/facts/i/summary, /readerContext/immediateSituation/summary, /actorObservations/i/summary, and each entity gloss's /relationshipToFocal and /whyRelevantNow. "
  + "A selector on a parent object such as /readerContext/facts/i does not bind its /summary. These literary fields require supports with explicit or strong-inference strength. "
  + "Omitted focalKnowledgeClaimIds/dependsOnFactIds default to empty arrays; focal-knowledge still requires actual seeded claim IDs. "
  + "The shared entry contract requires a non-dead bodily or channel-grounded role with final source-supported operational context, independent of the whole-book character count. Registered qualitative character.posture/breathing/sweating/wakefulness retain the source's precision; each such set operation needs an exact supporting selector on /delta/operations/i. Missing values remain unknown and imply no location, identity, numeric health or action capacity. Alive alone, readerContext and actorObservations are insufficient. Context grounding does not certify a legal action or autonomous driver: both require independent runtime witnesses. Do not invent a place, intention or number to pass. "
  + BODILY_STATE_INPUT_GUIDANCE + " Use preview_initial_world before submission when available; it checks input and exact evidence without staging a proposal, but does not certify graph closure or playability.";
