import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import { assertPreparedReadiness, preparedSubjectHash, type NovelClosureAssessment } from "../compiler/certification.js";
import { buildRoleRoster, majorRoleCandidates } from "../compiler/role-roster.js";
import { contentHash } from "./canonical.js";
import { deriveCharacterEntryOptions, deriveCharacterEntrySeed } from "./entry-context.js";
import { preparedPlayRoleSchema, type PreparedPlayRole } from "./play-role-schema.js";

/** One projection for CLI, Web and diagnostics; missing entries never shrink the roster. */
export function describePreparedRoles(bundle: PreparedNovelBundle, assessment: NovelClosureAssessment | null = bundle.readiness): PreparedPlayRole[] {
  const snapshot = bundle.compilerSnapshot;
  const roster = snapshot.roleRoster ?? buildRoleRoster({ sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256,
    unitIds: snapshot.structure.baseUnitIds, entities: bundle.canonical.entities, annotations: snapshot.annotations, resolutions: snapshot.entityResolutions });
  const major = majorRoleCandidates(roster), majorIds = new Set(major.map((role) => role.id));
  const candidates = [...new Map([...roster.candidates, ...major].map((role) => [role.id, role])).values()];
  const entries = deriveCharacterEntryOptions(bundle);
  const current = assessment?.subjectSnapshotHash === preparedSubjectHash(bundle) && assessment.playability?.rosterHash === contentHash(roster);
  return candidates.map((candidate) => {
    const entry = entries.find((option) => option.actorId === candidate.entityId);
    const probe = current ? assessment.playability?.roles.find((role) => role.candidateId === candidate.id) : undefined;
    const issues = [...(probe?.issues ?? [])];
    if (!current) issues.push({ code: "ROLE_EVALUATION_NOT_CURRENT", message: "This role has not been evaluated against the current frozen inputs" });
    else if (!probe) issues.push({ code: "ROLE_NOT_CERTIFIED", message: "This role has no entry certification" });
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

export function certifiedEntryOptions(bundle: PreparedNovelBundle) {
  assertPreparedReadiness(bundle);
  const ready = new Set(describePreparedRoles(bundle).filter((role) => role.status === "ready").map((role) => role.actorId));
  return deriveCharacterEntryOptions(bundle).filter((entry) => ready.has(entry.actorId));
}

/** Checked immediately before Genesis as well as at role selection. */
export function requireCertifiedEntry(bundle: PreparedNovelBundle, actorId: string, expectedEntryCutHash?: string) {
  if (!certifiedEntryOptions(bundle).some((entry) => entry.actorId === actorId)) throw new Error(`MAJOR_ROLE_NOT_CERTIFIED: ${actorId} has no certified entry in this revision`);
  const seed = deriveCharacterEntrySeed(bundle, actorId);
  if (expectedEntryCutHash && seed.cut.hash !== expectedEntryCutHash) throw new Error("ENTRY_CUT_STALE: the selected historical cut changed. Refresh the role list and copy entryCutHash before retrying once.");
  return seed;
}
