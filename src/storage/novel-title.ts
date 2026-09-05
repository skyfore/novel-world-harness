import { z } from "zod";
import { evidenceRefSchema, idSchema } from "../world/model.js";

const modelTitleSchema = z.string().trim().min(1).max(200).superRefine((title, ctx) => {
  for (const character of title) {
    if (!isUnsafeDisplayCharacter(character)) continue;
    ctx.addIssue({ code: "custom", message: "A novel title must be one safe display line." });
    return;
  }
});

const titleGenerationSchema = z.object({
  worker: z.literal("propose_novel_title"),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  compilerBatchId: idSchema,
}).strict();

export const sourceTitleProposalSchema = z.object({
  version: z.literal(1),
  proposalId: idSchema,
  sourceId: idSchema,
  title: modelTitleSchema,
  evidence: evidenceRefSchema,
  generatedBy: titleGenerationSchema,
  createdAt: z.string().datetime(),
}).strict();

export const sourceTitleInferenceSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  title: modelTitleSchema,
  evidence: evidenceRefSchema,
  generatedBy: titleGenerationSchema,
  inferredAt: z.string().datetime(),
}).strict();

export type SourceTitleProposal = z.infer<typeof sourceTitleProposalSchema>;
export type SourceTitleInference = z.infer<typeof sourceTitleInferenceSchema>;

/**
 * Normalize a title selected semantically by the compiler model. This function
 * validates display safety only; it never tries to decide which source text is
 * the work title.
 */
export function normalizeModelInferredNovelTitle(value: string): string {
  const normalized = collapseWhitespace(value.normalize("NFKC"));
  return modelTitleSchema.parse(normalized);
}

/** Require the model-selected title text to occur in its verified source slice. */
export function inferredTitleOccursInEvidence(title: string, excerpt: string): boolean {
  const needle = collapseWhitespace(title.normalize("NFKC")).toLowerCase();
  const haystack = collapseWhitespace(excerpt.normalize("NFKC")).toLowerCase();
  return Boolean(needle) && haystack.includes(needle);
}

/** Turn the accepted display title into the ASCII-safe stem required by branch IDs. */
export function novelTitleIdStem(title: string): string {
  let result = "";
  let separatorPending = false;
  for (const character of title.trim().normalize("NFKD").toLowerCase()) {
    const code = character.codePointAt(0)!;
    const asciiLetter = code >= 97 && code <= 122;
    const asciiDigit = code >= 48 && code <= 57;
    if (asciiLetter || asciiDigit) {
      if (separatorPending && result) result += "-";
      result += character;
      separatorPending = false;
      if (result.length >= 120) break;
    } else if (result) {
      separatorPending = true;
    }
  }
  return result.endsWith("-") ? result.slice(0, -1) : result;
}

function collapseWhitespace(value: string): string {
  let result = "";
  let whitespacePending = false;
  for (const character of value) {
    if (character.trim().length === 0) {
      whitespacePending = Boolean(result);
      continue;
    }
    if (whitespacePending) result += " ";
    result += character;
    whitespacePending = false;
  }
  return result;
}

function isUnsafeDisplayCharacter(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code <= 0x1f
    || (code >= 0x7f && code <= 0x9f)
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x206f)
    || code === 0xfeff;
}
