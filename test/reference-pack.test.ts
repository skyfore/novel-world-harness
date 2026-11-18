import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { buildReferencePack, compareWithReference, loadReferencePack, verifyReferencePack, writeReferencePack } from "../src/compiler/reference-pack.js";

const text = "\t“我们走。”路明非说。\n\t诺诺点头。\n";
const source = Buffer.from(text, "utf8");
const at = (needle: string) => {
  const startByte = Buffer.byteLength(text.slice(0, text.indexOf(needle)), "utf8");
  return { version: 1, sourceId: "src", startByte, endByte: startByte + Buffer.byteLength(needle, "utf8"), startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
};
const derivation = { runId: "run", worker: "test", ontologyVersion: "observation-v1" };
const [line1, line2] = text.split(/(?<=\n)/u);

function bundle(entities: Array<{ id: string; canonicalName: string; aliases?: string[] }>, eventLine?: string): PreparedNovelBundle {
  return {
    source: { id: "src" }, segmenterVersion: 1, admission: null, readiness: null,
    canonical: {
      entities: entities.map((entity) => ({ kind: "character", aliases: [], evidence: [], ...entity })),
      events: eventLine ? [{ id: "e1", title: "走", participants: ["lu"], preconditions: [], causalParents: [], confidence: 1, evidence: [], storyTime: { kind: "unknown" },
        observedOutcome: { version: 1, operations: [{ op: "set", entityId: "lu", field: "character.mood", value: "calm" }] } }] : [],
      eventParticipations: eventLine ? [{ id: "p1", eventId: "e1", entityId: "lu", role: "agent" }] : [],
      eventRelations: [], spatialRelations: [], sceneOccurrences: [], propositions: [], claims: [], attributions: [], models: [], goals: [],
      normTemplates: [], processTemplates: [], actionSchemas: [], rules: [],
    },
    compilerSnapshot: {
      annotations: [
        { version: 1, id: "m1", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("路明非"), surface: "路明非", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "m2", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("诺诺"), surface: "诺诺", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "q1", sourceId: "src", derivation, annotationType: "quotation", anchor: at("“我们走。”"), mode: "direct", speakerMentionId: "m1", addresseeMentionIds: [], attributionConfidence: 1 },
        ...(eventLine ? [{ version: 1, id: "em1", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: at("走"), trigger: "走", extentAnchors: [at(eventLine)],
          eventTypeCandidates: ["movement"], participantMentionIds: ["m1"], salience: "major", confidence: 1 }] : []),
      ],
      entityResolutions: [
        { id: "r1", mentionId: "m1", status: "resolved", entityId: "lu" },
        ...(entities.some((entity) => entity.id === "nono") ? [{ id: "r2", mentionId: "m2", status: "resolved", entityId: "nono", aliasType: "nickname" }] : []),
      ],
      eventResolutions: eventLine ? [{ id: "er1", eventMentionIds: ["em1"], status: "new-event", canonicalEventId: "e1" }] : [],
      accounting: { records: [{ unitId: "u0", status: "represented" }] },
    },
  } as unknown as PreparedNovelBundle;
}

const temporary: string[] = [];
afterAll(async () => { for (const directory of temporary) await fs.rm(directory, { recursive: true, force: true }); });
const meta = { source: { id: "src", sha256: "a".repeat(64), bytes: source.byteLength }, compiler: { pipelineVersion: 50, promptVersion: 51, engineVersion: "e", segmenterVersion: 1 }, bundle: { origin: "candidate", baselineIssues: 0 } };

describe("legacy reference pack", () => {
  it("flattens a candidate into reference records with speakers, surfaces and event extents", () => {
    const pack = buildReferencePack(bundle([{ id: "lu", canonicalName: "路明非" }, { id: "nono", canonicalName: "陈墨瞳" }], line1), source);
    const entities = pack.files["entities.json"] as Array<{ id: string; resolvedSurfaces: Array<{ surface: string; aliasType?: string }> }>;
    expect(entities.find((entity) => entity.id === "nono")!.resolvedSurfaces).toEqual([{ surface: "诺诺", aliasType: "nickname", mentions: 1 }]);
    expect(pack.files["quotations.json"]).toEqual([{ id: "q1", startByte: at("“我们走。”").startByte, endByte: at("“我们走。”").endByte, mode: "direct", text: "“我们走。”", speakerEntityId: "lu", speakerSurface: "路明非" }]);
    expect((pack.files["events.json"] as Array<{ mentionRanges: unknown[]; effects: string[] }>)[0]).toMatchObject({ mentionRanges: [{ startByte: at(line1!).startByte, endByte: at(line1!).endByte }],
      effects: ["set entityId=lu field=character.mood value=\"calm\""] });
    expect(pack.counts).toMatchObject({ entities: 2, events: 1, quotations: 1, entityMentions: 2, eventMentions: 1, entityResolutions: 2 });
  });

  it("writes an immutable pack, verifies hashes and counts, and detects tampering", async () => {
    const directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "nwh-ref-")), "pack");
    temporary.push(path.dirname(directory));
    const content = buildReferencePack(bundle([{ id: "lu", canonicalName: "路明非" }], line1), source);
    const manifest = await writeReferencePack(directory, content, meta);
    expect(manifest.files.map((file) => file.name)).toContain("entities.json");
    await expect(writeReferencePack(directory, content, meta)).rejects.toThrow("REFERENCE_PACK_EXISTS");
    expect((await verifyReferencePack(directory, { entities: 1, events: 1 })).ok).toBe(true);
    expect((await verifyReferencePack(directory, { entities: 135 })).issues).toEqual(["count entities: pack has 1, expected 135"]);
    await fs.chmod(path.join(directory, "events.json"), 0o600);
    await fs.writeFile(path.join(directory, "events.json"), "[]\n");
    const tampered = await verifyReferencePack(directory);
    expect(tampered.ok).toBe(false);
    expect(tampered.issues.join(" ")).toContain("events.json hash mismatch");
  });

  it("lists legacy entities and events the new candidate does not reproduce, within scope only", async () => {
    const directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "nwh-ref-")), "pack");
    temporary.push(path.dirname(directory));
    await writeReferencePack(directory, buildReferencePack(bundle([{ id: "lu", canonicalName: "路明非" }, { id: "nono", canonicalName: "陈墨瞳" }], line1), source), meta);
    const pack = await loadReferencePack(directory);
    const fresh = bundle([{ id: "lu-new", canonicalName: "路明非" }]);
    const comparison = compareWithReference(fresh, pack);
    expect(comparison.entities).toMatchObject({ reference: 2, reproduced: 1, missing: [{ id: "nono", name: "陈墨瞳" }] });
    expect(comparison.events).toMatchObject({ reference: 1, reproduced: 0 });
    const scoped = compareWithReference(fresh, pack, { startByte: at(line2!).startByte, endByte: at(line2!).endByte });
    expect(scoped.events.reference).toBe(0);
    expect(scoped.entities.missing.map((entity) => entity.id)).toEqual(["nono"]);
    expect(compareWithReference(bundle([{ id: "x", canonicalName: "路明非" }, { id: "y", canonicalName: "诺诺" }], line1), pack).entities.missing).toEqual([]);
  });
});
