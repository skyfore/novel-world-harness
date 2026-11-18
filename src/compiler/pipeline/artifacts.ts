import { Type } from "typebox";
import { z } from "zod";
import type { CompilerProposalKind } from "../proposals.js";
import { convergeCanonical, submitCanonical } from "./canon.js";
import type { ScopePlan, StageContext } from "./runner.js";
import { DISPOSITION_VERDICTS, type PipelineDisposition } from "./store.js";
import { extentSelectorSchema, spanSelectorSchema, ScopeText, windowUnits } from "./text.js";
import { applyEach, pipelineTool, T } from "./tooling.js";
import { loadPipelineView } from "./view.js";

/** Canonical kinds a pipeline scope may propose directly; the service and convergence validate each payload. */
export const PIPELINE_ARTIFACT_KINDS = [
  "entity", "proposition", "attribution", "claim", "event-relation", "spatial-relation", "semantic-effect", "perception-observation", "acquisition", "utterance-expression",
  "action-schema", "action-constraint", "norm-template", "process-template", "world-rule", "character-goal", "character-model", "possibility", "event-frame",
] as const satisfies readonly CompilerProposalKind[];

const citation = z.union([spanSelectorSchema, extentSelectorSchema]);
type Citation = z.infer<typeof citation>;

/**
 * Replace every `{ "$evidence": [citation…] }` placeholder in a payload with
 * host-built EvidenceRefs, and fill a missing top-level `evidence` from the
 * item's citations. The model never writes offsets or hashes.
 */
export function bindEvidence(payload: unknown, text: ScopeText, citations: readonly Citation[]): unknown {
  const resolve = (items: readonly Citation[]) => items.map((item) => text.evidence("unit" in item ? text.span(item) : text.extent(item)));
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ("$evidence" in record && Object.keys(record).length === 1) return resolve(z.array(citation).min(1).parse(record.$evidence));
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
  };
  const bound = visit(payload) as Record<string, unknown>;
  if (bound && typeof bound === "object" && !Array.isArray(bound) && !("evidence" in bound) && citations.length) bound.evidence = resolve(citations);
  return bound;
}

const artifactInput = z.object({
  items: z.array(z.object({ kind: z.enum(PIPELINE_ARTIFACT_KINDS), payload: z.record(z.string(), z.unknown()), evidence: z.array(citation).max(16).default([]) }).strict()).min(1).max(60),
}).strict();
const dispositionInput = z.object({
  items: z.array(z.object({ measure: z.string().min(1), subject: z.string().min(1).max(300), verdict: z.enum(DISPOSITION_VERDICTS), rationale: z.string().trim().min(1).max(1_000) }).strict()).min(1).max(200),
}).strict();

/** Measures a scope may close by a reviewed conclusion, with the verdicts each accepts. */
export const DISPOSABLE: Record<string, readonly PipelineDisposition["verdict"][]> = {
  "events.effectful": ["no-change"],
  "relations.roster-pairs": ["not-stated"],
  "causality.conditioned-key-events": ["unconditioned"],
  "lore.terms-grounded": ["narration-only"],
  "space.locations-on-graph": ["unknown", "not-stated"],
  "characters.speaking-modelled": ["not-stated"],
  "characters.speaking-with-disposition": ["not-stated"],
  "characters.speaking-with-goal": ["not-stated"],
  "agency.effectful-goals": ["not-stated"],
};

export function artifactTools(ctx: StageContext, scope: ScopePlan, range = scope.range) {
  const text = async () => {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    return new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, range.endByte > range.startByte ? range : { startByte: 0, endByte: ctx.limit }));
  };
  return [
    pipelineTool({
      name: "propose_artifacts", label: "Propose canonical artifacts",
      description: `Propose canonical artifacts of kinds ${PIPELINE_ARTIFACT_KINDS.join(", ")}. Give the full payload as the ontology defines it, without evidence spans: put {"$evidence":[{unit,text}|{from,to}]} wherever the payload needs EvidenceRefs, or list citations in evidence for the top-level field. The host validates and commits; failures come back per item.`,
      parameters: Type.Object({ items: Type.Array(Type.Object({ kind: Type.String(), payload: Type.Record(Type.String(), Type.Unknown()), evidence: Type.Optional(Type.Array(Type.Union([T.span(), T.extent()]))) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: artifactInput,
      async execute(input) {
        const scopeText = await text();
        const result = await applyEach(input.items, async (item) => submitCanonical(ctx, scope.id, item.kind, bindEvidence(item.payload, scopeText, item.evidence)));
        const issues = result.applied.length ? await convergeCanonical(ctx) : [];
        return { proposed: result.applied.length, failed: result.failed, convergenceIssues: issues };
      },
    }),
    pipelineTool({
      name: "record_dispositions", label: "Record reviewed dispositions",
      description: `Record an explicit reviewed conclusion instead of an artifact, with its reason: ${Object.entries(DISPOSABLE).map(([measure, verdicts]) => `${measure} → ${verdicts.join("/")}`).join("; ")}. Subjects: event:<id>, pair:<a>|<b> (sorted ids), term:<surface>, location:<id>, actor:<id>. Never use one to hide something the text states.`,
      parameters: Type.Object({ items: Type.Array(Type.Object({ measure: Type.String(), subject: Type.String(), verdict: Type.String(), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: dispositionInput,
      async execute(input) {
        const records: PipelineDisposition[] = [];
        const result = await applyEach(input.items, async (item) => {
          const allowed = DISPOSABLE[item.measure];
          if (!allowed?.includes(item.verdict)) throw new Error(`${item.measure} does not accept "${item.verdict}"; allowed: ${allowed?.join(", ") ?? "none"}.`);
          records.push({ measureId: item.measure, subject: item.subject, verdict: item.verdict, rationale: item.rationale, scopeId: scope.id });
          return `${item.measure} ${item.subject}`;
        });
        if (records.length) await ctx.store.recordDispositions(records);
        return { recorded: result.applied, failed: result.failed };
      },
    }),
  ];
}
