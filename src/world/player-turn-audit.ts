import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "./canonical.js";
import type { PlayerActionCandidate, PlayerProgressCertificate, PlayerTurnStage, PlayerWorldResolution } from "./player-action.js";
import type { EventProposal, ValidationIssue, ValidationReport } from "./model.js";
import type { PlayerWorldResponseOption, PlayerWorldResponseResolution } from "./runtime.js";
import type { NpcReactionEmotion, NpcReactionEvent, NpcResponseKind } from "./npc-reaction.js";
import type { CanonicalAttachmentResolution } from "./canonical-adaptation.js";
import type { CanonicalRecoveryTrace } from "./runtime.js";

export type PlayerTurnOrigin = "freeform" | "scene-choice" | "host-safe-choice" | "cli" | "web";

export type PlayerTurnAudit = {
  version: 1;
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  branchId: string;
  actorId: string;
  utterance: string;
  origin: PlayerTurnOrigin;
  runId?: string;
  playerMoveId?: string;
  intent?: "act" | "observe" | "reflect" | "wait";
  affordanceId?: string;
  previousHead: string;
  finalHead: string;
  stage: PlayerTurnStage;
  accepted: boolean;
  issues: ValidationIssue[];
  intendedCandidate?: PlayerActionCandidate;
  candidate?: PlayerActionCandidate;
  adjudication?: PlayerWorldResolution;
  proposal?: EventProposal;
  validation?: ValidationReport;
  eventHash?: string;
  progressCertificate?: PlayerProgressCertificate;
  worldResponseResolution?: PlayerWorldResponseResolution;
  /** Present on audits written by runtimes with immediate-response tracing. */
  worldResponseCandidates?: PlayerWorldResponseOption[];
  worldResponseEvents?: Array<{ eventHash: string; title: string; possibilityId: string }>;
  worldResponseError?: string;
  canonicalRecoveryResolution?: CanonicalAttachmentResolution;
  canonicalRecoveryTraces?: CanonicalRecoveryTrace[];
  excludedCanonicalPossibilityIds?: string[];
  canonicalRecoveryEvents?: Array<{
    eventHash: string;
    title: string;
    scaffoldPossibilityId: string;
    canonicalEventId: string;
  }>;
  canonicalRecoveryError?: string;
  reactionEvents: Array<{
    eventHash: string;
    title: string;
    actorId: string;
    responseKind?: NpcResponseKind;
    emotion?: NpcReactionEmotion;
    trace?: NpcReactionEvent["trace"];
  }>;
  npcResponseError?: string;
  backgroundEvents: Array<{ eventHash: string; title: string }>;
  backgroundError?: string;
  /** Presentation-memory failure; committed world truth remains unaffected. */
  conversationError?: string;
};

export class PlayerTurnAuditStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "play", "turns");
  }

  async write(input: Omit<PlayerTurnAudit, "version" | "id">): Promise<PlayerTurnAudit> {
    const id = `turn-${contentHash(input).slice(0, 24)}`;
    const audit: PlayerTurnAudit = { version: 1, id, ...structuredClone(input) };
    const filePath = path.join(this.root, input.branchId, `${input.startedAt.replaceAll(":", "-")}_${id}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
    return audit;
  }
}
