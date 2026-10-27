import { z } from "zod";

/** Domain blockers belong to existing repair ledgers. Unknown exceptions keep
 * the engineering diagnosis path instead of being classified by prose. */
export const compilationStopSchema = z.object({
  kind: z.enum(["semantic-repair", "host-state"]), sourceId: z.string().min(1),
  phase: z.enum(["opening", "roles", "closure"]), taskIds: z.array(z.string()).min(1),
  action: z.literal("inspect-compilation-plan"),
}).strict();
export type CompilationStop = z.infer<typeof compilationStopSchema>;
export class CompilationBlockedError extends Error {
  readonly recovery: CompilationStop;
  constructor(message: string, recovery: CompilationStop) {
    super(message); this.name = "CompilationBlockedError";
    this.recovery = compilationStopSchema.parse(recovery);
  }
}
export function compilationStopFromError(error: unknown): CompilationStop | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof CompilationBlockedError) return compilationStopSchema.parse(error.recovery);
    error = error.cause;
  }
  return undefined;
}
