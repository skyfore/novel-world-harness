import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { actorActionTemplateSchema, type ActorActionTemplate } from "../world/model-actor-policy.js";
import { constrainStateFields } from "./player-action-tool.js";

function prepareArguments(value: unknown): ActorActionTemplate {
  if (typeof value !== "string") return value as ActorActionTemplate;
  try {
    return JSON.parse(value) as ActorActionTemplate;
  } catch {
    throw new Error("Actor action tool arguments must be valid JSON.");
  }
}

export type ActorActionCaptureTool = {
  tool: ToolDefinition;
  getCandidate(): ActorActionTemplate | undefined;
  getExecutionAttempts(): number;
};

/** Capture-only proposal sink. It has no engine, storage, or commit access. */
export function createActorActionCaptureTool(stateFields: readonly string[]): ActorActionCaptureTool {
  let captured: ActorActionTemplate | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(actorActionTemplateSchema);
  constrainStateFields(jsonSchema, stateFields);
  const tool = defineTool({
    name: "propose_actor_action",
    label: "Propose autonomous actor action",
    description: "Capture one actor-scoped autonomous action proposal. The host validates scope, knowledge, footprint, rules, conflicts, and the current branch head before commit.",
    promptSnippet: "Submit one material autonomous actor action",
    promptGuidelines: [
      "Use only opaque handles and writable fields present in the supplied actor view.",
      "Propose a concrete state, knowledge, semantic, process or norm effect; do not submit a generic reaction or narration-only no-op.",
      "Treat goal, disposition, norms, and processes as current guidance, never as permission to import future canon or hidden facts.",
      "Declare an ad-hoc action footprint when using the action field. Coordination claims request exclusivity, consent, or authority; they do not prove permission.",
      "Call this tool at most once. The tool captures a proposal only and cannot commit world truth.",
    ],
    parameters: Type.Unsafe<ActorActionTemplate>(jsonSchema as TSchema),
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one autonomous actor action may be captured per request.");
      captured = structuredClone(actorActionTemplateSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "Actor action captured for deterministic validation. Nothing has been committed.",
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
