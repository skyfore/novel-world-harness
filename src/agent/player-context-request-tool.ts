import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import {
  runtimeContextRequestSchema,
  type RuntimeContextRequest,
} from "../world/runtime-context.js";

export type PlayerContextRequestCaptureTool = {
  tool: ToolDefinition;
  getRequest(): RuntimeContextRequest | undefined;
  getExecutionAttempts(): number;
};

/** A translator can explicitly preserve unknown rather than guessing or refusing. */
export function createPlayerContextRequestCaptureTool(): PlayerContextRequestCaptureTool {
  let captured: RuntimeContextRequest | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(runtimeContextRequestSchema);
  const tool = defineTool({
    name: "request_player_context",
    label: "Request player context",
    description: "Request one bounded host-private evidence consultation when actor-context and message retrieval cannot safely resolve the player's referent or premise.",
    promptSnippet: "Preserve a genuine data gap without guessing",
    promptGuidelines: [
      "Use only after the supplied actor-context and message retrieval cannot answer a material ambiguity.",
      "Do not use this tool for a known contradiction, forbidden capability, missing character knowledge, or tool/schema failure.",
      "Ask one concrete question and provide literal search terms from the player's wording.",
    ],
    parameters: Type.Unsafe<RuntimeContextRequest>(jsonSchema as TSchema),
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one player-context request may be captured per translation attempt.");
      captured = structuredClone(runtimeContextRequestSchema.parse(input));
      return {
        content: [{ type: "text" as const, text: "Context need captured. The host will decide whether a frozen-source consultation is permitted." }],
        details: { captured: true, authority: "proposal-only" },
      };
    },
  });
  return {
    tool,
    getRequest: () => captured ? structuredClone(captured) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}
