import { Type } from "typebox";
import { z } from "zod";
import { idSchema, participantPresenceModeSchema, stateOperationSchema } from "../../world/model.js";
import { buildAssertions } from "./artifacts.js";
import { convergeCanonical, submitCanonical } from "./canon.js";
import { gateOf, type StageDefinition } from "./runner.js";
import { extentSelectorSchema, spanSelectorSchema, ScopeText, windowUnits } from "./text.js";
import { pipelineTool, T } from "./tooling.js";
import { loadPipelineView, measureView } from "./view.js";

/**
 * Opening (kept from the old chain, design 5.1): the evidence-backed initial
 * world at the first scene — who is there, where everyone stands, and the
 * reader setup. Built through the same proposal path as every artifact.
 */
const citation = z.union([spanSelectorSchema, extentSelectorSchema]);
const openingInput = z.object({
  readerSetup: z.string().trim().min(1).max(2_000).optional(),
  presence: z.array(z.object({ entity: idSchema, mode: participantPresenceModeSchema }).strict()).min(1).max(64),
  positions: z.array(z.object({ entity: idSchema, location: idSchema }).strict()).max(64).default([]),
  operations: z.array(stateOperationSchema).max(64).default([]),
  evidence: z.array(citation).min(1).max(16),
  readerContext: z.unknown().optional(),
}).strict();

export const openingStage: StageDefinition = {
  stage: "opening",
  plan(ctx, view) {
    const first = view.bundle.canonical.sceneOccurrences.flatMap((scene) => scene.evidence.map((item) => item.span.endByte ?? 0)).sort((a, b) => a - b)[0];
    return [{ id: `opening-${ctx.sourceId}`, range: { startByte: 0, endByte: Math.min(ctx.limit, first ?? ctx.limit) }, items: [], title: "opening checkpoint" }];
  },
  prompt(ctx, view, scope, previous) {
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    return [
      "Opening checkpoint: compile the initial world as it stands when the first scene begins. Who is present and how (physical, remote, mentioned…), where each present character is, any state the text establishes, and a short reader setup that withholds later outcomes. Cite the text. Use propose_initial_world, then finish_scope.",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Entities:", ...view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}`),
      "--- opening text ---", text.render(),
    ].filter(Boolean).join("\n");
  },
  tools(ctx, scope) {
    return [pipelineTool({
      name: "propose_initial_world", label: "Propose initial world",
      description: "The initial world at the opening checkpoint: presence of characters, starting locations (positions), other state operations, reader setup, and citations.",
      parameters: Type.Object({ readerSetup: Type.Optional(Type.String()), presence: Type.Array(Type.Object({ entity: Type.String(), mode: Type.String() }, { additionalProperties: false })),
        positions: Type.Optional(Type.Array(Type.Object({ entity: Type.String(), location: Type.String() }, { additionalProperties: false }))), operations: Type.Optional(Type.Array(Type.Unknown())),
        evidence: Type.Array(Type.Union([T.span(), T.extent()])), readerContext: Type.Optional(Type.Unknown()) }, { additionalProperties: false }),
      input: openingInput,
      async execute(input) {
        const view = await loadPipelineView(ctx.root, ctx.sourceId);
        const entities = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
        for (const id of [...input.presence.map((item) => item.entity), ...input.positions.flatMap((item) => [item.entity, item.location])]) if (!entities.has(id)) throw new Error(`Unknown entity ${id}.`);
        const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, { startByte: 0, endByte: ctx.limit }));
        const evidence = input.evidence.map((item) => text.evidence("unit" in item ? text.span(item) : text.extent(item)));
        const payload = {
          version: 1, ...(input.readerSetup ? { readerSetup: input.readerSetup } : {}), ...(input.readerContext ? { readerContext: input.readerContext } : {}),
          participantPresence: input.presence.map((item) => ({ entityId: item.entity, mode: item.mode })),
          delta: { version: 1, operations: [...input.positions.map((item) => ({ op: "set" as const, entityId: item.entity, field: "character.location", value: item.location })), ...input.operations] },
          evidence,
        };
        await submitCanonical(ctx, scope.id, "initial-world", payload, "pipeline-opening", buildAssertions(ctx, scope.id, text, "initial-world", payload, input.evidence, []));
        return { convergenceIssues: await convergeCanonical(ctx) };
      },
    })];
  },
  async commit(ctx) { return convergeCanonical(ctx); },
  gate(ctx, view) {
    const initial = view.bundle.canonical.initialWorld;
    const report = measureView(view, { startByte: 0, endByte: ctx.limit });
    const positions = report.measures.find((item) => item.id === "space.opening-positions")!;
    return gateOf([
      { id: "opening.initial-world", passed: initial.evidence.length > 0, detail: initial.evidence.length ? `${initial.delta.operations.length} operations` : "no evidence-backed initial world" },
      { id: "space.opening-positions", passed: positions.status === "satisfied", detail: `${positions.numerator}/${positions.total} (${positions.status})` },
    ]);
  },
};
