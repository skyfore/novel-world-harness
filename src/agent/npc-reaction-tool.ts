import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { npcReactionCandidateSchema, type NpcReactionCandidate } from "../world/npc-reaction.js";
import { constrainStateFields } from "./player-action-tool.js";

function prepareArguments(value: unknown): NpcReactionCandidate {
  if (typeof value !== "string") return value as NpcReactionCandidate;
  try {
    return JSON.parse(value) as NpcReactionCandidate;
  } catch {
    throw new Error("NPC reaction tool arguments must be valid JSON.");
  }
}

export type NpcReactionCaptureTool = {
  tool: ToolDefinition;
  getCandidate(): NpcReactionCandidate | undefined;
  getExecutionAttempts(): number;
};

/** Single-use proposal sink. It cannot access or mutate the world engine. */
export function createNpcReactionCaptureTool(stateFields: readonly string[]): NpcReactionCaptureTool {
  let captured: NpcReactionCandidate | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(npcReactionCandidateSchema);
  constrainStateFields(jsonSchema, stateFields);
  const tool = defineTool({
    name: "propose_npc_reaction",
    label: "Propose NPC reaction",
    description: "Capture one explicit actor-scoped NPC response to a perceived player interaction. The host validates causality, knowledge, state scope, and world rules before commit.",
    promptSnippet: "Submit one explicit NPC response proposal",
    promptGuidelines: [
      "Choose speak, gesture, refuse, ignore, or other; silence and refusal must still be explicit perceptible responses.",
      "For speech, include exact words in interaction.content and address only the triggering player handle.",
      "Ground motivation in current actor knowledge, development, goals, affect continuity, and perceived history; never use future canon or player-only narration.",
      "communicatedClaimIds may contain only claim handles already known by this NPC and actually expressed in the response.",
      "Propose only this NPC's controlled state/knowledge changes. The host owns participants, time, causal parents, progress, and commit authority.",
      "Call this tool exactly once and do not narrate after capture.",
    ],
    parameters: Type.Unsafe<NpcReactionCandidate>(jsonSchema as TSchema),
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one NPC reaction may be captured per request.");
      captured = structuredClone(npcReactionCandidateSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "NPC reaction captured for deterministic validation. Nothing has been committed.",
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
