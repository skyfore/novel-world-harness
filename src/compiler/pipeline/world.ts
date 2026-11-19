import { Type } from "typebox";
import { z } from "zod";
import { CompilerProposalService } from "../proposals.js";
import type { WorldCompletenessReport } from "../world-completeness.js";
import { artifactTools } from "./artifacts.js";
import { convergeCanonical } from "./canon.js";
import { BASE_ACTION_SCHEMAS } from "./domain-modules.js";
import { convergeWorldProposals } from "../converge.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import { extentSelectorSchema, ScopeText, windowUnits } from "./text.js";
import { pipelineTool } from "./tooling.js";
import { identityTools } from "./identity.js";
import { observationTools } from "./observation.js";
import { loadPipelineView, measureView, type PipelineView } from "./view.js";

/**
 * World (design 5.6): whole-source and selective. The host derives work items
 * from the content contract's denominators; the model answers each with an
 * artifact or a reviewed "not stated". A scope completes when every item it
 * holds has left its measure's queue.
 */
export type WorldItemKind = "lore" | "location" | "pair" | "actor" | "roster" | "key-event" | "autonomy" | "knowledge";
const ITEMS_PER_SCOPE = 12;

/** Open work items, keyed `<kind>:<subject>`, from one completeness report. */
export function worldWorkItems(report: WorldCompletenessReport): string[] {
  const actorGaps = report.speakingCharacters.filter((item) => !item.model || !item.depth || item.goals === 0 || item.effectfulGoals === 0).map((item) => `actor:${item.actorId}`);
  const measure = (id: string) => report.measures.find((item) => item.id === id);
  // Characters dispositioned as "not stated" for every measure still count as open here only while a measure reports them.
  const openActors = actorGaps.filter((item) => ["characters.speaking-modelled", "characters.speaking-with-disposition", "characters.speaking-with-goal", "agency.effectful-goals"].some((id) => measure(id)?.status === "gap"));
  return [
    ...report.queues.ungroundedTerms.map((term) => `lore:${term.surface}`),
    ...report.queues.locationsOffGraph.map((id) => `location:${id}`),
    ...report.queues.rosterPairs.map((item) => item.subject.replace(/^pair:/u, "pair:")),
    ...openActors,
    // Reviewed and missing majors (design 5.7): a missing major stays open until it is an entity with a model and a goal, or reviewed "not stated".
    ...(measure("characters.roster-modelled")?.status === "gap" ? report.queues.rosterUnmodelled.map((item) => `roster:${item.subject}`) : []),
    ...report.queues.unconditionedKeyEvents.map((id) => `key-event:${id}`),
    ...(measure("possibility.autonomous-templates")?.status === "gap" ? ["autonomy:source"] : []),
    ...report.queues.unacquiredKnowledge.map((item) => `knowledge:${item.eventId}|${item.actorId}|${item.claimId}`),
  ];
}

/** Is a work item still open in this report? */
function stillOpen(report: WorldCompletenessReport, item: string, view: PipelineView): boolean {
  const [kind, subject] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
  const disposed = (measure: string, key: string) => view.dispositions.some((entry) => entry.measureId === measure && entry.subject === key);
  switch (kind) {
    case "lore": return report.queues.ungroundedTerms.some((term) => term.surface === subject);
    case "location": return report.queues.locationsOffGraph.includes(subject);
    case "pair": return report.queues.rosterPairs.some((entry) => entry.subject === `pair:${subject}`);
    case "actor": {
      const character = report.speakingCharacters.find((entry) => entry.actorId === subject);
      if (!character) return false;
      const done = (measure: string, ok: boolean) => ok || disposed(measure, `actor:${subject}`);
      return !(done("characters.speaking-modelled", character.model) && done("characters.speaking-with-disposition", character.depth)
        && done("characters.speaking-with-goal", character.goals > 0) && done("agency.effectful-goals", character.effectfulGoals > 0));
    }
    case "roster": return report.queues.rosterUnmodelled.some((entry) => entry.subject === subject) && report.measures.find((entry) => entry.id === "characters.roster-modelled")?.status === "gap";
    case "key-event": return report.queues.unconditionedKeyEvents.includes(subject);
    case "autonomy": return report.measures.find((entry) => entry.id === "possibility.autonomous-templates")?.status === "gap";
    case "knowledge": return report.queues.unacquiredKnowledge.some((entry) => `${entry.eventId}|${entry.actorId}|${entry.claimId}` === subject);
    default: return false;
  }
}

/** Install the host's base-action domain module once (same proposal and validation path as everything else). */
export async function installDomainModules(ctx: StageContext): Promise<void> {
  const view = await loadPipelineView(ctx.root, ctx.sourceId);
  const installed = new Set(view.bundle.canonical.actionSchemas.map((schema) => schema.id));
  const missing = BASE_ACTION_SCHEMAS.filter((schema) => !installed.has(schema.id));
  if (!missing.length) return;
  const service = new CompilerProposalService(ctx.root);
  for (const schema of missing) {
    await service.submit("action-schema", { proposalId: `domain-${schema.id}-v1`, payload: schema, generatedBy: { worker: "host-domain-module", compilerBatchId: `world-${ctx.sourceId}-domain` } })
      .catch((error: Error) => { if (!/already exists/u.test(error.message)) throw error; });
  }
  // Domain modules carry no source evidence, so converge across sources.
  await convergeWorldProposals(ctx.root);
}

const searchInput = z.object({ query: z.string().min(1).max(100), offset: z.number().int().nonnegative().optional() }).strict();
const readInput = extentSelectorSchema;

/** Whole-source reading tools for world scopes: search and bounded unit ranges, citable as {unit,text}. */
export function sourceReadingTools(ctx: StageContext) {
  const text = async () => {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    return new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, { startByte: 0, endByte: ctx.limit }));
  };
  return [
    pipelineTool({
      name: "search_source", label: "Search source", description: "Find units containing a string (20 per page). Units are citable as {unit,text}.",
      parameters: Type.Object({ query: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
      input: searchInput,
      async execute(input) {
        const units = (await text()).units.filter((unit) => unit.text.includes(input.query));
        const offset = input.offset ?? 0;
        return { total: units.length, units: units.slice(offset, offset + 20).map((unit) => ({ unit: unit.label, text: unit.text.slice(0, 400) })), ...(offset + 20 < units.length ? { nextOffset: offset + 20 } : {}) };
      },
    }),
    pipelineTool({
      name: "read_units", label: "Read units", description: "Read a unit range (at most 80 units).",
      parameters: Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: false }),
      input: readInput,
      async execute(input) {
        const scopeText = await text();
        const range = scopeText.extent(input);
        const units = scopeText.units.filter((unit) => unit.startByte >= range.startByte && unit.endByte <= range.endByte).slice(0, 80);
        return units.map((unit) => ({ unit: unit.label, text: unit.text }));
      },
    }),
  ];
}

function describeItem(view: PipelineView, report: WorldCompletenessReport, item: string): string {
  const [kind, subject] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
  const name = (id: string) => view.bundle.canonical.entities.find((entity) => entity.id === id)?.canonicalName ?? id;
  switch (kind) {
    case "lore": return `${item}: setting term "${subject}" (${report.queues.ungroundedTerms.find((term) => term.surface === subject)?.occurrences ?? "?"} occurrences). Ground it as a concept entity, world rule, action schema (source-statement or source-pattern induction), norm or process — or record_dispositions lore.terms-grounded term:${subject} narration-only.`;
    case "location": return `${item}: location ${name(subject)} is used by scenes or positions but has no spatial relation. Propose containment/adjacency/route spatial relations the text states, or record space.locations-on-graph location:${subject} unknown.`;
    case "pair": { const [a, b] = subject.split("|"); return `${item}: ${name(a!)} and ${name(b!)} share ${report.queues.rosterPairs.find((entry) => entry.subject === `pair:${subject}`)?.scenes ?? "?"} scenes. Propose a directed relation (proposition, or a character model's relationship stance), or record relations.roster-pairs pair:${subject} not-stated.`; }
    case "actor": { const entry = report.speakingCharacters.find((character) => character.actorId === subject); return `${item}: ${name(subject)} (${entry?.lines ?? 0} lines, ${entry?.scenes ?? 0} scenes; model ${entry?.model ? "yes" : "no"}, dispositions ${entry?.depth ? "yes" : "no"}, goals ${entry?.goals ?? 0}, state-changing goals ${entry?.effectfulGoals ?? 0}). Propose a character model with evidenced dispositions and goals whose candidate action changes state, or record not-stated per measure.`; }
    case "roster": {
      const slot = report.queues.rosterUnmodelled.find((entry) => entry.subject === subject);
      return slot?.actorId
        ? `${item}: roster major ${slot.name} needs a character model with evidenced dispositions and at least one goal whose candidate action changes state, or record characters.roster-modelled ${subject} not-stated.`
        : `${item}: the roster review names "${slot?.name ?? subject}" as a missing major. Annotate a mention of the name (propose_entity_mentions), create the character (propose_entities), then give it a model and a goal; or record characters.roster-modelled ${subject} not-stated if the text in range never presents this person.`;
    }
    case "key-event": { const event = view.bundle.canonical.events.find((entry) => entry.id === subject); return `${item}: key event "${event?.title ?? subject}". Give its preconditions or a typed causal relation (event-relation cause/enable/motivate), or record causality.conditioned-key-events event:${subject} unconditioned after review.`; }
    case "autonomy": return `${item}: no obligation, pressure or process stays in force after divergence. Propose at least one norm template, process template or possibility the text supports (a deadline, a duty, a pursuit, an institutional reaction).`;
    case "knowledge": { const [eventId, actorId, claimId] = subject.split("|"); return `${item}: ${name(actorId!)} learns ${claimId} in ${eventId} without an acquisition path. Propose an acquisition (observed / told / read / inferred) with its evidence.`; }
    default: return item;
  }
}

export const worldStage: StageDefinition = {
  stage: "world",
  plan(ctx, view) {
    const items = worldWorkItems(measureView(view, { startByte: 0, endByte: ctx.limit }));
    const byKind = new Map<string, string[]>();
    for (const item of items) byKind.set(item.slice(0, item.indexOf(":")), [...(byKind.get(item.slice(0, item.indexOf(":"))) ?? []), item]);
    const scopes: ScopePlan[] = [];
    for (const [kind, list] of byKind) for (let index = 0; index < list.length; index += ITEMS_PER_SCOPE) {
      const chunk = list.slice(index, index + ITEMS_PER_SCOPE);
      scopes.push({ id: `world-${ctx.sourceId}-${kind}-${String(index / ITEMS_PER_SCOPE).padStart(3, "0")}`, range: { startByte: 0, endByte: ctx.limit }, items: chunk, title: `${kind} items ${index + 1}-${index + chunk.length}` });
    }
    return scopes;
  },
  async prepare(ctx) { await installDomainModules(ctx); },
  prompt(ctx, view, scope, previous) {
    const report = measureView(view, { startByte: 0, endByte: ctx.limit });
    return [
      `World modelling, ${scope.title}. Answer every work item with an artifact (propose_artifacts) or a reviewed conclusion (record_dispositions). Cite source with {unit,text}; use search_source and read_units to find evidence. Only what the text states: "not stated" is a correct answer when the text is silent. Then call finish_scope.`,
      "Base actions speak / move / observe / give / take exist as host domain modules (base-action-*); propose source mechanisms only for capabilities the text states (source-statement induction, one cited statement) or shows repeatedly (source-pattern, at least two supporting events).",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Entities:", ...view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}`),
      "Events:", ...view.bundle.canonical.events.slice(0, 200).map((event) => `${event.id}: ${event.title}`),
      "Work items:", ...scope.items.map((item) => describeItem(view, report, item)),
    ].filter(Boolean).join("\n");
  },
  tools: (ctx, scope) => [...artifactTools(ctx, scope, { startByte: 0, endByte: ctx.limit }), ...sourceReadingTools(ctx),
    // Missing majors may need an entity first.
    ...(scope.items.some((item) => item.startsWith("roster:missing:")) ? [...observationTools(ctx, { ...scope, range: { startByte: 0, endByte: ctx.limit } }).filter((tool) => tool.name === "propose_entity_mentions"),
      ...identityTools(ctx, scope).filter((tool) => tool.name !== "decide_lexicon_entries")] : [])],
  async commit(ctx) { return convergeCanonical(ctx); },
  gate(ctx, view, scope) {
    const report = measureView(view, { startByte: 0, endByte: ctx.limit });
    const open = scope.items.filter((item) => stillOpen(report, item, view));
    return gateOf([{ id: "world.items-answered", passed: open.length === 0, detail: open.length ? `open: ${open.join(", ")}` : `${scope.items.length} items answered` }]);
  },
};
