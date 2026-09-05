import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import {
  playerWorldResolutionSchema,
  type PlayerWorldResolution,
} from "../world/player-action.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { constrainStateFields } from "./player-action-tool.js";

function prepareArguments(value: unknown): PlayerWorldResolution {
  if (typeof value !== "string") return value as PlayerWorldResolution;
  try {
    return JSON.parse(value) as PlayerWorldResolution;
  } catch {
    throw new Error("World-resolution tool arguments must be valid JSON.");
  }
}

export type PlayerWorldResolutionCaptureTool = {
  tool: ToolDefinition;
  getResolution(): PlayerWorldResolution | undefined;
  getExecutionAttempts(): number;
};

/** Capture-only sink: a world outcome remains an untrusted proposal. */
export function createPlayerWorldResolutionCaptureTool(
  stateFields: readonly string[] = DEFAULT_STATE_FIELDS.map((field) => field.key),
): PlayerWorldResolutionCaptureTool {
  let captured: PlayerWorldResolution | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerWorldResolutionSchema);
  constrainStateFields(jsonSchema, stateFields);
  const parameters = Type.Unsafe<PlayerWorldResolution>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_player_world_resolution",
    label: "Propose world resolution",
    description: "Resolve one player intent as its ordinary realization, a contradiction-grounded in-world consequence, or one bounded needs-context request. This capture-only tool cannot commit world truth.",
    promptSnippet: "Propose exactly one immediate world resolution",
    promptGuidelines: [
      "Distinguish intendedCandidate.intent.controlledAct from intent.desiredEffect; performing the former alone does not prove the latter.",
      "Choose transform only for a direct contradiction with committed state, an active rule, or unavoidable immediate causality/capability.",
      "Choose needs-context when a material absent detail prevents a safe realization/transform decision; ask one concrete question and never use it for a known contradiction.",
      "For state, active-rule, or deterministic-issue grounding, copy an exact currentWorld.constraintTokens[].token into a constraint-token basis. Never invent, alter, or reuse a token; it is bound to this candidate and branch head.",
      "An explicit ordinary causal/capability principle is valid only for a causality or capability contradiction.",
      "A transformed replacement is the immediate event that actually occurs, not a system refusal and not the impossible desired effect.",
      "Use only supplied opaque handles and writable fields; the host revalidates every replacement before commit.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one player-world resolution may be captured per turn.");
      captured = structuredClone(playerWorldResolutionSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "World-resolution proposal captured for host validation. It has not been committed.",
        }],
        details: { captured: true },
      };
    },
  });
  return {
    tool,
    getResolution: () => captured ? structuredClone(captured) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}
