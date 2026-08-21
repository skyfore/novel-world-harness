import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";

export const playerSceneChoiceSchema = z.object({
  action: z.string().trim().min(2).max(240).describe(
    "The complete player command for the very next beat: the resolved physical act, specific observation, concrete wait, or exact spoken words. Not a plan, intention, heading, or placeholder for deciding an action later.",
  ),
}).strict();

export const playerSceneChoicesSchema = z.object({
  choices: z.array(playerSceneChoiceSchema).min(2).max(4),
}).strict().superRefine(({ choices }, ctx) => {
  const seen = new Set<string>();
  choices.forEach((choice, index) => {
    const normalized = choice.action.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    if (seen.has(normalized)) {
      ctx.addIssue({ code: "custom", path: ["choices", index, "action"], message: "Player choices must be distinct." });
    }
    seen.add(normalized);
  });
});

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
 * file, store, or commit access. Suggestions are not capabilities or world
 * proposals: selecting one still enters the ordinary player-action translation
 * and deterministic validation pipeline.
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
    description: "Capture 2-4 complete player commands for the next beat: grounded physical/observational acts, concrete waits, or exact spoken lines. Never capture a plan for deciding an action later. Suggestions cannot commit or mutate world truth.",
    promptSnippet: "Before scene prose, capture the resolved next actions themselves, never plans for finding actions",
    promptGuidelines: [
      "Base every choice only on the supplied committed actor frame.",
      "The action string is sent unchanged as the player's next command. Write the exact immediate act or spoken line, not a promise to decide, plan, find a way, start implementing a plan, or take an unspecified next action.",
      "If the choice still makes a reader ask what the actor physically does, observes, waits for, or says, replace it before calling this tool.",
      "An absent person is not a valid dialogue/contact target unless the frame grounds a communication medium the actor can use now.",
      "Use behavioralContext as characterization guidance only. Never expose its trait, bias, or goal metadata in a choice.",
      "Never predict another character's response, invent an entity, or duplicate a choice.",
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
          text: "Concrete player choices captured. Now stream only the requested scene narration. Do not mention or enumerate these choices, and do not call this tool again.",
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
