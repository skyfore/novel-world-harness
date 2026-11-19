import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { buildReferencePack, loadReferencePack, writeReferencePack } from "../src/compiler/reference-pack.js";
import { draftGoldSliceFromReference, goldSliceSchema, restrictBundleToRange, scoreGoldSlice, unconfirmedRecords } from "../src/eval/gold-slice.js";

const text = "\t“我们走。”路明非说。\n\t诺诺点头，走了。\n";
const source = Buffer.from(text, "utf8");
const at = (needle: string, from = 0) => {
  const startByte = Buffer.byteLength(text.slice(0, text.indexOf(needle, from)), "utf8");
  return { version: 1, sourceId: "src", startByte, endByte: startByte + Buffer.byteLength(needle, "utf8"), startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
};
const derivation = { runId: "run", worker: "test", ontologyVersion: "observation-v1" };
const [line1, line2] = text.split(/(?<=\n)/u);
const bundle = {
  source: { id: "src" }, segmenterVersion: 1, admission: null, readiness: null,
  canonical: {
    entities: [{ id: "lu", kind: "character", canonicalName: "路明非", aliases: [], evidence: [] }, { id: "nono", kind: "character", canonicalName: "诺诺", aliases: [], evidence: [] }],
    events: [{ id: "e1", title: "走", participants: ["lu"], preconditions: [], causalParents: [], confidence: 1, evidence: [], storyTime: { kind: "unknown" }, observedOutcome: { version: 1, operations: [] } }],
    eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], propositions: [], claims: [], attributions: [], models: [], goals: [],
    normTemplates: [], processTemplates: [], actionSchemas: [], actionConstraints: [], rules: [], possibilities: [], initialWorld: { delta: { version: 1, operations: [] }, evidence: [] },
  },
  compilerSnapshot: {
    structure: { sourceId: "src", units: [], baseUnitIds: [] }, evidenceBindings: [],
    annotations: [
      { version: 1, id: "m1", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("路明非"), surface: "路明非", form: "proper", kindCandidates: ["character"], confidence: 1 },
      { version: 1, id: "m2", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("诺诺"), surface: "诺诺", form: "proper", kindCandidates: ["character"], confidence: 1 },
      { version: 1, id: "q1", sourceId: "src", derivation, annotationType: "quotation", anchor: at("“我们走。”"), mode: "direct", speakerMentionId: "m1", addresseeMentionIds: [], attributionConfidence: 1 },
      { version: 1, id: "em1", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: at("走", text.indexOf("走了")), trigger: "走", extentAnchors: [at(line2!)],
        eventTypeCandidates: ["movement"], participantMentionIds: ["m2"], salience: "major", confidence: 1 },
    ],
    entityResolutions: [{ id: "r1", mentionId: "m1", status: "resolved", entityId: "lu" }, { id: "r2", mentionId: "m2", status: "resolved", entityId: "nono" }],
    eventResolutions: [{ id: "er1", eventMentionIds: ["em1"], status: "new-event", canonicalEventId: "e1" }],
    accounting: { records: [] },
  },
} as unknown as PreparedNovelBundle;

const temporary: string[] = [];
afterAll(async () => { for (const directory of temporary) await fs.rm(directory, { recursive: true, force: true }); });

describe("gold slices", () => {
  it("drafts from a reference pack, refuses unconfirmed drafts, and scores confirmed ones with the 13-layer scorer", async () => {
    const directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "nwh-gold-")), "pack");
    temporary.push(path.dirname(directory));
    await writeReferencePack(directory, buildReferencePack(bundle, source), { source: { id: "src", sha256: "a".repeat(64), bytes: source.byteLength },
      compiler: { pipelineVersion: 50, promptVersion: 51, engineVersion: null, segmenterVersion: 1 }, bundle: { origin: "candidate", baselineIssues: 0 } });
    const pack = await loadReferencePack(directory);
    const range = { startByte: 0, endByte: source.byteLength };
    const draft = draftGoldSliceFromReference(pack, range, { name: "slice", directory, manifestSha256: "b".repeat(64) });
    expect(draft.gold.semantic.mentions.map((mention) => mention.kind).sort()).toEqual(["entity", "entity", "event", "quotation"]);
    expect(draft.gold.semantic.quotations[0]!.speakerEntityClusterId).toBeDefined();
    expect(unconfirmedRecords(draft)).toHaveLength(8);
    await expect(scoreGoldSlice("/nonexistent", bundle, draft)).rejects.toThrow("GOLD_SLICE_UNCONFIRMED");
    const confirmed = goldSliceSchema.parse({ ...draft, provenance: { ...draft.provenance, confirmedRecordIds: unconfirmedRecords(draft) } });
    const score = await scoreGoldSlice("/nonexistent", bundle, confirmed);
    expect(score.unconfirmed).toBe(0);
    expect(score.layers.mentions).toMatchObject({ status: "evaluated", precision: 1, recall: 1 });
    expect(score.layers.quotations).toMatchObject({ status: "evaluated", precision: 1, recall: 1 });
    expect(score.layers.entityResolution).toMatchObject({ status: "evaluated", recall: 1 });
  });

  it("rejects records outside the slice range and restricts the candidate to the range", () => {
    const range = { startByte: at(line2!).startByte, endByte: at(line2!).endByte };
    expect(() => goldSliceSchema.parse({ version: 1, kind: "nwh-gold-slice", name: "x", source: { id: "src", sha256: "a".repeat(64) }, range,
      provenance: { drafted: "manual" }, gold: { version: 2, name: "x", semantic: { mentions: [{ id: "g1", kind: "entity", span: { sourceId: "src", startByte: 0, endByte: 3 } }] } } })).toThrow("outside the slice range");
    const restricted = restrictBundleToRange(bundle, range);
    expect(restricted.compilerSnapshot.annotations.map((item) => item.id)).toEqual(["m2", "em1"]);
    expect(restricted.compilerSnapshot.entityResolutions.map((item) => item.id)).toEqual(["r2"]);
    expect(restricted.canonical.events.map((event) => event.id)).toEqual(["e1"]);
  });
});
