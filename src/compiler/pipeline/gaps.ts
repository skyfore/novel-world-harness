import crypto from "node:crypto";
import type { ByteRange, WorldCompletenessReport } from "../world-completeness.js";
import { artifactTools } from "./artifacts.js";
import { convergeCanonical } from "./canon.js";
import { identityTools } from "./identity.js";
import { observationTools } from "./observation.js";
import { gateOf, type ScopePlan, type StageDefinition } from "./runner.js";
import { sceneTools } from "./scenes.js";
import { ScopeText, windowUnits } from "./text.js";
import { sourceReadingTools, worldWorkItems } from "./world.js";
import { measureView, type PipelineView } from "./view.js";

/**
 * Gap loop (design 5.8, the gap-driven flow of design.md section 6): the
 * completeness report's repair queues become bounded scopes — a source range
 * plus a target — ordered by layer dependency (observation, identity,
 * scenes, world). Any stage's tools may be used inside a scope (decision
 * D3). A scope completes when its target leaves the queue; one failing twice
 * is held and the loop moves on.
 */
export type GapItem = { key: string; layer: "observation" | "identity" | "scenes" | "world"; range: ByteRange; describe: string; segmentId?: string };
const LAYER_ORDER = ["observation", "identity", "scenes", "world"] as const;

export function gapItems(view: PipelineView, report: WorldCompletenessReport, limit: number): GapItem[] {
  const whole = { startByte: 0, endByte: limit };
  const sceneRange = (sceneId: string): { range: ByteRange; segmentId?: string } => {
    const scene = view.bundle.canonical.sceneOccurrences.find((item) => item.id === sceneId);
    const spans = (scene?.evidence ?? []).flatMap(({ span }) => span.startByte !== undefined && span.endByte !== undefined ? [{ startByte: span.startByte, endByte: span.endByte }] : []);
    return { range: spans.length ? { startByte: Math.min(...spans.map((item) => item.startByte)), endByte: Math.max(...spans.map((item) => item.endByte)) } : whole, ...(scene?.discourseSegmentIds[0] ? { segmentId: scene.discourseSegmentIds[0] } : {}) };
  };
  const items: GapItem[] = [
    ...report.queues.hiddenUnits.ranges.map((range) => ({ key: `hidden:${range.startByte}-${range.endByte}`, layer: "observation" as const, range, describe: `Units closed as ${range.statuses.join("/")} that hide ${range.speech} speech span(s) and ${range.names} name(s): annotate them.` })),
    ...report.queues.unannotatedSpeech.ranges.map((range) => ({ key: `speech:${range.startByte}-${range.endByte}`, layer: "observation" as const, range, describe: "Direct speech without a quotation annotation: review the candidates." })),
    ...report.queues.nameCollisions.map((item) => ({ key: `collision:${item.surface}`, layer: "identity" as const, range: whole, describe: `"${item.surface}" resolves to ${item.entityIds.join(" and ")}: give ranged decisions or per-mention resolutions.` })),
    ...report.queues.unattachedAliases.map((item) => ({ key: `alias:${item.entityId}:${item.surface}`, layer: "identity" as const, range: whole, describe: `Mentions "${item.surface}" resolve to ${item.entityId} but it is not a recorded alias: decide the surface (decide_lexicon_entries) so the host attaches it.` })),
    ...report.queues.genericNames.map((item) => ({ key: `generic:${item.entityId}`, layer: "identity" as const, range: whole, describe: `Entity ${item.entityId} is named "${item.name}", a pronoun or bare noun: re-propose it with a qualifying derived label from the text.` })),
    ...report.queues.scenesWithoutLocation.map((id) => ({ key: `scene-location:${id}`, layer: "scenes" as const, ...sceneRange(id), describe: `Scene ${id} has neither a location nor a reasoned unknown.` })),
    ...report.queues.absentSpeakers.map((item) => ({ key: `absent-speaker:${item.sceneId}:${item.actorId}`, layer: "scenes" as const, ...sceneRange(item.sceneId), describe: `${item.actorId} speaks ${item.lines} line(s) in ${item.sceneId} but is not recorded present.` })),
    ...report.queues.scenesWithoutEvents.map((id) => ({ key: `scene-events:${id}`, layer: "scenes" as const, ...sceneRange(id), describe: `Scene ${id} has no beats.` })),
    ...worldWorkItems(report).map((item) => ({ key: `world:${item}`, layer: "world" as const, range: whole, describe: `World work item ${item}.` })),
  ];
  return items.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.range.startByte - b.range.startByte);
}

const scopeIdFor = (sourceId: string, key: string) => `gaps-${sourceId}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

export const gapsStage: StageDefinition = {
  stage: "gaps",
  plan(ctx, view) {
    return gapItems(view, measureView(view, { startByte: 0, endByte: ctx.limit }), ctx.limit).map((item): ScopePlan => ({
      id: scopeIdFor(ctx.sourceId, item.key), range: item.range, items: [item.key, ...(item.segmentId ? [`segment:${item.segmentId}`] : [])], title: `${item.layer}: ${item.describe}` }));
  },
  prompt(ctx, view, scope, previous) {
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    const whole = scope.range.startByte === 0 && scope.range.endByte >= ctx.limit;
    return [
      `Gap repair. Target: ${scope.title}`,
      "You may use any observation, identity, scene or world tool inside this scope. Fix exactly this target from the text, or record a reviewed conclusion where one is legal; then call finish_scope.",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Entities:", ...view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}`),
      whole ? "Use search_source / read_units to find the text." : `--- scope text ---\n${text.render()}`,
    ].filter(Boolean).join("\n");
  },
  tools(ctx, scope) {
    const segment = scope.items.find((item) => item.startsWith("segment:"))?.slice("segment:".length);
    return [
      ...observationTools(ctx, scope), ...identityTools(ctx, scope),
      ...(segment ? sceneTools(ctx, { ...scope, items: [segment] }) : []),
      ...artifactTools(ctx, scope, { startByte: 0, endByte: ctx.limit }), ...sourceReadingTools(ctx),
    ];
  },
  async commit(ctx) { return convergeCanonical(ctx); },
  gate(ctx, view, scope) {
    const key = scope.items[0]!;
    const open = gapItems(view, measureView(view, { startByte: 0, endByte: ctx.limit }), ctx.limit).some((item) => item.key === key);
    return gateOf([{ id: "gaps.target-closed", passed: !open, detail: open ? `${key} still open` : `${key} closed` }]);
  },
};
