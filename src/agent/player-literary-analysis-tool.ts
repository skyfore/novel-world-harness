import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import type {
  PlayerLiteraryStyleAnalysis,
  PlayerSceneDramaturgyAnalysis,
} from "../world/play-opening.js";

const note = (label: string, max = 500) => z.string().trim().min(1).max(max).describe(label);
const notes = (label: string, min: number, max: number) => z.array(note(label, 300)).min(min).max(max);

export const playerLiteraryStyleAnalysisSchema: z.ZodType<PlayerLiteraryStyleAnalysis> = z.object({
  proseMode: note("The narrative distance, focalization, and overall prose mode to sustain."),
  syntax: notes("A concrete sentence-structure pattern to use, abstracted from the admitted prose.", 1, 6),
  diction: notes("A diction/register tendency to use without copying source phrases.", 1, 6),
  cadence: note("The scene's intended cadence and paragraph rhythm."),
  dialogueHandling: note("How exact committed dialogue should sit inside the prose."),
  continuityCues: notes("A local voice, image, gesture, pronoun, or rhythm to continue from prior play prose.", 0, 8),
  avoid: notes("A style failure to avoid, such as summary compression, generic game copy, or source imitation by quotation.", 1, 8),
}).strict();

export const playerSceneDramaturgyAnalysisSchema: z.ZodType<PlayerSceneDramaturgyAnalysis> = z.object({
  dramaticPressure: note("The actor-visible pressure that gives this immediate beat dramatic shape."),
  beats: notes("One ordered, immediate beat to realize without inventing or advancing world truth.", 2, 8),
  sensoryAnchors: notes("A grounded sensory or bodily anchor already supported by the frame, or safe non-persistent texture.", 1, 8),
  dialoguePlacement: note("Where committed locked utterances belong in causal order; never invent missing speech."),
  continuityObligations: notes("A fact, wording dependency, or unresolved motion the final prose must preserve.", 0, 8),
  closingBeat: note("A concrete supported perception, motion, spoken cue, or signal on which to stop."),
  avoid: notes("A factual invention, causality error, agency violation, or premature time advance to avoid.", 1, 8),
}).strict();

export type PlayerLiteraryStyleAnalysisCapture = {
  tool: ToolDefinition;
  getAnalysis(): PlayerLiteraryStyleAnalysis | undefined;
  getExecutionAttempts(): number;
};

export type PlayerSceneDramaturgyAnalysisCapture = {
  tool: ToolDefinition;
  getAnalysis(): PlayerSceneDramaturgyAnalysis | undefined;
  getExecutionAttempts(): number;
};

function prepareArguments<T>(value: unknown): T {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Literary-analysis tool arguments must be valid JSON.");
  }
}

export function createPlayerLiteraryStyleAnalysisCaptureTool(): PlayerLiteraryStyleAnalysisCapture {
  let analysis: PlayerLiteraryStyleAnalysis | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerLiteraryStyleAnalysisSchema);
  const parameters = Type.Unsafe<PlayerLiteraryStyleAnalysis>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_literary_style_analysis",
    label: "Analyze literary style",
    description: "Capture a bounded, non-authoritative style analysis from admitted source prose and exact play continuity. This tool cannot write world truth or player-facing prose.",
    promptSnippet: "Abstract syntax, diction, cadence, dialogue handling, and continuity cues without copying source sentences",
    promptGuidelines: [
      "Use sourceReferences only for literary form; they prove no current or future fact.",
      "Use playContinuity only for local prose continuity; it is presentation memory, not world truth.",
      "Describe reusable patterns instead of quoting source wording or composing the final scene.",
    ],
    parameters,
    prepareArguments: prepareArguments<PlayerLiteraryStyleAnalysis>,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (analysis) throw new Error("Only one literary-style analysis may be captured per specialist call.");
      analysis = structuredClone(playerLiteraryStyleAnalysisSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "Style analysis captured. End this private specialist call now; do not write scene prose.",
        }],
        details: { captured: true },
      };
    },
  });
  return {
    tool,
    getAnalysis: () => analysis ? structuredClone(analysis) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}

export function createPlayerSceneDramaturgyAnalysisCaptureTool(): PlayerSceneDramaturgyAnalysisCapture {
  let analysis: PlayerSceneDramaturgyAnalysis | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerSceneDramaturgyAnalysisSchema);
  const parameters = Type.Unsafe<PlayerSceneDramaturgyAnalysis>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_scene_dramaturgy",
    label: "Analyze scene dramaturgy",
    description: "Capture a bounded, non-authoritative beat analysis from actor-visible committed truth. This tool cannot commit events or write player-facing prose.",
    promptSnippet: "Shape one immediate dramatic beat while preserving committed causality, exact dialogue, and player agency",
    promptGuidelines: [
      "actualOutcomes and committed actor-visible state win over the player's requested wording.",
      "Place lockedUtterances in causal order and never paraphrase or invent speech.",
      "Stay within one immediate beat; do not advance time, choose for the player, or invent persistent facts.",
    ],
    parameters,
    prepareArguments: prepareArguments<PlayerSceneDramaturgyAnalysis>,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (analysis) throw new Error("Only one scene-dramaturgy analysis may be captured per specialist call.");
      analysis = structuredClone(playerSceneDramaturgyAnalysisSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "Dramaturgy analysis captured. End this private specialist call now; do not write scene prose.",
        }],
        details: { captured: true },
      };
    },
  });
  return {
    tool,
    getAnalysis: () => analysis ? structuredClone(analysis) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}
