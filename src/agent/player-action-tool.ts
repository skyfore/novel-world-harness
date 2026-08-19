import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import {
  playerActionCandidateSchema,
  type PlayerActionCandidate,
} from "../world/player-action.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";

function parseJsonArgument(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Player action tool arguments must be a JSON value, not an invalid JSON string.");
  }
}

export function preparePlayerActionToolArguments(value: unknown): PlayerActionCandidate {
  return parseJsonArgument(value) as PlayerActionCandidate;
}

export type PlayerActionCaptureTool = {
  tool: ToolDefinition;
  getCandidate(): PlayerActionCandidate | undefined;
  getExecutionAttempts(): number;
};

/**
 * A single-use, in-memory proposal sink. It has no workspace, engine, store, or
 * commit capability; the caller must pass the captured candidate to host-side
 * scope and world validation.
 */
export function createPlayerActionCaptureTool(
  onCapture?: (candidate: PlayerActionCandidate) => void,
  stateFields: readonly string[] = DEFAULT_STATE_FIELDS.map((field) => field.key),
): PlayerActionCaptureTool {
  let captured: PlayerActionCandidate | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerActionCandidateSchema);
  constrainStateFields(jsonSchema, stateFields);
  const parameters = Type.Unsafe<PlayerActionCandidate>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_player_action",
    label: "Propose player action",
    description: "Capture one structured player intent plus actor-controlled candidate effects for host world adjudication and deterministic validation. This tool cannot commit or mutate world truth.",
    promptSnippet: "Submit exactly one scoped player-action candidate",
    promptGuidelines: [
      "Use only the supplied actor-scoped context; never infer future canon or hidden world state.",
      "Do not claim the action succeeded. The host validates and commits after this tool returns.",
      "Always provide intent; scene transitions and durations must be typed there rather than implied by wording.",
      "Submit exactly one candidate and do not invent entity or claim IDs outside the supplied scope.",
    ],
    parameters,
    prepareArguments: preparePlayerActionToolArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one player action candidate may be captured per turn.");
      const candidate = playerActionCandidateSchema.parse(input);
      captured = structuredClone(candidate);
      onCapture?.(structuredClone(candidate));
      return {
        content: [{
          type: "text" as const,
          text: "Player action candidate captured for deterministic validation. It is not committed world truth.",
        }],
        details: { captured: true },
      };
    },
  });
  return {
    tool,
    getCandidate: () => captured ? structuredClone(captured) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}

export function constrainStateFields(value: unknown, stateFields: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) constrainStateFields(item, stateFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const propertyRecord = properties as Record<string, unknown>;
    const op = propertyRecord.op;
    const operation = op && typeof op === "object" && !Array.isArray(op)
      ? (op as Record<string, unknown>).const
      : undefined;
    if (
      typeof operation === "string"
      && ["set", "unset", "adjust-number", "add-member", "remove-member", "fact-equals", "fact-gte", "fact-lte", "fact-exists", "entity-in"].includes(operation)
      && propertyRecord.field
    ) {
      propertyRecord.field = {
        type: "string",
        enum: [...stateFields],
        description: "A writable deterministic state field from the supplied actor scope.",
      };
    }
  }
  for (const nested of Object.values(record)) constrainStateFields(nested, stateFields);
}
