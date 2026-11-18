import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { z } from "zod";

/** Shared TypeBox fragments for model-facing tool schemas. Zod re-validates every input. */
export const T = {
  span: () => Type.Object({ unit: Type.String({ description: "Unit label, e.g. u0012" }), text: Type.String({ description: "Exact text copied from that unit" }), nth: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
  extent: () => Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: false }),
  rationale: () => Type.String({ minLength: 1, maxLength: 1000 }),
};

export function jsonResult(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/** A pipeline tool: TypeBox for the model, zod for the host. Validation errors name the failing path. */
export function pipelineTool<I>(spec: {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  input: z.ZodType<I>;
  execute: (input: I, signal?: AbortSignal) => Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: "sequential",
    async execute(_id, raw, signal) {
      signal?.throwIfAborted();
      const parsed = spec.input.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid ${spec.name} input: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}. Correct these fields and retry once.`);
      }
      return jsonResult(await spec.execute(parsed.data, signal));
    },
  }) as unknown as ToolDefinition;
}

/** Apply items one by one; a failing item is reported with its index and never blocks the others. */
export async function applyEach<I, R>(items: readonly I[], apply: (item: I, index: number) => Promise<R>): Promise<{ applied: R[]; failed: Array<{ index: number; error: string }> }> {
  const applied: R[] = [], failed: Array<{ index: number; error: string }> = [];
  for (let index = 0; index < items.length; index += 1) {
    try { applied.push(await apply(items[index]!, index)); }
    catch (error) { failed.push({ index, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { applied, failed };
}

/**
 * Stage a proposal under a content-derived ID. An identical proposal that is
 * already accepted is reused; one sitting in rejected history (e.g. after a
 * quarantine on an earlier attempt) is re-staged under a fresh ID.
 */
export async function stageOnce(stage: (id: string) => Promise<void>, id: string): Promise<string> {
  try {
    await stage(id);
    return id;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (/already exists in accepted history/u.test(error.message)) return id;
    if (!/already exists in rejected history/u.test(error.message)) throw error;
    const fresh = `${id.slice(0, 40)}-r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await stage(fresh);
    return fresh;
  }
}
