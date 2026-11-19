import { ActorModelStore } from "../../world/actors.js";
import { CanonicalModelStore } from "../../world/canonical-model.js";
import { InitialWorldStore } from "../../world/initial.js";
import { PossibilityTemplateStore } from "../../world/possibility-model.js";
import type { EvidenceRef } from "../../world/model.js";
import { readSourceMaterial } from "../../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../../storage/workspace-store.js";
import { SourceAnnotationStore } from "../annotations.js";
import { EntityResolutionStore } from "../entity-resolution.js";
import { EventResolutionStore } from "../event-resolution.js";
import { buildCharacterLexicon, buildLexicalInventory, type CharacterLexicon, type LexicalInventory } from "../lexical-inventory.js";
import type { PreparedNovelBundle } from "../prepared-cache.js";
import { SourceStructureStore, baseStructuralUnits, type SourceStructureManifest } from "../structure.js";
import type { SourceAccountingManifest } from "../source-accounting.js";
import { measureWorldCompleteness, type ByteRange, type CompileUsage, type LoreTerm, type RosterSummary, type WorldCompletenessOptions, type WorldCompletenessReport } from "../world-completeness.js";
import { PipelineStore, type CandidateReview, type CensusEntry, type LexiconDecision, type PipelineDisposition, type RosterDocument, type ScopeReceipt, type UnitAccount } from "./store.js";

/** Census classes that name something a mention can refer to. */
export const ENTITY_CENSUS_CLASSES = new Set(["person", "location", "organization", "object", "lore"]);
export const censusKey = (surface: string) => `census:${surface}`;

/**
 * The pipeline's working view of one source: current stores assembled into the
 * shape the completeness measures read. Gates, status and the gap loop all
 * measure this view, so a scope cannot pass a gate the report would fail.
 */
export type PipelineView = {
  accounting: SourceAccountingManifest;
  source: SourceDocument;
  bytes: Uint8Array;
  structure: SourceStructureManifest;
  bundle: PreparedNovelBundle;
  inventory: LexicalInventory;
  census: CensusEntry[];
  decisions: LexiconDecision[];
  dispositions: PipelineDisposition[];
  reviews: CandidateReview[];
  accounts: UnitAccount[];
  roster: RosterDocument | null;
  receipts: ScopeReceipt[];
  options: WorldCompletenessOptions;
};

/**
 * Lexicon from the census: every entity-class surface, keyed by the entity its
 * whole-source identity decision names once identity has run, else by its
 * census key. Person surfaces alone drive speaker cues.
 */
export function censusLexicons(census: readonly CensusEntry[], decisions: readonly LexiconDecision[]): { names: CharacterLexicon; persons: CharacterLexicon } {
  const unscoped = new Map<string, string>();
  const ranged = new Set<string>();
  for (const decision of decisions) {
    if (decision.ranges?.length) { ranged.add(decision.surface); continue; }
    if (decision.verdict === "entity" && decision.entityId) unscoped.set(decision.surface, decision.entityId);
  }
  const key = (entry: CensusEntry) => !ranged.has(entry.surface) && unscoped.get(entry.surface) ? unscoped.get(entry.surface)! : censusKey(entry.surface);
  const usable = census.filter((entry) => ENTITY_CENSUS_CLASSES.has(entry.class) && Array.from(entry.surface).length >= 2);
  return {
    names: { entries: usable.map((entry) => ({ surface: entry.surface, entityId: key(entry) })), collisions: [] },
    persons: { entries: usable.filter((entry) => entry.class === "person").map((entry) => ({ surface: entry.surface, entityId: key(entry) })), collisions: [] },
  };
}

function receiptsUsage(receipts: readonly ScopeReceipt[]): CompileUsage | null {
  const used = receipts.filter((receipt) => receipt.usage.requests > 0 || receipt.usage.cost > 0);
  if (!used.length) return null;
  return used.reduce<CompileUsage>((total, receipt) => ({ inputTokens: total.inputTokens + receipt.usage.input, outputTokens: total.outputTokens + receipt.usage.output,
    cacheReadTokens: total.cacheReadTokens + receipt.usage.cacheRead, nominalUsd: total.nominalUsd + receipt.usage.cost, runs: total.runs + receipt.traceRunIds.length }),
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, nominalUsd: 0, runs: 0 });
}

const fromSource = <T extends { evidence: readonly EvidenceRef[] }>(items: readonly T[], sourceId: string) => items.filter((item) => item.evidence.some((reference) => reference.span.sourceId === sourceId));

export async function loadPipelineView(workspaceRoot: string, sourceId: string): Promise<PipelineView> {
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const source = await workspace.getSource(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}.`);
  const bytes = await readSourceMaterial(workspaceRoot, source);
  const structure = await new SourceStructureStore(workspaceRoot).read(sourceId);
  if (!structure || structure.sourceSha256 !== source.contentSha256) throw new Error(`PIPELINE_SOURCE_STAGE_REQUIRED: run compile-novel source --source ${sourceId} first.`);
  const store = new PipelineStore(workspaceRoot, sourceId);
  const canonical = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  const [census, decisions, dispositions, reviews, accounts, roster, receipts, annotations, entityResolutions, eventResolutions] = await Promise.all([
    store.census(), store.lexiconDecisions(), store.dispositions(), store.candidateReviews(), store.unitAccounts(), store.roster(), store.receipts(),
    new SourceAnnotationStore(workspaceRoot).list(sourceId), new EntityResolutionStore(workspaceRoot).list(sourceId), new EventResolutionStore(workspaceRoot).list(sourceId),
  ]);
  const [entities, propositions, attributions, claims, events, eventParticipations, eventRelations, spatialRelations, sceneOccurrences, eventFrames, semanticEffects,
    perceptionObservations, acquisitions, utteranceExpressions, eventExecutions, actionSchemas, actionConstraints, normTemplates, processTemplates, rules, goals, models, possibilities, initialWorld] = await Promise.all([
    canonical.listEntities(), canonical.listPropositions(), canonical.listAttributions(), canonical.listClaims(), canonical.listEvents(), canonical.listEventParticipations(),
    canonical.listEventRelations(), canonical.listSpatialRelations(), canonical.listSceneOccurrences(), canonical.listEventFrames(), canonical.listSemanticEffects(),
    canonical.listPerceptionObservations(), canonical.listAcquisitions(), canonical.listUtteranceExpressions(), canonical.listEventExecutions(), canonical.listActionSchemas(),
    canonical.listActionConstraints(), canonical.listNormTemplates(), canonical.listProcessTemplates(), canonical.listRules(), actors.listGoals(), actors.listModels(),
    new PossibilityTemplateStore(workspaceRoot).list(), new InitialWorldStore(workspaceRoot).get(),
  ]);
  const sourceEntities = fromSource(entities, sourceId);
  // Host-derived accounting: annotation coverage represents a unit; otherwise only an explicit model disposition closes it.
  const covered = annotations.flatMap((item) => (item.annotationType === "event-mention" ? item.extentAnchors : item.annotationType === "discourse-segment" ? [] : [item.anchor]).map((anchor) => ({ id: item.id, startByte: anchor.startByte, endByte: anchor.endByte })));
  const sortedCovered = [...covered].sort((a, b) => a.startByte - b.startByte);
  const accountByUnit = new Map(accounts.map((item) => [item.unitId, item]));
  const records = baseStructuralUnits(structure).map((unit) => {
    const covering = [...new Set(sortedCovered.filter((range) => range.startByte < unit.anchor.endByte && range.endByte > unit.anchor.startByte).map((range) => range.id))].sort();
    const represented = covering.length > 0;
    const account = accountByUnit.get(unit.id);
    // Blank and other non-scene structure units carry no narrative: the host accounts for them deterministically.
    if (!represented && unit.kind === "non-scene") return { version: 1 as const, unitId: unit.id, status: "background-only" as const, annotationIds: [], evidenceAssertionIds: [],
      reason: "Non-scene structure unit (blank or layout).", reviewedBy: "deterministic" as const, reviewedAt: new Date(0).toISOString(), batchIds: [] };
    return { version: 1 as const, unitId: unit.id, status: represented ? "represented" as const : account?.status ?? "unresolved" as const, annotationIds: covering, evidenceAssertionIds: [],
      ...(account && !represented ? { reason: account.rationale } : {}), reviewedBy: represented ? "deterministic" as const : "model" as const, reviewedAt: new Date(0).toISOString(), batchIds: account && !represented ? [account.scopeId] : [] };
  });
  const accounting: SourceAccountingManifest = { version: 1, sourceId, sourceSha256: source.contentSha256, structureVersion: structure.structureVersion, batchReviews: [], records, updatedAt: new Date(0).toISOString() };
  const bundle = {
    version: 4,
    source: { id: source.id, contentMd5: source.contentMd5 ?? "", contentSha256: source.contentSha256 },
    segmenterVersion: 1,
    batchIds: [],
    admission: null,
    readiness: null,
    canonical: {
      entities: sourceEntities, propositions: fromSource(propositions, sourceId), attributions: fromSource(attributions, sourceId), claims: fromSource(claims, sourceId),
      events: fromSource(events, sourceId), eventParticipations: fromSource(eventParticipations, sourceId), eventRelations: fromSource(eventRelations, sourceId),
      spatialRelations: fromSource(spatialRelations, sourceId), sceneOccurrences: fromSource(sceneOccurrences, sourceId), eventFrames: fromSource(eventFrames, sourceId),
      semanticEffects: fromSource(semanticEffects, sourceId), perceptionObservations: fromSource(perceptionObservations, sourceId), acquisitions: fromSource(acquisitions, sourceId),
      utteranceExpressions: fromSource(utteranceExpressions, sourceId), eventExecutions: fromSource(eventExecutions, sourceId),
      actionSchemas: actionSchemas.filter((item) => item.induction.kind === "domain-module" || item.evidence.some((reference) => reference.span.sourceId === sourceId)),
      actionConstraints: actionConstraints.filter((item) => item.induction.kind === "domain-module" || item.evidence.some((reference) => reference.span.sourceId === sourceId)),
      normTemplates: normTemplates.filter((item) => item.induction.kind === "domain-module" || item.evidence.some((reference) => reference.span.sourceId === sourceId)),
      processTemplates: processTemplates.filter((item) => item.induction.kind === "domain-module" || item.evidence.some((reference) => reference.span.sourceId === sourceId)),
      rules: fromSource(rules, sourceId), goals: fromSource(goals, sourceId), models: fromSource(models, sourceId), possibilities: fromSource(possibilities, sourceId),
      initialWorld: initialWorld && initialWorld.evidence.some((reference) => reference.span.sourceId === sourceId) ? initialWorld : { version: 1, delta: { version: 1, operations: [] }, evidence: [] },
    },
    compilerSnapshot: {
      structure, annotations, entityResolutions, eventResolutions, evidenceBindings: [],
      accounting,
      roleRoster: null,
    },
  } as unknown as PreparedNovelBundle;

  // Inventory: census lexicon for names and person cues; collisions from resolutions that bind one proper surface to several characters without a ranged decision.
  const lexicons = censusLexicons(census, decisions);
  const names = buildLexicalInventory({ source: bytes, lexicon: lexicons.names });
  const persons = buildLexicalInventory({ source: bytes, lexicon: lexicons.persons });
  const ranged = new Set(decisions.filter((item) => item.ranges?.length).map((item) => item.surface));
  const resolved = buildCharacterLexicon({ entities: sourceEntities, annotations, entityResolutions });
  const inventory: LexicalInventory = { ...names, cues: persons.cues, lexicon: { entries: names.lexicon.entries, collisions: resolved.collisions.filter((item) => !ranged.has(item.surface)) } };

  const rosterSummary: RosterSummary | undefined = roster?.review ? { reviewed: true, actorIds: roster.review.majors, missing: roster.review.missing.map((item) => item.name) } : undefined;
  const loreTerms: LoreTerm[] = census.filter((entry) => entry.class === "lore").map((entry) => ({ surface: entry.surface, occurrences: entry.occurrences, origin: "census" as const }));
  const rejected = (kind: CandidateReview["kind"]) => reviews.filter((item) => item.kind === kind && item.verdict === "rejected").map((item) => item.range);
  const options: WorldCompletenessOptions = {
    inventory,
    dispositions: dispositions.flatMap((item) => item.verdict === "rejected-candidate" ? [] : [{ measureId: item.measureId, subject: item.subject, verdict: item.verdict, rationale: item.rationale }]),
    ...(rosterSummary ? { roster: rosterSummary } : {}),
    loreTerms,
    usage: receiptsUsage(receipts),
    handled: { speech: rejected("speech"), names: rejected("name"), times: rejected("time") },
  };
  return { accounting, source, bytes, structure, bundle, inventory, census, decisions, dispositions, reviews, accounts, roster, receipts, options };
}

export function measureView(view: PipelineView, scope?: ByteRange, extra: Pick<WorldCompletenessOptions, "queueLimit" | "admission"> = {}): WorldCompletenessReport {
  return measureWorldCompleteness(view.bundle, view.bytes, { ...view.options, ...extra, ...(scope ? { scope } : {}) });
}
