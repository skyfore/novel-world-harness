import { Type } from "typebox";
import { z } from "zod";
import { idSchema } from "../../world/model.js";
import { DEFAULT_COMPLETENESS_POLICY, measureWorldCompleteness } from "../world-completeness.js";
import { gateOf, type StageDefinition } from "./runner.js";
import type { RosterDocument } from "./store.js";
import { pipelineTool, T } from "./tooling.js";
import { loadPipelineView, type PipelineView } from "./view.js";

/**
 * Light roster (design 5.7). Candidates come from source statistics:
 * speaking characters, the most frequent event agents and viewpoint
 * characters. One bounded independent review sees only those statistics and
 * sampled passages, never the compiled character models, and answers two
 * questions: who among them is a major role, and who major is missing. A
 * missing major stays in the denominator even without an entity.
 */
export const ROSTER_AGENT_CANDIDATES = 12;

export function rosterCandidates(view: PipelineView, limit: number): RosterDocument["candidates"] {
  // Raw attributed lines for every character; "speaking" basis only at the policy threshold.
  const report = measureWorldCompleteness(view.bundle, view.bytes, { ...view.options, scope: { startByte: 0, endByte: limit }, policy: { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1 } });
  const names = new Map(view.bundle.canonical.entities.map((entity) => [entity.id, entity.canonicalName]));
  const characters = new Set(view.bundle.canonical.entities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
  const candidates = new Map<string, RosterDocument["candidates"][number]>();
  const add = (actorId: string, basis: "speaking" | "agent" | "viewpoint", lines = 0, agentEvents = 0) => {
    if (!characters.has(actorId)) return;
    const entry = candidates.get(actorId) ?? { actorId, name: names.get(actorId) ?? actorId, lines: 0, agentEvents: 0, basis: [] };
    entry.lines = Math.max(entry.lines, lines); entry.agentEvents = Math.max(entry.agentEvents, agentEvents);
    if (!entry.basis.includes(basis)) entry.basis.push(basis);
    candidates.set(actorId, entry);
  };
  const lines = new Map(report.speakingCharacters.map((item) => [item.actorId, item.lines]));
  for (const item of report.speakingCharacters) if (item.lines >= DEFAULT_COMPLETENESS_POLICY.speakingLineThreshold) add(item.actorId, "speaking", item.lines);
  const agents = new Map<string, number>();
  for (const item of view.bundle.canonical.eventParticipations) if (item.role === "agent") agents.set(item.entityId, (agents.get(item.entityId) ?? 0) + 1);
  for (const [actorId, count] of [...agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, ROSTER_AGENT_CANDIDATES)) add(actorId, "agent", 0, count);
  for (const scene of view.bundle.canonical.sceneOccurrences) for (const actorId of scene.viewpointActorIds) add(actorId, "viewpoint");
  for (const [actorId, count] of agents) if (candidates.has(actorId)) candidates.get(actorId)!.agentEvents = count;
  for (const [actorId, count] of lines) if (candidates.has(actorId)) candidates.get(actorId)!.lines = count;
  return [...candidates.values()].sort((a, b) => b.lines - a.lines || b.agentEvents - a.agentEvents || a.actorId.localeCompare(b.actorId));
}

const reviewInput = z.object({
  majors: z.array(idSchema).max(64),
  missing: z.array(z.object({ name: z.string().trim().min(1).max(80), rationale: z.string().trim().min(1).max(500), unit: z.string().optional() }).strict()).max(32).default([]),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

export const rosterStage: StageDefinition = {
  stage: "roster",
  plan(ctx) {
    return [{ id: `roster-${ctx.sourceId}-review`, range: { startByte: 0, endByte: ctx.limit }, items: [], title: "independent roster review" }];
  },
  async prepare(ctx) {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    const candidates = rosterCandidates(view, ctx.limit);
    const current = await ctx.store.roster();
    // New candidates invalidate an old review: the reviewer must see the denominator as it now stands.
    const same = current && JSON.stringify(current.candidates.map((item) => item.actorId).sort()) === JSON.stringify(candidates.map((item) => item.actorId).sort());
    await ctx.store.writeRoster({ version: 1, candidates, ...(same && current?.review ? { review: current.review } : {}) });
  },
  prompt(ctx, view) {
    const candidates = view.roster?.candidates ?? [];
    const text = Buffer.from(view.bytes.buffer, view.bytes.byteOffset, Math.min(view.bytes.byteLength, ctx.limit)).toString("utf8");
    const samples = (name: string) => {
      const out: string[] = [];
      for (let at = text.indexOf(name), count = 0; at >= 0 && count < 2; at = text.indexOf(name, at + name.length * 40), count += 1) out.push(text.slice(Math.max(0, at - 40), at + 60).replace(/\s+/gu, " "));
      return out.map((item) => `…${item}…`).join(" / ");
    };
    return [
      "Independent roster review. You see only source statistics and sampled passages, not any compiled character model. Answer two questions with review_roster:",
      "1. Which candidates are major roles of this text (drive events, recur, have their own goals)? 2. Is any major character missing from the candidates (name them, with a unit if you can)?",
      "Then call finish_scope.",
      "Candidates (id | name | attributed lines | events as agent | basis | samples):",
      ...candidates.map((item) => `${item.actorId} | ${item.name} | ${item.lines} | ${item.agentEvents} | ${item.basis.join("+")} | ${samples(item.name)}`),
    ].join("\n");
  },
  tools(ctx, scope) {
    return [pipelineTool({
      name: "review_roster", label: "Review roster", description: "Record the independent roster review: major candidate ids, missing majors by name, and the rationale.",
      parameters: Type.Object({ majors: Type.Array(Type.String()), missing: Type.Optional(Type.Array(Type.Object({ name: Type.String(), rationale: T.rationale(), unit: Type.Optional(Type.String()) }, { additionalProperties: false }))), rationale: T.rationale() }, { additionalProperties: false }),
      input: reviewInput,
      async execute(input) {
        const roster = await ctx.store.roster();
        if (!roster) throw new Error("No roster candidates; the host prepares them first.");
        const known = new Set(roster.candidates.map((item) => item.actorId));
        const unknown = input.majors.filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`Not candidates: ${unknown.join(", ")}; name a missing major under missing instead.`);
        await ctx.store.writeRoster({ ...roster, review: { scopeId: scope.id, reviewedAt: new Date().toISOString(), majors: input.majors,
          missing: input.missing.map((item) => ({ name: item.name, rationale: item.rationale })), rationale: input.rationale } });
        return { majors: input.majors.length, missing: input.missing.length };
      },
    })];
  },
  gate(_ctx, view) {
    return gateOf([{ id: "characters.roster-reviewed", passed: Boolean(view.roster?.review), detail: view.roster?.review ? `${view.roster.review.majors.length} majors, ${view.roster.review.missing.length} missing` : "not reviewed" }]);
  },
};

export { DEFAULT_COMPLETENESS_POLICY };
