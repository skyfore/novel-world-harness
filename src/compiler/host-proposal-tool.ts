import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { jsonArguments } from "../agent/json-arguments.js";

type HostExecute<P extends TSchema = TSchema, D = unknown> = (
  ...args: [
    toolCallId: Parameters<ToolDefinition<P, D>["execute"]>[0],
    input: Parameters<ToolDefinition<P, D>["execute"]>[1],
    signal?: Parameters<ToolDefinition<P, D>["execute"]>[2],
    onUpdate?: Parameters<ToolDefinition<P, D>["execute"]>[3],
  ]
) => ReturnType<ToolDefinition<P, D>["execute"]>;

export type CompilerToolDefinition = ToolDefinition & { executeHost?: HostExecute };

/** Domain executor shared by Pi and guarded host staging, without extension capabilities. */
export function defineHostProposalTool<P extends TSchema, D = unknown>(
  tool: Omit<ToolDefinition<P, D>, "execute"> & { execute: HostExecute<P, D> },
): ReturnType<typeof defineTool<P, D>> & { executeHost: HostExecute } {
  return {
    ...defineTool(tool),
    executeHost(id, input, signal, onUpdate) {
      const validated = validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: jsonArguments(input) });
      return tool.execute(id, validated, signal, onUpdate);
    },
  };
}
