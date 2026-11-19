import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import { preparedSubjectHash, type NovelClosureAssessment } from "../compiler/certification.js";
import { admittedEntries, assertCutAdmission, assertPlayableRevision, DEFAULT_MINIMUM_ADMISSION_TIER, type AdmissionTier } from "../compiler/cut-admission.js";
import { buildRoleRoster, majorRoleCandidates } from "../compiler/role-roster.js";
import { contentHash } from "./canonical.js";
import { deriveCharacterEntryOptions, deriveCharacterEntrySeed, deriveSceneEntrySeed } from "./entry-context.js";
import { preparedPlayRoleSchema, type PreparedPlayRole } from "./play-role-schema.js";
import { ENTRY_ACTION_WITNESS_VERSION, ENTRY_CONTRACT_VERSION } from "./entry-contract.js";

/** One projection for CLI, Web and diagnostics; missing entries never shrink the roster. */
export function describePreparedRoles(bundle: PreparedNovelBundle, assessment: NovelClosureAssessment | null = bundle.readiness): PreparedPlayRole[] {
  const snapshot = bundle.compilerSnapshot;
  const roster = snapshot.roleRoster ?? buildRoleRoster({ sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256,
    unitIds: snapshot.structure.baseUnitIds, entities: bundle.canonical.entities, annotations: snapshot.annotations, resolutions: snapshot.entityResolutions });
  const major = majorRoleCandidates(roster), majorIds = new Set(major.map((role) => role.id));
  const candidates = [...new Map([...roster.candidates, ...major].map((role) => [role.id, role])).values()];
  const entries = deriveCharacterEntryOptions(bundle);
  const current = assessment?.subjectSnapshotHash === preparedSubjectHash(bundle) && assessment.playability?.rosterHash === contentHash(roster)
    && assessment.playability.contractVersion === ENTRY_CONTRACT_VERSION;
  const admitted = assessment?.fullNovelReady ? new Map<string, { cutId: string; entryCutHash?: string }>() : admittedCharacterEntries(bundle, DEFAULT_MINIMUM_ADMISSION_TIER);
  return candidates.map((candidate) => {
    const entry = entries.find((option) => option.actorId === candidate.entityId);
    const admittedEntry = candidate.entityId ? admitted.get(candidate.entityId) : undefined;
    if (entry && admittedEntry?.entryCutHash) {
      // A cut-admitted first entry is playable without full-novel certification (D1).
      return preparedPlayRoleSchema.parse({ id: candidate.entityId, rosterEntryId: candidate.id, actorId: candidate.entityId, canonicalName: candidate.name,
        aliases: bundle.canonical.entities.find((entity) => entity.id === candidate.entityId)?.aliases ?? [], major: majorIds.has(candidate.id),
        status: "ready", entryKind: entry.entry.kind, entryTitle: entry.entry.title, entryCutHash: admittedEntry.entryCutHash, issues: [] });
    }
    const probe = current ? assessment.playability?.roles.find((role) => role.candidateId === candidate.id) : undefined;
    const issues = [...(probe?.issues ?? [])];
    if (!current) issues.push({ code: "ROLE_EVALUATION_NOT_CURRENT", message: "This role has not been evaluated against the current frozen inputs" });
    else if (!probe) issues.push({ code: "ROLE_NOT_CERTIFIED", message: "This role has no entry certification" });
    else if (probe.status === "ready" && probe.actionWitness?.version !== ENTRY_ACTION_WITNESS_VERSION)
      issues.push({ code: "ENTRY_ACTION_CONTRACT_STALE", message: "Re-evaluate the entry action under the player's current scope" });
    if (!assessment?.fullNovelReady) issues.push({ code: "NOVEL_NOT_CERTIFIED", message: "Complete the novel's independent semantic and live play evaluation before starting a new playthrough" });
    if (!entry) issues.push({ code: "ROLE_ENTRY_MISSING", message: "No grounded historical entry is available" });
    return preparedPlayRoleSchema.parse({ id: candidate.entityId ?? candidate.id, rosterEntryId: candidate.id,
      ...(candidate.entityId ? { actorId: candidate.entityId } : {}), canonicalName: candidate.name,
      aliases: bundle.canonical.entities.find((entity) => entity.id === candidate.entityId)?.aliases ?? [], major: majorIds.has(candidate.id),
      status: !candidate.entityId ? "unresolved-identity" : probe?.status === "ready" && !issues.length ? "ready" : "blocked",
      ...(entry ? { entryKind: entry.entry.kind, entryTitle: entry.entry.title } : {}),
      ...(probe?.entryCutHash ? { entryCutHash: probe.entryCutHash } : {}), issues });
  });
}

/**
 * Entries a fresh playthrough may start from: every ready role of a fully
 * certified revision, otherwise each role whose grounded entry cut is
 * admitted at the minimum tier.
 */
export function certifiedEntryOptions(bundle: PreparedNovelBundle, minimumTier: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER) {
  if (assertPlayableRevision(bundle, minimumTier) === "certified") {
    const ready = new Set(describePreparedRoles(bundle).filter((role) => role.status === "ready").map((role) => role.actorId));
    return deriveCharacterEntryOptions(bundle).filter((entry) => ready.has(entry.actorId));
  }
  const admitted = admittedCharacterEntries(bundle, minimumTier);
  return deriveCharacterEntryOptions(bundle).filter((entry) => admitted.has(entry.actorId));
}

/** Checked immediately before Genesis as well as at role selection. */
export function requireCertifiedEntry(bundle: PreparedNovelBundle, actorId: string, expectedEntryCutHash?: string, minimumTier: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER) {
  if (!certifiedEntryOptions(bundle, minimumTier).some((entry) => entry.actorId === actorId)) throw new Error(`MAJOR_ROLE_NOT_CERTIFIED: ${actorId} has no certified or admitted entry in this revision`);
  const seed = deriveCharacterEntrySeed(bundle, actorId);
  const admitted = admittedCharacterEntries(bundle, minimumTier).get(actorId);
  if (admitted && admitted.entryCutHash !== seed.cut.hash) throw new Error("ENTRY_CUT_STALE: the admitted entry was probed at a different cut. Re-admit the revision before starting play.");
  if (expectedEntryCutHash && seed.cut.hash !== expectedEntryCutHash) throw new Error("ENTRY_CUT_STALE: the selected historical cut changed. Refresh the role list and copy entryCutHash before retrying once.");
  return seed;
}

/** Admitted opening/checkpoint entries per actor (derived scene entries are started by cut). */
function admittedCharacterEntries(bundle: PreparedNovelBundle, minimumTier: AdmissionTier): Map<string, { cutId: string; entryCutHash?: string }> {
  const entries = new Map<string, { cutId: string; entryCutHash?: string }>();
  for (const { cut, actor } of admittedEntries(bundle, minimumTier)) {
    if (actor.entryBasis === "derived" || entries.has(actor.actorId)) continue;
    entries.set(actor.actorId, { cutId: cut.cutId, ...(actor.entryCutHash ? { entryCutHash: actor.entryCutHash } : {}) });
  }
  return entries;
}

/**
 * Checked immediately before Genesis for a start at an explicit cut: the cut
 * and actor must be admitted at the minimum tier, and the entry derived now
 * must be the exact entry the deterministic probes evaluated.
 */
export function requireAdmittedSceneEntry(bundle: PreparedNovelBundle, cutId: string, actorId: string, expectedEntryCutHash?: string, minimumTier: AdmissionTier = DEFAULT_MINIMUM_ADMISSION_TIER) {
  const { actor } = assertCutAdmission(bundle, cutId, actorId, minimumTier);
  const seed = deriveSceneEntrySeed(bundle, cutId, actorId);
  if (actor.entryCutHash !== seed.cut.hash) throw new Error("ENTRY_CUT_STALE: the admitted entry was probed at a different cut. Re-admit the revision before starting play.");
  if (expectedEntryCutHash && seed.cut.hash !== expectedEntryCutHash) throw new Error("ENTRY_CUT_STALE: the selected scene entry changed. Refresh the cut list and copy entryCutHash before retrying once.");
  return seed;
}
