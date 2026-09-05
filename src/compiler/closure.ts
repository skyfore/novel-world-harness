import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { validationIssueSchema } from "../world/model.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { annotationAnchors } from "./annotations.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

export const closureKindSchema = z.enum(["source", "unit", "discourse", "annotation", "entity-resolution", "event-resolution", "entity", "proposition", "attribution", "claim", "event", "participation", "event-relation", "spatial", "scene", "frame", "action", "event-execution", "constraint", "norm", "process", "rule", "goal", "model", "possibility", "initial", "evidence", "roster", "entry"]);
export type ClosureKind = z.infer<typeof closureKindSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const dependencyUseSchema = z.object({ pointer: z.string(), purpose: z.enum(["identity", "evidence-support", "temporal-order", "causal-precondition", "state-effect", "knowledge-acquisition", "entry-seed", "capability", "certificate"]) }).strict();
const refSchema = z.object({ kind: closureKindSchema, id: z.string().min(1), revisionHash: hashSchema.optional(), uses: z.array(dependencyUseSchema).default([]) }).strict();
export const closureGraphSchema = z.object({
  version: z.literal(1), nodes: z.array(z.object({ kind: closureKindSchema, id: z.string().min(1), revisionHash: hashSchema, dependsOn: z.array(refSchema) }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type ClosureGraph = z.infer<typeof closureGraphSchema>;
type Node = ClosureGraph["nodes"][number];
const key = (value: { kind: string; id: string }) => `${value.kind}/${value.id}`;

/** An explicit reference vocabulary, not an ID-suffix heuristic or a free-text scan. */
const referenceFields: Readonly<Record<string, ClosureKind>> = {
  entityId: "entity", actorId: "entity", subjectEntityId: "entity", holderEntityId: "entity", fromActorId: "entity", toActorId: "entity", debtorActorId: "entity", creditorActorId: "entity", beneficiaryActorId: "entity", sourceActorId: "entity", authorityEntityId: "entity", focalActorId: "entity", viewpointActorId: "entity", fromLocationId: "entity", toLocationId: "entity", containerLocationId: "entity", containedLocationId: "entity", locationId: "entity",
  entityIds: "entity", participants: "entity", targetEntityIds: "entity", targetIds: "entity", presentActorIds: "entity", viewpointActorIds: "entity", jurisdictionEntityIds: "entity", locationIds: "entity",
  propositionId: "proposition", attributionId: "attribution", sourceAttributionId: "attribution", claimId: "claim", knownByClaimIds: "claim", requiresKnowledge: "claim", blockedByKnowledge: "claim", forbidsKnowledge: "claim", focalKnowledgeClaimIds: "claim",
  eventId: "event", canonicalEventId: "event", fromEventId: "event", toEventId: "event", anchorEventId: "event", beforeCanonicalEventId: "event", eventIds: "event", supportingEventIds: "event", establishedByEventIds: "event", retiredByEventIds: "event", causalParents: "event",
  sceneOccurrenceIds: "scene", frameId: "frame", schemaId: "action", ruleId: "rule", activeRuleIds: "rule", overridesRuleIds: "rule", overridesConstraintIds: "constraint", overridesTemplateIds: "norm",
  goalId: "goal", parentGoalId: "goal",
  unitIds: "unit", reviewedUnitIds: "unit", basisUnitIds: "unit", resolutionIds: "entity-resolution",
  mentionId: "annotation", mentionIds: "annotation", participantMentionIds: "annotation", speakerMentionIds: "annotation", addresseeMentionIds: "annotation", viewpointMentionIds: "annotation", eventMentionIds: "annotation", quotationIds: "annotation", basisMentionIds: "annotation", basisEventMentionIds: "annotation", discourseSegmentId: "discourse", discourseSegmentIds: "discourse", sceneId: "discourse",
};

export function buildPreparedClosure(bundle: PreparedNovelBundle): ClosureGraph {
  const nodes = new Map<string, Node>(), payloads = new Map<string, unknown>();
  const issues: ClosureGraph["issues"] = [];
  const add = (kind: ClosureKind, id: string, payload: unknown) => {
    const node: Node = { kind, id, revisionHash: contentHash(payload), dependsOn: [] };
    if (nodes.has(key(node))) { issues.push({ code: "CLOSURE_DUPLICATE_ID", message: `Duplicate ${key(node)}` }); return; }
    nodes.set(key(node), node); payloads.set(key(node), payload);
  };
  add("source", bundle.source.id, bundle.source);
  const canonical = bundle.canonical;
  const collections: Array<[ClosureKind, readonly { id: string }[]]> = [
    ["entity", canonical.entities], ["proposition", canonical.propositions], ["attribution", canonical.attributions], ["claim", canonical.claims], ["event", canonical.events], ["participation", canonical.eventParticipations], ["event-relation", canonical.eventRelations], ["spatial", canonical.spatialRelations], ["scene", canonical.sceneOccurrences], ["frame", canonical.eventFrames], ["action", canonical.actionSchemas], ["event-execution", canonical.eventExecutions ?? []], ["constraint", canonical.actionConstraints], ["norm", canonical.normTemplates], ["process", canonical.processTemplates], ["rule", canonical.rules], ["goal", canonical.goals], ["possibility", canonical.possibilities],
  ];
  for (const [kind, records] of collections) for (const record of records) add(kind, record.id, record);
  for (const model of canonical.models) add("model", model.actorId, model);
  add("initial", bundle.source.id, canonical.initialWorld);
  const snapshot = bundle.compilerSnapshot;
  if (snapshot.roleRoster) add("roster", bundle.source.id, snapshot.roleRoster);
  for (const unit of snapshot.structure.units) add("unit", unit.id, unit);
  const baseUnits = snapshot.structure.units.filter((unit) => snapshot.structure.baseUnitIds?.includes(unit.id));
  for (const segment of snapshot.structure.discourseSegments ?? []) add("discourse", segment.id, segment);
  for (const annotation of snapshot.annotations) add("annotation", annotation.id, annotation);
  // Pi discourse observations live in SourceAnnotationStore; the structural
  // manifest is a separate byte-partition inventory and need not duplicate them.
  for (const annotation of snapshot.annotations) if (annotation.annotationType === "discourse-segment" && !nodes.has(`discourse/${annotation.id}`)) add("discourse", annotation.id, annotation);
  for (const resolution of snapshot.entityResolutions) add("entity-resolution", resolution.id, resolution);
  for (const resolution of snapshot.eventResolutions) add("event-resolution", resolution.id, resolution);
  for (const binding of snapshot.evidenceBindings) add("evidence", `${binding.artifactKind}/${binding.artifactId}`, binding);
  const link = (node: Node, kind: ClosureKind, id: string, pointer = "") => {
    if (node.kind === kind && node.id === id) return;
    const target = nodes.get(key({ kind, id }));
    let ref = node.dependsOn.find((x) => x.kind === kind && x.id === id);
    if (!ref) { ref = { kind, id, ...(target ? { revisionHash: target.revisionHash } : {}), uses: [] }; node.dependsOn.push(ref); }
    const purpose: z.infer<typeof dependencyUseSchema>["purpose"] = ["source", "unit", "evidence", "annotation", "discourse"].includes(kind) ? "evidence-support"
      : ["initial", "entry"].includes(node.kind) ? "entry-seed" : kind === "roster" ? "certificate"
        : ["action", "event-execution", "norm", "process"].includes(kind) ? "capability"
          : ["claim", "proposition", "attribution"].includes(kind) ? "knowledge-acquisition"
            : /Outcome|delta|stateEffects/.test(pointer) ? "state-effect" : /preconditions|causalParents/.test(pointer) ? "causal-precondition"
              : ["event", "event-relation", "event-resolution"].includes(kind) ? "temporal-order" : "identity";
    if (!ref.uses.some((use) => use.pointer === pointer && use.purpose === purpose)) ref.uses.push({ pointer, purpose });
    if (!target) issues.push({ code: "CLOSURE_DANGLING_REFERENCE", message: `${key(node)} requires missing ${kind}/${id}`, path: key(node) });
  };
  const fields = new Map(DEFAULT_STATE_FIELDS.map((field) => [field.key, field]));
  const visit = (node: Node, value: unknown, channel?: "norm" | "process", locals: ReadonlySet<string> = new Set(), pointer = "") => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(node, item, channel, locals, `${pointer}/${index}`)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [name, item] of Object.entries(record)) {
      const at = `${pointer}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      // Literals, descriptions and arbitrary legacy claim objects do not declare references.
      if (["evidence", "counterEvidence", "derivation", "parameters", "description", "summary", "rationale", "interpretation", "object", "value", "characterEntryCheckpoints", "projectionSeed"].includes(name)) {
        if (name === "parameters") {
          const specs = Array.isArray(item) ? item : canonical.actionSchemas.find((schema) => schema.id === record.schemaId)?.parameters ?? [];
          for (const [index, spec] of specs.entries()) {
            const values = Array.isArray(item) ? spec.allowedValues ?? [] : [item && typeof item === "object" ? (item as Record<string, unknown>)[spec.id] : undefined];
            for (const [valueIndex, value] of values.entries()) {
              const target = Array.isArray(item) ? `${at}/${index}/allowedValues/${valueIndex}` : `${at}/${spec.id}`;
              if (spec.valueType === "entity-ref" && typeof value === "string") link(node, "entity", value, target);
              if (spec.valueType === "entity-ref-set" && Array.isArray(value)) value.forEach((id, memberIndex) => { if (typeof id === "string") link(node, "entity", id, `${target}/${memberIndex}`); });
            }
          }
        }
        if (name === "object" && item && typeof item === "object" && (item as { kind?: string }).kind) visit(node, item, channel, locals, at);
        if (name === "value" && typeof record.field === "string") {
          const spec = fields.get(record.field);
          const literal = item && typeof item === "object" && !Array.isArray(item) && (item as { source?: string }).source === "literal" ? (item as { value?: unknown }).value : item;
          if (spec?.valueType === "entity-ref" && typeof literal === "string") link(node, "entity", literal, at);
          if (spec?.valueType === "entity-ref-set" && Array.isArray(literal)) literal.forEach((id, index) => { if (typeof id === "string") link(node, "entity", id, `${at}/${index}`); });
        }
        continue;
      }
      const targetKind = referenceFields[name] ?? (name === "templateId" ? channel : undefined);
      if (targetKind) {
        if (typeof item === "string" && !locals.has(`${targetKind}/${item}`)) link(node, targetKind, item, at);
        else if (Array.isArray(item)) item.forEach((id, index) => { if (typeof id === "string" && !locals.has(`${targetKind}/${id}`)) link(node, targetKind, id, `${at}/${index}`); });
      }
      visit(node, item, ["norm", "norms", "proposedNorms"].includes(name) ? "norm" : ["process", "processes", "proposedProcesses"].includes(name) ? "process" : channel, locals, at);
    }
  };
  const seedLocals = (seed: typeof canonical.initialWorld.projectionSeed) => new Set((seed?.semantics.operations ?? []).flatMap((op) => {
    if (op.op === "record-proposition") return [`proposition/${op.proposition.id}`];
    if (op.op === "record-attribution") return [`attribution/${op.attribution.id}`];
    if (op.op === "record-claim") return [`claim/${op.claim.id}`];
    if (op.op === "open-goal") return [`goal/${op.goal.id}`];
    return [];
  }));
  for (const node of nodes.values()) {
    const payload = payloads.get(key(node));
    if (node.kind !== "source") link(node, "source", bundle.source.id);
    // Entry branch-semantic IDs are validated by the production seed reducer, not canonical lookup.
    if (!["evidence", "unit"].includes(node.kind)) visit(node, node.kind === "initial" ? { delta: canonical.initialWorld.delta, knowledge: canonical.initialWorld.knowledge, checkpoint: canonical.initialWorld.checkpoint, ...canonical.initialWorld.projectionSeed } : payload, undefined, node.kind === "initial" ? seedLocals(canonical.initialWorld.projectionSeed) : undefined);
    if (node.kind === "claim") {
      const claim = canonical.claims.find((x) => x.id === node.id)!;
      link(node, "entity", claim.subject); if (claim.speaker) link(node, "entity", claim.speaker);
      if (typeof claim.object === "string" && nodes.has(`entity/${claim.object}`)) link(node, "entity", claim.object);
    }
  }
  for (const annotation of snapshot.annotations) {
    const node = nodes.get(`annotation/${annotation.id}`)!;
    if (annotation.annotationType === "discourse-segment") link(nodes.get(`discourse/${annotation.id}`)!, "annotation", annotation.id);
    // Only annotations with schema-valid anchors enter production snapshots.
    if (!("sourceId" in annotation)) continue;
    for (const anchor of annotationAnchors(annotation)) for (const unit of baseUnits) {
      if (anchor.startByte < unit.anchor.endByte && anchor.endByte > unit.anchor.startByte) link(node, "unit", unit.id);
    }
  }
  const artifactKinds: Readonly<Record<string, ClosureKind>> = { entity: "entity", proposition: "proposition", attribution: "attribution", claim: "claim", event: "event", "canonical-event": "event", "event-participation": "participation", "event-relation": "event-relation", "spatial-relation": "spatial", "scene-occurrence": "scene", "event-frame": "frame", "action-schema": "action", "event-execution": "event-execution", "action-constraint": "constraint", "norm-template": "norm", "process-template": "process", rule: "rule", "world-rule": "rule", goal: "goal", "character-goal": "goal", model: "model", "character-model": "model", possibility: "possibility", "initial-world": "initial" };
  for (const binding of snapshot.evidenceBindings) {
    const evidenceId = `${binding.artifactKind}/${binding.artifactId}`, node = nodes.get(`evidence/${evidenceId}`)!;
    const kind = artifactKinds[binding.artifactKind];
    const artifact = kind ? nodes.get(key({ kind, id: kind === "initial" ? bundle.source.id : binding.artifactId })) : undefined;
    if (artifact) link(artifact, "evidence", evidenceId);
    for (const assertion of binding.assertions) for (const anchor of assertion.anchors) for (const unit of baseUnits) {
      if (anchor.startByte < unit.anchor.endByte && anchor.endByte > unit.anchor.startByte) link(node, "unit", unit.id);
    }
  }
  // Legacy evidence and discourse anchors still participate in repair scope;
  // containment units (e.g. the whole work) must not expand every repair to the whole book.
  const evidenceUnits = (node: Node, value: unknown): void => {
    if (Array.isArray(value)) { value.forEach((item) => evidenceUnits(node, item)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const name of ["evidence", "counterEvidence", ...(node.kind === "discourse" ? ["anchors"] : [])]) {
      if (!Array.isArray(record[name])) continue;
      for (const reference of record[name]) {
        const span = reference?.span ?? reference;
        if (span?.sourceId !== bundle.source.id) continue;
        for (const unit of baseUnits) {
          const overlaps = typeof span.startByte === "number" && typeof span.endByte === "number"
            ? span.startByte < unit.anchor.endByte && span.endByte > unit.anchor.startByte
            : typeof span.startLine === "number" && typeof span.endLine === "number" && span.startLine <= unit.anchor.endLine && span.endLine >= unit.anchor.startLine;
          if (overlaps) link(node, "unit", unit.id);
        }
      }
    }
    for (const [name, item] of Object.entries(record)) if (!["evidence", "counterEvidence", "anchors", "derivation"].includes(name)) evidenceUnits(node, item);
  };
  for (const node of nodes.values()) if (!["source", "unit", "evidence", "roster"].includes(node.kind)) evidenceUnits(node, payloads.get(key(node)));
  // Identity repairs invalidate the semantic identity and all its downstream consumers.
  for (const resolution of snapshot.entityResolutions) {
    if (resolution.entityId) {
      const entity = nodes.get(`entity/${resolution.entityId}`);
      if (entity) link(entity, "entity-resolution", resolution.id);
    }
  }
  for (const resolution of snapshot.eventResolutions) {
    const event = nodes.get(`event/${resolution.canonicalEventId}`);
    if (event) link(event, "event-resolution", resolution.id);
  }
  for (const binding of canonical.eventExecutions ?? []) {
    const event = nodes.get(`event/${binding.canonicalEventId}`);
    if (event) link(event, "event-execution", binding.id);
  }
  for (const event of canonical.events) for (const checkpoint of event.characterEntryCheckpoints ?? []) {
    const id = `${checkpoint.actorId}/${event.id}`;
    add("entry", id, checkpoint);
    const node = nodes.get(`entry/${id}`)!;
    link(node, "event", event.id); link(node, "entity", checkpoint.actorId); link(node, "initial", bundle.source.id);
    if (snapshot.roleRoster) link(node, "roster", bundle.source.id);
    visit(node, { delta: checkpoint.delta, participantPresence: checkpoint.participantPresence, knowledge: checkpoint.knowledge, ...checkpoint.projectionSeed }, undefined, seedLocals(checkpoint.projectionSeed));
    for (const item of canonical.normTemplates) link(node, "norm", item.id);
    for (const item of canonical.processTemplates) link(node, "process", item.id);
  }
  return closureGraphSchema.parse({ version: 1, nodes: [...nodes.values()].map((node) => ({ ...node, dependsOn: node.dependsOn.sort((a, b) => key(a).localeCompare(key(b))) })).sort((a, b) => key(a).localeCompare(key(b))),
    issues: [...new Map(issues.map((issue) => [`${issue.code}/${issue.message}`, issue])).values()].sort((a, b) => a.message.localeCompare(b.message)) });
}

/** Return the fixed-point consumer set. Cycles in identity dependencies terminate safely. */
export function affectedClosureNodes(graph: ClosureGraph, changed: readonly { kind: ClosureKind; id: string }[]): string[] {
  const consumers = new Map<string, Set<string>>();
  for (const node of graph.nodes) for (const dependency of node.dependsOn) {
    const id = key(dependency); if (!consumers.has(id)) consumers.set(id, new Set()); consumers.get(id)!.add(key(node));
  }
  const affected = new Set(changed.map(key)), pending = [...affected];
  while (pending.length) for (const consumer of consumers.get(pending.pop()!) ?? []) if (!affected.has(consumer)) { affected.add(consumer); pending.push(consumer); }
  return [...affected].sort();
}

export function staleClosureNodes(graph: ClosureGraph, current: ClosureGraph): string[] {
  const revisions = new Map(current.nodes.map((node) => [key(node), node.revisionHash]));
  const changed = graph.nodes.filter((node) => revisions.get(key(node)) !== node.revisionHash);
  const known = new Set(graph.nodes.map(key));
  // Consumers may acquire a new dependency in the current revision. Walk both
  // graphs so additions as well as removals invalidate downstream artifacts.
  return affectedClosureNodes({ ...current, nodes: [...graph.nodes, ...current.nodes] }, [...changed, ...current.nodes.filter((node) => !known.has(key(node)))]);
}
