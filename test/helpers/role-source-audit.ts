import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEvidenceFixture } from "./evidence.js";
import { ensureSourceStructure } from "../../src/compiler/structure.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import { loadCurrentRoleRoster } from "../../src/compiler/role-roster-tools.js";
import { RoleReviewWorkStore } from "../../src/compiler/role-review-work.js";
import { contentHash } from "../../src/world/canonical.js";
import { RequirementLedger } from "../../src/compiler/requirement-ledger.js";

export async function sourceAuditFixture(options?: { findings?: Array<{ name: string; observation: string; unitIds?: string[] }> }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-auto-audit-"));
  const evidence = await createEvidenceFixture(root, "Hero waits for a letter.\nLater, Hero receives Friend's letter.\n");
  await ensureSourceStructure(root, evidence.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: evidence.evidence("Hero") });
  const { roster, structure } = await loadCurrentRoleRoster(root, evidence.source.id);
  const store = await RoleReviewWorkStore.open(root, { version: 1, sourceId: roster.sourceId, sourceHash: roster.sourceSha256,
    subjectHash: roster.subjectHash, batchId: `role-roster-${roster.sourceId}-test`, structureHash: contentHash(structure),
    spans: [{ start: 0, end: evidence.source.bytes }], legacyDraftHashes: [] });
  const unit = roster.unitIds[0]!, candidate = roster.candidates[0]!;
  const findings = (options?.findings ?? []).map(finding => ({ ...finding, unitIds: finding.unitIds ?? [unit] }));
  await store.submit("source", 0, { summary: "A letter arrives later", findings, openQuestions: ["Does the letter arrive?"] }, () => {});
  await new RequirementLedger(root, roster.sourceId).registerRoleQuestions(store.questions(0));
  const entry = { candidateId: candidate.id, importance: "major", rationale: "Hero drives the scene", basisUnitIds: [unit],
    developmentExpectation: { kind: "unknown", rationale: "No long term evidence", basisUnitIds: [unit] } };
  store.journal.record("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry }, "succeeded");
  await store.submitClaim({ candidateId: candidate.id, claimRevision: contentHash(entry), atlasRevision: store.atlasRevision(), packetHash: contentHash(entry),
    verdict: "supported", rationale: "Boundary follows evidence", basisUnitIds: [unit], counterevidence: { searchedUnitIds: [unit], rationale: "Read the source" },
    checks: ["importance", "identity", "development"].map(kind => ({ kind, verdict: "supported", rationale: "Evidence checked", basisUnitIds: [unit] })) }, candidate.id, () => {});
  const audit = { rationale: "Need later evidence", missingMajorCharacters: [], unresolved: ["Arrival not checked"], atlasRevision: store.atlasRevision(),
    questionDispositions: store.questions(0).map(q => ({ questionId: q.questionId, status: "blocked" as const, rationale: "Need later evidence", basisUnitIds: [unit] })), discoveryDispositions: [] };
  return { root, store, roster, unit, audit, options: { root, configPath: path.join(root, "absent.yaml"), sourceId: roster.sourceId, compilerBatchId: store.plan.batchId, automaticRecovery: true as const } };
}
