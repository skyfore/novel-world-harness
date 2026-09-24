import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { buildLiteraryReferenceIndex } from "../src/world/literary-reference.js";
import { buildNarrativeSourceReferences } from "../src/world/narrative-source.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it.each([
  { visible: "The rain taps the window.", hidden: "Tomorrow the familiar witness will steal the key." },
  { visible: "细雨敲着窗棂。", hidden: "明天，熟识的见证人会悄悄偷走钥匙。" },
])("indexes exact actor-visible source text without adjacent hidden content: $visible", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-literary-index-")); roots.push(root);
  const text = `${scene.visible}\n${scene.hidden}`, source = await createEvidenceFixture(root, text);
  const context: WorldModelContext = { entities: new Map(["hero", "witness"].map(id => [id, { id, kind: "character", canonicalName: id, aliases: [], evidence: source.evidence(text) }])), claims: new Map(), rules: new Map(), actorGoals: [], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "witness", field: "character.alive", value: true }] }, undefined, source.source.id);
  await engine.branches.create({ id: "sibling", name: "Sibling", parentBranchId: "main", forkCommitId: genesis, headCommitId: genesis });
  const committed = await engine.commitProposal({ proposalId: "observe", branchId: "main", expectedParentCommit: genesis, source: "player", actorId: "hero", title: "The window", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }], actorObservations: [{ actorId: "hero", summary: scene.visible }], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "watch the rain" }] }, causalParents: [], evidence: source.evidence(text) });
  expect(committed.report.errors).toEqual([]);
  const args = { engine, workspaceRoot: root, branchId: "main", atCommit: committed.newHead, actorId: "hero", sourceId: source.source.id };
  const result = await buildLiteraryReferenceIndex(args);
  expect(result.references.map(item => item.text)).toEqual([scene.visible]);
  expect(result.index.records[0]!.span.endByte).toBe(Buffer.byteLength(scene.visible));
  expect(result.index.records[0]!.visibility).toEqual({ actorId: "hero", basis: "committed-observation" });
  expect(JSON.stringify(result)).not.toContain(scene.hidden);
  expect(result.index).toEqual((await buildLiteraryReferenceIndex({ ...args, engine: new WorldEngine(root, context) })).index);
  expect((await buildLiteraryReferenceIndex({ ...args, actorId: "witness" })).references).toEqual([]);
  expect((await buildLiteraryReferenceIndex({ ...args, branchId: "sibling", atCommit: genesis })).references).toEqual([]);
  await expect(buildLiteraryReferenceIndex({ ...args, branchId: "sibling" })).rejects.toThrow("LITERARY_REFERENCE_STALE_HEAD");
});

it("does not use a keyword anchor as authority for a paragraph, or pick an ambiguous occurrence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-literary-admission-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Wait. A hidden plan. Wait.");
  const base = { workspaceRoot: root, sourceId: source.source.id };
  expect(await buildNarrativeSourceReferences({ ...base, candidates: [{ evidence: source.evidence("Wait. A hidden plan. Wait."), relevance: ["style"], anchors: ["Wait."] }] })).toEqual([]);
  expect(await buildNarrativeSourceReferences({ ...base, candidates: [{ evidence: source.evidence("Wait. A hidden plan. Wait."), relevance: ["style"], anchors: ["Wait."], admittedTexts: ["Wait."] }] })).toEqual([]);
  const refs = await buildNarrativeSourceReferences({ ...base, candidates: [0, 1].map(index => ({ evidence: source.evidence("Wait.", index), relevance: ["committed speech"], anchors: ["Wait."], admittedTexts: ["Wait."], occurrenceId: `event-${index}` })) });
  expect(refs.map(item => item.text)).toEqual(["Wait.", "Wait."]);
  expect(refs[0]!.ref).not.toBe(refs[1]!.ref);
});
