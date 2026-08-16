import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";

export const playerSceneChoiceSchema = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  action: z.string().trim().min(1).max(1_000),
  intent: z.enum(["act", "observe", "reflect", "wait"]).default("act"),
}).strict();

export const playerSceneChoicesSchema = z.object({
  choices: z.array(playerSceneChoiceSchema).min(2).max(4),
}).strict();

// Use the input type so persisted v1 transcripts and custom narrators that do
// not yet emit `intent` remain source-compatible. Parsing normalizes them to
// the conservative `act` capability.
export type PlayerSceneChoice = z.input<typeof playerSceneChoiceSchema>;

export type PlayerSceneChoiceCaptureTool = {
  tool: ToolDefinition;
  getChoices(): PlayerSceneChoice[];
  reset(): void;
};

function prepareArguments(value: unknown): z.infer<typeof playerSceneChoicesSchema> {
  if (typeof value !== "string") return value as z.infer<typeof playerSceneChoicesSchema>;
  try {
    return JSON.parse(value) as z.infer<typeof playerSceneChoicesSchema>;
  } catch {
    throw new Error("Scene-choice tool arguments must be valid JSON.");
  }
}

/**
 * A capture-only sink for suggested player utterances. The tool has no world,
 * file, store, or commit access. Selecting one of its results still enters the
 * ordinary player-action translation and deterministic validation pipeline.
 * The three non-`act` intents are deliberately narrow host capabilities: the
 * host ignores any implied outcome in their prose and records only the chosen
 * observation/reflection/wait intention.
 */
export function createPlayerSceneChoiceCaptureTool(): PlayerSceneChoiceCaptureTool {
  let choices: PlayerSceneChoice[] = [];
  let captured = false;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerSceneChoicesSchema);
  const parameters = Type.Unsafe<z.infer<typeof playerSceneChoicesSchema>>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_player_choices",
    label: "Propose player choices",
    description: "Capture 2-4 actor-visible suggested next actions for the player. This tool cannot commit or mutate world truth.",
    promptSnippet: "After the streamed scene prose, capture grounded player choices",
    promptGuidelines: [
      "Base every choice only on the supplied committed actor frame.",
      "Phrase choices as immediate player intentions, never as outcomes that already happened.",
      "Do not introduce hidden state, future canon, or named entities absent from the actor frame.",
      "Use intent=observe only for looking/listening, intent=reflect only for reviewing already-known information, intent=wait only for a short deliberate pause, and intent=act for every other choice.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one scene-choice set may be captured per narration attempt.");
      const parsed = playerSceneChoicesSchema.parse(input);
      choices = structuredClone(parsed.choices);
      captured = true;
      return {
        content: [{
          type: "text" as const,
          text: "Player choices captured. End the response now without adding more narration.",
        }],
        details: { captured: choices.length },
      };
    },
  });
  return {
    tool,
    getChoices: () => structuredClone(choices),
    reset() {
      choices = [];
      captured = false;
    },
  };
}
