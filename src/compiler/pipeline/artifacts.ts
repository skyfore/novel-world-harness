import { Type } from "typebox";
import { z } from "zod";
import crypto from "node:crypto";
import { compilerProposalArtifactId, type CompilerProposalKind } from "../proposals.js";
import { evidenceAssertionSchema, type EvidenceAssertion } from "../../world/model.js";
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

const supportSchema = z.object({
  path: z.string().refine((value) => /^(?:\/(?:[^~/]|~[01])*)*$/u.test(value), "path must be a JSON Pointer into the payload ('' for the whole artifact)"),
  citations: z.array(citation).min(1).max(8),
  relation: z.enum(["supports", "contradicts", "contextualizes"]).default("supports"),
  strength: z.enum(["explicit", "strong-inference", "weak-inference"]).default("explicit"),
  interpretation: z.string().trim().min(1).max(1_000).optional(),
}).strict();
const artifactInput = z.object({
  items: z.array(z.object({ kind: z.enum(PIPELINE_ARTIFACT_KINDS), payload: z.record(z.string(), z.unknown()), evidence: z.array(citation).max(16).default([]), support: z.array(supportSchema).max(32).default([]) }).strict()).min(1).max(60),
}).strict();

/**
 * Exact evidence assertions for one proposal: each support entry binds cited
 * anchors to a payload path. With citations but no support, the whole
 * artifact is supported explicitly by them.
 */
export function buildAssertions(ctx: StageContext, scopeId: string, text: ScopeText, kind: string, payload: unknown, citations: readonly Citation[], support: readonly z.infer<typeof supportSchema>[]): EvidenceAssertion[] {
  const artifactId = compilerProposalArtifactId(kind as CompilerProposalKind, payload, "pending");
  const entries = support.length ? support : citations.length ? [{ path: "", citations: [...citations], relation: "supports" as const, strength: "explicit" as const }] : [];
  return entries.map((entry) => {
    const anchors = entry.citations.map((item) => text.anchor("unit" in item ? text.span(item) : text.extent(item)));
    return evidenceAssertionSchema.parse({
      version: 1, id: `ea-${crypto.createHash("sha256").update(`${kind}\u0000${artifactId}\u0000${entry.path}\u0000${JSON.stringify(anchors.map((anchor) => [anchor.startByte, anchor.endByte]))}`).digest("hex").slice(0, 20)}`,
      target: { artifactKind: kind, artifactId, jsonPointer: entry.path }, anchors, relation: entry.relation, strength: entry.strength,
      ...(entry.interpretation ? { interpretation: entry.interpretation } : entry.strength !== "explicit" ? { interpretation: "Inferred from the cited text." } : {}),
      derivation: { runId: ctx.runId, worker: `pipeline-${kind}`, compilerBatchId: scopeId, ...(ctx.generatedBy.provider ? { provider: ctx.generatedBy.provider } : {}), ...(ctx.generatedBy.model ? { model: ctx.generatedBy.model } : {}), ontologyVersion: "evidence-v1" },
    });
  });
}
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
  "characters.roster-modelled": ["not-stated"],
  // Reviewed exceptions for ratio measures: they close a gap-loop item, and the target's slack absorbs them.
  "observation.speech-attributed": ["unknown"],
  "events.typed-agent": ["not-stated"],
  "events.speech-in-beats": ["narration-only"],
  "time.anchored-events": ["not-stated"],
  "scenes.narrative-covered": ["narration-only"],
};

/** The subject kinds each disposable measure speaks about. */
const SUBJECT_KINDS: Record<string, readonly string[]> = {
  "events.effectful": ["event"], "relations.roster-pairs": ["pair"], "causality.conditioned-key-events": ["event"], "lore.terms-grounded": ["term"],
  "space.locations-on-graph": ["location"], "characters.speaking-modelled": ["actor"], "characters.speaking-with-disposition": ["actor"], "characters.speaking-with-goal": ["actor"],
  "agency.effectful-goals": ["actor"], "characters.roster-modelled": ["actor", "missing"], "observation.speech-attributed": ["speech"], "events.typed-agent": ["event"],
  "events.speech-in-beats": ["speech"], "time.anchored-events": ["event"], "scenes.narrative-covered": ["segment"],
};

/** A disposition must name a subject that exists: an unknown subject would silently close nothing. */
function checkSubject(view: Awaited<ReturnType<typeof loadPipelineView>>, measure: string, subject: string): void {
  const kind = subject.slice(0, subject.indexOf(":"));
  const value = subject.slice(subject.indexOf(":") + 1);
  if (!SUBJECT_KINDS[measure]?.includes(kind) || !value) throw new Error(`${measure} takes subjects ${SUBJECT_KINDS[measure]?.map((item) => `${item}:<…>`).join(" or ") ?? "(none)"}, not "${subject}".`);
  const entities = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
  if (kind === "event" && !view.bundle.canonical.events.some((event) => event.id === value)) throw new Error(`Unknown event ${value}.`);
  if (kind === "actor" && !entities.has(value)) throw new Error(`Unknown actor ${value}.`);
  if (kind === "location" && !entities.has(value)) throw new Error(`Unknown location ${value}.`);
  if (kind === "pair" && value.split("|").some((id) => !entities.has(id))) throw new Error(`Unknown actor in pair ${value}.`);
  if (kind === "segment" && !view.bundle.compilerSnapshot.annotations.some((item) => item.id === value && item.annotationType === "discourse-segment")) throw new Error(`Unknown discourse segment ${value}.`);
  if (kind === "speech" && !view.inventory.speech.some((span) => span.kind === "speech" && String(span.startByte) === value)) throw new Error(`No direct-speech span starts at byte ${value}; use the number from the speech:<start> or s<start> id.`);
  if (kind === "missing" && !view.roster?.review?.missing.some((item) => item.name === value)) throw new Error(`The roster review names no missing major "${value}".`);
}

export function artifactTools(ctx: StageContext, scope: ScopePlan, range = scope.range) {
  const text = async () => {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    return new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, range.endByte > range.startByte ? range : { startByte: 0, endByte: ctx.limit }));
  };
  return [
    pipelineTool({
      name: "propose_artifacts", label: "Propose canonical artifacts",
      description: `Propose canonical artifacts of kinds ${PIPELINE_ARTIFACT_KINDS.join(", ")}. Give the full payload as the ontology defines it, without evidence spans: put {"$evidence":[{unit,text}|{from,to}]} wherever the payload needs EvidenceRefs, or list citations in evidence for the top-level field. Exact support: citations also become evidence assertions on the whole artifact; give support [{path:"/clauses/0", citations, strength, interpretation}] to bind specific fields. The host validates and commits; failures come back per item.`,
      parameters: Type.Object({ items: Type.Array(Type.Object({ kind: Type.String(), payload: Type.Record(Type.String(), Type.Unknown()), evidence: Type.Optional(Type.Array(Type.Union([T.span(), T.extent()]))),
        support: Type.Optional(Type.Array(Type.Object({ path: Type.String(), citations: Type.Array(Type.Union([T.span(), T.extent()])), relation: Type.Optional(Type.String()), strength: Type.Optional(Type.String()), interpretation: Type.Optional(Type.String()) }, { additionalProperties: false }))) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: artifactInput,
      async execute(input) {
        const scopeText = await text();
        const result = await applyEach(input.items, async (item) => {
          const payload = bindEvidence(item.payload, scopeText, item.evidence);
          return submitCanonical(ctx, scope.id, item.kind, payload, `pipeline-${item.kind}`, buildAssertions(ctx, scope.id, scopeText, item.kind, payload, item.evidence, item.support));
        });
        const issues = result.applied.length ? await convergeCanonical(ctx) : [];
        return { proposed: result.applied.length, failed: result.failed, convergenceIssues: issues };
      },
    }),
    pipelineTool({
      name: "record_dispositions", label: "Record reviewed dispositions",
      description: `Record an explicit reviewed conclusion instead of an artifact, with its reason: ${Object.entries(DISPOSABLE).map(([measure, verdicts]) => `${measure} → ${verdicts.join("/")}`).join("; ")}. Subjects: event:<id>, pair:<a>|<b> (sorted ids), term:<surface>, location:<id>, actor:<id>, missing:<name>, speech:<start byte>, segment:<id>. Never use one to hide something the text states.`,
      parameters: Type.Object({ items: Type.Array(Type.Object({ measure: Type.String(), subject: Type.String(), verdict: Type.String(), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: dispositionInput,
      async execute(input) {
        const records: PipelineDisposition[] = [];
        const view = await loadPipelineView(ctx.root, ctx.sourceId);
        const result = await applyEach(input.items, async (item) => {
          const allowed = DISPOSABLE[item.measure];
          if (!allowed?.includes(item.verdict)) throw new Error(`${item.measure} does not accept "${item.verdict}"; allowed: ${allowed?.join(", ") ?? "none"}.`);
          checkSubject(view, item.measure, item.subject);
          const subject = item.subject.startsWith("pair:") ? `pair:${item.subject.slice(5).split("|").sort().join("|")}` : item.subject;
          records.push({ measureId: item.measure, subject, verdict: item.verdict, rationale: item.rationale, scopeId: scope.id });
          return `${item.measure} ${subject}`;
        });
        if (records.length) await ctx.store.recordDispositions(records);
        return { recorded: result.applied, failed: result.failed };
      },
    }),
  ];
}
