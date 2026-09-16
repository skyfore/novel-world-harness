import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { semanticEffectSchema, validateSemanticEffect } from "../src/world/semantic-effect.js";
import { createCompilerProposalToolset, compilerToolAllowedInSemanticStage } from "../src/compiler/proposal-tools.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { buildPreparedClosure } from "../src/compiler/closure.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine, validateEventProposal } from "../src/world/engine.js";
import { loadCompilerArtifactRecords } from "../src/compiler/artifact-retrieval.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { withNwhToolRecovery, buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { contentHash } from "../src/world/canonical.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it.each([
  { name: "Rin", text: "Rin plans to walk home. Suddenly Rin cannot speak; nobody knows how long this will last.", capacity: "speech" },
  { name: "Tova", text: "A bell rings. Tova plans to leave. Tova becomes unable to move for an unknown duration.", capacity: "action" },
])("persists unmapped source meaning through finish, rebuild and runtime: $name", async fixture => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-semantic-effect-")); roots.push(root);
  const source = await createEvidenceFixture(root, fixture.text), canonical = new CanonicalModelStore(root);
  await canonical.putEntity({ id: "actor", kind: "character", canonicalName: fixture.name, aliases: [], evidence: source.evidence(fixture.name) });
  const event = canonicalEventSchema.parse({ id: "incapacity", title: "Temporary incapacity", participants: ["actor"], participantPresence: [{ entityId: "actor", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: source.evidence(fixture.text) });
  await canonical.putEvent(event);
  const payload = { ontologyVersion: "semantic-effect-v1", id: "incapacity-meaning", canonicalEventId: event.id, subjectEntityId: "actor", validTime: event.storyTime,
    kind: "temporary-incapacity", args: { capacity: fixture.capacity, duration: { kind: "unknown" } }, lowering: { status: "unmapped", reason: "unknown-duration" } };
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "semantic-meaning", source.source.id);
  const propose = withNwhToolRecovery(toolset.tools.find(item => item.name === "propose_semantic_effect")!);
  expect(propose).toBeDefined();
  expect(compilerToolAllowedInSemanticStage(propose.name, "semantic")).toBe(true);
  expect(compilerToolAllowedInSemanticStage(propose.name, "observation")).toBe(false);
  const input = { proposal_id: "meaning-proposal", payload, evidence_segment_ids: [source.segmentId],
    evidence_selectors: ["/canonicalEventId", "/subjectEntityId", "/kind", "/validTime", "/args/capacity", "/args/duration"].map(target_path => ({ segment_id: source.segmentId, exact: fixture.text, target_path, relation: "supports", strength: "explicit" })) };
  await expect(propose.execute("missing-evidence", { ...input, evidence_selectors: input.evidence_selectors.slice(1) } as never, undefined, undefined, {} as never)).rejects.toThrow("SEMANTIC_EFFECT_EVIDENCE_MISSING");
  expect(await canonical.listSemanticEffects()).toEqual([]);
  await propose.execute("correct-evidence", input as never, undefined, undefined, {} as never);
  const finished = await toolset.tools.find(item => item.name === "finish_compiler_batch")!.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "Source meaning is represented; no execution is claimed" } as never, undefined, undefined, {} as never);
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const effect = (await canonical.listSemanticEffects())[0]!;
  expect(effect, JSON.stringify(finished)).toBeDefined();
  expect(effect.lowering).toEqual(payload.lowering);
  expect(await canonical.getEvent(event.id)).toEqual(event);
  expect((await loadCompilerArtifactRecords(root, source.source.id)).some(item => item.kind === "semantic-effect" && item.logicalId === effect.id)).toBe(true);
  await new InitialWorldStore(root).put({ version: 1, evidence: source.evidence(fixture.text), participantPresence: [{ entityId: "actor", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "actor", field: "character.alive", value: true }, { op: "set", entityId: "actor", field: "character.plan", value: "leave" }] } });
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, (await prepareCompilerBatches(root, source.source)).map(item => item.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot);
  const bundle = await cache.candidateSnapshot(source.source);
  const archived = await cache.archiveCandidate(source.source);
  expect(bundle.canonical.semanticEffects).toEqual([effect]);
  const node = buildPreparedClosure(bundle).nodes.find(item => item.kind === "semantic-effect" && item.id === effect.id)!;
  expect(node.revisionHash).toBe(contentHash(effect));
  expect(node.dependsOn).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "event", id: event.id }), expect.objectContaining({ kind: "entity", id: "actor" })]));
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-semantic-clone-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, fixture.text);
  await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(cloneSource.source, archived.bundleHash!);
  expect(await new CanonicalModelStore(cloneRoot).listSemanticEffects()).toEqual([effect]);
  const contexts = new WorldContextStore(cloneRoot), context = await contexts.captureCurrent(cloneSource.source.id);
  expect((await contexts.load(context.canonicalSnapshotHash!)).semanticEffects?.get(effect.id)).toEqual(effect);
  const engine = new WorldEngine(cloneRoot, context);
  const head = await engine.createBranch("test", "Unmapped", { version: 1, operations: [{ op: "set", entityId: "actor", field: "character.alive", value: true }] });
  const state = await engine.projector.project(head);
  const proposal = { proposalId: "attempt", source: "actor", title: "Attempted canonical incapacity", evidence: [], causalParents: [], branchId: "test", expectedParentCommit: head, actorId: "actor", participants: ["actor"], possibilityId: `canon-${event.id}`, preconditions: [], proposedDelta: { version: 1, operations: [] }, proposedTime: { kind: "unknown" } };
  expect(validateEventProposal(proposal as never, head, state, context).report.errors.some(item => item.code === "SEMANTIC_EFFECT_UNMAPPED")).toBe(true);
  const { possibilityId: _canonical, ...independent } = proposal;
  expect(validateEventProposal(independent as never, head, state, context).report.errors.some(item => item.code === "SEMANTIC_EFFECT_UNMAPPED")).toBe(false);
  expect(() => semanticEffectSchema.parse({ ...effect, lowering: { status: "mapped", executionId: "invented" } })).toThrow();
  expect(validateSemanticEffect({ ...effect, subjectEntityId: "missing" }, { entities: context.entities, events: context.events! })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SEMANTIC_EFFECT_SUBJECT_MISSING" })]));
  await expect(engine.createBranch("forged", "Cannot claim an unmapped occurrence", { version: 1, operations: [] }, undefined, undefined, undefined, [], {}, { realizesCanonicalEventIds: [event.id] })).rejects.toThrow("SEMANTIC_EFFECT_UNMAPPED");
  await new EvidenceAssertionStore(root).replaceForArtifact("semantic-effect", effect.id, contentHash(effect), []);
  await expect(cache.candidateSnapshot(source.source)).rejects.toThrow("Semantic effect exact evidence is incomplete");
  // The archived checkpoint and its frozen runtime context retain their original evidence.
  expect((await contexts.load(context.canonicalSnapshotHash!)).semanticEffects?.get(effect.id)).toEqual(effect);
});

it.each([
  { giver: "Hero", recipient: "Mo Yan", text: "Hero owns the silver key and plans to give it away. Hero gives Mo Yan the silver key." },
  { giver: "Nell", recipient: "Oren", text: "A dog barks. Nell owns the silver key and plans a gift. Oren receives the silver key from Nell." },
])("lowers only through a validated action and the existing reducer: $giver", async fixture => {
  const { giftSchema, giftSilverKey } = await import("./helpers/actions.js");
  const { CompilerValidator } = await import("../src/compiler/validator.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-mapped-effect-")); roots.push(root);
  const source = await createEvidenceFixture(root, fixture.text), canonical = new CanonicalModelStore(root);
  for (const [id, canonicalName, kind] of [["hero", fixture.giver, "character"], ["mo-yan", fixture.recipient, "character"], ["silver-key", "silver key", "artifact"]] as const) await canonical.putEntity({ id, canonicalName, kind, aliases: [], evidence: source.evidence(canonicalName) });
  await canonical.putActionSchema(giftSchema);
  const delta = { version: 1 as const, operations: [{ op: "set" as const, entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }] };
  const event = canonicalEventSchema.parse({ id: "gift", title: "A gift", participants: ["hero", "mo-yan", "silver-key"], participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "mo-yan", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: delta, causalParents: [], confidence: 1, evidence: source.evidence(fixture.text) });
  await canonical.putEvent(event);
  for (const [entityId, role] of [["hero", "agent"], ["mo-yan", "beneficiary"], ["silver-key", "theme"]] as const) await canonical.putEventParticipation({ id: `participation-${entityId}`, eventId: event.id, entityId, role, ...(entityId !== "silver-key" ? { presence: "physical" as const } : {}), confidence: 1, evidence: source.evidence(fixture.text) });
  await canonical.putEventExecution({ id: "gift-execution", canonicalEventId: event.id, actorId: "hero", action: giftSilverKey as never, evidence: source.evidence(fixture.text) });
  const payload = { ontologyVersion: "semantic-effect-v1", id: "gift-meaning", canonicalEventId: event.id, subjectEntityId: "silver-key", validTime: event.storyTime,
    kind: "state-change", args: { field: "artifact.owner", value: "mo-yan" }, lowering: { status: "mapped", executionId: "gift-execution" } };
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], "gift-meaning", source.source.id);
  await toolset.tools.find(item => item.name === "propose_semantic_effect")!.execute("propose", { proposal_id: "gift-meaning", payload, evidence_segment_ids: [source.segmentId],
    evidence_selectors: ["/canonicalEventId", "/subjectEntityId", "/kind", "/validTime", "/args/field", "/args/value"].map(target_path => ({ segment_id: source.segmentId, exact: fixture.text, target_path, relation: "supports", strength: "explicit" })) } as never, undefined, undefined, {} as never);
  await toolset.tools.find(item => item.name === "finish_compiler_batch")!.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "One explicitly evidenced ownership effect" } as never, undefined, undefined, {} as never);
  expect((await convergeWorldProposals(root, source.source.id)).canonical.blocked).toEqual([]);
  const effect = (await canonical.listSemanticEffects())[0]!;
  const validator = new CompilerValidator(canonical);
  expect((await validator.validate("semantic-effect", { ...effect, args: { field: "artifact.owner", value: "hero" } })).errors.some(item => item.code === "SEMANTIC_EFFECT_LOWERING_MISMATCH")).toBe(true);
  expect((await validator.validate("semantic-effect", { ...effect, lowering: { status: "mapped", executionId: "missing" } })).errors.some(item => item.code === "SEMANTIC_EFFECT_EXECUTION_MISSING")).toBe(true);
  const contexts = new WorldContextStore(root), context = await contexts.captureCurrent(source.source.id);
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("gift", "Before the gift", { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }, { op: "set", entityId: "hero", field: "character.alive", value: true }] });
  const state = await engine.projector.project(head);
  const proposal = { proposalId: "gift", branchId: "gift", expectedParentCommit: head, source: "actor", title: "Give the key", actorId: "hero", participants: event.participants, participantPresence: event.participantPresence,
    proposedTime: event.storyTime, preconditions: [], proposedDelta: delta, causalParents: [], evidence: [], action: giftSilverKey, possibilityId: "canon-gift" } as const;
  const result = validateEventProposal(proposal as never, head, state, context);
  expect(result.report.errors).toEqual([]);
  expect(result.postState!.values["silver-key"]!["artifact.owner"]).toBe("mo-yan");
  expect(state.values["silver-key"]!["artifact.owner"]).toBe("hero");
  const committed = await engine.commitProposal(proposal as never);
  expect(committed.report.errors).toEqual([]);
  expect(committed.newHead).not.toBe(head);
  expect((await engine.projector.project(committed.newHead, { fresh: true, useCheckpoints: false })).values["silver-key"]!["artifact.owner"]).toBe("mo-yan");
  expect(await canonical.getEvent(event.id)).toEqual(event);
  const invalid = createCompilerProposalToolset(root); await invalid.beginBatch([], "invalid-mapping", source.source.id);
  await invalid.tools.find(item => item.name === "propose_semantic_effect")!.execute("bad", { proposal_id: "bad-meaning", payload: { ...payload, id: "bad-meaning", args: { field: "artifact.owner", value: "hero" } }, evidence_segment_ids: [source.segmentId],
    evidence_selectors: ["/canonicalEventId", "/subjectEntityId", "/kind", "/validTime", "/args/field", "/args/value"].map(target_path => ({ segment_id: source.segmentId, exact: fixture.text, target_path, relation: "supports", strength: "explicit" })) } as never, undefined, undefined, {} as never);
  await expect(invalid.tools.find(item => item.name === "finish_compiler_batch")!.execute("bad-finish", { outcome: "complete", reviewed_segments: [], summary: "Invalid lowering" } as never, undefined, undefined, {} as never)).rejects.toThrow("SEMANTIC_EFFECT_LOWERING_MISMATCH");
  expect(await canonical.listSemanticEffects()).toEqual([effect]);
  expect(await canonical.getEvent(event.id)).toEqual(event);
  expect((await contexts.load(context.canonicalSnapshotHash!)).semanticEffects?.get(effect.id)).toEqual(effect);
});

it("gives bounded same-source dependency recovery and stops unmapped realization", () => {
  const missing = buildNwhToolRecoveryAdvice("finish_compiler_batch", "SEMANTIC_EFFECT_EXECUTION_MISSING: mapped effect requires a same-occurrence execution");
  expect(missing.category).toBe("lookup-miss");
  expect(missing.suggestedCall?.arguments.kind).toBe("event-execution");
  expect(missing.steps.join(" ")).toContain("results[].readArguments.ref");
  expect(missing.steps.join(" ")).toContain("payload.id");
  expect(missing.steps.join(" ")).toContain("at most one");
  expect(buildNwhToolRecoveryAdvice("propose_semantic_effect", "SEMANTIC_EFFECT_UNMAPPED: unsupported mechanism")).toMatchObject({ retryable: false, category: "host-repair-required" });
});
