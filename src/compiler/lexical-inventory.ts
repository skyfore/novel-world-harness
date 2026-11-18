import crypto from "node:crypto";

/**
 * Host-deterministic lexical inventory (iteration 02, M1).
 *
 * Things a novel's text states on its face, found without a model:
 * direct-speech spans, occurrences of lexicon names, conservative speaker
 * cues ("…”路明非说" / "路明非点头，“…" / "玄德曰：\"…\"") and explicit time
 * expressions. They serve as independent completeness denominators, as host
 * observation candidates and as presentation-only fallback voice material.
 * They never become canonical facts or branch state.
 *
 * Quotation conventions (v2): curly “…”, corner 「…」『…』, straight "…"
 * (paired left to right inside a paragraph) and the classical unquoted
 * "曰：…" which runs to the end of its paragraph.
 */
export const LEXICAL_INVENTORY_VERSION = "lexical-v2" as const;

export type SpeechSpan = {
  /** Byte span including the quotation marks. */
  startByte: number;
  endByte: number;
  /** `speech` is direct discourse; `embedded` is a quoted term or sound (“叮”的一声). */
  kind: "speech" | "embedded";
  /** False when the paragraph ends before the closing mark (multi-paragraph quotation convention). */
  closed: boolean;
  /** Which quotation convention delimited the span; `colon` is unquoted "曰：…" discourse. */
  delimiter: SpeechDelimiter;
};
export type SpeechDelimiter = "curly" | "corner" | "straight" | "colon";

export type LexiconEntry = { surface: string; entityId: string };
export type CharacterLexicon = {
  entries: LexiconEntry[];
  /** Surfaces naming more than one character; never matched. */
  collisions: Array<{ surface: string; entityIds: string[] }>;
};

export type NameOccurrence = { startByte: number; endByte: number; entityId: string };

export type SpeakerCueRule = "post-cue" | "verb-cue" | "pre-cue" | "continuation";
export type SpeakerCue = {
  speechStartByte: number;
  speechEndByte: number;
  entityId: string;
  cueStartByte: number;
  cueEndByte: number;
  rule: SpeakerCueRule;
};

export type TimeExpressionKind = "date" | "clock" | "relative" | "period";
export type TimeExpression = { startByte: number; endByte: number; kind: TimeExpressionKind; surface: string };

export type LexicalInventory = {
  version: typeof LEXICAL_INVENTORY_VERSION;
  speech: SpeechSpan[];
  occurrences: NameOccurrence[];
  cues: SpeakerCue[];
  lexicon: CharacterLexicon;
  times: TimeExpression[];
};

type LexiconEntity = { id: string; kind: string; canonicalName: string; aliases: readonly string[] };
type LexiconAnnotation = { annotationType: string; id: string; surface?: string; form?: string };
type LexiconResolution = { id: string; mentionId: string; status: string; entityId?: string; supersedesResolutionId?: string };

const QUOTE_PAIRS = new Map([["“", "”"], ["「", "」"], ["『", "』"], ['"', '"']]);
const DELIMITER_OF = new Map<string, SpeechDelimiter>([["“", "curly"], ["「", "corner"], ["『", "corner"], ['"', "straight"]]);
const QUOTE_MARKS = /[“”「」『』"']/u;
/** Speech verbs that introduce discourse with a colon: 玄德曰：/ 路明非说：/ 张飞大叫：. */
const SPEECH_VERBS = new Set(["曰", "道", "说", "问", "答", "叫", "喊", "喝", "骂", "笑", "叹", "云", "言", "吼", "嚷", "呼"]);
const COLONS = new Set(["：", ":"]);
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

function skipSpaces(text: string, index: number, limit: number): number {
  while (index < limit && SPACE.test(text[index]!)) index += 1;
  return index;
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

type CharSpeech = { start: number; end: number; paragraph: Paragraph; kind: SpeechSpan["kind"]; closed: boolean; delimiter: SpeechDelimiter };

/** Closers each opener accepts: a straight opener may be closed by a curly mark (mixed-convention texts). */
const CLOSERS = new Map([["“", ["”"]], ["「", ["」"]], ["『", ["』"]], ['"', ['"', "”"]]]);

function findCloser(text: string, opener: string, from: number, limit: number): number {
  let best = -1;
  for (const closer of CLOSERS.get(opener) ?? []) {
    const at = text.indexOf(closer, from);
    if (at >= 0 && at < limit && (best < 0 || at < best)) best = at;
  }
  return best;
}

function scanCharSpeech(text: string): CharSpeech[] {
  const spans: CharSpeech[] = [];
  let pending: CharSpeech | undefined;
  for (const paragraph of paragraphs(text)) {
    let index = paragraph.contentStart;
    // A quotation left open by the previous paragraph continues here when this
    // paragraph does not re-open it: its text runs to the first closing mark.
    const carried = pending;
    pending = undefined;
    if (carried && !QUOTE_PAIRS.has(text[index]!)) {
      const opener = text[carried.start]!;
      const closeAt = findCloser(text, opener, index, paragraph.end);
      const firstOpener = [...QUOTE_PAIRS.keys()].map((mark) => text.indexOf(mark, index)).filter((at) => at >= 0 && at < paragraph.end).sort((a, b) => a - b)[0] ?? -1;
      if (closeAt >= 0 && (firstOpener < 0 || closeAt <= firstOpener)) {
        if (text.slice(index, closeAt).trim()) spans.push({ start: index, end: closeAt + 1, paragraph, kind: "speech", closed: true, delimiter: carried.delimiter });
        index = closeAt + 1;
      }
    }
    while (index < paragraph.end) {
      const mark = text[index]!;
      // Classical unquoted discourse: 后人有诗赞曰：英雄露颖在今朝…
      if (mark === "曰" && COLONS.has(text[index + 1] ?? "")) {
        const start = skipSpaces(text, index + 2, paragraph.end);
        const next = text[start] ?? "";
        if (start < paragraph.end && !QUOTE_PAIRS.has(next) && next !== "'") {
          let end = start;
          while (end < paragraph.end && !QUOTE_MARKS.test(text[end]!)) end += 1;
          if (text.slice(start, end).trim()) spans.push({ start, end, paragraph, kind: "speech", closed: true, delimiter: "colon" });
          index = end;
          continue;
        }
        if (next === "'") {
          // 曰：'持此还祖龙。' — a straight single quote opened by a speech verb.
          const closeAt = text.indexOf("'", start + 1);
          const closed = closeAt >= 0 && closeAt < paragraph.end;
          const end = closed ? closeAt + 1 : paragraph.end;
          if (text.slice(start + 1, closed ? closeAt : paragraph.end).trim()) spans.push({ start, end, paragraph, kind: "speech", closed, delimiter: "straight" });
          index = end;
          continue;
        }
        index += 1;
        continue;
      }
      if (!QUOTE_PAIRS.has(mark)) { index += 1; continue; }
      const closeAt = findCloser(text, mark, index + 1, paragraph.end);
      const closed = closeAt >= 0;
      const end = closed ? closeAt + 1 : paragraph.end;
      const content = text.slice(index + 1, closed ? closeAt : paragraph.end);
      const before = index > paragraph.contentStart ? text[index - 1]! : "";
      const after = end < paragraph.end ? text[end]! : "";
      const embedded = closed && !SPEECH_PUNCTUATION.test(content)
        && ((before !== "" && IDEOGRAPH.test(before)) || EMBEDDING_PARTICLES.has(after));
      if (content.trim()) {
        const span: CharSpeech = { start: index, end, paragraph, kind: embedded ? "embedded" : "speech", closed, delimiter: DELIMITER_OF.get(mark)! };
        spans.push(span);
        if (!closed) pending = span;
      }
      index = end;
    }
  }
  return spans;
}

/** Direct-speech and quoted-term spans with exact byte offsets. */
export function scanSpeechSpans(source: Uint8Array): SpeechSpan[] {
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  return scanCharSpeech(text).map((span) => ({ startByte: offsets[span.start]!, endByte: offsets[span.end]!, kind: span.kind, closed: span.closed, delimiter: span.delimiter }));
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
  /**
   * 张飞大怒曰：“…” / 路明非说：“…”: a speech verb and colon directly before the
   * quotation, whose clause (since the last sentence end or quotation mark)
   * opens with exactly one character's name. "后人有诗赞玄德曰" does not open with
   * the name, and "玄德谓张飞曰" names two characters, so both abstain.
   */
  const verbCue = (span: CharSpeech) => {
    let colonAt = span.start - 1;
    while (colonAt >= span.paragraph.contentStart && SPACE.test(text[colonAt]!)) colonAt -= 1;
    if (colonAt <= span.paragraph.contentStart || !COLONS.has(text[colonAt]!) || !SPEECH_VERBS.has(text[colonAt - 1]!)) return undefined;
    const verbAt = colonAt - 1;
    let clauseStart = verbAt;
    while (clauseStart > span.paragraph.contentStart && !SENTENCE_END.test(text[clauseStart - 1]!) && !QUOTE_MARKS.test(text[clauseStart - 1]!)) clauseStart -= 1;
    clauseStart = skipSpaces(text, clauseStart, verbAt);
    if (Array.from(text.slice(clauseStart, verbAt)).length > PRE_CUE_MAX_CHARACTERS) return undefined;
    const inClause = occurrences.filter((item) => item.start >= clauseStart && item.end <= verbAt);
    const subject = inClause[0];
    if (!subject || subject.start !== clauseStart || NON_SUBJECT_FOLLOWERS.has(text[subject.end] ?? "")) return undefined;
    if (inClause.some((item) => item.entityId !== subject.entityId)) return undefined;
    return subject;
  };
  const attributed = new Map<CharSpeech, CharOccurrence>();
  for (const span of speech) {
    if (span.kind !== "speech") continue;
    const post = postCue(span);
    if (post) {
      cues.push({ speech: span, occurrence: post, rule: "post-cue" });
      attributed.set(span, post);
      continue;
    }
    const verb = verbCue(span);
    if (verb) {
      cues.push({ speech: span, occurrence: verb, rule: "verb-cue" });
      attributed.set(span, verb);
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
      if (speaker && speaker.start >= previous.end && !SENTENCE_END.test(between) && !QUOTE_MARKS.test(between)) {
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

/**
 * The full inventory for one immutable source. The lexicon is either derived
 * from compiled entities (attested proper-name mentions, M1) or supplied by
 * the caller, e.g. from the census store (v2), in which case `entityId` is the
 * lexicon key the caller chose.
 */
export function buildLexicalInventory(input: {
  source: Uint8Array;
  entities?: readonly LexiconEntity[];
  annotations?: readonly LexiconAnnotation[];
  entityResolutions?: readonly LexiconResolution[];
  lexicon?: CharacterLexicon;
}): LexicalInventory {
  const text = Buffer.from(input.source.buffer, input.source.byteOffset, input.source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  const lexicon = input.lexicon ?? buildCharacterLexicon({ ...input, entities: input.entities ?? [] });
  const charSpeech = scanCharSpeech(text);
  const charOccurrences = scanCharOccurrences(text, lexicon);
  const cues = attributeCharSpeech(text, charSpeech, charOccurrences);
  return {
    version: LEXICAL_INVENTORY_VERSION,
    speech: charSpeech.map((span) => ({ startByte: offsets[span.start]!, endByte: offsets[span.end]!, kind: span.kind, closed: span.closed, delimiter: span.delimiter })),
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
    times: scanCharTimes(text).map((item) => ({ startByte: offsets[item.start]!, endByte: offsets[item.end]!, kind: item.kind, surface: item.surface })),
  };
}

const CN_NUMBER = "〇零一二三四五六七八九十百千两廿卅0-9０-９";
/**
 * Explicit time expressions, most specific kind first. Conservative: a match
 * must carry a calendar/clock unit or a fixed deictic phrase, so "周围" or
 * "后来" never count. Overlaps resolve leftmost-longest.
 */
const TIME_PATTERNS: Array<{ kind: TimeExpressionKind; pattern: RegExp }> = [
  { kind: "date", pattern: new RegExp(`(?:[${CN_NUMBER}]+|元)年(?:[${CN_NUMBER}正闰]+月)?(?:(?:初|廿)?[${CN_NUMBER}]+[日号]|望日|朔日|晦日)?(?![轻纪级头代])`, "gu") },
  { kind: "date", pattern: new RegExp(`[${CN_NUMBER}正闰]+月(?:(?:初|廿)?[${CN_NUMBER}]+[日号]|望日?|朔日?|晦日?)?`, "gu") },
  { kind: "clock", pattern: new RegExp(`[0-9０-９]{1,2}[:：][0-9０-９]{2}|[0-9０-９]{1,2}点(?:钟|半|[0-9０-９]+分)?|[${CN_NUMBER}]+点(?:钟|半|[${CN_NUMBER}]+分)|[子丑寅卯辰巳午未申酉戌亥]时(?:[一二三四初正]刻)?|[一二三四五]更(?:天|时分?)?(?![加多是好大新换改衣])`, "gu") },
  { kind: "relative", pattern: new RegExp(`[${CN_NUMBER}几数半]+(?:天|日|年|个月|个星期|星期|周|小时|个小时|钟头|分钟|秒钟?|刻钟)(?:之后|以后|之前|以前|后|前|过去了|过后)`, "gu") },
  { kind: "relative", pattern: /(?:第[二三四五六七八九十0-9]+|次|翌|当|前|昨|今|明|后|那|这|同|是|其)(?:天|日|晚|夜|年|早|晨)(?:晚上|夜里|早上|清早)?(?![空使才生下性然真地赋气轻纪级头代色际意命子数神堂王])/gu },
  { kind: "period", pattern: /(?:星期|礼拜)[一二三四五六日天]|周[一二三四五六日](?![\p{Script=Han}])|清晨|早上|早晨|上午|中午|正午|下午|傍晚|黄昏|晚上|深夜|半夜|午夜|凌晨|拂晓|黎明|入夜|夜里|白天/gu },
];

/** A calendar match must name a month, a full year numeral or an era's first year; "三年" alone is a duration. */
function calendarLike(surface: string): boolean {
  if (surface.includes("月")) {
    const month = surface.slice(surface.indexOf("年") + 1, surface.indexOf("月"));
    return /^(?:[正闰]|[一二三四五六七八九十]{1,3}|[0-9０-９]{1,2})$/u.test(month) || surface.includes("年");
  }
  const year = surface.slice(0, surface.indexOf("年"));
  return year === "元" || Array.from(year).length >= 3;
}

function scanCharTimes(text: string): Array<{ start: number; end: number; kind: TimeExpressionKind; surface: string }> {
  const found: Array<{ start: number; end: number; kind: TimeExpressionKind; surface: string; rank: number }> = [];
  TIME_PATTERNS.forEach(({ kind, pattern }, rank) => {
    for (const match of text.matchAll(pattern)) {
      if (!match[0] || match.index === undefined) continue;
      if (kind === "date" && !calendarLike(match[0])) continue;
      found.push({ start: match.index, end: match.index + match[0].length, kind, surface: match[0], rank });
    }
  });
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.rank - b.rank);
  const result: Array<{ start: number; end: number; kind: TimeExpressionKind; surface: string }> = [];
  let cursor = -1;
  for (const item of found) {
    if (item.start < cursor) continue;
    result.push({ start: item.start, end: item.end, kind: item.kind, surface: item.surface });
    cursor = item.end;
  }
  return result;
}

/** Explicit time expressions with exact byte offsets. */
export function scanTimeExpressions(source: Uint8Array): TimeExpression[] {
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  const offsets = byteOffsets(text);
  return scanCharTimes(text).map((item) => ({ startByte: offsets[item.start]!, endByte: offsets[item.end]!, kind: item.kind, surface: item.surface }));
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export type SourceInventorySummary = {
  version: typeof LEXICAL_INVENTORY_VERSION;
  bytes: number;
  range?: { startByte: number; endByte: number };
  speech: { total: number; byDelimiter: Partial<Record<SpeechDelimiter, number>>; unclosed: number };
  embedded: number;
  cues: { total: number; byRule: Partial<Record<SpeakerCueRule, number>> };
  times: { total: number; byKind: Partial<Record<TimeExpressionKind, number>>; top: Array<{ surface: string; count: number }> };
  /** Quoted terms occurring at least `threshold` times in the whole text: setting-vocabulary candidates for the census. */
  quotedTerms: Array<{ surface: string; occurrences: number }>;
};

/** Source-only denominators for any text, with no compile: the deterministic layer of the content contract. */
export function summarizeSourceInventory(source: Uint8Array, options: { range?: { startByte: number; endByte: number }; lexicon?: CharacterLexicon; termThreshold?: number } = {}): SourceInventorySummary {
  const inventory = buildLexicalInventory({ source, lexicon: options.lexicon ?? { entries: [], collisions: [] } });
  const inRange = (item: { startByte: number; endByte: number }) => !options.range || (item.startByte >= options.range.startByte && item.endByte <= options.range.endByte);
  const speech = inventory.speech.filter(inRange);
  const count = <K extends string>(keys: K[]) => keys.reduce<Partial<Record<K, number>>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {});
  const times = inventory.times.filter(inRange);
  const timeCounts = new Map<string, number>();
  for (const item of times) timeCounts.set(item.surface, (timeCounts.get(item.surface) ?? 0) + 1);
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  const quoted = new Set<string>();
  for (const span of speech) {
    if (span.kind !== "embedded") continue;
    const surface = Buffer.from(source.buffer, source.byteOffset + span.startByte, span.endByte - span.startByte).toString("utf8").slice(1, -1).trim();
    if (Array.from(surface).length >= 2 && Array.from(surface).length <= 12 && /\p{Script=Han}|[A-Za-z]{3,}/u.test(surface)) quoted.add(surface);
  }
  const threshold = options.termThreshold ?? 10;
  const quotedTerms = [...quoted].map((surface) => {
    let occurrences = 0;
    for (let index = text.indexOf(surface); index >= 0; index = text.indexOf(surface, index + surface.length)) occurrences += 1;
    return { surface, occurrences };
  }).filter((item) => item.occurrences >= threshold).sort((a, b) => b.occurrences - a.occurrences || a.surface.localeCompare(b.surface));
  const cues = inventory.cues.filter((cue) => inRange({ startByte: cue.speechStartByte, endByte: cue.speechEndByte }));
  return {
    version: LEXICAL_INVENTORY_VERSION,
    bytes: options.range ? options.range.endByte - options.range.startByte : source.byteLength,
    ...(options.range ? { range: options.range } : {}),
    speech: { total: speech.filter((span) => span.kind === "speech").length, byDelimiter: count(speech.filter((span) => span.kind === "speech").map((span) => span.delimiter)), unclosed: speech.filter((span) => !span.closed).length },
    embedded: speech.filter((span) => span.kind === "embedded").length,
    cues: { total: cues.length, byRule: count(cues.map((cue) => cue.rule)) },
    times: { total: times.length, byKind: count(times.map((item) => item.kind)), top: [...timeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([surface, n]) => ({ surface, count: n })) },
    quotedTerms: quotedTerms.slice(0, 50),
  };
}
