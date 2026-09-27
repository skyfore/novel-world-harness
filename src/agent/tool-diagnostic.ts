import { z } from "zod";
/** Host-generated diagnostics. Embedded source strings are evidence, never instructions. */
export const toolDiagnosticContextSchema = z.object({
  code: z.string(),
  issues: z.array(z.record(z.string(), z.unknown())),
  steps: z.array(z.string()),
  retry: z.object({ sourceId: z.string(), batchId: z.string(), proposalId: z.string(), correctedRetryAvailable: z.boolean() }).optional(),
}).strict();
export type ToolDiagnosticContext = z.infer<typeof toolDiagnosticContextSchema>;

export class ToolDiagnosticError extends Error {
  constructor(message: string, readonly diagnostic: ToolDiagnosticContext, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ToolDiagnosticError";
  }
}
