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
