import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import {
  runtimeContextProposalSchema,
  type RuntimeContextProposal,
} from "../world/runtime-context.js";

function prepareArguments(value: unknown): RuntimeContextProposal {
  if (typeof value !== "string") return value as RuntimeContextProposal;
  try {
    return JSON.parse(value) as RuntimeContextProposal;
  } catch {
    throw new Error("Runtime-context proposal arguments must be valid JSON.");
  }
}

export type RuntimeContextProposalCaptureTool = {
  tool: ToolDefinition;
  getProposal(): RuntimeContextProposal | undefined;
  getExecutionAttempts(): number;
};

/** Capture-only sink. Source interpretation remains a proposal until host admission. */
export function createRuntimeContextProposalCaptureTool(): RuntimeContextProposalCaptureTool {
  let captured: RuntimeContextProposal | undefined;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(runtimeContextProposalSchema);
  const parameters = Type.Unsafe<RuntimeContextProposal>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_runtime_context_supplement",
    label: "Propose runtime context supplement",
    description: "Propose cited source interpretation for host admission. This capture-only tool cannot change world truth, character knowledge, or the active branch.",
    promptSnippet: "Submit exactly one cited runtime-context proposal",
    promptGuidelines: [
      "Cite only exact source-unit refs returned and read in this invocation.",
      "Link only compiled artifact refs shown beside those source units; never invent an ID.",
      "Classify later or uncertain material honestly. Source prose alone is not current branch truth.",
      "Use not-found with no findings when the pinned source cannot answer the bounded need.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one runtime-context proposal may be captured per consultation.");
      captured = structuredClone(runtimeContextProposalSchema.parse(input));
      return {
        content: [{
          type: "text" as const,
          text: "Runtime-context proposal captured for deterministic scope and authority admission. Nothing was committed.",
        }],
        details: { captured: true, authority: "proposal-only" },
      };
    },
  });
  return {
    tool,
    getProposal: () => captured ? structuredClone(captured) : undefined,
    getExecutionAttempts: () => executionAttempts,
  };
}
