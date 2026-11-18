import crypto from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { scanSpeechSpans, scanTimeExpressions } from "../lexical-inventory.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import { sourceChapters } from "./source-stage.js";
import { CENSUS_CLASSES, type CensusEntry } from "./store.js";
import { applyEach, pipelineTool, T } from "./tooling.js";
import { ScopeText, windowUnits } from "./text.js";
import { loadPipelineView, type PipelineView } from "./view.js";

/**
 * Census (design 5.2): the host proposes the surfaces a novel uses as names
 * and setting vocabulary; the model classifies them. The census lexicon is an
 * observation-layer list ("this surface is worth annotating"), never identity.
 */
export const CENSUS_POLICY = {
  /** Candidates occurring at least this often must be classified. */
  frequencyThreshold: 10,
  /** Surfaces found in speaker position at least this often must be classified. */
  speakerThreshold: 3,
  /** Word-like n-grams: lengths and the fragment test. */
  minLength: 2,
  maxLength: 4,
  /** An n-gram is a fragment when one extension carries this share of its occurrences. */
  fragmentShare: 0.8,
  /** Place-suffixed words and quoted terms qualify from this many occurrences. */
  minorThreshold: 3,
  maxCandidatesPerScope: 120,
} as const;

export type CensusCandidate = {
  id: string;
  surface: string;
  occurrences: number;
  speakerPositions: number;
  firstByte: number;
  basis: Array<"speaker" | "frequent" | "place-suffix" | "quoted">;
  /** Must be classified for the gate (frequency or speaker threshold). */
  required: boolean;
};

const HAN = /\p{Script=Han}/u;
/** Function characters that never occur in an n-gram treated as a candidate term. */
const FUNCTION_CHARACTERS = new Set("的了是在不有我你他她它们这那就也都还要会说道着过很把被给对向从和与而之其以于为所如若但却并又再已没吗呢吧啊呀嘛么什怎哪谁里上下中个一些些得地".split(""));
const SPEECH_VERBS = "说|道|问|答|叫|喊|喝|骂|笑|叹|吼|嚷|曰";
const ADVERBS = "低声|轻声|大声|冷冷地|笑着|淡淡地|忽然|突然|又|也|就|才|还|便|只|连忙|急忙|不禁";
const PLACE_SUFFIX = /[\p{Script=Han}·]{1,5}(?:馆|楼|城|室|站|厅|院|街|路|桥|山|湖|河|港|岛|宫|殿|寺|庙|府|塔|校|园|场|店|厂|村|镇|州|郡|县|堡|关|营|寨|洞|谷|岭|峰|海|江)/gu;
const candidateId = (surface: string) => `c-${crypto.createHash("sha256").update(surface).digest("hex").slice(0, 10)}`;

function countAll(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/** Deterministic census candidates for the text before `limit` bytes. */
export function censusCandidates(bytes: Uint8Array, limit = bytes.byteLength): CensusCandidate[] {
  const prefix = bytes.subarray(0, limit);
  const text = Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength).toString("utf8");
  const byteAt = (index: number) => Buffer.byteLength(text.slice(0, index), "utf8");
  const found = new Map<string, { speakerPositions: number; basis: Set<CensusCandidate["basis"][number]> }>();
  const note = (surface: string, basis: CensusCandidate["basis"][number], speaker = false) => {
    if (Array.from(surface).length < CENSUS_POLICY.minLength || ![...surface].every((char) => HAN.test(char) || char === "·")) return;
    const item = found.get(surface) ?? { speakerPositions: 0, basis: new Set() };
    item.basis.add(basis);
    if (speaker) item.speakerPositions += 1;
    found.set(surface, item);
  };
  // 1. Speaker position: ”路明非说 / 。玄德曰：
  const post = new RegExp(`[”"」』]\\s*([\\p{Script=Han}·]{2,6}?)(?:${ADVERBS})?(?:${SPEECH_VERBS})`, "gu");
  const pre = new RegExp(`(?:^|[。！？\\n“”"])\\s*([\\p{Script=Han}·]{2,6}?)(?:${ADVERBS})?(?:${SPEECH_VERBS})[：:]`, "gmu");
  for (const pattern of [post, pre]) for (const match of text.matchAll(pattern)) note(match[1]!, "speaker", true);
  // 2. Frequent word-like n-grams (not fragments of a longer frequent n-gram, no function characters).
  const counts = new Map<string, number>();
  const runs = text.split(/[^\p{Script=Han}]+/u);
  for (const run of runs) {
    const chars = Array.from(run);
    for (let start = 0; start < chars.length; start += 1) {
      for (let length = CENSUS_POLICY.minLength; length <= CENSUS_POLICY.maxLength + 1 && start + length <= chars.length; length += 1) {
        const gram = chars.slice(start, start + length).join("");
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  const frequent = [...counts.entries()].filter(([gram, count]) => count >= CENSUS_POLICY.frequencyThreshold && Array.from(gram).length <= CENSUS_POLICY.maxLength
    && ![...gram].some((char) => FUNCTION_CHARACTERS.has(char)));
  // Index longer grams by their prefixes/suffixes for the fragment test without a quadratic scan.
  const extensions = new Map<string, number>();
  for (const [gram, count] of counts) {
    if (count < CENSUS_POLICY.frequencyThreshold) continue;
    const chars = Array.from(gram);
    if (chars.length < 3) continue;
    for (const key of [chars.slice(0, -1).join(""), chars.slice(1).join("")]) extensions.set(key, Math.max(extensions.get(key) ?? 0, count));
  }
  // Drop fragments of a longer frequent n-gram ("路明" in "路明非") and extensions of a far more frequent one ("路明非看").
  const dominatedBy = (gram: string, count: number) => {
    const chars = Array.from(gram);
    for (let length = CENSUS_POLICY.minLength; length < chars.length; length += 1) {
      for (const part of [chars.slice(0, length).join(""), chars.slice(chars.length - length).join("")]) if ((counts.get(part) ?? 0) >= 3 * count && ![...part].some((char) => FUNCTION_CHARACTERS.has(char))) return true;
    }
    return false;
  };
  for (const [gram, count] of frequent) if ((extensions.get(gram) ?? 0) / count < CENSUS_POLICY.fragmentShare && !dominatedBy(gram, count)) note(gram, "frequent");
  // 3. Place-suffixed words and 4. quoted terms.
  for (const match of text.matchAll(PLACE_SUFFIX)) if (![...match[0]].some((char) => FUNCTION_CHARACTERS.has(char))) note(match[0], "place-suffix");
  for (const span of scanSpeechSpans(prefix)) {
    if (span.kind !== "embedded") continue;
    note(Buffer.from(prefix.buffer, prefix.byteOffset + span.startByte, span.endByte - span.startByte).toString("utf8").slice(1, -1).trim(), "quoted");
  }
  const candidates: CensusCandidate[] = [];
  for (const [surface, item] of found) {
    const occurrences = countAll(text, surface);
    const required = occurrences >= CENSUS_POLICY.frequencyThreshold || item.speakerPositions >= CENSUS_POLICY.speakerThreshold;
    const minor = (item.basis.has("place-suffix") || item.basis.has("quoted")) && occurrences >= CENSUS_POLICY.minorThreshold;
    if (!required && !minor) continue;
    candidates.push({ id: candidateId(surface), surface, occurrences, speakerPositions: item.speakerPositions, firstByte: byteAt(text.indexOf(surface)), basis: [...item.basis].sort(), required });
  }
  // A speaker-position surface that only extends a shorter one ("诺诺点头" after "诺诺") is noise.
  const speakerSurfaces = candidates.filter((item) => item.speakerPositions > 0).map((item) => item.surface);
  return candidates.filter((item) => !(item.basis.length === 1 && item.basis[0] === "speaker" && speakerSurfaces.some((other) => other !== item.surface && item.surface.startsWith(other))))
    .sort((a, b) => a.firstByte - b.firstByte || a.surface.localeCompare(b.surface));
}

/** Host-classified time surfaces (no model work). */
export function censusTimeEntries(bytes: Uint8Array, limit: number, scopeId: string): CensusEntry[] {
  const counts = new Map<string, { occurrences: number; firstByte: number }>();
  for (const item of scanTimeExpressions(bytes.subarray(0, limit))) {
    const entry = counts.get(item.surface) ?? { occurrences: 0, firstByte: item.startByte };
    entry.occurrences += 1;
    counts.set(item.surface, entry);
  }
  return [...counts.entries()].filter(([surface, item]) => item.occurrences >= 2 && Array.from(surface).length <= 40)
    .map(([surface, item]) => ({ surface, class: "time" as const, occurrences: item.occurrences, firstByte: item.firstByte, decidedBy: "host" as const, scopeId }));
}

const classifyInput = z.object({
  items: z.array(z.object({ candidate: z.string().min(1), class: z.enum(CENSUS_CLASSES), rationale: z.string().trim().max(500).optional() }).strict()).min(1).max(200),
}).strict();
const addInput = z.object({
  items: z.array(z.object({ unit: z.string(), text: z.string().min(2).max(40), nth: z.number().int().positive().optional(), class: z.enum(CENSUS_CLASSES), rationale: z.string().trim().min(1).max(500) }).strict()).min(1).max(100),
}).strict();

function scopeCandidates(view: PipelineView, ctx: StageContext, scope: ScopePlan): CensusCandidate[] {
  const items = new Set(scope.items);
  return censusCandidates(view.bytes, ctx.limit).filter((item) => items.has(item.id));
}

/** Census coverage: required candidates (frequency or speaker threshold) with a class. One implementation for the gate and the status report. */
export function censusCoverage(view: PipelineView, candidates: readonly CensusCandidate[]) {
  const classified = new Set(view.census.map((entry) => entry.surface));
  const required = candidates.filter((item) => item.required);
  const missing = required.filter((item) => !classified.has(item.surface));
  return { required: required.length, classified: required.length - missing.length, missing };
}

export const censusStage: StageDefinition = {
  stage: "census",
  async plan(ctx, view) {
    const chapters = (await sourceChapters(ctx.root, ctx.sourceId)).filter((chapter) => chapter.startByte < ctx.limit);
    const candidates = censusCandidates(view.bytes, ctx.limit);
    const scopes: ScopePlan[] = [];
    for (const chapter of chapters) {
      const inChapter = candidates.filter((item) => item.firstByte >= chapter.startByte && item.firstByte < chapter.endByte);
      for (let part = 0; part * CENSUS_POLICY.maxCandidatesPerScope < Math.max(1, inChapter.length); part += 1) {
        const items = inChapter.slice(part * CENSUS_POLICY.maxCandidatesPerScope, (part + 1) * CENSUS_POLICY.maxCandidatesPerScope);
        if (!items.length) continue;
        scopes.push({ id: `census-${ctx.sourceId}-c${String(chapter.ordinal).padStart(3, "0")}-p${part}`, range: { startByte: chapter.startByte, endByte: Math.min(chapter.endByte, ctx.limit) },
          items: items.map((item) => item.id), title: `${chapter.title ?? `chapter ${chapter.ordinal}`} candidates ${part * CENSUS_POLICY.maxCandidatesPerScope + 1}-${part * CENSUS_POLICY.maxCandidatesPerScope + items.length}` });
      }
    }
    return scopes;
  },
  async prepare(ctx, scope) {
    // Time expressions are classified by the host once per source.
    if ((await ctx.store.census()).some((entry) => entry.decidedBy === "host")) return;
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    const entries = censusTimeEntries(view.bytes, ctx.limit, scope.id);
    if (entries.length) await ctx.store.recordCensus(entries);
  },
  prompt(ctx, view, scope, previous) {
    const candidates = scopeCandidates(view, ctx, scope);
    const text = Buffer.from(view.bytes.buffer, view.bytes.byteOffset, Math.min(view.bytes.byteLength, ctx.limit)).toString("utf8");
    const context = (item: CensusCandidate) => {
      const index = text.indexOf(item.surface);
      return text.slice(Math.max(0, index - 18), index + item.surface.length + 18).replace(/\s+/gu, " ");
    };
    const decided = new Map(view.census.map((entry) => [entry.surface, entry.class]));
    return [
      `Census for ${scope.title}. Classify every candidate surface below by what the source uses it as:`,
      `person (a named or titled individual), location, organization, object (a named artifact), lore (setting vocabulary: powers, institutions' terms, species, technologies, rituals), time, or non-entity (an ordinary word or a fragment).`,
      `Use classify_census_candidates with the candidate id. Use add_census_entries for names or setting terms you see in the contexts that the host missed (cite a unit label and copy the text). Then call finish_scope.`,
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Candidates (id | surface | occurrences | speaker positions | first context):",
      ...candidates.map((item) => `${item.id} | ${item.surface} | ${item.occurrences} | ${item.speakerPositions} | …${context(item)}…${decided.has(item.surface) ? ` (already: ${decided.get(item.surface)})` : ""}`),
    ].filter(Boolean).join("\n");
  },
  tools(ctx, scope) {
    return [
      pipelineTool({
        name: "classify_census_candidates", label: "Classify census candidates",
        description: "Classify host census candidates by id. Each item: candidate id, class, optional rationale (required for non-entity of a speaker-position surface).",
        parameters: Type.Object({ items: Type.Array(Type.Object({ candidate: Type.String(), class: Type.Union(CENSUS_CLASSES.map((value) => Type.Literal(value))), rationale: Type.Optional(T.rationale()) }, { additionalProperties: false })) }, { additionalProperties: false }),
        input: classifyInput,
        async execute(input) {
          const view = await loadPipelineView(ctx.root, ctx.sourceId);
          const byId = new Map(censusCandidates(view.bytes, ctx.limit).map((item) => [item.id, item]));
          const entries: CensusEntry[] = [];
          const result = await applyEach(input.items, async (item) => {
            const candidate = byId.get(item.candidate);
            if (!candidate) throw new Error(`Unknown candidate ${item.candidate}; copy an id from the list.`);
            if (!scope.items.includes(candidate.id)) throw new Error(`Candidate ${item.candidate} belongs to another census scope.`);
            if (item.class === "non-entity" && candidate.speakerPositions >= CENSUS_POLICY.speakerThreshold && !item.rationale) throw new Error(`${candidate.surface} sits in speaker position ${candidate.speakerPositions} times; explain why it is not a person.`);
            entries.push({ surface: candidate.surface, class: item.class, occurrences: candidate.occurrences, firstByte: candidate.firstByte, decidedBy: "model", ...(item.rationale ? { rationale: item.rationale } : {}), scopeId: scope.id });
            return candidate.id;
          });
          if (entries.length) await ctx.store.recordCensus(entries);
          return { classified: result.applied.length, failed: result.failed };
        },
      }),
      pipelineTool({
        name: "add_census_entries", label: "Add census entries",
        description: "Add a name or setting term the host did not propose. Cite a unit label and copy the exact surface text from that unit.",
        parameters: Type.Object({ items: Type.Array(Type.Object({ unit: Type.String(), text: Type.String(), nth: Type.Optional(Type.Integer({ minimum: 1 })), class: Type.Union(CENSUS_CLASSES.map((value) => Type.Literal(value))), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
        input: addInput,
        async execute(input) {
          const view = await loadPipelineView(ctx.root, ctx.sourceId);
          const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, { startByte: 0, endByte: ctx.limit }));
          const whole = Buffer.from(view.bytes.buffer, view.bytes.byteOffset, Math.min(view.bytes.byteLength, ctx.limit)).toString("utf8");
          const entries: CensusEntry[] = [];
          const result = await applyEach(input.items, async (item) => {
            const range = text.span({ unit: item.unit, text: item.text, ...(item.nth ? { nth: item.nth } : {}) });
            entries.push({ surface: item.text, class: item.class, occurrences: countAll(whole, item.text), firstByte: Buffer.byteLength(whole.slice(0, whole.indexOf(item.text)), "utf8"), decidedBy: "model", rationale: item.rationale, scopeId: scope.id });
            return range;
          });
          if (entries.length) await ctx.store.recordCensus(entries);
          return { added: result.applied.length, failed: result.failed };
        },
      }),
    ];
  },
  gate(ctx, view, scope) {
    const candidates = scopeCandidates(view, ctx, scope);
    const coverage = censusCoverage(view, candidates);
    const classified = new Set(view.census.map((entry) => entry.surface));
    const speaker = candidates.filter((item) => item.speakerPositions >= CENSUS_POLICY.speakerThreshold);
    const speakerMissing = speaker.filter((item) => !classified.has(item.surface));
    return gateOf([
      { id: "census.required-classified", passed: coverage.missing.length === 0, detail: `${coverage.classified}/${coverage.required} candidates at ≥${CENSUS_POLICY.frequencyThreshold} occurrences or ≥${CENSUS_POLICY.speakerThreshold} speaker positions classified${coverage.missing.length ? `; missing ${coverage.missing.slice(0, 20).map((item) => `${item.id}:${item.surface}`).join(", ")}` : ""}` },
      { id: "census.speakers-classified", passed: speakerMissing.length === 0, detail: `${speaker.length - speakerMissing.length}/${speaker.length} speaker-position surfaces classified` },
    ]);
  },
};
