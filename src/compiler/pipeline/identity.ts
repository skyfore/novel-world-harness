import { Type } from "typebox";
import { z } from "zod";
import { CanonicalModelStore } from "../../world/canonical-model.js";
import { idSchema, type Entity, type EntityKind, type EvidenceRef } from "../../world/model.js";
import type { EntityMention } from "../annotations.js";
import { ENTITY_RESOLUTION_ONTOLOGY_VERSION, EntityResolutionStore, identityResolutionSchema, type IdentityResolution } from "../entity-resolution.js";
import { isGenericName, type ByteRange } from "../world-completeness.js";
import { convergeCanonical, submitCanonical } from "./canon.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import type { LexiconDecision } from "./store.js";
import { ScopeText, spanSelectorSchema, windowUnits } from "./text.js";
import { AnnotationWriter } from "./annotate.js";
import { applyEach, pipelineTool, stageOnce, T } from "./tooling.js";
import { ENTITY_CENSUS_CLASSES, loadPipelineView, measureView, type PipelineView } from "./view.js";
import { observationWindows } from "./observation.js";
import crypto from "node:crypto";

/**
 * Identity (design 5.4): one model decision per lexicon surface ("this surface
 * names X across the source, or within these ranges"), expanded by the host
 * into one resolution per proper-name mention (worker host-lexicon-v1). Only
 * same-name collisions, pronouns and titles, exceptions and ambiguous entries
 * need per-mention resolutions. Equal surfaces propose identity; they never
 * prove it, so every expansion cites the decision it came from.
 */
export const HOST_LEXICON_WORKER = "host-lexicon-v1";
const LEXICON_SCOPE = 60;

const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;
const within = (anchor: ByteRange, ranges?: readonly ByteRange[]) => !ranges?.length || ranges.some((range) => anchor.startByte >= range.startByte && anchor.endByte <= range.endByte);

type Snapshot = PipelineView["bundle"]["compilerSnapshot"];
const entityMentions = (snapshot: Snapshot) => snapshot.annotations.filter((item): item is EntityMention => item.annotationType === "entity-mention");

function resolution(ctx: StageContext, scopeId: string, mention: EntityMention, input: { status: IdentityResolution["status"]; entityId?: string; aliasType?: IdentityResolution["aliasType"]; rationale: string; worker: string; candidates?: string[] }): IdentityResolution {
  const candidates = (input.candidates ?? (input.entityId ? [input.entityId] : [])).map((entityId) => ({ entityId, confidence: entityId === input.entityId ? 0.9 : 0.5, basisMentionIds: [mention.id], evidenceAssertionIds: [], rationale: input.rationale }));
  return identityResolutionSchema.parse({
    version: 1, id: `res-${mention.id}`, sourceId: ctx.sourceId, mentionId: mention.id, status: input.status, ...(input.entityId ? { entityId: input.entityId } : {}),
    candidates: input.status === "non-referential" ? [] : candidates, ...(input.aliasType && ["resolved", "new-entity"].includes(input.status) ? { aliasType: input.aliasType } : {}),
    rationale: input.rationale, derivation: { runId: ctx.runId, worker: input.worker, compilerBatchId: scopeId, ...(ctx.generatedBy.provider ? { provider: ctx.generatedBy.provider } : {}),
      ...(ctx.generatedBy.model && input.worker !== HOST_LEXICON_WORKER ? { model: ctx.generatedBy.model } : {}), ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION },
  });
}

async function writeResolutions(ctx: StageContext, scopeId: string, items: readonly IdentityResolution[]): Promise<void> {
  if (!items.length) return;
  const store = new EntityResolutionStore(ctx.root);
  const current = new Map((await store.list(ctx.sourceId)).map((item) => [item.mentionId, item]));
  const changed = items.filter((item) => JSON.stringify(current.get(item.mentionId)) !== JSON.stringify(item));
  const ids: string[] = [];
  for (const item of changed) {
    ids.push(await stageOnce((id) => store.stage(ctx.sourceId, { version: 1, id, payload: item, generatedBy: { worker: item.derivation.worker, compilerBatchId: scopeId }, createdAt: new Date().toISOString() }),
      `pr-${crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`));
  }
  for (let index = 0; index < ids.length; index += 200) await store.commitProposals(ctx.sourceId, ids.slice(index, index + 200));
}

/**
 * Expand every lexicon decision into per-mention resolutions, and attach each
 * expanded surface to its entity's aliases. Mentions an earlier model
 * resolution already covers keep it unless the decision is the only source.
 */
export async function expandLexiconDecisions(ctx: StageContext, scopeId: string): Promise<{ resolutions: number; aliases: number }> {
  const view = await loadPipelineView(ctx.root, ctx.sourceId);
  const snapshot = view.bundle.compilerSnapshot;
  const current = new Map(snapshot.entityResolutions.map((item) => [item.mentionId, item]));
  const entities = new Map(view.bundle.canonical.entities.map((entity) => [entity.id, entity]));
  const bySurface = new Map<string, LexiconDecision[]>();
  for (const decision of view.decisions) bySurface.set(decision.surface, [...(bySurface.get(decision.surface) ?? []), decision]);
  const out: IdentityResolution[] = [];
  const aliasAdds = new Map<string, Set<string>>();
  for (const mention of entityMentions(snapshot)) {
    if (mention.form !== "proper" || mention.anchor.endByte > ctx.limit) continue;
    const decisions = (bySurface.get(mention.surface.trim()) ?? []).filter((decision) => within(mention.anchor, decision.ranges) && !decision.exceptMentionIds.includes(mention.id));
    if (decisions.length !== 1) continue;
    const existing = current.get(mention.id);
    if (existing && existing.derivation.worker !== HOST_LEXICON_WORKER) continue;
    const decision = decisions[0]!;
    const rationale = `Lexicon decision ${decision.id}: ${decision.rationale}`;
    if (decision.verdict === "entity") {
      const entity = entities.get(decision.entityId!);
      if (!entity) continue;
      out.push(resolution(ctx, scopeId, mention, { status: "resolved", entityId: entity.id, ...(decision.aliasType ? { aliasType: decision.aliasType } : {}), rationale, worker: HOST_LEXICON_WORKER }));
      const surface = mention.surface.trim();
      if (surface !== entity.canonicalName && !entity.aliases.includes(surface)) aliasAdds.set(entity.id, (aliasAdds.get(entity.id) ?? new Set()).add(surface));
    } else if (decision.verdict === "non-referential") {
      out.push(resolution(ctx, scopeId, mention, { status: "non-referential", rationale, worker: HOST_LEXICON_WORKER }));
    }
  }
  await writeResolutions(ctx, scopeId, out);
  for (const [entityId, surfaces] of aliasAdds) {
    const entity = entities.get(entityId)!;
    const added = nameEvidence(view, [...surfaces]);
    const known = new Set(entity.evidence.map((item) => `${item.span.startByte}-${item.span.endByte}`));
    await submitCanonical(ctx, scopeId, "entity", { ...entity, aliases: [...entity.aliases, ...surfaces],
      evidence: [...entity.evidence, ...added.evidence.filter((item) => !known.has(`${item.span.startByte}-${item.span.endByte}`))] } satisfies Entity, HOST_LEXICON_WORKER);
  }
  if (aliasAdds.size) await convergeCanonical(ctx);
  return { resolutions: out.length, aliases: [...aliasAdds.values()].reduce((total, set) => total + set.size, 0) };
}

const entityKinds = ["character", "location", "faction", "artifact", "institution", "relationship", "concept", "other"] as const;
const entityInput = z.object({
  items: z.array(z.object({ id: idSchema, kind: z.enum(entityKinds), canonicalName: z.string().trim().min(1).max(120), aliases: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
    label: spanSelectorSchema.optional().describe("Derived label for an unnamed person: a qualifying phrase copied from the text; canonicalName must equal it") }).strict()).min(1).max(80),
}).strict();
const decisionInput = z.object({
  items: z.array(z.object({ surface: z.string().trim().min(1).max(40), verdict: z.enum(["entity", "non-referential", "ambiguous"]), entity: idSchema.optional(),
    aliasType: z.enum(["name", "title", "office", "kinship", "nickname", "other"]).optional(), ranges: z.array(z.object({ from: z.string(), to: z.string() }).strict()).max(16).optional(),
    rationale: z.string().trim().min(1).max(1_000) }).strict()).min(1).max(LEXICON_SCOPE * 2),
}).strict();
const resolveInput = z.object({
  items: z.array(z.object({ mention: z.string().min(1), status: z.enum(["resolved", "non-referential", "ambiguous", "unresolved"]), entity: idSchema.optional(), candidates: z.array(idSchema).max(8).optional(),
    aliasType: z.enum(["name", "title", "office", "kinship", "nickname", "other"]).optional(), rationale: z.string().trim().min(1).max(1_000) }).strict()).min(1).max(200),
}).strict();

const anchorEvidence = (anchor: EntityMention["anchor"]): EvidenceRef => ({ span: { sourceId: anchor.sourceId, startByte: anchor.startByte, endByte: anchor.endByte, startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash }, strength: "explicit" });

/** Evidence for an entity: one mention per name (validation requires every name to occur in resolved evidence). */
function nameEvidence(view: PipelineView, names: readonly string[]): { evidence: EvidenceRef[]; mentions: EntityMention[]; missing: string[] } {
  const all = entityMentions(view.bundle.compilerSnapshot).sort((a, b) => a.anchor.startByte - b.anchor.startByte);
  const evidence: EvidenceRef[] = [], mentions: EntityMention[] = [], missing: string[] = [];
  for (const name of new Set(names)) {
    const mention = all.find((item) => item.surface.trim() === name);
    if (mention) { evidence.push(anchorEvidence(mention.anchor)); mentions.push(mention); } else missing.push(name);
  }
  return { evidence, mentions, missing };
}

/** Shared identity tools; the gap loop reuses them (design D3). */
export function identityTools(ctx: StageContext, scope: ScopePlan) {
  return [
    pipelineTool({
      name: "propose_entities", label: "Propose entities",
      description: "Create canonical entities (characters, locations, factions, artifacts, institutions, concepts). The canonical name and every alias must be names the text uses; the host cites the first annotated mention of each. An unnamed person gets a derived label: a qualifying phrase copied from the text (label: {unit,text}, e.g. \"穿风衣的男人\"), never a pronoun or bare noun.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String({ description: "Stable id, e.g. char-lin-qi, loc-bell-tower" }), kind: Type.String(), canonicalName: Type.String(), aliases: Type.Optional(Type.Array(Type.String())), label: Type.Optional(T.span()) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: entityInput,
      async execute(input) {
        const view = await loadPipelineView(ctx.root, ctx.sourceId);
        const existing = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
        const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, { startByte: 0, endByte: ctx.limit }));
        const result = await applyEach(input.items, async (item) => {
          if (existing.has(item.id)) throw new Error(`Entity ${item.id} exists; decide surfaces for it instead.`);
          if (isGenericName(item.canonicalName)) throw new Error(`"${item.canonicalName}" is a pronoun or bare noun; use the person's name, or a qualifying phrase from the text as a derived label.`);
          const label = item.label ? text.span(item.label) : undefined;
          if (label && text.text(label) !== item.canonicalName) throw new Error(`A derived label's canonicalName must equal its copied text "${text.text(label)}".`);
          const names = label ? item.aliases : [item.canonicalName, ...item.aliases];
          const found = nameEvidence(view, names);
          if (found.missing.length) throw new Error(`No annotated mention carries ${found.missing.join(", ")}; annotate it in observation (propose_entity_mentions) first, or drop the alias.`);
          // Every cited name is a resolved mention of the new entity: the label mention (created if needed) or the first mention of each name.
          const cited: EntityMention[] = [...found.mentions];
          if (label) {
            const writer = new AnnotationWriter(ctx, scope.id, text);
            const existingMention = entityMentions(view.bundle.compilerSnapshot).find((mention) => mention.anchor.startByte === label.startByte && mention.anchor.endByte === label.endByte);
            cited.unshift(existingMention ?? await writer.commit(writer.entityMention({ range: label, form: "nominal", kinds: [item.kind as EntityKind], worker: "pipeline-identity", interpretation: "Derived label for an unnamed person." })) as EntityMention);
          }
          if (!cited.length) throw new Error("An entity needs at least one cited name.");
          await writeResolutions(ctx, scope.id, cited.map((mention, index) => resolution(ctx, scope.id, mention, { status: index === 0 ? "new-entity" : "resolved", entityId: item.id,
            aliasType: "name", rationale: `Cited name of new entity ${item.id}.`, worker: "pipeline-identity" })));
          const evidence = cited.map((mention) => anchorEvidence(mention.anchor));
          return submitCanonical(ctx, scope.id, "entity", { id: item.id, kind: item.kind as EntityKind, canonicalName: item.canonicalName, aliases: item.aliases, evidence } satisfies Entity);
        });
        const issues = result.applied.length ? await convergeCanonical(ctx) : [];
        return { proposed: result.applied.length, failed: result.failed, convergenceIssues: issues };
      },
    }),
    pipelineTool({
      name: "decide_lexicon_entries", label: "Decide lexicon entries",
      description: "One identity decision per surface: verdict entity (with entity id and alias type), non-referential, or ambiguous (then resolve its mentions one by one). For two people sharing a name, give each decision its unit ranges. The host applies each decision to every proper-name mention of the surface.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ surface: Type.String(), verdict: Type.String(), entity: Type.Optional(Type.String()), aliasType: Type.Optional(Type.String()),
        ranges: Type.Optional(Type.Array(T.extent())), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: decisionInput,
      async execute(input) {
        const view = await loadPipelineView(ctx.root, ctx.sourceId);
        const entities = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
        const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, { startByte: 0, endByte: ctx.limit }));
        const decisions: LexiconDecision[] = [];
        const result = await applyEach(input.items, async (item) => {
          if (item.verdict === "entity" && (!item.entity || !entities.has(item.entity))) throw new Error(`Unknown entity ${item.entity ?? "(missing)"}; propose_entities first.`);
          const ranges = item.ranges?.map((range) => text.extent(range));
          const key = `${item.surface}\u0000${JSON.stringify(ranges ?? [])}`;
          decisions.push({ id: `lex-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`, surface: item.surface, verdict: item.verdict,
            ...(item.verdict === "entity" ? { entityId: item.entity } : {}), ...(item.aliasType ? { aliasType: item.aliasType } : {}), ...(ranges?.length ? { ranges } : {}),
            exceptMentionIds: [], rationale: item.rationale, scopeId: scope.id });
          return item.surface;
        });
        if (decisions.length) await ctx.store.recordLexiconDecisions(decisions);
        const expanded = await expandLexiconDecisions(ctx, scope.id);
        return { decided: result.applied, failed: result.failed, expanded };
      },
    }),
    pipelineTool({
      name: "resolve_mentions", label: "Resolve mentions",
      description: "Resolve individual entity mentions (pronouns, titles, nominal references, same-name collisions, exceptions): status resolved (entity id), non-referential (not a reference), ambiguous (two or more candidate ids), or unresolved. Always give a rationale.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ mention: Type.String(), status: Type.String(), entity: Type.Optional(Type.String()), candidates: Type.Optional(Type.Array(Type.String())),
        aliasType: Type.Optional(Type.String()), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: resolveInput,
      async execute(input) {
        const view = await loadPipelineView(ctx.root, ctx.sourceId);
        const mentions = new Map(entityMentions(view.bundle.compilerSnapshot).map((item) => [item.id, item]));
        const entities = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
        const out: IdentityResolution[] = [];
        const result = await applyEach(input.items, async (item) => {
          const mention = mentions.get(item.mention);
          if (!mention) throw new Error(`Unknown mention ${item.mention}.`);
          for (const id of [item.entity, ...(item.candidates ?? [])]) if (id && !entities.has(id)) throw new Error(`Unknown entity ${id}.`);
          if (item.status === "resolved" && !item.entity) throw new Error("A resolved mention names its entity.");
          out.push(resolution(ctx, scope.id, mention, { status: item.status, ...(item.status === "resolved" ? { entityId: item.entity! } : {}), ...(item.aliasType ? { aliasType: item.aliasType } : {}),
            rationale: item.rationale, worker: "pipeline-identity", ...(item.status === "ambiguous" ? { candidates: item.candidates ?? [] } : {}) }));
          return item.mention;
        });
        await writeResolutions(ctx, scope.id, out);
        return { resolved: result.applied, failed: result.failed };
      },
    }),
  ];
}

function lexiconSurfaces(view: PipelineView, ctx: StageContext) {
  return view.census.filter((entry) => ENTITY_CENSUS_CLASSES.has(entry.class) && entry.firstByte < ctx.limit && Array.from(entry.surface).length >= 2)
    .sort((a, b) => a.firstByte - b.firstByte || a.surface.localeCompare(b.surface));
}

export const identityStage: StageDefinition = {
  stage: "identity",
  async plan(ctx, view) {
    const surfaces = lexiconSurfaces(view, ctx);
    const scopes: ScopePlan[] = [];
    for (let index = 0; index < surfaces.length; index += LEXICON_SCOPE) {
      const items = surfaces.slice(index, index + LEXICON_SCOPE);
      scopes.push({ id: `identity-${ctx.sourceId}-lexicon-${String(index / LEXICON_SCOPE).padStart(3, "0")}`, range: { startByte: 0, endByte: ctx.limit }, items: items.map((item) => item.surface), title: `lexicon ${index + 1}-${index + items.length}` });
    }
    // Then per window: what lexicon decisions cannot cover.
    for (const window of await observationWindows(ctx, view)) scopes.push({ ...window, id: window.id.replace(/^observation-/u, "identity-"), title: `references in ${window.title}` });
    return scopes;
  },
  async prepare(ctx, scope) {
    if (!scope.items.length) await expandLexiconDecisions(ctx, scope.id);
  },
  prompt(ctx, view, scope, previous) {
    const failing = previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "";
    const entities = view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}${entity.aliases.length ? ` aka ${entity.aliases.join("/")}` : ""}`);
    if (scope.items.length) {
      const text = Buffer.from(view.bytes.buffer, view.bytes.byteOffset, Math.min(view.bytes.byteLength, ctx.limit)).toString("utf8");
      const context = (surface: string) => { const at = text.indexOf(surface); return text.slice(Math.max(0, at - 20), at + surface.length + 20).replace(/\s+/gu, " "); };
      const classes = new Map(view.census.map((entry) => [entry.surface, entry]));
      return [
        `Identity decisions for ${scope.title}. For every surface below: create the entity it names if it does not exist (propose_entities), then decide the surface (decide_lexicon_entries). Several surfaces may name one entity (full name, given name, nickname, title): give each its alias type. If two people share a surface, give one decision per person with unit ranges. Then call finish_scope.`,
        failing,
        "Existing entities:", ...(entities.length ? entities : ["(none)"]),
        "Surfaces (surface | class | occurrences | first context):",
        ...scope.items.map((surface) => `${surface} | ${classes.get(surface)?.class ?? "?"} | ${classes.get(surface)?.occurrences ?? 0} | …${context(surface)}…`),
      ].filter(Boolean).join("\n");
    }
    const units = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    const resolved = new Set(view.bundle.compilerSnapshot.entityResolutions.filter((item) => ["resolved", "new-entity", "non-referential", "misidentified"].includes(item.status)).map((item) => item.mentionId));
    const open = entityMentions(view.bundle.compilerSnapshot).filter((item) => overlaps(item.anchor, scope.range) && !resolved.has(item.id));
    return [
      `Resolve the remaining entity mentions in ${scope.title}: pronouns, titles, nominal references, same-name collisions and exceptions to lexicon decisions. Use resolve_mentions; propose_entities for anyone not yet an entity (an unnamed person gets a qualified derived label). Then call finish_scope.`,
      failing,
      "Entities:", ...(entities.length ? entities : ["(none)"]),
      `Unresolved mentions (${open.length}):`, ...open.slice(0, 200).map((item) => `${item.id} [${units.unitAt(item.anchor.startByte)?.label ?? "?"}] ${item.form} "${item.surface}"`),
      "--- scope text ---", units.render(),
    ].filter(Boolean).join("\n");
  },
  tools: (ctx, scope) => identityTools(ctx, scope),
  gate(ctx, view, scope) {
    if (scope.items.length) {
      const decided = new Set(view.decisions.map((item) => item.surface));
      const missing = scope.items.filter((surface) => !decided.has(surface));
      const report = measureView(view);
      const generic = report.measures.find((item) => item.id === "identity.generic-names")!;
      return gateOf([
        { id: "identity.surfaces-decided", passed: missing.length === 0, detail: missing.length ? `undecided: ${missing.slice(0, 20).join(", ")}` : `${scope.items.length} surfaces decided` },
        { id: "identity.generic-names", passed: generic.status === "satisfied", detail: `${generic.numerator} generic canonical names` },
      ]);
    }
    const report = measureView(view, scope.range);
    const byId = new Map(report.measures.map((item) => [item.id, item]));
    const check = (id: string) => {
      const item = byId.get(id)!;
      return { id, passed: item.status === "satisfied" || (item.status === "unknown" && item.total === 0), detail: `${item.numerator}/${item.total} (${item.status})${id === "identity.name-collisions" && report.queues.nameCollisions.length ? `: ${report.queues.nameCollisions.slice(0, 5).map((c) => c.surface).join(", ")}` : ""}` };
    };
    return gateOf([check("identity.mentions-resolved"), check("identity.aliases-attached"), check("identity.name-collisions"), check("identity.generic-names")]);
  },
};
