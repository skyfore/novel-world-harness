import crypto from "node:crypto";

/**
 * Host-deterministic lexical inventory (iteration 02, M1).
 *
 * Three things a novel's text states on its face, found without a model:
 * direct-speech spans, occurrences of established character names, and
 * conservative speaker cues ("…”路明非说" / "路明非点头，“…"). They serve as
 * independent completeness denominators and as presentation-only fallback
 * voice material. They never become canonical facts or branch state.
 */
export const LEXICAL_INVENTORY_VERSION = "lexical-v1" as const;

export type SpeechSpan = {
  /** Byte span including the quotation marks. */
  startByte: number;
  endByte: number;
  /** `speech` is direct discourse; `embedded` is a quoted term or sound (“叮”的一声). */
  kind: "speech" | "embedded";
  /** False when the paragraph ends before the closing mark (multi-paragraph quotation convention). */
  closed: boolean;
};

export type LexiconEntry = { surface: string; entityId: string };
export type CharacterLexicon = {
  entries: LexiconEntry[];
  /** Surfaces naming more than one character; never matched. */
  collisions: Array<{ surface: string; entityIds: string[] }>;
};

export type NameOccurrence = { startByte: number; endByte: number; entityId: string };

export type SpeakerCueRule = "post-cue" | "pre-cue" | "continuation";
export type SpeakerCue = {
  speechStartByte: number;
  speechEndByte: number;
  entityId: string;
  cueStartByte: number;
  cueEndByte: number;
  rule: SpeakerCueRule;
};

export type LexicalInventory = {
  version: typeof LEXICAL_INVENTORY_VERSION;
  speech: SpeechSpan[];
  occurrences: NameOccurrence[];
  cues: SpeakerCue[];
  lexicon: CharacterLexicon;
};

type LexiconEntity = { id: string; kind: string; canonicalName: string; aliases: readonly string[] };
type LexiconAnnotation = { annotationType: string; id: string; surface?: string; form?: string };
type LexiconResolution = { id: string; mentionId: string; status: string; entityId?: string; supersedesResolutionId?: string };

const QUOTE_PAIRS = new Map([["“", "”"], ["「", "」"], ["『", "』"]]);
const SPEECH_PUNCTUATION = /[。！？!?…，,；;～~—：:]/u;
const SENTENCE_END = /[。！？!?]/u;
const CLAUSE_JOIN = new Set(["，", ",", "：", ":"]);
const IDEOGRAPH = /[\p{Script=Han}A-Za-z0-9]/u;
/** Particles that bind a short quotation into the surrounding sentence (“叮”的一声 / 所谓“龙墓”之说). */
const EMBEDDING_PARTICLES = new Set(["的", "之", "和", "与", "是", "这", "那", "一", "字", "声", "般", "似"]);
const SPACE = /[ \t　 ]/u;
/** A name directly followed by these is an object or possessor, not a speaker. */
const NON_SUBJECT_FOLLOWERS = new Set(["的", "被", "们"]);
const PRE_CUE_MAX_CHARACTERS = 40;
const MIN_SURFACE_CODE_POINTS = 2;

/** UTF-16 index → UTF-8 byte offset for every position (length + 1 entries). */
function byteOffsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    offsets[index] = bytes;
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      offsets[index + 1] = bytes;
      bytes += 4;
      index += 1;
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
  }
  offsets[text.length] = bytes;
  return offsets;
}

type Paragraph = { start: number; contentStart: number; end: number };

function paragraphs(text: string): Paragraph[] {
  const result: Paragraph[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let contentStart = start;
    while (contentStart < end && (SPACE.test(text[contentStart]!) || text[contentStart] === "\r")) contentStart += 1;
    if (contentStart < end) result.push({ start, contentStart, end: text[end - 1] === "\r" ? end - 1 : end });
    start = end + 1;
  }
  return result;
}

type CharSpeech = { start: number; end: number; paragraph: Paragraph; kind: SpeechSpan["kind"]; closed: boolean };

function scanCharSpeech(text: string): CharSpeech[] {
  const spans: CharSpeech[] = [];
  for (const paragraph of paragraphs(text)) {
    let index = paragraph.contentStart;
    while (index < paragraph.end) {
      const closer = QUOTE_PAIRS.get(text[index]!);
      if (!closer) { index += 1; continue; }
      const closeAt = text.indexOf(closer, index + 1);
      const closed = closeAt >= 0 && closeAt < paragraph.end;
      const end = closed ? closeAt + 1 : paragraph.end;
      const content = text.slice(index + 1, closed ? closeAt : paragraph.end);
      const before = index > paragraph.contentStart ? text[index - 1]! : "";
      const after = end < paragraph.end ? text[end]! : "";
      const embedded = closed && !SPEECH_PUNCTUATION.test(content)
        && ((before !== "" && IDEOGRAPH.test(before)) || EMBEDDING_PARTICLES.has(after));
      if (content.trim()) spans.push({ start: index, end, paragraph, kind: embedded ? "embedded" : "speech", closed });
      index = end;
    }
  }
  return spans;
}

/** Direct-speech and quoted-term spans with exact byte offsets. */
export function scanSpeechSpans(source: Uint8Array): SpeechSpan[] {
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  return scanCharSpeech(text).map((span) => ({ startByte: offsets[span.start]!, endByte: offsets[span.end]!, kind: span.kind, closed: span.closed }));
}

/**
 * Proper names the compile has already established for characters. A surface
 * qualifies when a resolved proper-name mention attests it, or when it is a
 * canonical name/alias that contains or is contained in such an attested
 * name ("恺撒·加图索" / "恺撒"). Generic nouns used as names ("男人",
 * "列车员") and kinship terms are never attested as proper names, so they
 * stay out. A surface naming two characters is dropped, so a match always
 * identifies exactly one character.
 */
export function buildCharacterLexicon(input: {
  entities: readonly LexiconEntity[];
  annotations?: readonly LexiconAnnotation[];
  entityResolutions?: readonly LexiconResolution[];
}): CharacterLexicon {
  const characters = new Set(input.entities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
  const usable = (surface: string) => Array.from(surface).length >= MIN_SURFACE_CODE_POINTS && !/\s/u.test(surface);
  const superseded = new Set((input.entityResolutions ?? []).flatMap((resolution) => resolution.supersedesResolutionId ? [resolution.supersedesResolutionId] : []));
  const resolvedMention = new Map<string, string>();
  for (const resolution of input.entityResolutions ?? []) {
    if (superseded.has(resolution.id) || !resolution.entityId || !["resolved", "new-entity"].includes(resolution.status)) continue;
    if (characters.has(resolution.entityId)) resolvedMention.set(resolution.mentionId, resolution.entityId);
  }
  const attested = new Map<string, Set<string>>();
  for (const annotation of input.annotations ?? []) {
    if (annotation.annotationType !== "entity-mention" || annotation.form !== "proper" || !annotation.surface) continue;
    const entityId = resolvedMention.get(annotation.id);
    const surface = annotation.surface.trim();
    if (!entityId || !usable(surface)) continue;
    attested.set(entityId, (attested.get(entityId) ?? new Set()).add(surface));
  }
  const owners = new Map<string, Set<string>>();
  const add = (surface: string, entityId: string) => owners.set(surface, (owners.get(surface) ?? new Set<string>()).add(entityId));
  for (const entity of input.entities) {
    const names = attested.get(entity.id);
    if (!characters.has(entity.id) || !names) continue;
    for (const surface of names) add(surface, entity.id);
    for (const candidate of [entity.canonicalName, ...entity.aliases].map((value) => value.trim())) {
      if (usable(candidate) && [...names].some((name) => candidate.includes(name) || name.includes(candidate))) add(candidate, entity.id);
    }
  }
  const entries: LexiconEntry[] = [];
  const collisions: CharacterLexicon["collisions"] = [];
  for (const [surface, ids] of [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.size === 1) entries.push({ surface, entityId: [...ids][0]! });
    else collisions.push({ surface, entityIds: [...ids].sort() });
  }
  return { entries, collisions };
}

type CharOccurrence = { start: number; end: number; entityId: string };

function scanCharOccurrences(text: string, lexicon: CharacterLexicon): CharOccurrence[] {
  const byFirst = new Map<string, LexiconEntry[]>();
  for (const entry of lexicon.entries) {
    const first = entry.surface[0]!;
    byFirst.set(first, [...(byFirst.get(first) ?? []), entry]);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.surface.length - a.surface.length || a.surface.localeCompare(b.surface));
  const occurrences: CharOccurrence[] = [];
  let index = 0;
  while (index < text.length) {
    const match = byFirst.get(text[index]!)?.find((entry) => text.startsWith(entry.surface, index));
    if (!match) { index += 1; continue; }
    occurrences.push({ start: index, end: index + match.surface.length, entityId: match.entityId });
    index += match.surface.length;
  }
  return occurrences;
}

/** Leftmost-longest occurrences of lexicon surfaces. */
export function scanNameOccurrences(source: Uint8Array, lexicon: CharacterLexicon): NameOccurrence[] {
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  return scanCharOccurrences(text, lexicon).map((item) => ({ startByte: offsets[item.start]!, endByte: offsets[item.end]!, entityId: item.entityId }));
}

function skipSpaces(text: string, index: number, limit: number): number {
  while (index < limit && SPACE.test(text[index]!)) index += 1;
  return index;
}

function attributeCharSpeech(text: string, speech: readonly CharSpeech[], occurrences: readonly CharOccurrence[]) {
  const occurrenceAt = new Map(occurrences.map((item) => [item.start, item]));
  const firstOccurrenceFrom = (from: number, to: number) => occurrences.find((item) => item.start >= from && item.end <= to);
  const cues: Array<{ speech: CharSpeech; occurrence: CharOccurrence; rule: SpeakerCueRule }> = [];
  const postCue = (span: CharSpeech) => {
    if (!span.closed) return undefined;
    const occurrence = occurrenceAt.get(skipSpaces(text, span.end, span.paragraph.end));
    if (!occurrence || NON_SUBJECT_FOLLOWERS.has(text[occurrence.end] ?? "")) return undefined;
    return occurrence;
  };
  const previousSpeech = new Map<CharSpeech, CharSpeech>();
  let prior: CharSpeech | undefined;
  for (const span of speech) {
    if (span.kind !== "speech") continue;
    if (prior && prior.paragraph === span.paragraph) previousSpeech.set(span, prior);
    prior = span;
  }
  const attributed = new Map<CharSpeech, CharOccurrence>();
  for (const span of speech) {
    if (span.kind !== "speech") continue;
    const post = postCue(span);
    if (post) {
      cues.push({ speech: span, occurrence: post, rule: "post-cue" });
      attributed.set(span, post);
      continue;
    }
    let joinAt = span.start - 1;
    while (joinAt >= span.paragraph.contentStart && SPACE.test(text[joinAt]!)) joinAt -= 1;
    if (joinAt < span.paragraph.contentStart || !CLAUSE_JOIN.has(text[joinAt]!)) continue;
    const previous = previousSpeech.get(span);
    if (previous) {
      // “A”路明非说，“B”: B continues A's speaker when only a cue clause sits between them.
      const between = text.slice(previous.end, span.start);
      const speaker = attributed.get(previous);
      if (speaker && speaker.start >= previous.end && !SENTENCE_END.test(between) && !/[“”「」『』]/u.test(between)) {
        cues.push({ speech: span, occurrence: speaker, rule: "continuation" });
        attributed.set(span, speaker);
      }
      continue;
    }
    // 路明非点头，“B”: the paragraph's opening subject speaks.
    const prefix = text.slice(span.paragraph.contentStart, span.start);
    if (Array.from(prefix).length > PRE_CUE_MAX_CHARACTERS || SENTENCE_END.test(prefix)) continue;
    const subject = firstOccurrenceFrom(span.paragraph.contentStart, span.start);
    if (!subject || subject.start !== span.paragraph.contentStart || NON_SUBJECT_FOLLOWERS.has(text[subject.end] ?? "")) continue;
    // "路明非抬头，看见恺撒伸出手，“…”": a second character in the clause makes the speaker uncertain.
    if (occurrences.some((item) => item.start > subject.start && item.end <= span.start && item.entityId !== subject.entityId)) continue;
    cues.push({ speech: span, occurrence: subject, rule: "pre-cue" });
    attributed.set(span, subject);
  }
  return cues;
}

/** The full inventory for one immutable source. */
export function buildLexicalInventory(input: {
  source: Uint8Array;
  entities: readonly LexiconEntity[];
  annotations?: readonly LexiconAnnotation[];
  entityResolutions?: readonly LexiconResolution[];
}): LexicalInventory {
  const text = Buffer.from(input.source.buffer, input.source.byteOffset, input.source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  const lexicon = buildCharacterLexicon(input);
  const charSpeech = scanCharSpeech(text);
  const charOccurrences = scanCharOccurrences(text, lexicon);
  const cues = attributeCharSpeech(text, charSpeech, charOccurrences);
  return {
    version: LEXICAL_INVENTORY_VERSION,
    speech: charSpeech.map((span) => ({ startByte: offsets[span.start]!, endByte: offsets[span.end]!, kind: span.kind, closed: span.closed })),
    occurrences: charOccurrences.map((item) => ({ startByte: offsets[item.start]!, endByte: offsets[item.end]!, entityId: item.entityId })),
    cues: cues.map(({ speech, occurrence, rule }) => ({
      speechStartByte: offsets[speech.start]!,
      speechEndByte: offsets[speech.end]!,
      entityId: occurrence.entityId,
      cueStartByte: offsets[occurrence.start]!,
      cueEndByte: offsets[occurrence.end]!,
      rule,
    })),
    lexicon,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
