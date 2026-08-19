import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";

export const playerWorldResponseSelectionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("none") }).strict(),
  z.object({
    decision: z.literal("select"),
    responseId: z.string().regex(/^response-[0-9]{3}$/),
  }).strict(),
]);
export type PlayerWorldResponseSelection = z.infer<typeof playerWorldResponseSelectionSchema>;

function prepareArguments(value: unknown): PlayerWorldResponseSelection {
  if (typeof value !== "string") return value as PlayerWorldResponseSelection;
  try {
    return JSON.parse(value) as PlayerWorldResponseSelection;
  } catch {
    throw new Error("Player-world response selection arguments must be valid JSON.");
  }
}

export type PlayerWorldResponseCaptureTool = {
  tool: ToolDefinition;
  getSelection(): PlayerWorldResponseSelection | undefined;
  getExecutionAttempts(): number;
};

/** Capture-only sink. The selected opaque handle is decoded and validated by the host. */
export function createPlayerWorldResponseCaptureTool(): PlayerWorldResponseCaptureTool {
  let captured: PlayerWorldResponseSelection | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerWorldResponseSelectionSchema);
  const parameters = Type.Unsafe<PlayerWorldResponseSelection>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "select_player_world_response",
    label: "Select immediate world response",
    description: "Select at most one offered world development that is directly and immediately triggered by the player's committed action. This capture-only tool cannot commit it.",
    promptSnippet: "Select one immediate offered response or none",
    promptGuidelines: [
      "Select only an offered opaque responseId.",
      "Use none when eligibility is merely temporal, topical, or character overlap rather than immediate causality.",
      "Never narrate, alter effects, combine responses, or schedule future plot.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one player-world response selection may be captured per turn.");
      captured = structuredClone(playerWorldResponseSelectionSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "World-response selection captured for host validation. Nothing has been committed.",
        }],
        details: { captured: true },
      };
    },
  });
  return {
    tool,
    getSelection: () => captured ? structuredClone(captured) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}
