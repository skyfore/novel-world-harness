import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { validationIssueSchema } from "../world/model.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { annotationAnchors } from "./annotations.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

export const closureKindSchema = z.enum(["source", "unit", "discourse", "annotation", "entity-resolution", "event-resolution", "entity", "proposition", "attribution", "claim", "event", "participation", "event-relation", "spatial", "scene", "frame", "action", "constraint", "norm", "process", "rule", "goal", "model", "possibility", "initial", "evidence", "roster", "entry"]);
export type ClosureKind = z.infer<typeof closureKindSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const refSchema = z.object({ kind: closureKindSchema, id: z.string().min(1), revisionHash: hashSchema.optional() }).strict();
export const closureGraphSchema = z.object({
  version: z.literal(1), nodes: z.array(z.object({ kind: closureKindSchema, id: z.string().min(1), revisionHash: hashSchema, dependsOn: z.array(refSchema) }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type ClosureGraph = z.infer<typeof closureGraphSchema>;
type Node = ClosureGraph["nodes"][number];
const key = (value: { kind: string; id: string }) => `${value.kind}/${value.id}`;

/** An explicit reference vocabulary, not an ID-suffix heuristic or a free-text scan. */
const referenceFields: Readonly<Record<string, ClosureKind>> = {
  entityId: "entity", actorId: "entity", subjectEntityId: "entity", holderEntityId: "entity", fromActorId: "entity", toActorId: "entity", debtorActorId: "entity", creditorActorId: "entity", sourceActorId: "entity", authorityEntityId: "entity", focalActorId: "entity", viewpointActorId: "entity", fromLocationId: "entity", toLocationId: "entity", containerLocationId: "entity", containedLocationId: "entity", locationId: "entity",
  entityIds: "entity", participants: "entity", targetEntityIds: "entity", targetIds: "entity", presentActorIds: "entity", viewpointActorIds: "entity", jurisdictionEntityIds: "entity", locationIds: "entity",
  propositionId: "proposition", attributionId: "attribution", sourceAttributionId: "attribution", claimId: "claim", knownByClaimIds: "claim", requiresKnowledge: "claim", blockedByKnowledge: "claim", forbidsKnowledge: "claim", focalKnowledgeClaimIds: "claim",
  eventId: "event", canonicalEventId: "event", fromEventId: "event", toEventId: "event", anchorEventId: "event", beforeCanonicalEventId: "event", eventIds: "event", supportingEventIds: "event", establishedByEventIds: "event", retiredByEventIds: "event", causalParents: "event",
  sceneOccurrenceIds: "scene", frameId: "frame", schemaId: "action", ruleId: "rule", activeRuleIds: "rule", overridesRuleIds: "rule", overridesConstraintIds: "constraint", overridesTemplateIds: "norm",
  unitIds: "unit", reviewedUnitIds: "unit", basisUnitIds: "unit", resolutionIds: "entity-resolution",
  mentionId: "annotation", mentionIds: "annotation", participantMentionIds: "annotation", eventMentionIds: "annotation", quotationIds: "annotation", basisMentionIds: "annotation", basisEventMentionIds: "annotation", discourseSegmentId: "discourse", discourseSegmentIds: "discourse",
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
    ["entity", canonical.entities], ["proposition", canonical.propositions], ["attribution", canonical.attributions], ["claim", canonical.claims], ["event", canonical.events], ["participation", canonical.eventParticipations], ["event-relation", canonical.eventRelations], ["spatial", canonical.spatialRelations], ["scene", canonical.sceneOccurrences], ["frame", canonical.eventFrames], ["action", canonical.actionSchemas], ["constraint", canonical.actionConstraints], ["norm", canonical.normTemplates], ["process", canonical.processTemplates], ["rule", canonical.rules], ["goal", canonical.goals], ["possibility", canonical.possibilities],
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
  for (const resolution of snapshot.entityResolutions) add("entity-resolution", resolution.id, resolution);
  for (const resolution of snapshot.eventResolutions) add("event-resolution", resolution.id, resolution);
  for (const binding of snapshot.evidenceBindings) add("evidence", `${binding.artifactKind}/${binding.artifactId}`, binding);
  const link = (node: Node, kind: ClosureKind, id: string) => {
    if (node.kind === kind && node.id === id) return;
    const target = nodes.get(key({ kind, id }));
    if (!node.dependsOn.some((x) => x.kind === kind && x.id === id)) node.dependsOn.push({ kind, id, ...(target ? { revisionHash: target.revisionHash } : {}) });
    if (!target) issues.push({ code: "CLOSURE_DANGLING_REFERENCE", message: `${key(node)} requires missing ${kind}/${id}`, path: key(node) });
  };
  const fields = new Map(DEFAULT_STATE_FIELDS.map((field) => [field.key, field]));
  const visit = (node: Node, value: unknown, channel?: "norm" | "process") => {
    if (Array.isArray(value)) { for (const item of value) visit(node, item, channel); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [name, item] of Object.entries(record)) {
      // Literals, descriptions and arbitrary legacy claim objects do not declare references.
      if (["evidence", "counterEvidence", "derivation", "parameters", "description", "summary", "rationale", "interpretation", "object", "value", "characterEntryCheckpoints", "projectionSeed"].includes(name)) {
        if (name === "object" && item && typeof item === "object" && (item as { kind?: string }).kind) visit(node, item, channel);
        if (name === "value" && typeof record.field === "string") {
          const spec = fields.get(record.field);
          if (spec?.valueType === "entity-ref" && typeof item === "string") link(node, "entity", item);
          if (spec?.valueType === "entity-ref-set" && Array.isArray(item)) for (const id of item) if (typeof id === "string") link(node, "entity", id);
        }
        continue;
      }
      const targetKind = referenceFields[name] ?? (name === "templateId" ? channel : undefined);
      if (targetKind) {
        if (typeof item === "string") link(node, targetKind, item);
        else if (Array.isArray(item)) for (const id of item) if (typeof id === "string") link(node, targetKind, id);
      }
      visit(node, item, ["norm", "norms", "proposedNorms"].includes(name) ? "norm" : ["process", "processes", "proposedProcesses"].includes(name) ? "process" : channel);
    }
  };
  for (const node of nodes.values()) {
    const payload = payloads.get(key(node));
    if (node.kind !== "source") link(node, "source", bundle.source.id);
    // Entry branch-semantic IDs are validated by the production seed reducer, not canonical lookup.
    if (!["evidence", "unit"].includes(node.kind)) visit(node, node.kind === "initial" ? { delta: canonical.initialWorld.delta } : payload);
    if (node.kind === "claim") {
      const claim = canonical.claims.find((x) => x.id === node.id)!;
      link(node, "entity", claim.subject); if (claim.speaker) link(node, "entity", claim.speaker);
      if (typeof claim.object === "string" && nodes.has(`entity/${claim.object}`)) link(node, "entity", claim.object);
    }
  }
  for (const annotation of snapshot.annotations) {
    const node = nodes.get(`annotation/${annotation.id}`)!;
    // Only annotations with schema-valid anchors enter production snapshots.
    if (!("sourceId" in annotation)) continue;
    for (const anchor of annotationAnchors(annotation)) for (const unit of baseUnits) {
      if (anchor.startByte < unit.anchor.endByte && anchor.endByte > unit.anchor.startByte) link(node, "unit", unit.id);
    }
  }
  const artifactKinds: Readonly<Record<string, ClosureKind>> = { entity: "entity", proposition: "proposition", attribution: "attribution", claim: "claim", event: "event", "canonical-event": "event", "event-participation": "participation", "event-relation": "event-relation", "spatial-relation": "spatial", "scene-occurrence": "scene", "event-frame": "frame", "action-schema": "action", "action-constraint": "constraint", "norm-template": "norm", "process-template": "process", rule: "rule", "world-rule": "rule", goal: "goal", "character-goal": "goal", model: "model", "character-model": "model", possibility: "possibility", "initial-world": "initial" };
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
  for (const event of canonical.events) for (const checkpoint of event.characterEntryCheckpoints ?? []) {
    const id = `${checkpoint.actorId}/${event.id}`;
    add("entry", id, checkpoint);
    const node = nodes.get(`entry/${id}`)!;
    link(node, "event", event.id); link(node, "entity", checkpoint.actorId); link(node, "initial", bundle.source.id);
    if (snapshot.roleRoster) link(node, "roster", bundle.source.id);
    visit(node, { delta: checkpoint.delta, participantPresence: checkpoint.participantPresence });
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
  return affectedClosureNodes(graph, [...changed, ...current.nodes.filter((node) => !known.has(key(node)))]);
}
