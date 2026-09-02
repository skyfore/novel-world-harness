import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readSourceMaterial } from "../storage/source-material-store.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { idSchema } from "../world/model.js";
import { promptJson } from "../util/prompt-data.js";
import { worldStorageRoot } from "../world/paths.js";

export const CHAPTER_SPLIT_DISCOVERY_VERSION = 1 as const;

const chapterNumberStyleSchema = z.enum(["arabic", "chinese", "roman", "english", "mixed"]);

export const chapterHeadingRuleSchema = z.object({
  prefix: z.string().max(80).refine(singleLine, "prefix must be a single line"),
  numberStyle: chapterNumberStyleSchema,
  suffix: z.string().max(40).refine(singleLine, "suffix must be a single line"),
  caseSensitive: z.boolean(),
  allowLeadingWhitespace: z.boolean(),
  allowTrailingText: z.boolean(),
}).strict().superRefine((rule, ctx) => {
  if (!rule.prefix && !rule.suffix && rule.numberStyle !== "arabic") {
    ctx.addIssue({
      code: "custom",
      message: "A marker-free rule is allowed only for Arabic-numbered headings.",
    });
  }
});

const chapterSplitExampleSchema = z.object({
  line: z.number().int().positive(),
  text: z.string().min(1).max(240).refine(singleLine, "example text must be a single line"),
}).strict();

export const chapterSplitPlanSchema = z.object({
  version: z.literal(1),
  discoveryVersion: z.literal(CHAPTER_SPLIT_DISCOVERY_VERSION),
  sourceId: idSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["builtin", "custom"]),
  rule: chapterHeadingRuleSchema.optional(),
  examples: z.array(chapterSplitExampleSchema).max(12),
  reason: z.string().min(1).max(1_000),
  generatedBy: z.object({
    compilerBatchId: idSchema,
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict().superRefine((plan, ctx) => {
  if (plan.mode === "custom" && !plan.rule) {
    ctx.addIssue({ code: "custom", path: ["rule"], message: "A custom split plan requires a heading rule." });
  }
  if (plan.mode === "custom" && plan.examples.length < 2) {
    ctx.addIssue({ code: "custom", path: ["examples"], message: "A custom split plan requires at least two sampled heading examples." });
  }
  if (plan.mode === "builtin" && (plan.rule || plan.examples.length)) {
    ctx.addIssue({ code: "custom", message: "A builtin split plan cannot contain a custom rule or examples." });
  }
  if (plan.generatedBy.compilerBatchId !== `structure-${plan.sourceId}-v${plan.discoveryVersion}`) {
    ctx.addIssue({
      code: "custom",
      path: ["generatedBy", "compilerBatchId"],
      message: "compilerBatchId must identify this source's structure-discovery version",
    });
  }
});

export type ChapterHeadingRule = z.infer<typeof chapterHeadingRuleSchema>;
export type ChapterSplitPlan = z.infer<typeof chapterSplitPlanSchema>;
export type ChapterSplitPlanInput = {
  mode: "builtin" | "custom";
  rule?: ChapterHeadingRule;
  examples?: Array<{ line: number; text: string }>;
  reason: string;
};

export type ChapterStructureSample = {
  version: 1;
  sourceId: string;
  sourcePath: string;
  totalLines: number;
  sampledRanges: Array<{ startLine: number; endLine: number }>;
  lines: Array<{ line: number; text: string; truncated?: true }>;
  prompt: string;
  promptCharacters: number;
};

export type ChapterSplitEvaluation = {
  plan: ChapterSplitPlan;
  headingLines: number[];
  headingTitles: string[];
};

const SAMPLE_WINDOW_LINES = 96;
const SAMPLE_LINE_CHARACTERS = 240;
const SAMPLE_WINDOW_PROMPT_CHARACTERS = 18_000;
const STRUCTURAL_ORDINAL_CANDIDATE = /(?:[0-9０-９]+|[零〇一二三四五六七八九十百千万两兩壹贰叁肆伍陆柒捌玖拾佰仟萬廿卅]+|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[ivxlcdm]{1,16})\b)/iu;

export class ChapterSplitPlanStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "evidence", "chapter-splits");
  }

  async read(sourceId: string): Promise<ChapterSplitPlan | null> {
    try {
      const parsed = chapterSplitPlanSchema.parse(JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")));
      if (parsed.sourceId !== sourceId) {
        throw new Error(`Chapter split plan source '${parsed.sourceId}' does not match requested source '${sourceId}'.`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(plan: ChapterSplitPlan): Promise<void> {
    const validated = chapterSplitPlanSchema.parse(plan);
    await atomicJson(this.filePath(validated.sourceId), validated);
  }

  async remove(sourceId: string): Promise<void> {
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) throw new Error(`Unsafe source id: ${sourceId}`);
    return path.join(this.root, `${sourceId}.json`);
  }
}

export async function buildChapterStructureSample(
  workspaceRoot: string,
  source: SourceDocument,
): Promise<ChapterStructureSample> {
  const text = await verifiedSourceText(workspaceRoot, source);
  const lines = text.split(/\r\n|\r|\n/u);
  const lastIndex = Math.max(0, lines.length - 1);
  const anchors = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => Math.round(lastIndex * fraction));
  const selected = new Map<number, { line: number; text: string; truncated?: true }>();
  const ranges: Array<{ startLine: number; endLine: number }> = [];

  for (const anchor of anchors) {
    const start = anchor === 0
      ? 0
      : anchor === lastIndex
        ? Math.max(0, lastIndex - SAMPLE_WINDOW_LINES + 1)
        : Math.max(0, anchor - Math.floor(SAMPLE_WINDOW_LINES / 2));
    const end = Math.min(lastIndex, start + SAMPLE_WINDOW_LINES - 1);
    let promptCharacters = 0;
    let includedEnd = start - 1;
    for (let index = start; index <= end; index += 1) {
      if (selected.has(index)) {
        includedEnd = index;
        continue;
      }
      const original = lines[index] ?? "";
      const textValue = original.length > SAMPLE_LINE_CHARACTERS
        ? original.slice(0, SAMPLE_LINE_CHARACTERS)
        : original;
      const value = {
        line: index + 1,
        text: textValue,
        ...(textValue.length < original.length ? { truncated: true as const } : {}),
      };
      const cost = promptJson(value).length;
      if (promptCharacters > 0 && promptCharacters + cost > SAMPLE_WINDOW_PROMPT_CHARACTERS) break;
      selected.set(index, value);
      promptCharacters += cost;
      includedEnd = index;
    }
    if (includedEnd >= start) ranges.push({ startLine: start + 1, endLine: includedEnd + 1 });
  }

  // Long chapters can place every heading between the fixed windows. Add a
  // bounded, evenly distributed set of isolated short lines from the whole
  // source; these are high-recall structural candidates, not trusted headings.
  const isolatedShortLines = lines.flatMap((line, index) => {
    const trimmed = line.trim();
    const isolated = !(lines[index - 1] ?? "").trim() || !(lines[index + 1] ?? "").trim();
    return trimmed && trimmed.length <= 120 && isolated && STRUCTURAL_ORDINAL_CANDIDATE.test(trimmed) ? [index] : [];
  });
  const candidateCount = Math.min(120, isolatedShortLines.length);
  let candidatePromptCharacters = 0;
  for (let position = 0; position < candidateCount; position += 1) {
    const candidateOffset = candidateCount === 1
      ? 0
      : Math.round(position * (isolatedShortLines.length - 1) / (candidateCount - 1));
    const index = isolatedShortLines[candidateOffset]!;
    if (selected.has(index)) continue;
    const value = { line: index + 1, text: lines[index]! };
    const cost = promptJson(value).length;
    if (candidatePromptCharacters > 0
      && candidatePromptCharacters + cost > SAMPLE_WINDOW_PROMPT_CHARACTERS) break;
    selected.set(index, value);
    ranges.push({ startLine: index + 1, endLine: index + 1 });
    candidatePromptCharacters += cost;
  }

  const sampledLines = [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
  const sampledRanges = mergeRanges(ranges);
  const payload = {
    version: 1 as const,
    sourceId: source.id,
    sourcePath: source.sourcePath,
    totalLines: lines.length,
    sampledRanges,
    lines: sampledLines,
  };
  const { sourcePath: _ingestPath, ...modelPayload } = payload;
  const prompt = promptJson(modelPayload);
  return { ...payload, prompt, promptCharacters: prompt.length };
}

export async function evaluateChapterSplitPlan(
  workspaceRoot: string,
  source: SourceDocument,
  input: ChapterSplitPlanInput,
  generatedBy: ChapterSplitPlan["generatedBy"],
): Promise<ChapterSplitEvaluation> {
  const text = await verifiedSourceText(workspaceRoot, source);
  const lines = text.split(/\r\n|\r|\n/u);
  const base = {
    version: 1 as const,
    discoveryVersion: CHAPTER_SPLIT_DISCOVERY_VERSION,
    sourceId: source.id,
    sourceSha256: source.contentSha256,
    reason: input.reason,
    generatedBy,
    createdAt: new Date().toISOString(),
  };

  if (input.mode === "builtin") {
    const plan = chapterSplitPlanSchema.parse({ ...base, mode: "builtin", examples: [] });
    return { plan, headingLines: [], headingTitles: [] };
  }

  const rule = chapterHeadingRuleSchema.parse(input.rule);
  const examples = chapterSplitExampleSchema.array().min(2).max(12).parse(input.examples ?? []);
  const uniqueExampleLines = new Set(examples.map((example) => example.line));
  if (uniqueExampleLines.size !== examples.length) throw new Error("Chapter heading examples must use distinct sampled lines.");

  const sample = await buildChapterStructureSample(workspaceRoot, source);
  const exactSampleLines = new Map(
    sample.lines.filter((line) => !line.truncated).map((line) => [line.line, line.text]),
  );
  for (const example of examples) {
    if (exactSampleLines.get(example.line) !== example.text) {
      throw new Error(`Chapter heading example at line ${example.line} is not an exact, untruncated line from the supplied structure sample.`);
    }
    if (!chapterHeadingMatches(example.text, rule)) {
      throw new Error(`Chapter heading rule does not match its example at line ${example.line}.`);
    }
  }

  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => chapterHeadingMatches(line, rule));
  if (matches.length < 2) throw new Error("Chapter heading rule must match at least two lines in the immutable source.");
  if (matches.some(({ line }) => line.trim().length > SAMPLE_LINE_CHARACTERS)) {
    throw new Error(`Chapter heading rule matched a line longer than ${SAMPLE_LINE_CHARACTERS} characters; narrow the rule.`);
  }
  if (lines.length >= 50 && matches.length / lines.length > 0.1) {
    throw new Error(`Chapter heading rule matched ${matches.length}/${lines.length} lines; narrow the rule below 10% of source lines.`);
  }
  if (matches.length > 5_000) throw new Error("Chapter heading rule matched more than 5,000 lines; narrow the rule.");
  const matchedLines = new Set(matches.map(({ index }) => index + 1));
  for (const example of examples) {
    if (!matchedLines.has(example.line)) throw new Error(`Chapter heading example at line ${example.line} was not selected by the full-source rule.`);
  }

  const plan = chapterSplitPlanSchema.parse({ ...base, mode: "custom", rule, examples });
  return {
    plan,
    headingLines: matches.map(({ index }) => index + 1),
    headingTitles: matches.slice(0, 20).map(({ line }) => line.trim()),
  };
}

export function chapterHeadingMatches(line: string, rule: ChapterHeadingRule): boolean {
  const normalizedLine = line.normalize("NFKC");
  const candidate = rule.allowLeadingWhitespace ? normalizedLine.trimStart() : normalizedLine;
  const prefix = rule.prefix.normalize("NFKC");
  const suffix = rule.suffix.normalize("NFKC");
  const comparable = (value: string) => rule.caseSensitive ? value : value.toLocaleLowerCase("en-US");
  if (!comparable(candidate).startsWith(comparable(prefix))) return false;
  const afterPrefix = candidate.slice(prefix.length);
  const number = numberPattern(rule.numberStyle).exec(afterPrefix)?.[0];
  if (!number) return false;
  const afterNumber = afterPrefix.slice(number.length);
  if (!comparable(afterNumber).startsWith(comparable(suffix))) return false;
  const remainder = afterNumber.slice(suffix.length);
  if (!remainder.trim()) return true;
  if (!rule.allowTrailingText) return false;
  if (suffix) return true;
  return /^[\s:：.。、_\-—–]/u.test(remainder);
}

export function customChapterBoundaries(lines: readonly string[], plan: ChapterSplitPlan | null): number[] {
  if (!plan || plan.mode !== "custom" || !plan.rule) return [];
  return lines.flatMap((line, index) => chapterHeadingMatches(line, plan.rule!) ? [index] : []);
}

function numberPattern(style: ChapterHeadingRule["numberStyle"]): RegExp {
  const arabic = "[0-9]{1,6}";
  const chinese = "[零〇一二三四五六七八九十百千万两兩壹贰叁肆伍陆柒捌玖拾佰仟萬廿卅]{1,16}";
  const roman = "[IVXLCDMivxlcdm]{1,16}";
  const englishWord = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth)";
  const english = `${englishWord}(?:[ -]${englishWord}){0,5}`;
  const pattern = style === "arabic"
    ? arabic
    : style === "chinese"
      ? chinese
      : style === "roman"
        ? roman
        : style === "english"
          ? english
          : `(?:${arabic}|${chinese}|${roman}|${english})`;
  return new RegExp(`^(?:${pattern})`, style === "english" || style === "mixed" ? "i" : "");
}

async function verifiedSourceText(workspaceRoot: string, source: SourceDocument): Promise<string> {
  const buffer = await readSourceMaterial(workspaceRoot, source);
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual !== source.contentSha256) {
    throw new Error(`Source changed since ingest: ${source.sourcePath}; expected ${source.contentSha256}, found ${actual}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Source must be valid UTF-8 text: ${source.sourcePath}`);
  }
}

function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine);
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push({ ...range });
  }
  return merged;
}

function singleLine(value: string): boolean {
  return !/[\r\n\0]/u.test(value);
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
