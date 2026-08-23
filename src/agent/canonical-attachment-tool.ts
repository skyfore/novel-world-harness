import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  canonicalAttachmentResolutionSchema,
  type CanonicalAttachmentResolution,
} from "../world/canonical-adaptation.js";
import { z } from "zod";

function prepareArguments(value: unknown): CanonicalAttachmentResolution {
  if (typeof value !== "string") return value as CanonicalAttachmentResolution;
  try {
    return JSON.parse(value) as CanonicalAttachmentResolution;
  } catch {
    throw new Error("Canonical attachment arguments must be valid JSON.");
  }
}

export type CanonicalAttachmentCaptureTool = {
  tool: ToolDefinition;
  getResolution(): CanonicalAttachmentResolution | undefined;
  getExecutionAttempts(): number;
};

/** Capture-only sink. Core world effects never cross this model tool. */
export function createCanonicalAttachmentCaptureTool(): CanonicalAttachmentCaptureTool {
  let captured: CanonicalAttachmentResolution | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(canonicalAttachmentResolutionSchema);
  const parameters = Type.Unsafe<CanonicalAttachmentResolution>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "attach_canonical_scaffold",
    label: "Attach canonical scaffold",
    description: "Select one offered host-validated role binding and add only a bounded event title, role observations, and role affect. This capture-only tool cannot alter or commit core effects.",
    promptSnippet: "Attach one coherent binding to the locked canonical scaffold or choose none",
    promptGuidelines: [
      "Use only an offered opaque bindingOptionId and listed roleId values.",
      "Choose attach only when the rebound participants can still perform the described causal functions without becoming out of character.",
      "The title and role observations describe the instantiated event; they cannot invent extra state, knowledge, history, or future consequences.",
      "Choose none when identity is essential, motivation would require invented facts, or every offered binding would merely force canon.",
      "Call this tool exactly once and stop after capture.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one canonical attachment may be captured per request.");
      captured = structuredClone(canonicalAttachmentResolutionSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "Canonical attachment captured for deterministic host validation. Nothing has been committed.",
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
