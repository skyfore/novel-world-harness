import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RequirementLedger, requirementResultIssues } from "../src/compiler/requirement-ledger.js";
import { registerSourceRequirements, requirementInputs, settleSourceRequirements } from "../src/compiler/requirement-service.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { validateAssessmentRevision } from "../src/compiler/certification.js";
import { contentHash } from "../src/world/canonical.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(content = "Ada waits. Nothing changes.") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-requirement-ledger-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, content);
  const sourceId = fixture.source.id, canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: fixture.evidence("Ada") });
  const event = canonicalEventSchema.parse({ id: "wait", title: "Waiting", participants: ["ada"],
    participantPresence: [{ entityId: "ada", mode: "physical" }],
    storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: fixture.evidence(content) });
  await canon.putEvent(event);
  const bytes = Buffer.from(content), spec = { version: 1 as const, sourceId, sourceSha256: fixture.source.contentSha256,
    review: { method: "independent-source-review" as const, reviewer: "independent-fixture-author", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "source-review-v1" },
    cases: [{ id: "waiting", kind: "event-effects" as const, scene: "Waiting", rationale: "The independent text states no change",
      evidence: [textAnchorForByteRange(sourceId, bytes, 0, bytes.length)], eventId: "wait", requiresMechanism: false,
      expectation: { kind: "no-change" as const, justification: "Explicit no change" } }],
  };
  const ledger = new RequirementLedger(root, sourceId);
  const register = (value: unknown = spec, predecessorRevision?: string) => registerSourceRequirements(root, { sourceId, id: "scene-checks", spec: value, scopeDecisionRef: "review-decision", predecessorRevision });
  return { root, sourceId, fixture, event, bytes, spec, canon, ledger, register };
}

it("persists separate unresolved requirements across restart and idempotent reevaluation", async () => {
  const f = await setup();
  await f.register({ ...f.spec, cases: [{ ...f.spec.cases[0], initiatorId: "ada", requiresMechanism: true }] });
  const first = await settleSourceRequirements(f.root, f.sourceId);
  expect(first.results[0]!.requirements.find(item => item.id.endsWith(":state-effect"))!.state).toBe("satisfied");
  expect(first.issues.join()).toContain("agency: blocked");
  expect(first.issues.join()).toContain("mechanism: blocked");
  const count = (await f.ledger.history()).length;
  const restarted = new RequirementLedger(f.root, f.sourceId);
  expect(await restarted.definitions()).toEqual(first.sets);
  const inputs = await requirementInputs(f.root, f.sourceId);
  await restarted.evaluate(inputs.bytes, inputs.catalog);
  expect((await restarted.history()).length).toBe(count);
  // A changed repair namespace is not a ledger identity or reset mechanism.
  await fs.mkdir(path.join(worldStorageRoot(f.root), "compiler", "reconciliation", "another-namespace"), { recursive: true });
  expect((await settleSourceRequirements(f.root, f.sourceId)).issues).toEqual(first.issues);
});

it("requires exact predecessor for scope changes and retains superseded definitions", async () => {
  const f = await setup(), original = await f.register();
  const changed = { ...f.spec, review: { ...f.spec.review, auditRef: "corrected-independent-review" } };
  await expect(f.register(changed)).rejects.toThrow("predecessor");
  expect(await f.ledger.definitions()).toEqual([original]);
  const successor = await f.register(changed, original.revisionHash);
  expect(successor.parentRevision).toBe(original.revisionHash);
  expect(await f.ledger.definitionHistory()).toEqual([original, successor]);
  expect(await f.register(changed, original.revisionHash)).toEqual(successor);
  await expect(f.register(f.spec, original.revisionHash)).rejects.toThrow("predecessor");
});

it("rechecks active revisions and rejects forged success, missing results and changed denominators", async () => {
  const f = await setup(); await f.register();
  const first = await settleSourceRequirements(f.root, f.sourceId), inputs = await requirementInputs(f.root, f.sourceId);
  expect(first.issues).toEqual([]);
  const altered = structuredClone(first.results);
  altered[0]!.requirements.pop();
  expect(requirementResultIssues(first.sets, altered, inputs.catalog).join()).toContain("DENOMINATOR_CHANGED");
  expect(requirementResultIssues(first.sets, [], inputs.catalog).join()).toContain("NOT_EVALUATED");
  await f.canon.putEvent({ ...f.event, observedOutcome: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: false }] } });
  const current = await requirementInputs(f.root, f.sourceId);
  expect(requirementResultIssues(first.sets, first.results, current.catalog).join()).toContain("REVISION_STALE");
  const reevaluated = await settleSourceRequirements(f.root, f.sourceId);
  expect(reevaluated.issues.join()).toContain("UNRESOLVED");
  const forged = structuredClone(reevaluated.results);
  forged[0]!.requirements.forEach(item => { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; });
  expect(requirementResultIssues(first.sets, forged, current.catalog).join()).toContain("RESULT_MISMATCH");
  expect((await f.ledger.history()).filter(record => record.payload.kind === "evaluation")).toHaveLength(2);
});

it("validates source before any registration and rejects foreign scopes", async () => {
  const f = await setup();
  const altered = structuredClone(f.spec); altered.cases[0]!.evidence[0]!.exactHash = "0".repeat(64);
  await expect(f.register(altered)).rejects.toThrow("EVIDENCE_INVALID");
  await expect(f.register({ ...f.spec, sourceSha256: "0".repeat(64) })).rejects.toThrow("source hash mismatch");
  await expect(f.register({ ...f.spec, sourceId: "another-source" })).rejects.toThrow("scope mismatch");
  expect(await f.ledger.history()).toEqual([]);
  expect(await f.canon.listEvents()).toEqual([f.event]);
});

it("settles only committed active artifacts after the real proposal, finish and convergence chain", async () => {
  const f = await setup(); await f.register();
  const bad = { ...f.event, observedOutcome: { version: 1 as const, operations: [{ op: "set" as const, entityId: "ada", field: "character.alive", value: false }] } };
  await f.canon.putEvent(bad);
  expect((await settleSourceRequirements(f.root, f.sourceId)).issues.length).toBeGreaterThan(0);
  const tools = createCompilerProposalToolset(f.root);
  const batchId = `requirement-repair-${f.sourceId}`;
  await tools.beginBatch([], batchId, f.sourceId);
  const call = (name: string, args: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, args as never, undefined, undefined, {} as never);
  const { evidence: _evidence, ...payload } = f.event;
  await call("propose_canonical_event", { proposal_id: "repair-wait", payload, evidence_segment_ids: [f.fixture.segmentId] });
  expect((await settleSourceRequirements(f.root, f.sourceId)).issues.length).toBeGreaterThan(0);
  await expect(call("finish_compiler_batch", { outcome: "no-artifacts", reviewed_segments: [], summary: "Invalid finish" })).rejects.toThrow("active successful");
  expect(await f.canon.listEvents()).toEqual([bad]);
  expect(await new CompilerFinishReceipts(f.root, f.sourceId, batchId).read()).toBeUndefined();
  await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Restore the source-reviewed no-change occurrence" });
  expect((await settleSourceRequirements(f.root, f.sourceId)).issues.length).toBeGreaterThan(0);
  await convergeWorldProposals(f.root, f.sourceId);
  expect((await settleSourceRequirements(f.root, f.sourceId)).issues).toEqual([]);
  expect(await f.canon.listEvents()).toEqual([f.event]);
});

it("fails closed on a missing head, missing committed record or corrupted content", async () => {
  const f = await setup(); await f.register();
  const directory = path.join(worldStorageRoot(f.root), "compiler", "requirements", f.sourceId);
  const headPath = path.join(directory, "head.json"), headBytes = await fs.readFile(headPath);
  const head = JSON.parse(headBytes.toString());
  await fs.unlink(headPath);
  await expect(f.ledger.definitions()).rejects.toThrow("head is missing");
  await fs.writeFile(headPath, headBytes);
  const file = path.join(directory, `${head.hash}.json`), original = await fs.readFile(file);
  await fs.unlink(file);
  await expect(f.ledger.definitions()).rejects.toThrow();
  const forged = JSON.parse(original.toString()); forged.payload.definition.scopeDecisionRef = "tampered";
  await fs.writeFile(file, JSON.stringify(forged));
  await expect(f.ledger.definitions()).rejects.toThrow("hash mismatch");
  await fs.writeFile(file, original);
  expect(await f.ledger.definitions()).toHaveLength(1);
});

it("round-trips full definition lineage and refuses rollback that forgets local obligations", async () => {
  const f = await setup("Ada stays outside. No one moves."), first = await f.register();
  await f.register({ ...f.spec, review: { ...f.spec.review, auditRef: "second-review" } }, first.revisionHash);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-requirement-clone-")); roots.push(cloneRoot);
  const clone = new RequirementLedger(cloneRoot, f.sourceId), history = await f.ledger.definitionHistory();
  await clone.restore(history);
  expect(await clone.definitions()).toEqual(await f.ledger.definitions());
  await expect(clone.restore([first])).rejects.toThrow("forget current obligations");
  await expect(clone.restore([])).rejects.toThrow("forget current obligations");
  expect(await clone.definitionHistory()).toEqual(history);
});

it("freezes requirements in real candidate snapshots, checks certificates and preserves old candidates", async () => {
  const f = await setup(); await f.register();
  await new InitialWorldStore(f.root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }] }, evidence: f.fixture.evidence("Ada waits. Nothing changes.") });
  const batches = await prepareCompilerBatches(f.root, f.fixture.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache"));
  const candidate = await cache.inspectCandidate(f.fixture.source);
  expect(candidate.bundle.compilerSnapshot.requirementDefinitions).toEqual(await f.ledger.definitionHistory());
  expect(candidate.assessment.requirementResults?.[0]?.requirements.every(item => item.state === "satisfied")).toBe(true);
  expect(candidate.assessment.closure.nodes.some(node => node.kind === "requirement-set")).toBe(true);
  const oldHash = contentHash(candidate.bundle), corrupt = structuredClone(candidate.assessment);
  corrupt.requirementResults = [];
  expect(validateAssessmentRevision(candidate.bundle, corrupt).join()).toContain("REQUIREMENT_NOT_EVALUATED");
  const archive = await cache.publish(f.fixture.source, { allowSemanticDebtForRollback: true });
  const first = (await f.ledger.definitions())[0]!;
  await f.register({ ...f.spec, cases: [{ ...f.spec.cases[0], requiresMechanism: true, initiatorId: "ada" }] }, first.revisionHash);
  const next = await cache.inspectCandidate(f.fixture.source);
  expect(next.assessment.issues.some(issue => issue.code === "REQUIREMENT_NOT_CERTIFIED")).toBe(true);
  expect(next.assessment.fullNovelReady).toBe(false);
  await expect(cache.restoreCompilerCheckpoint(f.fixture.source, archive.bundleHash!)).rejects.toThrow("forget current obligations");
  expect(contentHash(candidate.bundle)).toBe(oldHash);
  expect(await f.canon.listEvents()).toEqual([f.event]);
});

it("transports the complete scene journal, resumes a prefix import and rejects lost evaluations or bad source bytes", async () => {
  const f = await setup(); await f.register(); await settleSourceRequirements(f.root, f.sourceId);
  const frozen = await f.ledger.history();
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-scene-journal-import-")); roots.push(cloneRoot);
  const clone = new RequirementLedger(cloneRoot, f.sourceId);
  await expect(clone.restoreJournal(frozen, Buffer.from("Different source bytes"))).rejects.toThrow("SCENE_REVIEW_SOURCE_MISMATCH");
  expect(await clone.history()).toEqual([]);
  await clone.restoreJournal(frozen.slice(0, 1), f.bytes);
  await clone.restoreJournal(frozen, f.bytes);
  await clone.restoreJournal(frozen, f.bytes);
  expect(await new RequirementLedger(cloneRoot, f.sourceId).history()).toEqual(frozen);
  await f.canon.putEvent({ ...f.event, observedOutcome: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: false }] } });
  await settleSourceRequirements(f.root, f.sourceId);
  await expect(f.ledger.restoreJournal(frozen, f.bytes)).rejects.toThrow("discard or rewrite current audit history");
  expect((await f.ledger.history()).filter(record => record.payload.kind === "evaluation")).toHaveLength(2);
});
