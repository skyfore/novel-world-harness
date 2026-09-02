import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import type { PlayerActionCandidate, PlayerProgressCertificate, PlayerTurnStage, PlayerWorldResolution } from "./player-action.js";
import { idSchema, type EventProposal, type ValidationIssue, type ValidationReport } from "./model.js";
import type { PlayerWorldResponseOption, PlayerWorldResponseResolution } from "./runtime.js";
import type { NpcReactionEmotion, NpcReactionEvent, NpcResponseKind } from "./npc-reaction.js";
import type { CanonicalAttachmentResolution } from "./canonical-adaptation.js";
import type { CanonicalRecoveryTrace } from "./runtime.js";
import type { RuntimeContextConsultationRecord } from "./runtime-context.js";
import { worldStorageRoot } from "./paths.js";

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
  contextConsultations?: RuntimeContextConsultationRecord[];
  repairHintIds?: string[];
  repairHintError?: string;
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

export type PlayerTurnAuditRecoveryLink = Pick<
  PlayerTurnAudit,
  "id" | "branchId" | "runId" | "playerMoveId" | "previousHead" | "finalHead" | "accepted" | "eventHash"
>;

export class PlayerTurnAuditStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "play", "turns");
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

  /**
   * Finds the immutable turn audit that was durably written for one Web trace.
   * This is intentionally a recovery-only lookup: audit data can repair
   * observability links, but it never changes branch truth.
   */
  async findRecoveryLink(branchId: string, runId: string): Promise<PlayerTurnAuditRecoveryLink | undefined> {
    idSchema.parse(branchId);
    const directory = path.join(this.root, branchId);
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const matches: PlayerTurnAuditRecoveryLink[] = [];
    for (const name of names) {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as unknown;
      if (!isRecord(value) || value.runId !== runId) continue;
      const audit = assertRecoveryAudit(value, branchId, runId);
      matches.push({
        id: audit.id,
        branchId: audit.branchId,
        runId: audit.runId,
        ...(audit.playerMoveId ? { playerMoveId: audit.playerMoveId } : {}),
        previousHead: audit.previousHead,
        finalHead: audit.finalHead,
        accepted: audit.accepted,
        ...(audit.eventHash ? { eventHash: audit.eventHash } : {}),
      });
    }
    if (matches.length > 1) {
      throw new Error(`Player move trace '${runId}' has ${matches.length} turn audits on branch '${branchId}'.`);
    }
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }
}

function assertRecoveryAudit(value: Record<string, unknown>, branchId: string, runId: string): PlayerTurnAudit {
  if (
    value.version !== 1
    || typeof value.id !== "string"
    || value.branchId !== branchId
    || value.runId !== runId
    || typeof value.previousHead !== "string"
    || typeof value.finalHead !== "string"
    || typeof value.accepted !== "boolean"
    || (value.playerMoveId !== undefined && typeof value.playerMoveId !== "string")
    || (value.eventHash !== undefined && typeof value.eventHash !== "string")
  ) {
    throw new Error(`Invalid player-turn recovery audit for trace '${runId}' on branch '${branchId}'.`);
  }
  const { version: _version, id, ...input } = value;
  const expectedId = `turn-${contentHash(input).slice(0, 24)}`;
  if (id !== expectedId) throw new Error(`Player-turn audit '${id}' failed its content-integrity check.`);
  return value as PlayerTurnAudit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
