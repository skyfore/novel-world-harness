import { contentHash, canonicalJson } from "../world/canonical.js";
import { characterModelSchema, type CharacterModel } from "../world/actors.js";
import { CHARACTER_ONTOLOGY_VERSION, characterOntologyEvidence, resolveCharacterOntology,
  validateCharacterOntologyReferences, validateCharacterOntologyEvidenceAssertions, type DevelopmentEpisode } from "../world/character-ontology.js";
import { compareStoryTime } from "../world/time.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION, type EvidenceRef } from "../world/model.js";
import { baseStructuralUnits } from "./structure.js";
import { majorRoleCandidates, reviewedRoleDevelopmentRequirements, validateRoleRoster, type RoleRoster, type RoleDevelopmentExpectation } from "./role-roster.js";
import { assessSemanticRequirements, type RequirementObservation, type SemanticRequirement } from "./semantic-requirements.js";
import { requirementResultSchema, type RequirementResult } from "./requirement-ledger.js";
import { entryDriverWitnessIssues } from "./entry-driver-probe.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import type { PlayabilityManifest } from "./playability.js";

export const CORE_ROLE_EVALUATOR_VERSION = "core-role-capabilities-v1";

/** Independent source review supplies the denominator; accepted models never shrink it. */
export function coreRoleDefinitions(bundle: PreparedNovelBundle, roster: RoleRoster): SemanticRequirement[] {
  const evidenceRefs = roster.unitIds.map(id => `source-unit:${id}`);
  const common = { sourceId: bundle.source.id, evidenceRefs };
  const definitions: SemanticRequirement[] = [{ ...common, id: "core-roles:source-review", targetRef: `source:${bundle.source.id}`,
    capability: "role-denominator", stage: "source-review", expectation: { kind: "two-independent-full-source-reviews", rosterHash: contentHash(roster) }, dependsOn: [] }];
  const development = reviewedRoleDevelopmentRequirements(roster);
  for (const role of majorRoleCandidates(roster)) {
    const targetRef = role.entityId ? `character:${role.entityId}` : `unresolved-role:${role.id}`;
    definitions.push({ ...common, id: `${role.id}:ontology`, targetRef, capability: "ontology", stage: "ontology",
      expectation: { kind: "character-ontology", version: CHARACTER_ONTOLOGY_VERSION }, dependsOn: ["core-roles:source-review"] });
    definitions.push({ ...common, id: `${role.id}:development`, targetRef, capability: "development", stage: "executable",
      expectation: { kind: "source-reviewed-development", review: development.find(item => item.candidateId === role.id)! }, dependsOn: [`${role.id}:ontology`] });
    definitions.push({ ...common, id: `${role.id}:opening-driver`, targetRef, capability: "opening-driver", stage: "executable",
      expectation: { kind: "committed-autonomy-at-first-physical-entry", excludedActorId: role.entityId ?? null }, dependsOn: ["core-roles:source-review"] });
  }
  return definitions;
}

/** Host evaluation over frozen canonical inputs. Requires the normal source/evidence verification gates as well. */
export function evaluateCoreRoleCapabilities(bundle: PreparedNovelBundle, roster: RoleRoster, playability: PlayabilityManifest | null, subjectSnapshotHash: string): RequirementResult {
  const definitions = coreRoleDefinitions(bundle, roster);
  const units = baseStructuralUnits(bundle.compilerSnapshot.structure);
  const context = { sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256,
    specHash: contentHash({ definitions, units }),
    catalogHash: contentHash({ canonical: bundle.canonical, evidenceBindings: bundle.compilerSnapshot.evidenceBindings, subjectSnapshotHash,
      engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION }),
    evaluatorVersion: CORE_ROLE_EVALUATOR_VERSION };
  const observations: RequirementObservation[] = [];
  const record = (requirementId: string, diagnostics: string[], state: RequirementObservation["state"] = diagnostics.length ? "blocked" : "satisfied") =>
    observations.push({ requirementId, context, state, diagnostics });
  const sourceIssues = validateRoleRoster(roster).filter(issue => issue.code !== "ROSTER_MAJOR_IDENTITY_UNRESOLVED").map(issue => `${issue.code}: ${issue.message}`);
  if (roster.sourceId !== bundle.source.id || roster.sourceSha256 !== bundle.source.contentSha256
    || canonicalJson([...roster.unitIds].sort()) !== canonicalJson(units.map(unit => unit.id).sort())) sourceIssues.push("CORE_ROLE_SOURCE_SCOPE_MISMATCH");
  record("core-roles:source-review", sourceIssues);
  const developments = reviewedRoleDevelopmentRequirements(roster);
  for (const role of majorRoleCandidates(roster)) {
    const models = bundle.canonical.models.filter(model => model.actorId === role.entityId);
    const parsed = models.length === 1 ? characterModelSchema.safeParse(models[0]) : undefined;
    const model = parsed?.success ? parsed.data : undefined;
    const ontologyIssues = ontologyDiagnostics(bundle, model);
    if (!role.entityId) ontologyIssues.push("CORE_ROLE_IDENTITY_UNRESOLVED");
    record(`${role.id}:ontology`, ontologyIssues);
    const expected = developments.find(item => item.candidateId === role.id)!;
    if (expected.status === "unknown") record(`${role.id}:development`, ["CORE_DEVELOPMENT_EXPECTATION_UNKNOWN"], "unknown");
    else if (!model) record(`${role.id}:development`, ["CORE_CHARACTER_MODEL_MISSING"]);
    else {
      const diagnostics: string[] = [];
      for (const review of expected.reviews) {
        const expectation = review.expectation!;
        if (expectation.kind === "stable") diagnostics.push(...stableDiagnostics(model));
        if (expectation.kind === "changes") for (const [index, change] of expectation.changes.entries()) {
          if (!developmentMatches(bundle, model, change)) diagnostics.push(`CORE_DEVELOPMENT_NOT_EXECUTABLE: ${review.runId}/change-${index}`);
        }
      }
      record(`${role.id}:development`, [...new Set(diagnostics)]);
    }
    try {
      if (!role.entityId) throw new Error("CORE_ROLE_IDENTITY_UNRESOLVED");
      const cut = deriveCharacterEntrySeed(bundle, role.entityId).cut;
      const matches = playability?.roles.filter(result => result.candidateId === role.id && result.actorId === role.entityId) ?? [];
      record(`${role.id}:opening-driver`, matches.length === 1 ? entryDriverWitnessIssues(matches[0]!.driverWitness,
        { sourceId: bundle.source.id, subjectSnapshotHash, entryCutHash: cut.hash, actorId: role.entityId }) : ["ENTRY_DRIVER_NOT_EVALUATED"]);
    } catch (error) { record(`${role.id}:opening-driver`, [String(error)]); }
  }
  const assessment = assessSemanticRequirements(definitions, observations, context);
  return requirementResultSchema.parse({ setId: "core-roles", revisionHash: context.specHash, catalogHash: context.catalogHash, evaluatorVersion: context.evaluatorVersion,
    requirements: assessment.requirements.map(({ ownState: _own, state, diagnostics, blockedBy, ...definition }) => ({
      id: definition.id, definitionHash: contentHash(definition), state, diagnostics, blockedBy,
    })) });
}

function ontologyDiagnostics(bundle: PreparedNovelBundle, model: CharacterModel | undefined): string[] {
  if (!model) return ["CORE_CHARACTER_MODEL_MISSING_OR_INVALID"];
  if (model.ontologyVersion !== CHARACTER_ONTOLOGY_VERSION) return ["CORE_CHARACTER_ONTOLOGY_MISSING"];
  const issues = validateCharacterOntologyReferences(model, {
    entities: new Map(bundle.canonical.entities.map(item => [item.id, item])), events: new Map(bundle.canonical.events.map(item => [item.id, item])),
    goals: new Map(bundle.canonical.goals.map(item => [item.id, item])), propositions: new Set(bundle.canonical.propositions.map(item => item.id)),
  }).map(issue => `${issue.code}: ${issue.message}`);
  if (!bundle.canonical.entities.some(entity => entity.id === model.actorId && entity.kind === "character")) issues.push("CORE_CHARACTER_IDENTITY_MISSING");
  if (!model.dispositions?.some(item => item.status === "supported")) issues.push("CORE_CHARACTER_DISPOSITION_MISSING");
  if ([...model.evidence, ...characterOntologyEvidence(model)].some(ref => ref.span.sourceId !== bundle.source.id
    || ref.span.startByte === undefined || ref.span.endByte === undefined)) issues.push("CORE_CHARACTER_EVIDENCE_UNANCHORED");
  const bindings = bundle.compilerSnapshot.evidenceBindings.filter(binding => binding.artifactKind === "character-model" && binding.artifactId === model.actorId && binding.artifactHash === contentHash(model));
  if (bindings.length !== 1) issues.push("CORE_CHARACTER_EXACT_BINDING_MISSING_OR_STALE");
  else {
    if (bindings[0]!.assertions.some(assertion => assertion.target.artifactKind !== "character-model" || assertion.target.artifactId !== model.actorId
      || assertion.anchors.some(anchor => anchor.sourceId !== bundle.source.id))) issues.push("CORE_CHARACTER_ASSERTION_SCOPE_INVALID");
    issues.push(...validateCharacterOntologyEvidenceAssertions(model, bindings[0]!.assertions).map(issue => `${issue.code}: ${issue.message}`));
  }
  return issues;
}

function stableDiagnostics(model: CharacterModel): string[] {
  // Appraisals and contextual differences are allowed; temporal disposition
  // changes require a different independent expectation, never an invented arc.
  const stableIds = new Set(model.dispositions?.filter(item => item.stability === "stable").map(item => item.id));
  if (model.developmentEpisodes?.some(episode => [...episode.beforeDispositionIds, ...episode.afterDispositionIds].some(id => stableIds.has(id)))
    || model.dispositions?.some(item => item.stability === "stable" && item.validStoryTime && item.validStoryTime.kind !== "unknown")
    || model.developmentPhases?.some(phase => [...Object.values(phase.traitModifiers), ...Object.values(phase.decisionBiasModifiers)].some(value => value !== 0))) {
    return ["CORE_STABILITY_HAS_TEMPORAL_POLICY: independent stable expectation conflicts with temporal policy; source review is required"];
  }
  return [];
}

type ReviewedChange = Extract<RoleDevelopmentExpectation, { kind: "changes" }>["changes"][number];
function developmentMatches(bundle: PreparedNovelBundle, model: CharacterModel, expected: ReviewedChange): boolean {
  const units = new Map(baseStructuralUnits(bundle.compilerSnapshot.structure).map(unit => [unit.id, unit.anchor]));
  const covers = (evidence: readonly EvidenceRef[], ids: readonly string[]) => ids.every(id => {
    const unit = units.get(id);
    return unit && evidence.some(ref => ref.span.sourceId === bundle.source.id && ref.span.startByte !== undefined && ref.span.endByte !== undefined
      && ref.span.startByte < unit.endByte && ref.span.endByte > unit.startByte);
  });
  for (const episode of model.developmentEpisodes ?? []) {
    if (episode.evidenceStatus !== "supported") continue;
    const triggerEvidenceMatches = episode.triggerEventIds.every(id => bundle.canonical.events.find(event => event.id === id)?.evidence.some(eventRef =>
      episode.evidence.some(ref => ref.span.sourceId === bundle.source.id && eventRef.span.sourceId === bundle.source.id
        && ref.span.startByte !== undefined && ref.span.endByte !== undefined && eventRef.span.startByte !== undefined && eventRef.span.endByte !== undefined
        && ref.span.startByte < eventRef.span.endByte && ref.span.endByte > eventRef.span.startByte)));
    if (!triggerEvidenceMatches) continue;
    for (const before of model.dispositions ?? []) for (const after of model.dispositions ?? []) {
      if (!episode.beforeDispositionIds.includes(before.id) || !episode.afterDispositionIds.includes(after.id)
        || before.status !== "supported" || after.status !== "supported" || before.dimensionId !== expected.dimensionId || after.dimensionId !== expected.dimensionId
        || before.stability !== "stable" || after.stability !== "stable"
        || canonicalJson(before.scope) !== canonicalJson(after.scope) || !covers(before.evidence, expected.beforeUnitIds) || !covers(after.evidence, expected.afterUnitIds)) continue;
      if ((expected.direction === "increase" ? after.value <= before.value : after.value >= before.value)) continue;
      if (probeDevelopmentTransition(bundle, model, episode, before.id, after.id)) return true;
    }
  }
  return false;
}

function probeDevelopmentTransition(bundle: PreparedNovelBundle, model: CharacterModel, episode: DevelopmentEpisode, beforeId: string, afterId: string): boolean {
  const events = new Map(bundle.canonical.events.map(event => [event.id, event]));
  const triggers = episode.triggerEventIds.map(id => events.get(id));
  if (triggers.some(event => !event)) return false;
  const past = new Set(bundle.canonical.events.filter(event => triggers.every(trigger => compareStoryTime(event.storyTime, trigger!.storyTime) === -1)).map(event => event.id));
  const addAncestors = (id: string) => { for (const parent of events.get(id)?.causalParents ?? []) if (!past.has(parent) && !episode.triggerEventIds.includes(parent)) { past.add(parent); addAncestors(parent); } };
  episode.triggerEventIds.forEach(addAncestors);
  const experiencedByActor = (world: Set<string>) => new Set([...world].filter(id => {
    const event = events.get(id), presence = event?.participantPresence?.find(item => item.entityId === model.actorId)?.mode;
    return event?.participants.includes(model.actorId) && presence !== "mentioned" && presence !== "represented";
  }));
  const resolve = (world: Set<string>, experienced = experiencedByActor(world), storyTime = episode.startsAt) => resolveCharacterOntology(model, { realizedCanonicalEventIds: world,
    experiencedCanonicalEventIds: experienced, storyTime }).dispositions;
  const beforeTime = model.dispositions?.find(item => item.id === beforeId)?.validStoryTime;
  const before = resolve(past, experiencedByActor(past), beforeTime && beforeTime.kind !== "relative" && beforeTime.kind !== "unknown" ? beforeTime : episode.startsAt);
  if (!before.some(item => item.id === beforeId) || before.some(item => item.id === afterId)) return false;
  const activated = new Set([...past, ...episode.triggerEventIds]);
  const after = resolve(activated);
  if (!after.some(item => item.id === afterId) || after.some(item => item.id === beforeId)) return false;
  // Partial triggers and compiler-only knowledge cannot prematurely activate a change.
  for (const missing of episode.triggerEventIds) if (resolve(new Set([...activated].filter(id => id !== missing))).some(item => item.id === afterId)) return false;
  if (episode.triggerMode === "experienced" && resolve(activated, experiencedByActor(past)).some(item => item.id === afterId)) return false;
  if (episode.decay.kind === "event-dependent") for (const reversal of episode.decay.reversalEventIds) {
    if (resolve(new Set([...activated, reversal])).some(item => item.id === afterId)) return false;
  }
  return true;
}

export function coreRoleResultIssues(bundle: PreparedNovelBundle, roster: RoleRoster | null, playability: PlayabilityManifest | null, subjectSnapshotHash: string, result: RequirementResult | undefined): string[] {
  if (!roster || !result) return ["CORE_ROLE_REQUIREMENTS_NOT_EVALUATED"];
  const expected = evaluateCoreRoleCapabilities(bundle, roster, playability, subjectSnapshotHash);
  const issues = contentHash(result) === contentHash(expected) ? [] : ["CORE_ROLE_REQUIREMENT_RESULT_STALE_OR_MISMATCH"];
  for (const requirement of expected.requirements) if (requirement.state !== "satisfied") issues.push(`CORE_ROLE_REQUIREMENT_UNRESOLVED: ${requirement.id}: ${requirement.state}`);
  return issues;
}
