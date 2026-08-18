import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { idSchema } from "../world/model.js";

export const playerSceneChoiceSchema = z.object({
  affordanceId: idSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  action: z.string().trim().min(1).max(1_000),
  intent: z.enum(["act", "observe", "reflect", "wait"]).default("act"),
  recommended: z.boolean().default(false),
}).strict();

export const playerSceneChoicesSchema = z.object({
  choices: z.array(playerSceneChoiceSchema).min(1).max(4),
}).strict();

export type PlayerSceneChoice = z.infer<typeof playerSceneChoiceSchema>;

export type PlayerSceneChoiceCaptureTool = {
  tool: ToolDefinition;
  getChoices(): PlayerSceneChoice[];
  getExecutionAttempts(): number;
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
 * ordinary player-action validation pipeline.  The host later binds every ID
 * back to its authoritative preflighted affordance and ignores model edits to
 * labels, prose, intent, or recommendation.
 */
export function createPlayerSceneChoiceCaptureTool(): PlayerSceneChoiceCaptureTool {
  let choices: PlayerSceneChoice[] = [];
  let captured = false;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerSceneChoicesSchema);
  const parameters = Type.Unsafe<z.infer<typeof playerSceneChoicesSchema>>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_player_choices",
    label: "Propose player choices",
    description: "Capture 1-4 host-supplied actor-visible next actions (normally 2-4; one is allowed only when recovery leaves one). This tool cannot commit or mutate world truth.",
    promptSnippet: "After the streamed scene prose, capture grounded player choices",
    promptGuidelines: [
      "Base every choice only on the supplied committed actor frame.",
      "Select only affordance IDs supplied in the committed actor frame and copy every field verbatim.",
      "Never invent, rewrite, or duplicate an affordance.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
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
    getExecutionAttempts: () => executionAttempts,
    reset() {
      choices = [];
      captured = false;
      executionAttempts = 0;
    },
  };
}
