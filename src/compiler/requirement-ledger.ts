import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { evaluateSceneCapabilities, evaluateReviewedSceneCapabilities, sceneCapabilitySpecSchema, type SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { SCENE_REQUIREMENT_EVALUATOR_VERSION } from "../eval/scene-requirements.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const requirementSetSchema = z.object({
  id: idSchema, revisionHash: hash, parentRevision: hash.nullable(),
  scopeDecisionRef: text, spec: sceneCapabilitySpecSchema,
}).strict().superRefine(({ revisionHash, ...identity }, ctx) => {
  if (contentHash(identity) !== revisionHash) ctx.addIssue({ code: "custom", message: "Requirement definition hash mismatch" });
});
export type RequirementSet = z.infer<typeof requirementSetSchema>;
export const requirementResultSchema = z.object({
  setId: idSchema, revisionHash: hash, catalogHash: hash, evaluatorVersion: text,
  requirements: z.array(z.object({
    id: text, definitionHash: hash,
    state: z.enum(["satisfied", "blocked", "unknown", "unmapped", "stale"]),
    diagnostics: z.array(text), blockedBy: z.array(text),
  }).strict()).min(1),
}).strict();
export type RequirementResult = z.infer<typeof requirementResultSchema>;
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("definition"), definition: requirementSetSchema }).strict(),
  z.object({ kind: z.literal("evaluation"), result: requirementResultSchema }).strict(),
]);
const recordSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(),
  predecessorHash: hash.nullable(), payload: payloadSchema, hash,
}).strict().superRefine(({ hash: recordedHash, ...identity }, ctx) => {
  if (contentHash(identity) !== recordedHash) ctx.addIssue({ code: "custom", message: "Requirement journal hash mismatch" });
});
type LedgerRecord = z.infer<typeof recordSchema>;
const headSchema = z.object({ version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(), hash }).strict();

/** Frozen input only. Evaluations are derived, never part of their own subject hash. */
export const frozenRequirementSetsSchema = z.array(requirementSetSchema).superRefine((sets, ctx) => {
  if (new Set(sets.map(set => set.id)).size !== sets.length) ctx.addIssue({ code: "custom", message: "Duplicate requirement set identity" });
});

export const requirementDefinitionHistorySchema = z.array(requirementSetSchema).superRefine((history, ctx) => {
  const active = new Map<string, RequirementSet>();
  for (const set of history) {
    if (set.parentRevision !== (active.get(set.id)?.revisionHash ?? null)) ctx.addIssue({ code: "custom", message: "Requirement definition history is incomplete" });
    active.set(set.id, set);
  }
});
export function activeRequirementSets(history: readonly RequirementSet[]): RequirementSet[] {
  const active = new Map<string, RequirementSet>();
  for (const set of requirementDefinitionHistorySchema.parse(history)) active.set(set.id, set);
  return [...active.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function sceneCatalogHash(catalog: SceneReviewCatalog): string {
  // Fix the vocabulary; callers with a larger validator catalog must hash the
  // exact same consumer inputs as a frozen bundle, not unrelated Map fields.
  return contentHash(Object.fromEntries(sceneCatalogKeys.map(key =>
    [key, [...(catalog[key]?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id))])));
}
export const sceneCatalogKeys = ["entities", "events", "eventParticipations", "actionSchemas", "eventExecutions", "normTemplates", "rules", "claims", "propositions", "attributions"] as const;

export function evaluateRequirementSet(setInput: RequirementSet, bytes: Uint8Array, catalog: SceneReviewCatalog): RequirementResult {
  const set = requirementSetSchema.parse(setInput);
  const report = evaluateSceneCapabilities(set.spec, bytes, catalog);
  return resultFromReport(set, report, catalog);
}
function resultFromReport(set: RequirementSet, report: ReturnType<typeof evaluateReviewedSceneCapabilities>, catalog: SceneReviewCatalog): RequirementResult {
  return requirementResultSchema.parse({ setId: set.id, revisionHash: set.revisionHash,
    catalogHash: sceneCatalogHash(catalog), evaluatorVersion: SCENE_REQUIREMENT_EVALUATOR_VERSION,
    requirements: report.requirements.requirements.map(({ state, ownState: _own, diagnostics, blockedBy, ...definition }) => ({
      id: definition.id, definitionHash: contentHash(definition), state, diagnostics, blockedBy,
    })),
  });
}

/** Fail closed on stale inputs and partial success; proposed is not a state. */
export function requirementResultIssues(setsInput: readonly RequirementSet[], results: readonly RequirementResult[], catalog: SceneReviewCatalog): string[] {
  const sets = frozenRequirementSetsSchema.parse(setsInput), issues: string[] = [];
  const catalogHash = sceneCatalogHash(catalog);
  for (const result of results) {
    requirementResultSchema.parse(result);
    if (!sets.some(set => set.id === result.setId)) issues.push(`REQUIREMENT_RESULT_OUTSIDE_SCOPE: ${result.setId}`);
  }
  for (const set of sets) {
    const found = results.filter(result => result.setId === set.id);
    if (found.length !== 1) { issues.push(`REQUIREMENT_NOT_EVALUATED: ${set.id} must have exactly one result`); continue; }
    const result = found[0]!;
    if (result.revisionHash !== set.revisionHash || result.catalogHash !== catalogHash || result.evaluatorVersion !== SCENE_REQUIREMENT_EVALUATOR_VERSION) {
      issues.push(`REQUIREMENT_REVISION_STALE: ${set.id}`); continue;
    }
    const expectedIds = set.spec.cases.flatMap(item => [
      `${item.id}:case-validation`,
      ...(item.kind === "event-effects" ? [`${item.id}:state-effect`, ...(item.initiatorId ? [`${item.id}:agency`] : []), ...(item.requiresMechanism ? [`${item.id}:mechanism`] : [])] : []),
    ]).sort();
    if (canonicalJson(expectedIds) !== canonicalJson(result.requirements.map(item => item.id).sort())) issues.push(`REQUIREMENT_DENOMINATOR_CHANGED: ${set.id}`);
    const rechecked = resultFromReport(set, evaluateReviewedSceneCapabilities(set.spec, catalog), catalog);
    if (contentHash(rechecked) !== contentHash(result)) issues.push(`REQUIREMENT_RESULT_MISMATCH: ${set.id}`);
    for (const item of result.requirements) if (item.state !== "satisfied" || item.diagnostics.length || item.blockedBy.length) issues.push(`REQUIREMENT_UNRESOLVED: ${set.id}/${item.id}: ${item.state}`);
  }
  return issues;
}

/** Host-only mutations under the compiler lock. A head publishes an immutable
 * chain; temp/orphan files do not grant authority. Published writes are idempotent;
 * a missing head with existing records stops for host inspection. Old records
 * and predecessor definitions are never deleted.
 */
export class RequirementLedger {
  private readonly directory: string;
  constructor(root: string, readonly sourceId: string) {
    this.directory = path.join(worldStorageRoot(root), "compiler", "requirements", idSchema.parse(sourceId));
  }
  private async readHead() {
    try {
      const head = headSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, "head.json"), "utf8")));
      if (head.sourceId !== this.sourceId) throw new Error("Requirement journal source mismatch; stop for host review.");
      return head;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let files: string[];
      try { files = await fs.readdir(this.directory); }
      catch (listError) { if ((listError as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw listError; }
      if (files.some(file => /^[a-f0-9]{64}\.json$/.test(file))) throw new Error("Requirement journal head is missing; stop for host recovery, do not reset obligations.");
      return undefined;
    }
  }
  async history(): Promise<LedgerRecord[]> {
    const head = await this.readHead();
    if (!head) return [];
    const records: LedgerRecord[] = [];
    let cursor: string | null = head.hash;
    for (let sequence = head.sequence; sequence >= 0; sequence--) {
      if (!cursor) throw new Error("Requirement journal chain truncated; stop for host review, do not reset the ledger.");
      const record = recordSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, `${cursor}.json`), "utf8")));
      if (record.hash !== cursor || record.sequence !== sequence || record.sourceId !== this.sourceId) throw new Error("Requirement journal chain mismatch; stop for host review.");
      records.push(record); cursor = record.predecessorHash;
    }
    if (cursor) throw new Error("Requirement journal has an invalid root; stop for host review.");
    records.reverse();
    const definitions = new Map<string, RequirementSet>();
    for (const record of records) {
      if (record.payload.kind === "definition") {
        const next = record.payload.definition;
        if (next.spec.sourceId !== this.sourceId || next.parentRevision !== (definitions.get(next.id)?.revisionHash ?? null)) throw new Error("Requirement definition lineage mismatch; stop for host review.");
        definitions.set(next.id, next);
      } else if (definitions.get(record.payload.result.setId)?.revisionHash !== record.payload.result.revisionHash) throw new Error("Requirement evaluation has no active definition; stop for host review.");
    }
    return records;
  }
  async definitions(): Promise<RequirementSet[]> {
    return activeRequirementSets(await this.definitionHistory());
  }
  async definitionHistory(): Promise<RequirementSet[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "definition" ? [record.payload.definition] : []);
  }
  private async publish(payload: z.infer<typeof payloadSchema>): Promise<void> {
    const history = await this.history(), last = history.at(-1);
    if (last && contentHash(last.payload) === contentHash(payload)) return;
    const identity = { version: 1 as const, sourceId: this.sourceId, sequence: history.length, predecessorHash: last?.hash ?? null, payload };
    const record = recordSchema.parse({ ...identity, hash: contentHash(identity) });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${record.hash}.json`), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${canonicalJson(record)}\n`, { flag: "wx", mode: 0o600 });
      // link publishes complete bytes with no overwrite, including on recovery.
      try { await fs.link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (canonicalJson(JSON.parse(await fs.readFile(destination, "utf8"))) !== canonicalJson(record)) throw new Error("Requirement journal collision; stop for host review.");
      }
      await fs.unlink(temporary);
      const head = headSchema.parse({ version: 1, sourceId: this.sourceId, sequence: record.sequence, hash: record.hash });
      await fs.writeFile(temporary, `${canonicalJson(head)}\n`, { mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, "head.json"));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async register(input: { id: string; spec: unknown; scopeDecisionRef: string; predecessorRevision?: string }, bytes: Uint8Array, catalog: SceneReviewCatalog): Promise<RequirementSet> {
    const spec = sceneCapabilitySpecSchema.parse(input.spec);
    if (spec.sourceId !== this.sourceId) throw new Error("Requirement source scope mismatch; stop for host review.");
    // Verify immutable source anchors before publishing any obligation. Bad
    // candidate semantics may be blocked; bad evidence cannot register a spec.
    evaluateSceneCapabilities(spec, bytes, catalog);
    const previous = (await this.definitions()).find(set => set.id === input.id);
    if (previous && contentHash(previous.spec) === contentHash(spec) && previous.scopeDecisionRef === input.scopeDecisionRef) return previous;
    if ((previous?.revisionHash ?? undefined) !== input.predecessorRevision) throw new Error("Requirement predecessor changed. Inspect the same-source requirement ledger and copy definitions[].revisionHash; do not guess, overwrite, or retry unchanged.");
    const identity = { id: idSchema.parse(input.id), parentRevision: previous?.revisionHash ?? null, scopeDecisionRef: text.parse(input.scopeDecisionRef), spec };
    const definition = requirementSetSchema.parse({ ...identity, revisionHash: contentHash(identity) });
    await this.publish({ kind: "definition", definition });
    return definition;
  }
  async evaluate(bytes: Uint8Array, catalog: SceneReviewCatalog): Promise<RequirementResult[]> {
    const results: RequirementResult[] = [];
    for (const set of await this.definitions()) {
      const result = evaluateRequirementSet(set, bytes, catalog);
      const previous = (await this.history()).findLast(record => record.payload.kind === "evaluation" && record.payload.result.setId === set.id);
      if (!previous || previous.payload.kind !== "evaluation" || contentHash(previous.payload.result) !== contentHash(result)) await this.publish({ kind: "evaluation", result });
      results.push(result);
    }
    return results;
  }
  /** Materialization may add missing requirements, never discard newer/local
   * obligations in order to match an older bundle. A different lineage needs a
   * fresh isolated repair workspace; old branches already use their frozen input.
   */
  async assertRestorable(historyInput: readonly RequirementSet[]): Promise<void> {
    const history = requirementDefinitionHistorySchema.parse(historyInput), current = await this.definitionHistory();
    for (const set of history) if (set.spec.sourceId !== this.sourceId) throw new Error("Requirement restore source mismatch");
    if (current.some((set, i) => set.revisionHash !== history[i]?.revisionHash)) throw new Error("Requirement restore would forget current obligations; use an isolated workspace. Do not retry unchanged or reset the ledger.");
  }
  async restore(historyInput: readonly RequirementSet[]): Promise<void> {
    await this.assertRestorable(historyInput);
    const history = requirementDefinitionHistorySchema.parse(historyInput), current = await this.definitionHistory();
    for (const set of history.slice(current.length)) {
      if (set.spec.sourceId !== this.sourceId) throw new Error("Requirement restore source mismatch");
      await this.publish({ kind: "definition", definition: set });
    }
  }
}
