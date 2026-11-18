import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestWorkspaceSource } from "../../src/commands/ingest.js";
import { ScriptedStageAgent, type ScriptedCall, type StageAgentInput } from "../../src/compiler/pipeline/agent.js";
import type { StageContext } from "../../src/compiler/pipeline/runner.js";
import { PipelineStore } from "../../src/compiler/pipeline/store.js";
import { censusStage } from "../../src/compiler/pipeline/census.js";
import { observationStage } from "../../src/compiler/pipeline/observation.js";
import { runStage } from "../../src/compiler/pipeline/runner.js";

/** Original micro novel (no third-party text). */
export const BELL_TOWER = [
  "第一章 钟楼",
  "",
  "林岐站在钟楼下。“第七声钟就要响了。”林岐说。",
  "墨砚跑过来。“银钥在哪里？”墨砚问。",
  "“在我这里。”林岐说，“你拿去吧。”",
  "墨砚接过银钥。“谢谢你。”墨砚说。",
  "他带着墨砚走向北门。",
  "“快走！”林岐说。“好。”墨砚说。",
  "",
].join("\n");

export async function pipelineWorkspace(text = BELL_TOWER) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pipeline-"));
  const file = path.join(root, "novel.txt");
  await fs.writeFile(file, text);
  const { document } = await ingestWorkspaceSource(root, file);
  return { root, source: document, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export function stageContext(root: string, sourceId: string, script: (input: StageAgentInput, call: ScriptedCall) => Promise<void>, limit = Number.MAX_SAFE_INTEGER): StageContext & { agent: ScriptedStageAgent } {
  return { root, sourceId, limit, agent: new ScriptedStageAgent(script), store: new PipelineStore(root, sourceId), runId: "run-test", generatedBy: { provider: "test", model: "scripted" }, report: () => undefined };
}

/** Call a tool and fail loudly if it errors or reports item failures. */
export async function must(call: ScriptedCall, name: string, input: unknown): Promise<any> {
  const result = await call(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.text}`);
  const failed = (result.details as { failed?: unknown[] } | null)?.failed;
  if (failed?.length) throw new Error(`${name} item failures: ${JSON.stringify(failed)}`);
  return result.details;
}

export const BELL_TOWER_CLASSES: Record<string, string> = { 林岐: "person", 墨砚: "person", 钟楼: "location", 北门: "location" };

export const unitsOf = (prompt: string) => [...prompt.matchAll(/^\[(u\d+)\] (.*)$/gmu)].map((match) => ({ unit: match[1]!, text: match[2]! }));

export function censusScript(classes = BELL_TOWER_CLASSES) {
  return async (input: StageAgentInput, call: ScriptedCall) => {
    const items = [...input.prompt.matchAll(/^(c-[a-f0-9]+) \| ([^|]+) \|/gmu)].map((match) => ({ candidate: match[1]!, class: classes[match[2]!.trim()] ?? "non-entity", rationale: "Test classification." }));
    if (items.length) await must(call, "classify_census_candidates", { items });
    await must(call, "finish_scope", {});
  };
}

/** Accept every host candidate (speaker from the cue), close the heading, add the 他 pronoun and the walk event, segment the scene. */
export function observationScript(options: { skipFirstSpeech?: () => boolean } = {}) {
  return async (input: StageAgentInput, call: ScriptedCall) => {
    const open = await must(call, "list_open_candidates", {});
    const firstSpeech = open.candidates.find((item: { kind: string }) => item.kind === "speech")?.id;
    const items = open.candidates.filter((item: { id: string }) => !(options.skipFirstSpeech?.() && item.id === firstSpeech))
      .map((item: { id: string; kind: string; cue?: string }) => item.kind === "speech" ? { id: item.id, verdict: "accept", ...(item.cue ? { speaker: "cue" } : {}) } : { id: item.id, verdict: "accept" });
    if (items.length) await must(call, "review_observation_candidates", { items });
    const lines = unitsOf(input.prompt);
    const heading = lines.find((line) => line.text.startsWith("第一章"));
    if (heading) await must(call, "account_units", { items: [{ unit: heading.unit, status: "paratext", rationale: "Chapter heading." }] });
    const walk = lines.find((line) => line.text.startsWith("他带着"));
    if (walk) {
      const pronoun = await must(call, "propose_entity_mentions", { items: [{ span: { unit: walk.unit, text: "他" }, form: "pronoun", kinds: ["character"], interpretation: "林岐." }] });
      const annotations = await must(call, "list_window_annotations", { type: "entity-mention" });
      const mo = annotations.find((item: { unit: string; text: string }) => item.unit === walk.unit && item.text === "墨砚");
      await must(call, "propose_event_mentions", { items: [{ trigger: { unit: walk.unit, text: "走向" }, extent: { from: walk.unit, to: walk.unit }, types: ["movement"], salience: "major", participants: [...pronoun.created, ...(mo ? [mo.id] : [])] }] });
    }
    const narrative = lines.filter((line) => line !== heading);
    if (narrative.length) await must(call, "propose_discourse_segments", { items: [{ extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, kind: "scene" }] });
    await call("finish_scope", {});
  };
}

export async function observedWorkspace(text = BELL_TOWER) {
  const workspace = await pipelineWorkspace(text);
  await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript()));
  const observed = await runStage(observationStage, stageContext(workspace.root, workspace.source.id, observationScript()));
  if (observed.held.length) throw new Error(`observation held: ${observed.held.join(", ")}`);
  return workspace;
}

const IDENTITY_ENTITIES: Record<string, { id: string; kind: string }> = { 林岐: { id: "char-lin-qi", kind: "character" }, 墨砚: { id: "char-mo-yan", kind: "character" }, 北门: { id: "loc-north-gate", kind: "location" }, 钟楼: { id: "loc-bell-tower", kind: "location" } };

export function identityScriptFor(entities = IDENTITY_ENTITIES) {
  return async (input: StageAgentInput, call: ScriptedCall) => {
    if (input.scopeId.includes("-lexicon-")) {
      const surfaces = [...input.prompt.matchAll(/^([^\s|]+) \| (\w[\w-]*) \| \d+ \|/gmu)].map((match) => match[1]!);
      const known = surfaces.filter((surface) => entities[surface]);
      if (known.length) await must(call, "propose_entities", { items: known.map((surface) => ({ id: entities[surface]!.id, kind: entities[surface]!.kind, canonicalName: surface })) });
      await must(call, "decide_lexicon_entries", { items: surfaces.map((surface) => entities[surface]
        ? { surface, verdict: "entity", entity: entities[surface]!.id, aliasType: "name", rationale: "The text names this one referent." }
        : { surface, verdict: "non-referential", rationale: "Not a name here." }) });
    } else {
      const open = [...input.prompt.matchAll(/^(em-\d+-\d+) \[u\d+\] pronoun "他"/gmu)].map((match) => match[1]!);
      if (open.length) await must(call, "resolve_mentions", { items: open.map((mention) => ({ mention, status: "resolved", entity: "char-lin-qi", rationale: "He leads 墨砚." })) });
    }
    await call("finish_scope", {});
  };
}

export async function identifiedWorkspace(text = BELL_TOWER) {
  const workspace = await observedWorkspace(text);
  const { identityStage } = await import("../../src/compiler/pipeline/identity.js");
  const identified = await runStage(identityStage, stageContext(workspace.root, workspace.source.id, identityScriptFor()));
  if (identified.held.length) throw new Error(`identity held: ${identified.held.join(", ")}`);
  return workspace;
}

/** Scene script: one scene at the bell tower; beats for the walk and, unless omitted, the two conversations. */
export function scenesScript(options: { conversations?: () => boolean } = {}) {
  return async (input: StageAgentInput, call: ScriptedCall) => {
    // Places the census did not list (two occurrences each): annotate and create them here (cross-stage writes, decision D3).
    const placeLines = unitsOf(input.prompt);
    const tower = placeLines.find((line) => line.text.startsWith("林岐站在钟楼"))!, gate = placeLines.find((line) => line.text.startsWith("他带着"))!;
    if (!input.prompt.includes("loc-bell-tower (location)")) {
      await must(call, "propose_entity_mentions", { items: [{ span: { unit: tower.unit, text: "钟楼" }, form: "proper", kinds: ["location"] }, { span: { unit: gate.unit, text: "北门" }, form: "proper", kinds: ["location"] }] });
      await must(call, "propose_entities", { items: [{ id: "loc-bell-tower", kind: "location", canonicalName: "钟楼" }, { id: "loc-north-gate", kind: "location", canonicalName: "北门" }] });
    }
    await must(call, "propose_scene", { location: "loc-bell-tower", present: ["char-lin-qi", "char-mo-yan"], viewpoint: [] });
    const walk = [...input.prompt.matchAll(/^(ev-\d+-\d+) \[u\d+\] "走向"/gmu)][0]![1]!;
    await must(call, "propose_beats", { items: [{ id: "event-walk-north-gate", title: "林岐带墨砚走向北门", mentions: [walk],
      participants: [{ entity: "char-lin-qi", role: "agent" }, { entity: "char-mo-yan", role: "theme" }],
      effects: [{ op: "set", entityId: "char-lin-qi", field: "character.location", value: "loc-north-gate" }, { op: "set", entityId: "char-mo-yan", field: "character.location", value: "loc-north-gate" }],
      storyTime: { kind: "ordinal", label: "第七声钟前", orderHint: 2 } }] });
    if (options.conversations?.() !== false) {
      const lines = unitsOf(input.prompt);
      const ask = lines.find((line) => line.text.startsWith("墨砚问"))!, thanks = lines.find((line) => line.text.startsWith("墨砚说"))!;
      const first = lines.find((line) => line.text.startsWith("林岐站在"))!;
      const last = lines.at(-1)!, go = lines.find((line) => line.text === "“快走！”")!;
      const created = await must(call, "propose_event_mentions", { items: [
        { trigger: { unit: ask.unit, text: "问" }, extent: { from: first.unit, to: thanks.unit }, types: ["communication"], salience: "major" },
        { trigger: { unit: last.unit, text: "说" }, extent: { from: go.unit, to: last.unit }, types: ["communication"], salience: "supporting" },
      ] });
      await must(call, "propose_beats", { items: [
        { id: "event-ask-for-key", title: "墨砚向林岐讨要银钥", mentions: [created.created[0]], participants: [{ entity: "char-mo-yan", role: "agent" }, { entity: "char-lin-qi", role: "patient" }],
          noChange: "The exchange is spoken; the handover of the key is not tracked as state in this scene.", storyTime: { kind: "ordinal", label: "第七声钟前", orderHint: 1 } },
        { id: "event-hurry", title: "林岐催促出发", mentions: [created.created[1]], participants: [{ entity: "char-lin-qi", role: "agent" }, { entity: "char-mo-yan", role: "patient" }],
          noChange: "An exhortation only.", storyTime: { kind: "ordinal", label: "第七声钟前", orderHint: 3 } },
      ] });
    }
    await call("finish_scope", {});
  };
}

export async function scenedWorkspace(text = BELL_TOWER) {
  const workspace = await identifiedWorkspace(text);
  const { scenesStage } = await import("../../src/compiler/pipeline/scenes.js");
  const scened = await runStage(scenesStage, stageContext(workspace.root, workspace.source.id, scenesScript()));
  if (scened.held.length) throw new Error(`scenes held: ${scened.held.join(", ")}`);
  return workspace;
}

/** World script: a stated route for each location, a reviewed unconditioned key event, and one source-statement norm. */
export function worldScript() {
  return async (input: StageAgentInput, call: ScriptedCall) => {
    const items = [...input.prompt.matchAll(/^((?:location|key-event|autonomy|pair|actor|lore|knowledge):[^:\s]+):/gmu)].map((match) => match[1]!);
    const found = await must(call, "search_source", { query: "走向北门" });
    const walk = found.units[0];
    for (const item of items) {
      if (item.startsWith("location:")) {
        await must(call, "propose_artifacts", { items: [{ kind: "spatial-relation", payload: { ontologyVersion: "spatial-v1", id: "route-bell-tower-north-gate", kind: "route", basis: "explicit", visibility: "public",
          status: "supported", confidence: 0.8, fromLocationId: "loc-bell-tower", toLocationId: "loc-north-gate", direction: "two-way", modes: ["foot"] }, evidence: [{ unit: walk.unit, text: "走向北门" }] }] });
      } else if (item.startsWith("key-event:")) {
        await must(call, "record_dispositions", { items: [{ measure: "causality.conditioned-key-events", subject: item.replace("key-event:", "event:"), verdict: "unconditioned", rationale: "Nothing in the text gates the walk." }] });
      } else if (item.startsWith("autonomy:")) {
        const hurry = (await must(call, "search_source", { query: "快走" })).units[0];
        await must(call, "propose_artifacts", { items: [{ kind: "norm-template", payload: { ontologyVersion: "norm-template-v1", id: "norm-leave-before-seventh-bell", name: "Leave before the seventh bell", modality: "obligation",
          actionPattern: { kind: "schema", schemaId: "base-action-move" }, appliesWhen: [], exceptions: [], reparations: [], priority: 1, defeasible: true, overridesTemplateIds: [], status: "supported", visibility: "public", knownByClaimIds: [],
          induction: { kind: "source-statement", statement: "林岐催促：快走！" } }, evidence: [{ unit: hurry.unit, text: "“快走！”" }] }] });
      }
    }
    await call("finish_scope", {});
  };
}

/** One agent for the whole chain: dispatch the bell-tower scripts by stage. */
export function bellTowerAgent() {
  const scripts: Record<string, (input: StageAgentInput, call: ScriptedCall) => Promise<void>> = {
    census: censusScript(), observation: observationScript(), identity: identityScriptFor(), scenes: scenesScript(), world: worldScript(),
    roster: async (input, call) => {
      const ids = [...input.prompt.matchAll(/^(char-[\w-]+) \|/gmu)].map((match) => match[1]!);
      await must(call, "review_roster", { majors: ids, missing: [], rationale: "Both drive the only scene." });
      await call("finish_scope", {});
    },
    opening: async (input, call) => {
      const first = unitsOf(input.prompt).find((line) => line.text.startsWith("林岐站在"));
      const units = first ? [first] : (await must(call, "search_source", { query: "林岐站在" })).units.map((unit: { unit: string; text: string }) => ({ unit: unit.unit, text: unit.text }));
      await must(call, "propose_initial_world", { readerSetup: "第七声钟将响，林岐守在钟楼下。", presence: [{ entity: "char-lin-qi", mode: "physical" }], positions: [{ entity: "char-lin-qi", location: "loc-bell-tower" }],
        evidence: [{ unit: units[0].unit, text: "林岐站在钟楼下" }] });
      await call("finish_scope", {});
    },
    gaps: async (_input, call) => { await call("finish_scope", {}); },
  };
  return new ScriptedStageAgent(async (input, call) => scripts[input.stage]!(input, call));
}

type GoldClass = "person" | "location" | "object";
const HEADING = /^(?:第.{1,4}[章回幕]|《)/u;

/**
 * Generic heuristic agent for any micro novel. It classifies census candidates
 * by basis, adds the given entity surfaces the census missed (as a model adds
 * names the host could not find), accepts host candidates, treats each window
 * as one scene with one covering event, and answers world items only with
 * legal reviewed dispositions, or a source-statement norm where the text says
 * 禁止 / 义务 / 必须. It never states what the text does not, so closure
 * reports whatever it leaves open.
 */
export function heuristicAgent(surfaces: Record<string, GoldClass>) {
  const entityId = (kind: string, surface: string) => `${kind === "character" ? "char" : kind === "location" ? "loc" : "obj"}-${Buffer.from(surface).toString("hex").slice(0, 12)}`;
  const kindOf = (cls: string) => cls === "person" ? "character" : cls === "location" ? "location" : cls === "object" ? "artifact" : cls === "organization" ? "faction" : "concept";
  return new ScriptedStageAgent(async (input, call) => {
    const units = unitsOf(input.prompt);
    const entities = [...input.prompt.matchAll(/^([\w-]+) \((\w+)\) (.+)$/gmu)].map((match) => ({ id: match[1]!, kind: match[2]!, name: match[3]!.trim() }));
    switch (input.stage) {
      case "census": {
        const items = [...input.prompt.matchAll(/^(c-[a-f0-9]+) \| ([^|]+) \| (\d+) \| (\d+) \|/gmu)].map((match) => ({ candidate: match[1]!,
          class: surfaces[match[2]!.trim()] ?? (Number(match[4]) > 0 ? "person" : "non-entity"), rationale: "Heuristic." }));
        if (items.length) await call("classify_census_candidates", { items });
        if (input.scopeId.endsWith("-p0")) for (const [surface, cls] of Object.entries(surfaces)) {
          const found = (await call("search_source", { query: surface })).details as { units: Array<{ unit: string }> } | null;
          if (found?.units[0]) await call("add_census_entries", { items: [{ unit: found.units[0].unit, text: surface, class: cls, rationale: "Named in the text." }] });
        }
        break;
      }
      case "observation": {
        const open = (await call("list_open_candidates", {})).details as { candidates: Array<{ id: string; kind: string; cue?: string; unit?: string }> };
        const persons = Object.entries(surfaces).filter(([, cls]) => cls === "person").map(([surface]) => surface);
        const items = open.candidates.map((item) => {
          if (item.kind !== "speech") return { id: item.id, verdict: "accept" };
          if (item.cue) return { id: item.id, verdict: "accept", speaker: "cue" };
          // The nearest earlier person name in the unit or the one before it speaks.
          const index = units.findIndex((line) => line.unit === item.unit);
          for (const line of [units[index], units[index - 1]].filter(Boolean)) {
            const name = persons.filter((surface) => line!.text.includes(surface)).sort((a, b) => line!.text.lastIndexOf(b) - line!.text.lastIndexOf(a))[0];
            if (name) return { id: item.id, verdict: "accept", speaker: { unit: line!.unit, text: name, form: "proper" } };
          }
          return { id: item.id, verdict: "accept" };
        });
        if (items.length) await call("review_observation_candidates", { items });
        // Names the census did not list: annotate every occurrence, as a model adds what the host missed.
        const existing = (await call("list_window_annotations", { type: "entity-mention" })).details as Array<{ unit: string; text: string }>;
        const add: Array<{ span: { unit: string; text: string; nth: number }; form: string; kinds: string[] }> = [];
        for (const line of units) for (const [surface, cls] of Object.entries(surfaces)) {
          const count = line.text.split(surface).length - 1;
          const have = existing.filter((item) => item.unit === line.unit && item.text === surface).length;
          for (let nth = have + 1; nth <= count; nth += 1) add.push({ span: { unit: line.unit, text: surface, nth }, form: "proper", kinds: [kindOf(cls)] });
        }
        if (add.length) await call("propose_entity_mentions", { items: add });
        const headings = units.filter((line) => HEADING.test(line.text));
        if (headings.length) await call("account_units", { items: headings.map((line) => ({ unit: line.unit, status: "paratext", rationale: "Title or chapter heading." })) });
        const narrative = units.filter((line) => !HEADING.test(line.text));
        if (narrative.length) {
          await call("propose_discourse_segments", { items: [{ extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, kind: "scene" }] });
          await call("propose_event_mentions", { items: [{ trigger: { unit: narrative[0]!.unit, text: Array.from(narrative[0]!.text)[0]! }, extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, types: ["other"], salience: "major" }] });
        }
        break;
      }
      case "identity": {
        if (input.scopeId.includes("-lexicon-")) {
          const rows = [...input.prompt.matchAll(/^([^\s|]+) \| (\w[\w-]*) \| \d+ \|/gmu)].map((match) => ({ surface: match[1]!, cls: match[2]! }));
          const real = rows.filter((row) => !["non-entity", "time"].includes(row.cls));
          const fresh = real.filter((row) => !entities.some((entity) => entity.name === row.surface));
          if (fresh.length) await call("propose_entities", { items: fresh.map((row) => ({ id: entityId(kindOf(row.cls), row.surface), kind: kindOf(row.cls), canonicalName: row.surface })) });
          await call("decide_lexicon_entries", { items: rows.map((row) => real.includes(row)
            ? { surface: row.surface, verdict: "entity", entity: entityId(kindOf(row.cls), row.surface), aliasType: "name", rationale: "Named in the text." }
            : { surface: row.surface, verdict: "non-referential", rationale: "Not a name." }) });
        } else {
          const open = [...input.prompt.matchAll(/^(em-\d+-\d+) \[u\d+\] (\w+) "(.+)"$/gmu)].map((match) => ({ mention: match[1]!, form: match[2]!, surface: match[3]! }));
          // A named person or place without an entity yet: create it (the host resolves its first mention), then bind the rest by name.
          const fresh = [...new Set(open.filter((item) => item.form === "proper" && surfaces[item.surface] && !entities.some((entity) => entity.name === item.surface)).map((item) => item.surface))];
          if (fresh.length) {
            await call("propose_entities", { items: fresh.map((surface) => ({ id: entityId(kindOf(surfaces[surface]!), surface), kind: kindOf(surfaces[surface]!), canonicalName: surface })) });
            for (const surface of fresh) entities.push({ id: entityId(kindOf(surfaces[surface]!), surface), kind: kindOf(surfaces[surface]!), name: surface });
          }
          const firsts = new Set(fresh.map((surface) => open.find((item) => item.surface === surface)!.mention));
          const items = open.filter((item) => !firsts.has(item.mention)).map((item) => {
            const entity = entities.find((candidate) => candidate.name === item.surface);
            return entity ? { mention: item.mention, status: "resolved", entity: entity.id, rationale: "Same name." } : { mention: item.mention, status: "non-referential", rationale: "Heuristic agent cannot bind it." };
          });
          if (items.length) await call("resolve_mentions", { items });
        }
        break;
      }
      case "scenes": {
        const text = units.map((line) => line.text).join("");
        const present = entities.filter((entity) => entity.kind === "character" && text.includes(entity.name)).map((entity) => entity.id);
        const place = entities.find((entity) => entity.kind === "location" && text.includes(entity.name));
        await call("propose_scene", { ...(place ? { location: place.id } : { locationUnknown: "The heuristic agent found no named place." }), present });
        const mentions = [...input.prompt.matchAll(/^(ev-\d+-\d+) \[u\d+\]/gmu)].map((match) => match[1]!);
        const participants = present.map((id, index) => ({ entity: id, role: index === 0 ? "agent" : "patient" }));
        if (mentions.length && participants.length) await call("propose_beats", { items: mentions.map((mention, index) => ({ id: `beat-${input.scopeId.slice(-24)}-${index}`.replace(/[^A-Za-z0-9._-]/gu, "-"), title: `Beat ${index + 1}`, mentions: [mention],
          participants, noChange: "Heuristic agent: no state change asserted.", storyTime: { kind: "ordinal", label: input.scopeId, orderHint: index } })) });
        break;
      }
      case "world": {
        const items = [...input.prompt.matchAll(/^((?:lore|location|pair|actor|key-event|autonomy|knowledge):[^:\s]+):/gmu)].map((match) => match[1]!);
        const dispositions = items.flatMap((item) => {
          const [kind, subject] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
          if (kind === "lore") return [{ measure: "lore.terms-grounded", subject: `term:${subject}`, verdict: "narration-only", rationale: "Heuristic." }];
          if (kind === "location") return [{ measure: "space.locations-on-graph", subject: `location:${subject}`, verdict: "unknown", rationale: "Heuristic." }];
          if (kind === "pair") return [{ measure: "relations.roster-pairs", subject: `pair:${subject}`, verdict: "not-stated", rationale: "Heuristic." }];
          if (kind === "key-event") return [{ measure: "causality.conditioned-key-events", subject: `event:${subject}`, verdict: "unconditioned", rationale: "Heuristic." }];
          if (kind === "actor") return ["characters.speaking-modelled", "characters.speaking-with-disposition", "characters.speaking-with-goal", "agency.effectful-goals"].map((measure) => ({ measure, subject: `actor:${subject}`, verdict: "not-stated", rationale: "Heuristic." }));
          return [];
        });
        if (dispositions.length) await call("record_dispositions", { items: dispositions });
        if (items.includes("autonomy:source")) {
          for (const word of ["禁止", "义务", "必须"]) {
            const found = (await call("search_source", { query: word })).details as { units: Array<{ unit: string; text: string }> } | null;
            const unit = found?.units[0];
            if (!unit) continue;
            await call("propose_artifacts", { items: [{ kind: "norm-template", payload: { ontologyVersion: "norm-template-v1", id: `norm-${Buffer.from(word).toString("hex")}`, name: `Stated ${word}`, modality: word === "禁止" ? "prohibition" : "obligation",
              actionPattern: { kind: "any" }, appliesWhen: [], exceptions: [], reparations: [], priority: 1, defeasible: true, overridesTemplateIds: [], status: "supported", visibility: "public", knownByClaimIds: [],
              induction: { kind: "source-statement", statement: unit.text.slice(0, 200) } }, evidence: [{ unit: unit.unit, text: word }] }] });
            break;
          }
        }
        break;
      }
      case "roster": {
        const ids = [...input.prompt.matchAll(/^([\w-]+) \|/gmu)].map((match) => match[1]!).filter((id) => id !== "Candidates");
        await call("review_roster", { majors: ids, missing: [], rationale: "Heuristic: every candidate." });
        break;
      }
      case "opening": {
        const first = units.find((line) => !HEADING.test(line.text) && line.text.trim());
        const opening = units.map((line) => line.text).join("");
        const present = entities.filter((entity) => entity.kind === "character" && opening.includes(entity.name));
        const place = entities.find((entity) => entity.kind === "location");
        if (first && present.length) await call("propose_initial_world", { presence: present.map((entity) => ({ entity: entity.id, mode: "physical" })),
          positions: place ? present.map((entity) => ({ entity: entity.id, location: place.id })) : [], evidence: [{ unit: first.unit, text: Array.from(first.text).slice(0, 4).join("") }] });
        break;
      }
      default: break;
    }
    await call("finish_scope", {});
  });
}
