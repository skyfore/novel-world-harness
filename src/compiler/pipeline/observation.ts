import { Type } from "typebox";
import { z } from "zod";
import { eventMentionTypeSchema, type SourceAnnotation } from "../annotations.js";
import type { ByteRange } from "../world-completeness.js";
import { AnnotationWriter, HOST_LEXICAL_WORKER, KIND_FOR_CLASS, PIPELINE_OBSERVATION_WORKER, annotationId } from "./annotate.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import { sourceChapters } from "./source-stage.js";
import type { CandidateReview } from "./store.js";
import { extentSelectorSchema, spanSelectorSchema, ScopeText, unitLabel, windowUnits } from "./text.js";
import { applyEach, pipelineTool, T } from "./tooling.js";
import { censusKey, loadPipelineView, measureView, type PipelineView } from "./view.js";

/**
 * Observation (design 5.3): 16 KiB windows. The host pre-annotates every
 * direct-speech span and lexicon occurrence as a candidate; the model accepts,
 * rewrites or rejects each one and adds what the host cannot see (pronoun and
 * title references, indirect speech, event mentions, scene boundaries).
 */
export const OBSERVATION_WINDOW_BYTES = 16 * 1024;
const PAGE = 150;

export type ObservationCandidate = {
  id: string;
  kind: "speech" | "name";
  range: ByteRange;
  text: string;
  /** Speech: the host speaker cue (person lexicon occurrence). */
  cue?: { range: ByteRange; surface: string; rule: string };
  /** Name: census surface and class. */
  censusClass?: string;
};

const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;
const inside = (inner: ByteRange, outer: ByteRange) => inner.startByte >= outer.startByte && inner.endByte <= outer.endByte;

export function observationCandidates(view: PipelineView, range: ByteRange): ObservationCandidate[] {
  const decode = (item: ByteRange) => Buffer.from(view.bytes.buffer, view.bytes.byteOffset + item.startByte, item.endByte - item.startByte).toString("utf8");
  const cues = new Map(view.inventory.cues.map((cue) => [cue.speechStartByte, cue]));
  const classOf = new Map(view.census.map((entry) => [entry.surface, entry.class]));
  const result: ObservationCandidate[] = [];
  for (const span of view.inventory.speech) {
    if (span.kind !== "speech" || !inside(span, range)) continue;
    const cue = cues.get(span.startByte);
    const cueRange = cue ? { startByte: cue.cueStartByte, endByte: cue.cueEndByte } : undefined;
    result.push({ id: `s${span.startByte}`, kind: "speech", range: { startByte: span.startByte, endByte: span.endByte }, text: decode(span),
      ...(cue && cueRange ? { cue: { range: cueRange, surface: decode(cueRange), rule: cue.rule } } : {}) });
  }
  for (const occurrence of view.inventory.occurrences) {
    if (!inside(occurrence, range)) continue;
    const surface = decode(occurrence);
    result.push({ id: `n${occurrence.startByte}`, kind: "name", range: { startByte: occurrence.startByte, endByte: occurrence.endByte }, text: surface, censusClass: classOf.get(surface) ?? "person" });
  }
  return result.sort((a, b) => a.range.startByte - b.range.startByte || a.kind.localeCompare(b.kind));
}

/** Candidates neither reviewed nor already covered by a matching annotation. */
export function openCandidates(view: PipelineView, range: ByteRange): ObservationCandidate[] {
  const reviewed = new Set(view.reviews.map((item) => item.candidateId));
  const annotations = view.bundle.compilerSnapshot.annotations;
  const quotations = annotations.filter((item) => item.annotationType === "quotation").map((item) => item.anchor);
  const mentions = annotations.filter((item) => item.annotationType === "entity-mention").map((item) => item.anchor);
  return observationCandidates(view, range).filter((item) => !reviewed.has(item.id)
    && !(item.kind === "speech" ? quotations : mentions).some((anchor) => overlaps(anchor, item.range)));
}

export async function observationWindows(ctx: StageContext, view: PipelineView): Promise<ScopePlan[]> {
  const chapters = (await sourceChapters(ctx.root, ctx.sourceId)).filter((chapter) => chapter.startByte < ctx.limit);
  const scopes: ScopePlan[] = [];
  for (const chapter of chapters) {
    const units = windowUnits(view.structure, view.bytes, { startByte: chapter.startByte, endByte: Math.min(chapter.endByte, ctx.limit) });
    let current: typeof units = [];
    const flush = () => {
      if (!current.length) return;
      const first = current[0]!, last = current.at(-1)!;
      scopes.push({ id: `observation-${ctx.sourceId}-${first.label}`, range: { startByte: first.startByte, endByte: last.endByte }, items: [], title: `${chapter.title ?? `chapter ${chapter.ordinal}`} ${first.label}..${last.label}` });
      current = [];
    };
    for (const unit of units) {
      if (current.length && unit.endByte - current[0]!.startByte > OBSERVATION_WINDOW_BYTES) flush();
      current.push(unit);
    }
    flush();
  }
  return scopes;
}

const speakerSchema = z.union([spanSelectorSchema.extend({ form: z.enum(["proper", "nominal", "pronoun", "title", "kinship", "collective"]).optional() }).strict(), z.object({ mention: z.string().min(1) }).strict(), z.literal("cue")]);
const reviewInput = z.object({
  items: z.array(z.object({
    id: z.string().regex(/^[sn]\d+$/u),
    verdict: z.enum(["accept", "rewrite", "reject"]),
    rationale: z.string().trim().min(1).max(500).optional(),
    span: spanSelectorSchema.optional(),
    speaker: speakerSchema.optional(),
    mode: z.enum(["direct", "indirect", "free-indirect"]).optional(),
    form: z.enum(["proper", "nominal", "title", "kinship", "collective"]).optional(),
    kinds: z.array(z.enum(["character", "location", "faction", "artifact", "institution", "relationship", "concept", "other"])).min(1).max(4).optional(),
  }).strict()).min(1).max(PAGE),
}).strict();
const mentionInput = z.object({
  items: z.array(z.object({ span: spanSelectorSchema, form: z.enum(["proper", "nominal", "pronoun", "title", "kinship", "collective"]),
    kinds: z.array(z.enum(["character", "location", "faction", "artifact", "institution", "relationship", "concept", "other"])).min(1).max(4), interpretation: z.string().trim().min(1).max(500).optional() }).strict()).min(1).max(PAGE),
}).strict();
const quotationInput = z.object({
  items: z.array(z.object({ span: spanSelectorSchema, mode: z.enum(["direct", "indirect", "free-indirect"]), speaker: speakerSchema.optional(), interpretation: z.string().trim().min(1).max(500).optional() }).strict()).min(1).max(PAGE),
}).strict();
const eventInput = z.object({
  items: z.array(z.object({ trigger: spanSelectorSchema, extent: extentSelectorSchema, types: z.array(eventMentionTypeSchema).min(1).max(4),
    salience: z.enum(["major", "supporting", "minor"]), participants: z.array(z.string().min(1)).max(16).default([]), interpretation: z.string().trim().min(1).max(500).optional() }).strict()).min(1).max(PAGE),
}).strict();
const discourseInput = z.object({
  items: z.array(z.object({ extent: extentSelectorSchema, kind: z.enum(["scene", "summary", "flashback", "flashforward", "frame", "recollection", "hypothetical", "dream", "embedded-document", "narrator-commentary", "unclassified"]),
    interpretation: z.string().trim().min(1).max(500).optional() }).strict()).min(1).max(64),
}).strict();
const accountInput = z.object({
  items: z.array(z.object({ unit: z.string(), status: z.enum(["background-only", "duplicate-description", "paratext"]), rationale: z.string().trim().min(1).max(500) }).strict()).min(1).max(PAGE),
}).strict();

const speakerT = () => Type.Union([Type.Object({ unit: Type.String(), text: Type.String(), nth: Type.Optional(Type.Integer({ minimum: 1 })), form: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ mention: Type.String() }, { additionalProperties: false }), Type.Literal("cue")]);
const kindsT = () => Type.Array(Type.String({ description: "character | location | faction | artifact | institution | relationship | concept | other" }));

/** Shared observation tools: the gap loop reuses them in any scope (design D3). */
export function observationTools(ctx: StageContext, scope: ScopePlan) {
  const load = async () => {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    return { view, text, writer: new AnnotationWriter(ctx, scope.id, text) };
  };
  const mentionAt = (view: PipelineView, range: ByteRange) => view.bundle.compilerSnapshot.annotations.find((item) => item.annotationType === "entity-mention" && item.anchor.startByte === range.startByte && item.anchor.endByte === range.endByte);
  const isCensusPerson = (view: PipelineView, surface: string) => view.census.some((entry) => entry.surface === surface && entry.class === "person");
  /** Resolve a speaker reference to an entity-mention id, creating the mention when the model cites new text. */
  const speakerMention = async (state: Awaited<ReturnType<typeof load>>, speaker: z.infer<typeof speakerSchema> | undefined, cue?: ObservationCandidate["cue"]): Promise<string | undefined> => {
    if (!speaker) return undefined;
    if (speaker === "cue") {
      if (!cue) throw new Error("This candidate has no host speaker cue; cite the speaker text instead.");
      const existing = mentionAt(state.view, cue.range);
      if (existing) return existing.id;
      return (await state.writer.commit(state.writer.entityMention({ range: cue.range, form: "proper", kinds: ["character"], worker: HOST_LEXICAL_WORKER }))).id;
    }
    if ("mention" in speaker) {
      if (!state.view.bundle.compilerSnapshot.annotations.some((item) => item.id === speaker.mention && item.annotationType === "entity-mention")) throw new Error(`Unknown entity mention ${speaker.mention}; use list_window_annotations.`);
      return speaker.mention;
    }
    const range = state.text.span(speaker);
    const existing = mentionAt(state.view, range);
    if (existing) return existing.id;
    const form = speaker.form ?? (isCensusPerson(state.view, state.text.text(range)) ? "proper" : undefined);
    if (!form) throw new Error(`Give a form (proper, nominal, pronoun, title, kinship, collective) for speaker "${speaker.text}".`);
    return (await state.writer.commit(state.writer.entityMention({ range, form, kinds: ["character"], worker: PIPELINE_OBSERVATION_WORKER }))).id;
  };
  return [
    pipelineTool({
      name: "list_open_candidates", label: "List open candidates",
      description: "Host candidates in this scope not yet reviewed or covered: direct speech (id s…) with any host speaker cue, and lexicon name occurrences (id n…).",
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
      input: z.object({ offset: z.number().int().nonnegative().optional() }).strict(),
      async execute(input) {
        const { view, text } = await load();
        const open = openCandidates(view, scope.range);
        const offset = input.offset ?? 0;
        return { total: open.length, candidates: open.slice(offset, offset + PAGE).map((item) => ({ id: item.id, kind: item.kind, unit: text.unitAt(item.range.startByte)?.label, text: item.text.slice(0, 300),
          ...(item.cue ? { cue: item.cue.surface, cueRule: item.cue.rule } : {}), ...(item.censusClass ? { class: item.censusClass } : {}) })), ...(offset + PAGE < open.length ? { nextOffset: offset + PAGE } : {}) };
      },
    }),
    pipelineTool({
      name: "list_window_annotations", label: "List scope annotations",
      description: "Current annotations in this scope: ids, types, text, speakers. Use ids as speaker mentions or event participants.",
      parameters: Type.Object({ type: Type.Optional(Type.String()) }, { additionalProperties: false }),
      input: z.object({ type: z.enum(["entity-mention", "quotation", "event-mention", "discourse-segment"]).optional() }).strict(),
      async execute(input) {
        const { view, text } = await load();
        const anchorOf = (item: SourceAnnotation) => item.annotationType === "event-mention" ? item.triggerAnchor : item.annotationType === "discourse-segment" ? item.anchors[0]! : item.anchor;
        return view.bundle.compilerSnapshot.annotations.filter((item) => (!input.type || item.annotationType === input.type) && overlaps(anchorOf(item), scope.range)).slice(0, 400).map((item) => ({
          id: item.id, type: item.annotationType, unit: text.unitAt(anchorOf(item).startByte)?.label, text: text.text(anchorOf(item)).slice(0, 120),
          ...(item.annotationType === "quotation" && item.speakerMentionId ? { speaker: item.speakerMentionId } : {}),
          ...(item.annotationType === "entity-mention" ? { form: item.form, kinds: item.kindCandidates } : {}),
        }));
      },
    }),
    pipelineTool({
      name: "review_observation_candidates", label: "Review observation candidates",
      description: "Accept, rewrite or reject host candidates by id. Speech: give speaker as {unit,text[,form]}, {mention:id} or \"cue\" (the host cue), and mode (default direct). Names: optionally kinds/form. Rewrite: give the corrected span. Reject: give a rationale (e.g. a quoted term, not speech; an ordinary word, not this name).",
      parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), verdict: Type.Union([Type.Literal("accept"), Type.Literal("rewrite"), Type.Literal("reject")]), rationale: Type.Optional(T.rationale()),
        span: Type.Optional(T.span()), speaker: Type.Optional(speakerT()), mode: Type.Optional(Type.String()), form: Type.Optional(Type.String()), kinds: Type.Optional(kindsT()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: reviewInput,
      async execute(input) {
        const state = await load();
        const byId = new Map(observationCandidates(state.view, scope.range).map((item) => [item.id, item]));
        const reviews: CandidateReview[] = [];
        const result = await applyEach(input.items, async (item) => {
          const candidate = byId.get(item.id);
          if (!candidate) throw new Error(`Unknown candidate ${item.id} in this scope; use list_open_candidates.`);
          if (item.verdict === "reject") {
            if (!item.rationale) throw new Error("A rejection needs a rationale.");
            reviews.push({ candidateId: candidate.id, kind: candidate.kind, range: candidate.range, verdict: "rejected", rationale: item.rationale, scopeId: scope.id });
            return { id: candidate.id, verdict: "rejected" };
          }
          const range = item.verdict === "rewrite" ? (item.span ? state.text.span(item.span) : (() => { throw new Error("A rewrite gives the corrected span."); })()) : candidate.range;
          const worker = item.verdict === "accept" ? HOST_LEXICAL_WORKER : PIPELINE_OBSERVATION_WORKER;
          let annotation: SourceAnnotation;
          if (candidate.kind === "speech") {
            const speakerMentionId = await speakerMention(state, item.speaker, candidate.cue);
            annotation = await state.writer.commit(state.writer.quotation({ range, mode: item.mode ?? "direct", ...(speakerMentionId ? { speakerMentionId } : {}),
              ...(item.speaker === "cue" && candidate.cue ? { cue: candidate.cue.range } : {}), worker, ...(item.mode && item.mode !== "direct" ? { interpretation: item.rationale ?? "Indirect discourse." } : {}) }));
          } else {
            const kinds = item.kinds ?? KIND_FOR_CLASS[(candidate.censusClass ?? "person") as keyof typeof KIND_FOR_CLASS];
            const existing = mentionAt(state.view, range);
            annotation = existing ?? await state.writer.commit(state.writer.entityMention({ range, form: item.form ?? "proper", kinds, worker }));
          }
          reviews.push({ candidateId: candidate.id, kind: candidate.kind, range: candidate.range, verdict: item.verdict === "accept" ? "accepted" : "rewritten", annotationId: annotation.id, ...(item.rationale ? { rationale: item.rationale } : {}), scopeId: scope.id });
          return { id: candidate.id, annotationId: annotation.id };
        });
        if (reviews.length) await ctx.store.recordCandidateReviews(reviews);
        return { reviewed: result.applied, failed: result.failed, open: openCandidates(await loadPipelineView(ctx.root, ctx.sourceId), scope.range).length };
      },
    }),
    pipelineTool({
      name: "propose_entity_mentions", label: "Propose entity mentions",
      description: "Add entity mentions the host could not find: pronouns and titles that refer to a person (at least for speakers and event agents), nominal references, unnamed people, places and objects.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ span: T.span(), form: Type.String(), kinds: kindsT(), interpretation: Type.Optional(T.rationale()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: mentionInput,
      async execute(input) {
        const state = await load();
        const result = await applyEach(input.items, async (item) => (await state.writer.commit(state.writer.entityMention({ range: state.text.span(item.span), form: item.form, kinds: item.kinds,
          worker: PIPELINE_OBSERVATION_WORKER, ...(item.interpretation ? { interpretation: item.interpretation } : {}) }))).id);
        return { created: result.applied, failed: result.failed };
      },
    }),
    pipelineTool({
      name: "propose_quotations", label: "Propose quotations",
      description: "Add discourse the host did not find: indirect and free-indirect speech (needs an interpretation), or direct speech in an unusual convention.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ span: T.span(), mode: Type.String(), speaker: Type.Optional(speakerT()), interpretation: Type.Optional(T.rationale()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: quotationInput,
      async execute(input) {
        const state = await load();
        const result = await applyEach(input.items, async (item) => {
          const speakerMentionId = await speakerMention(state, item.speaker);
          return (await state.writer.commit(state.writer.quotation({ range: state.text.span(item.span), mode: item.mode, ...(speakerMentionId ? { speakerMentionId } : {}), worker: PIPELINE_OBSERVATION_WORKER,
            ...(item.interpretation ? { interpretation: item.interpretation } : {}) }))).id;
        });
        return { created: result.applied, failed: result.failed };
      },
    }),
    pipelineTool({
      name: "propose_event_mentions", label: "Propose event mentions",
      description: "Add event mentions: a trigger span, the extent (first..last unit), event types, salience, and participant entity-mention ids. Mark story-advancing events major.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ trigger: T.span(), extent: T.extent(), types: Type.Array(Type.String()), salience: Type.String(), participants: Type.Optional(Type.Array(Type.String())), interpretation: Type.Optional(T.rationale()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: eventInput,
      async execute(input) {
        const state = await load();
        const mentionIds = new Set(state.view.bundle.compilerSnapshot.annotations.filter((item) => item.annotationType === "entity-mention").map((item) => item.id));
        const result = await applyEach(input.items, async (item) => {
          const missing = item.participants.filter((id) => !mentionIds.has(id));
          if (missing.length) throw new Error(`Unknown participant mentions ${missing.join(", ")}; propose or look up the mentions first.`);
          return (await state.writer.commit(state.writer.eventMention({ trigger: state.text.span(item.trigger), extents: [state.text.extent(item.extent)], types: item.types,
            participantMentionIds: item.participants, salience: item.salience, ...(item.interpretation ? { interpretation: item.interpretation } : {}) }))).id;
        });
        return { created: result.applied, failed: result.failed };
      },
    }),
    pipelineTool({
      name: "propose_discourse_segments", label: "Propose discourse segments",
      description: "Mark discourse segments (first..last unit): scenes, summaries, flashbacks, narrator commentary and so on. Every narrative unit in the scope must belong to one.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ extent: T.extent(), kind: Type.String(), interpretation: Type.Optional(T.rationale()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: discourseInput,
      async execute(input) {
        const state = await load();
        const result = await applyEach(input.items, async (item) => (await state.writer.commit(state.writer.discourse({ extents: [state.text.extent(item.extent)], kind: item.kind,
          ...(item.interpretation ? { interpretation: item.interpretation } : { ...(item.kind === "unclassified" ? { interpretation: "Boundary unresolved." } : {}) }) }))).id);
        return { created: result.applied, failed: result.failed };
      },
    }),
    pipelineTool({
      name: "account_units", label: "Account units",
      description: "Close units that carry no annotation: background-only, duplicate-description or paratext, with a reason. A unit holding a speech or name candidate that is not rejected cannot be closed this way; annotate it instead.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ unit: Type.String(), status: Type.String(), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: accountInput,
      async execute(input) {
        const state = await load();
        const rejected = new Set(state.view.reviews.filter((item) => item.verdict === "rejected").map((item) => item.candidateId));
        const candidates = observationCandidates(state.view, scope.range);
        const result = await applyEach(input.items, async (item) => {
          const unit = state.text.unit(item.unit);
          const holding = candidates.filter((candidate) => overlaps(candidate.range, unit) && !rejected.has(candidate.id));
          if (holding.length) throw new Error(`${item.unit} holds ${holding.length} candidate(s) (${holding.slice(0, 5).map((candidate) => candidate.id).join(", ")}); review them instead of closing the unit.`);
          await ctx.store.recordUnitAccounts([{ unitId: unit.unitId, status: item.status, rationale: item.rationale, scopeId: scope.id }]);
          return item.unit;
        });
        return { accounted: result.applied, failed: result.failed };
      },
    }),
  ];
}

/** Narrative units in range not covered by a discourse segment. */
export function uncoveredByDiscourse(view: PipelineView, range: ByteRange): string[] {
  const segments = view.bundle.compilerSnapshot.annotations.flatMap((item) => item.annotationType === "discourse-segment" ? item.anchors : []);
  const paratext = new Set(view.accounts.filter((item) => item.status === "paratext").map((item) => item.unitId));
  return windowUnits(view.structure, view.bytes, range).filter((unit) => unit.narrative && unit.text.trim() && !paratext.has(unit.unitId) && !segments.some((anchor) => overlaps(anchor, unit))).map((unit) => unit.label);
}

export const observationStage: StageDefinition = {
  stage: "observation",
  plan: observationWindows,
  prompt(ctx, view, scope, previous) {
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    const open = openCandidates(view, scope.range);
    const times = view.inventory.times.filter((item) => inside(item, scope.range));
    return [
      `Observation for ${scope.title}. The scope text is below, one base unit per line.`,
      "1. Review every host candidate with review_observation_candidates: direct speech (id s…) needs its speaker whenever the text lets you tell (use \"cue\" when the host cue is right); name occurrences (id n…) are accepted unless the surface is not that name here.",
      "2. Add what the host cannot find: propose_entity_mentions for pronouns, titles and unnamed people who speak or act; propose_quotations for indirect speech; propose_event_mentions for every event (mark story-advancing ones major); propose_discourse_segments so every unit belongs to a segment.",
      "3. Close units with no content worth annotating with account_units. Then call finish_scope; fix whatever it reports.",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      `Open candidates: ${open.length} (first ${Math.min(open.length, PAGE)} below; page with list_open_candidates).`,
      ...open.slice(0, PAGE).map((item) => `${item.id} ${item.kind} [${text.unitAt(item.range.startByte)?.label ?? "?"}] ${item.text.slice(0, 80)}${item.cue ? ` (cue: ${item.cue.surface})` : ""}`),
      times.length ? `Explicit time expressions (for later scene timing): ${times.slice(0, 40).map((item) => `${item.surface}@${text.unitAt(item.startByte)?.label ?? "?"}`).join(", ")}` : "",
      "--- scope text ---",
      text.render(),
    ].filter(Boolean).join("\n");
  },
  tools: (ctx, scope) => observationTools(ctx, scope),
  gate(_ctx, view, scope) {
    const report = measureView(view, scope.range);
    const byId = new Map(report.measures.map((item) => [item.id, item]));
    const check = (id: string, satisfied: (status: string) => boolean = (status) => status === "satisfied" || status === "unknown" && (byId.get(id)?.total ?? 0) === 0) => {
      const item = byId.get(id)!;
      return { id, passed: satisfied(item.status), detail: `${item.numerator}/${item.total} (${item.status})` };
    };
    const uncovered = uncoveredByDiscourse(view, scope.range);
    const open = openCandidates(view, scope.range);
    return gateOf([
      { id: "observation.candidates-reviewed", passed: open.length === 0, detail: `${open.length} host candidates open${open.length ? `: ${open.slice(0, 10).map((item) => item.id).join(", ")}` : ""}` },
      check("observation.speech-annotated"),
      check("observation.names-annotated"),
      check("source.hidden-units"),
      check("source.blocking-units"),
      { id: "observation.units-in-segments", passed: uncovered.length === 0, detail: uncovered.length ? `units outside every discourse segment: ${uncovered.slice(0, 20).join(", ")}` : "all units segmented" },
    ]);
  },
};

export { annotationId, censusKey, unitLabel };
