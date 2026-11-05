import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { applyEventExecutions } from "../world/event-execution.js";
import { buildPreparedClosure, affectedClosureNodes, type ClosureKind } from "./closure.js";
import { preparedNovelBundleSchema } from "./prepared-cache.js";
import { SourceStructureStore } from "./structure.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { RoleReviewWorkStore } from "./role-review-work.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { SegmentStore } from "./segments.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { prepareCoreRoleDependencyReview, type RoleDependencyReviewInput } from "./role-dependency-review-service.js";
import { validateSemanticScopeHistory, validateSemanticScopePlan } from "./role-semantic-scope.js";
import { verifySemanticScopeRecord } from "./role-semantic-scope-trace.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { identityIntentSchema, identityRequirementId, IDENTITY_CONSUMER_SHARD_SIZE, type IdentityIntent, type IdentityInventory } from "./identity-requirements.js";
import { retainedUpstreamReviewPrefix } from "./upstream-review-prefix.js";

const mapping: Record<string, [string, ClosureKind]> = {
  entity: ["entities", "entity"], proposition: ["propositions", "proposition"], attribution: ["attributions", "attribution"], claim: ["claims", "claim"],
  "canonical-event": ["events", "event"], "event-participation": ["eventParticipations", "participation"], "event-relation": ["eventRelations", "event-relation"],
  "spatial-relation": ["spatialRelations", "spatial"], "scene-occurrence": ["sceneOccurrences", "scene"], "event-frame": ["eventFrames", "frame"],
  "semantic-effect": ["semanticEffects", "semantic-effect"], "perception-observation": ["perceptionObservations", "perception-observation"], acquisition: ["acquisitions", "acquisition"],
  "utterance-expression": ["utteranceExpressions", "utterance-expression"], "event-execution": ["eventExecutions", "event-execution"],
  "action-schema": ["actionSchemas", "action"], "action-constraint": ["actionConstraints", "constraint"], "norm-template": ["normTemplates", "norm"], "process-template": ["processTemplates", "process"],
  "world-rule": ["rules", "rule"], "character-goal": ["goals", "goal"], "character-model": ["models", "model"], possibility: ["possibilities", "possibility"],
};
const key = (r: { kind: string; id: string }) => `${r.kind}/${r.id}`;

/** Pure closure construction over a strictly read-only live inventory. No cache build,
 * preparation, roster activation, or source-overlap-to-authority inference. */
export async function prepareIdentityRequirements(root: string, input: RoleDependencyReviewInput,
  authorizationRef: string, priorUsage: IdentityIntent["priorUsage"], verifyOldTraces = true) {
  const prepared = await prepareCoreRoleDependencyReview(root, input), { review, catalog } = prepared;
  const ledger = new RequirementLedger(root, input.scope.sourceId), journal = await ledger.history();
  const semantic = await ledger.roleSemanticScopes(review.taskId);
  validateSemanticScopeHistory(review, semantic);
  const plan = semantic[0]?.output, check = semantic[1]?.output;
  if (plan?.phase !== "semantic-scope-plan" || check?.phase !== "semantic-scope-check" || !plan.operations.length
    || check.operationJudgments.some(j => j.verdict !== "supported") || check.judgments.some(j => j.verdict !== "supported") || check.consumerVerdict !== "supported") throw prerequisiteStop("Exact original operation scope is absent or independently rejected");
  validateSemanticScopePlan(plan, review, prepared.prerequisites, prepared.representations, catalog, prepared.discovery.findings.map(f => f.findingId));
  if (verifyOldTraces) for (const r of semantic) await verifySemanticScopeRecord(root, review, r);
  const targets = plan.operations.map(op => {
    if (op.kind !== "entity-resolution" || op.mode !== "create" || op.baseline || op.pointers.length) throw prerequisiteStop("Independent requirement target is not an exact immutable resolution creation");
    const p = identityResolutionSchema.parse(JSON.parse(op.payloadJson));
    const mention = catalog.find(c => c.kind === "entity-mention" && c.id === p.mentionId);
    const predecessor = p.supersedesResolutionId ? catalog.find(c => c.kind === "entity-resolution" && c.id === p.supersedesResolutionId) : null;
    if (!mention || (p.supersedesResolutionId && !predecessor)) throw prerequisiteStop("Exact target mention/predecessor is no longer current");
    return { slot: op.slot, requirementId: identityRequirementId(review.taskId, op.slot), mentionId: p.mentionId, mentionHash: mention.revisionHash,
      predecessor: predecessor ? { id: predecessor.id, hash: predecessor.revisionHash } : null, questionIds: op.questionIds };
  });
  const [structure, annotations, resolutions, eventResolutions, artifacts, manifest, definitions, coreDefinitions] = await Promise.all([
    new SourceStructureStore(root).read(input.scope.sourceId), new SourceAnnotationStore(root).list(input.scope.sourceId),
    new EntityResolutionStore(root).list(input.scope.sourceId), new EventResolutionStore(root).list(input.scope.sourceId),
    loadCompilerArtifactRecords(root, input.scope.sourceId), new SegmentStore(root).readManifest(input.scope.sourceId),
    ledger.definitionHistory(), ledger.coreRoleDefinitionHistory(),
  ]);
  if (!structure || !manifest) throw prerequisiteStop("Current consumer source inventory missing");
  const canonicalInput: Record<string, unknown> = Object.fromEntries(Object.values(mapping).map(([name]) => [name, []]));
  const payloads = new Map<string, unknown>();
  for (const a of artifacts.filter(a => a.status === "canonical")) {
    if (a.kind === "initial-world") { canonicalInput.initialWorld = a.payload; payloads.set(`initial/${review.scope.sourceId}`, a.payload); }
    else {
      const m = mapping[a.kind];
      if (!m) throw prerequisiteStop(`Consumer graph does not support canonical type ${a.kind}`);
      (canonicalInput[m[0]] as unknown[]).push(a.payload); payloads.set(`${m[1]}/${a.logicalId}`, a.payload);
    }
  }
  // Built-in capabilities also consume typed identities even without source evidence.
  const canon = new CanonicalModelStore(root);
  for (const [name, kind, values] of [
    ["actionSchemas", "action", await canon.listActionSchemas()], ["actionConstraints", "constraint", await canon.listActionConstraints()],
    ["normTemplates", "norm", await canon.listNormTemplates()], ["processTemplates", "process", await canon.listProcessTemplates()],
  ] as const) for (const value of values) if (value.induction.kind === "domain-module" && !payloads.has(`${kind}/${value.id}`)) {
    (canonicalInput[name] as unknown[]).push(value); payloads.set(`${kind}/${value.id}`, value);
  }
  const canonical = preparedNovelBundleSchema.shape.canonical.parse(canonicalInput);
  for (const a of annotations) {
    payloads.set(`annotation/${a.id}`, a);
    if (a.annotationType === "discourse-segment") payloads.set(`discourse/${a.id}`, a);
  }
  for (const d of structure.discourseSegments) payloads.set(`discourse/${d.id}`, d);
  for (const u of structure.units) payloads.set(`unit/${u.id}`, u);
  for (const r of resolutions) payloads.set(`entity-resolution/${r.id}`, r);
  for (const r of eventResolutions) payloads.set(`event-resolution/${r.id}`, r);
  const evidenceBindings = artifacts.filter(a => a.status === "canonical" && a.evidenceAssertions.length).map(a => ({ artifactKind: a.kind, artifactId: a.logicalId, artifactHash: contentHash(a.payload), assertions: a.evidenceAssertions }));
  for (const b of evidenceBindings) payloads.set(`evidence/${b.artifactKind}/${b.artifactId}`, b);
  for (const d of definitions) payloads.set(`requirement-set/${d.id}`, d);
  for (const d of coreDefinitions) payloads.set(`core-role-requirements/${d.id}`, d);
  payloads.set(`roster/${review.scope.sourceId}`, review.priorRoster);
  for (const e of applyEventExecutions(canonical.events, canonical.eventExecutions)) for (const c of e.characterEntryCheckpoints ?? []) payloads.set(`entry/${c.actorId}/${e.id}`, c);
  const graph = buildPreparedClosure({ source: { id: review.scope.sourceId, contentSha256: review.scope.sourceHash, contentMd5: createHash("md5").update(prepared.bytes).digest("hex") }, canonical,
    compilerSnapshot: { structure, annotations, entityResolutions: resolutions, eventResolutions, evidenceBindings, roleRoster: review.priorRoster,
      requirementDefinitions: definitions, coreRoleRequirementDefinitions: coreDefinitions } });
  const roots: { kind: ClosureKind; id: string }[] = targets.flatMap(t => [{ kind: "annotation", id: t.mentionId }, ...(t.predecessor ? [{ kind: "entity-resolution" as const, id: t.predecessor.id }] : [])]);
  const affected = new Set(affectedClosureNodes(graph, roots));
  const consumers: IdentityInventory["consumers"] = graph.nodes.filter(n => affected.has(key(n))).map(n => {
    if (!payloads.has(key(n)) || contentHash(payloads.get(key(n))) !== n.revisionHash) throw prerequisiteStop(`Consumer graph lacks full exact payload ${key(n)}`);
    return { ref: key(n), revisionHash: n.revisionHash, payload: payloads.get(key(n)), reason: "typed-consumer", dependencies: n.dependsOn.filter(d => affected.has(key(d))) };
  });
  const selected = manifest.segments.filter(s => prepared.upstreamPlan.sourceScope.segmentIds.includes(s.id));
  const sourcePages = review.priorPlan.spans.flatMap((p, i) => selected.some(s => p.start < s.endByte && p.end > s.startByte) ? [i] : []);
  // Include ALL staged entries and both denominator inventories. Evidence overlap is
  // merely a reading aid; it neither filters the review denominator nor grants writes.
  for (const entry of new RoleReviewWorkStore(root, review.priorPlan).stagedEntries()) consumers.push({ ref: `staged-role/${entry.candidateId}`, revisionHash: contentHash(entry), payload: entry, reason: "source-review-coverage", dependencies: [] });
  consumers.push({ ref: "pending-role-denominator", revisionHash: contentHash({ prior: review.priorRoster, next: review.nextRoster }),
    payload: { prior: review.priorRoster, next: review.nextRoster }, reason: "denominator", dependencies: [] });
  const inventory: IdentityInventory = { graphHash: contentHash(graph), roots: roots.map(key), closureIssues: graph.issues,
    consumers: consumers.sort((a, b) => a.ref.localeCompare(b.ref)), sourcePages,
    candidateIds: review.nextRoster.candidates.map(c => c.id), originalQuestionIds: review.scope.questions.map(q => q.questionId) };
  const upstream = await new UpstreamRepairLedger(root, review.scope.sourceId).history();
  const existing = (await ledger.identityRequirements(review.taskId))[0]?.intent;
  const intent = identityIntentSchema.parse({ version: 1, policy: "independent-identity-requirements/v1", taskId: review.taskId,
    revisionHash: review.revisionHash, sourceId: review.scope.sourceId, sourceHash: review.scope.sourceHash, parentStateHash: review.scope.parentStateHash,
    originalPlanHash: review.scope.planHash, originalBudgetHash: review.scope.originalBudgetHash, authorizationRef,
    semanticRecordHashes: semantic.map(contentHash), retainedConditionsHash: contentHash({ questions: plan.questions, consumer: plan.consumer }),
    consumerShards: Array.from({ length: Math.ceil(inventory.consumers.length / IDENTITY_CONSUMER_SHARD_SIZE) }, (_, i) => ({ index: i, refs: inventory.consumers.slice(i * IDENTITY_CONSUMER_SHARD_SIZE, (i + 1) * IDENTITY_CONSUMER_SHARD_SIZE).map(c => c.ref) })),
    catalogHash: contentHash(catalog), inventoryHash: contentHash(inventory), requiredSourceSegmentIds: selected.map(s => s.id), targets,
    requirementPrefix: existing?.requirementPrefix ?? { length: journal.length, head: journal.at(-1)!.hash },
    upstreamPrefix: retainedUpstreamReviewPrefix(upstream, existing?.upstreamPrefix), priorUsage });
  if (existing && contentHash(existing) !== contentHash(intent)) throw prerequisiteStop("Original identity intent changed; no phase retry or namespace rotation");
  return { ...prepared, intent, semantic, inventory, graph, manifest };
}
export type PreparedIdentityRequirements = Awaited<ReturnType<typeof prepareIdentityRequirements>>;
