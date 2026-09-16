import { compilerFinishReceiptSchema, type CompilerFinishReceipt } from "./finish-receipts.js";
import { coreRoleAttemptScope } from "./requirement-attempts.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { evaluateSceneCapabilities, evaluateReviewedSceneCapabilities, sceneCapabilitySpecSchema, type SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { SCENE_REQUIREMENT_EVALUATOR_VERSION } from "../eval/scene-requirements.js";
import { coreRoleRequirementDefinitionSchema, coreRoleRequirementHistorySchema, coreRoleDefinitions, assertCoreRoleDefinitionEvidence, type CoreRoleRequirementDefinition } from "./core-role-requirement-records.js";
import { validateRoleRoster, roleRosterSchema, type RoleRoster } from "./role-roster.js";
import type { StructuralUnit } from "./structure.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import type { NovelClosureAssessment } from "./certification.js";

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
  z.object({ kind: z.literal("core-role-invalidation"), evaluationRef: hash, nextSubjectSnapshotHash: hash, reason: text }).strict(),
  z.object({ kind: z.literal("core-role-attempt-evaluation"), settlementKey: hash, receiptFingerprint: hash, definitionRevision: hash,
    subjectSnapshotHash: hash, evaluationRef: hash, result: requirementResultSchema.shape.requirements.element }).strict(),
  z.object({ kind: z.literal("core-role-attempt"), receipt: compilerFinishReceiptSchema }).strict(),
  z.object({ kind: z.literal("definition"), definition: requirementSetSchema }).strict(),
  z.object({ kind: z.literal("evaluation"), result: requirementResultSchema }).strict(),
  z.object({ kind: z.literal("core-role-definition"), definition: coreRoleRequirementDefinitionSchema }).strict(),
  z.object({ kind: z.literal("core-role-evaluation"), definitionRevision: hash, subjectSnapshotHash: hash, result: requirementResultSchema }).strict(),
]);
const recordSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(),
  predecessorHash: hash.nullable(), payload: payloadSchema, hash,
}).strict().superRefine(({ hash: recordedHash, ...identity }, ctx) => {
  if (contentHash(identity) !== recordedHash) ctx.addIssue({ code: "custom", message: "Requirement journal hash mismatch" });
});
export type LedgerRecord = z.infer<typeof recordSchema>;
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
  constructor(private readonly root: string, readonly sourceId: string) {
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
    return requirementJournalSchema.parse(records);
  }
  async assertJournalRestorable(input: readonly LedgerRecord[], bytes?: Uint8Array): Promise<void> {
    const incoming = requirementJournalSchema.parse(input), current = await this.history();
    if (current.some((record, index) => record.hash !== incoming[index]?.hash)) throw new Error("Requirement journal restore would discard or rewrite current audit history; preserve the journal and stop for host review");
    if (incoming.some(record => record.sourceId !== this.sourceId)) throw new Error("Requirement journal restore source mismatch; stop for host review");
    if (incoming.length && !bytes) throw new Error("Requirement journal restore needs immutable source bytes; stop for host storage review");
    for (const record of incoming) {
      if (record.payload.kind === "core-role-definition") assertCoreRoleDefinitionEvidence(record.payload.definition, bytes!);
      if (record.payload.kind === "definition") evaluateRequirementSet(record.payload.definition, bytes!, Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map()])) as SceneReviewCatalog);
    }
  }
  async restoreJournal(input: readonly LedgerRecord[], bytes?: Uint8Array): Promise<void> {
    await this.assertJournalRestorable(input, bytes);
    const current = await this.history();
    for (const record of input.slice(current.length)) await this.publish(record.payload);
  }
  async definitions(): Promise<RequirementSet[]> {
    return activeRequirementSets(await this.definitionHistory());
  }
  async definitionHistory(): Promise<RequirementSet[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "definition" ? [record.payload.definition] : []);
  }
  async coreRoleDefinitionHistory(): Promise<CoreRoleRequirementDefinition[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "core-role-definition" ? [record.payload.definition] : []);
  }
  async registerCoreRoles(input: { roster: RoleRoster; units: StructuralUnit[]; scopeDecisionRef: string; scopeChangeReason: string; predecessorRevision?: string; allowScopeReduction?: boolean }, bytes: Uint8Array): Promise<CoreRoleRequirementDefinition> {
    input = { ...input, roster: roleRosterSchema.parse(input.roster) };
    const issues = validateRoleRoster(input.roster).filter(issue => !["ROSTER_MAJOR_IDENTITY_UNRESOLVED", "ROSTER_NO_MAJOR_CHARACTERS"].includes(issue.code));
    if (issues.length) throw new Error(`Core role source review is incomplete: ${issues.map(issue => issue.code).join(", ")}; preserve reviews and stop unchanged retries`);
    const retainedDefinitions = await this.coreRoleDefinitionHistory(), previous = retainedDefinitions.at(-1);
    const specHash = contentHash({ definitions: coreRoleDefinitions({ source: { id: this.sourceId } }, input.roster), units: input.units });
    if (previous?.specHash === specHash) { assertCoreRoleDefinitionEvidence(previous, bytes); return previous; }
    for (const review of input.roster.reviews) {
      const retained = retainedDefinitions.flatMap(definition => definition.roster.reviews).find(item => item.runId === review.runId);
      if (retained && contentHash(retained) !== contentHash(review)) throw new Error("Core role review run was rewritten. Preserve the original review and use fresh independent review runs; do not retry with mutated history.");
    }
    if (input.predecessorRevision !== previous?.revisionHash) throw new Error(`Core role predecessor changed. Run nwh requirements inspect --source ${this.sourceId}, copy coreRoleDefinitions[].revisionHash from the last entry, and make one corrected host retry. Stop model retries; do not reset history.`);
    const nextIds = new Set(coreRoleDefinitions({ source: { id: this.sourceId } }, input.roster).map(item => item.id));
    const removedRequirementIds = previous ? coreRoleDefinitions({ source: { id: this.sourceId } }, previous.roster).map(item => item.id).filter(id => !nextIds.has(id)).sort() : [];
    if (removedRequirementIds.length && !input.allowScopeReduction) throw new Error(`Core role scope reduction requires host review of ${removedRequirementIds.join(", ")}. Stop model retries. The host must use nwh requirements register-core-roles --source ${this.sourceId} with the exact --predecessor, --scope-decision and --reason; preserve history and do not retry unchanged.`);
    const identity = { version: 1 as const, id: "core-roles" as const, sourceId: this.sourceId, sourceSha256: input.roster.sourceSha256,
      parentRevision: previous?.revisionHash ?? null, specHash, scopeDecisionRef: text.parse(input.scopeDecisionRef), scopeChangeReason: text.parse(input.scopeChangeReason),
      removedRequirementIds, roster: input.roster, units: input.units };
    const definition = coreRoleRequirementDefinitionSchema.parse({ ...identity, revisionHash: contentHash(identity) });
    assertCoreRoleDefinitionEvidence(definition, bytes);
    await this.publish({ kind: "core-role-definition", definition });
    return definition;
  }
  async assertCoreRoleAttemptsRestorable(receipts: readonly CompilerFinishReceipt[], definitions: readonly CoreRoleRequirementDefinition[]): Promise<void> {
    const attempts = receipts.filter(receipt => receipt.state === "completed" && receipt.identity.requirementAttempts);
    for (const receipt of attempts) assertCoreRoleAttemptDefinition(compilerFinishReceiptSchema.parse(receipt), definitions, this.sourceId);
    for (const record of await this.history()) {
      const payload = record.payload;
      if (payload.kind === "core-role-attempt" && !attempts.some(receipt => receipt.fingerprint === payload.receipt.fingerprint)) throw new Error("Core role restore would forget a repair attempt; preserve its receipt and stop for host review");
    }
  }
  async recordCoreRoleAttempts(input: CompilerFinishReceipt): Promise<void> {
    const receipt = compilerFinishReceiptSchema.parse(input);
    assertCoreRoleAttemptDefinition(receipt, await this.coreRoleDefinitionHistory(), this.sourceId);
    const history = await this.history();
    if (history.some(record => record.payload.kind === "core-role-attempt" && record.payload.receipt.fingerprint === receipt.fingerprint)) return;
    await this.publish({ kind: "core-role-attempt", receipt });
  }
  async invalidateCoreRoleEvaluation(nextSubjectSnapshotHash: string): Promise<void> {
    hash.parse(nextSubjectSnapshotHash);
    const history = await this.history(), previous = history.findLast(record => record.payload.kind === "core-role-evaluation");
    if (!previous || previous.payload.kind !== "core-role-evaluation" || previous.payload.subjectSnapshotHash === nextSubjectSnapshotHash) return;
    const evaluationRef = contentHash(previous.payload);
    if (history.some(record => record.payload.kind === "core-role-invalidation" && record.payload.evaluationRef === evaluationRef && record.payload.nextSubjectSnapshotHash === nextSubjectSnapshotHash)) return;
    await this.publish({ kind: "core-role-invalidation", evaluationRef, nextSubjectSnapshotHash,
      reason: "Frozen subject changed; retain the previous evaluation as historical evidence only" });
  }
  async recordCoreRoleEvaluation(bundle: PreparedNovelBundle, assessment: NovelClosureAssessment): Promise<void> {
    const definition = (await this.coreRoleDefinitionHistory()).at(-1);
    if (!definition || bundle.source.id !== this.sourceId || bundle.source.contentSha256 !== definition.sourceSha256 || bundle.compilerSnapshot.coreRoleRequirementDefinitions?.at(-1)?.revisionHash !== definition.revisionHash) throw new Error("Core role evaluation lacks its current frozen definition; stop for host review");
    const { evaluateCoreRoleCapabilities } = await import("./core-role-capabilities.js");
    const { preparedSubjectHash } = await import("./certification.js");
    const subjectSnapshotHash = preparedSubjectHash(bundle);
    if (!assessment.coreRoleResult) throw new Error("Core role evaluation result is missing; evaluate the frozen candidate before recording, never submit model success as a result");
    if (!assessment.roster || assessment.subjectSnapshotHash !== subjectSnapshotHash || contentHash(assessment.roster) !== contentHash(definition.roster)) throw new Error("Core role evaluation subject is stale; re-evaluate the current candidate, do not replay model writes");
    const result = evaluateCoreRoleCapabilities(bundle, assessment.roster, assessment.playability, subjectSnapshotHash);
    if (result.revisionHash !== definition.specHash || contentHash(result) !== contentHash(assessment.coreRoleResult)) throw new Error("Core role evaluation differs from its frozen deterministic result; stop for host review");
    const payload = { kind: "core-role-evaluation" as const, definitionRevision: definition.revisionHash, subjectSnapshotHash, result };
    const previous = (await this.history()).findLast(record => record.payload.kind === "core-role-evaluation");
    if (!previous || contentHash(previous.payload) !== contentHash(payload)) {
      await this.invalidateCoreRoleEvaluation(subjectSnapshotHash);
      await this.publish(payload);
    }
    await this.settleCoreRoleAttempts(bundle, payload);
  }
  private async settleCoreRoleAttempts(bundle: PreparedNovelBundle, evaluation: Extract<LedgerRecord["payload"], { kind: "core-role-evaluation" }>): Promise<void> {
    const history = await this.history();
    const settled = new Map(history.flatMap(record => record.payload.kind === "core-role-attempt-evaluation" ? [[record.payload.settlementKey, record.payload] as const] : []));
    const { ProposalStore } = await import("../world/canonical-model.js");
    const proposals = new ProposalStore(this.root), active = new Map<string, boolean>();
    for (const record of history) {
      if (record.payload.kind !== "core-role-attempt") continue;
      const receipt = record.payload.receipt;
      for (const attempt of receipt.identity.requirementAttempts ?? []) {
        const result = evaluation.result.requirements.find(item => item.id === attempt.requirementId);
        const diagnostics: string[] = [];
        if (attempt.definitionRevision !== evaluation.definitionRevision || result?.definitionHash !== attempt.definitionHash) diagnostics.push("ATTEMPT_REQUIREMENT_REVISION_STALE");
        for (const ref of attempt.proposalRefs) {
          const key = contentHash(ref);
          if (!active.has(key)) {
            try {
              const envelope = await proposals.readEnvelope("accepted", ref.proposalId);
              const catalog = envelope.kind === "character-model" ? bundle.canonical.models : envelope.kind === "character-goal" ? bundle.canonical.goals : [];
              active.set(key, contentHash(envelope) === ref.hash && catalog.some(item => contentHash(item) === contentHash(envelope.payload)));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              active.set(key, false);
            }
          }
          if (!active.get(key)) diagnostics.push(`ATTEMPT_DEPENDENCY_NOT_ACTIVE: ${ref.proposalId}`);
        }
        const settledResult = diagnostics.length ? { id: attempt.requirementId, definitionHash: attempt.definitionHash, state: "stale" as const, diagnostics, blockedBy: [] } : result!;
        const settlementKey = contentHash({ receiptFingerprint: receipt.fingerprint, requirementId: attempt.requirementId, definitionHash: attempt.definitionHash, subjectSnapshotHash: evaluation.subjectSnapshotHash });
        const payload = { kind: "core-role-attempt-evaluation" as const, settlementKey, receiptFingerprint: receipt.fingerprint, definitionRevision: attempt.definitionRevision,
          subjectSnapshotHash: evaluation.subjectSnapshotHash, evaluationRef: contentHash(evaluation), result: settledResult };
        if (settled.has(settlementKey)) {
          if (contentHash(settled.get(settlementKey)) !== contentHash(payload)) throw new Error("Role attempt settlement dependencies changed for the same frozen subject; stop for host review, never replay model writes");
          continue;
        }
        await this.publish(payload);
      }
    }
  }
  async assertCoreRolesRestorable(input: readonly CoreRoleRequirementDefinition[], bytes?: Uint8Array): Promise<void> {
    const incoming = coreRoleRequirementHistorySchema.parse(input), current = await this.coreRoleDefinitionHistory();
    if (current.some((definition, index) => definition.revisionHash !== incoming[index]?.revisionHash)) throw new Error("Core role restore would forget current obligations; use an isolated workspace, never reset the ledger");
    for (const definition of incoming) {
      if (definition.sourceId !== this.sourceId) throw new Error("Core role restore source mismatch");
      if (!bytes) throw new Error("Core role restore requires immutable source bytes");
      assertCoreRoleDefinitionEvidence(definition, bytes);
    }
  }
  async restoreCoreRoles(input: readonly CoreRoleRequirementDefinition[], bytes?: Uint8Array): Promise<void> {
    await this.assertCoreRolesRestorable(input, bytes);
    const current = await this.coreRoleDefinitionHistory();
    for (const definition of input.slice(current.length)) await this.publish({ kind: "core-role-definition", definition });
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

export function assertCoreRoleAttemptDefinition(receipt: CompilerFinishReceipt, history: readonly CoreRoleRequirementDefinition[], sourceId: string): void {
  const scope = receipt.identity.requirementScope?.coreRoleScope;
  const definition = history.find(item => item.revisionHash === scope?.definitionRevision);
  if (receipt.state !== "completed" || !scope || !receipt.identity.requirementAttempts || !definition
    || receipt.identity.sourceId !== sourceId || receipt.identity.sourceSha256 !== definition.sourceSha256
    || contentHash(scope) !== contentHash(coreRoleAttemptScope(definition))) throw new Error("Core role attempt lacks its completed receipt and retained independent definition; preserve history and stop model retries");
}

export function coreRoleAttemptHistoryIssues(receipts: readonly CompilerFinishReceipt[], definitions: readonly CoreRoleRequirementDefinition[], sourceId: string): string[] {
  const issues: string[] = [];
  for (const receipt of receipts) {
    if (receipt.state !== "completed" || !receipt.identity.requirementAttempts) continue;
    try { assertCoreRoleAttemptDefinition(receipt, definitions, sourceId); }
    catch { issues.push(`CORE_ROLE_ATTEMPT_DEFINITION_MISMATCH: ${receipt.fingerprint}`); }
  }
  return issues;
}

/** Complete audit history, excluded from the semantic subject hash. */
export const requirementJournalSchema = z.array(recordSchema).superRefine((records, ctx) => {
  try {
    const sourceId = records[0]?.sourceId ?? "";
    for (const [index, record] of records.entries()) {
      if (record.sourceId !== sourceId || record.sequence !== index || record.predecessorHash !== (records[index - 1]?.hash ?? null)) throw new Error("Requirement journal source or predecessor chain mismatch");
      if (index && contentHash(record.payload) === contentHash(records[index - 1]!.payload)) throw new Error("Requirement journal repeats an adjacent published payload");
    }
    const definitions = new Map<string, RequirementSet>();
    const coreHistory: CoreRoleRequirementDefinition[] = [];
    const evaluations = new Map<string, Extract<LedgerRecord["payload"], { kind: "core-role-evaluation" }>>();
    const attempts = new Map<string, CompilerFinishReceipt>();
    const settlementKeys = new Set<string>();
    for (const record of records) {
      if (record.payload.kind === "definition") {
        const next = record.payload.definition;
        if (next.spec.sourceId !== sourceId || next.parentRevision !== (definitions.get(next.id)?.revisionHash ?? null)) throw new Error("Requirement definition lineage mismatch; stop for host review.");
        definitions.set(next.id, next);
      } else if (record.payload.kind === "evaluation") {
        if (definitions.get(record.payload.result.setId)?.revisionHash !== record.payload.result.revisionHash) throw new Error("Requirement evaluation has no active definition; stop for host review.");
      } else if (record.payload.kind === "core-role-definition") {
        if (record.payload.definition.sourceId !== sourceId) throw new Error("Core role definition escapes its source; stop for host review.");
        coreHistory.push(record.payload.definition);
        coreRoleRequirementHistorySchema.parse(coreHistory);
      } else if (record.payload.kind === "core-role-attempt") {
        assertCoreRoleAttemptDefinition(record.payload.receipt, coreHistory, sourceId);
        if (attempts.has(record.payload.receipt.fingerprint)) throw new Error("Requirement journal repeats an immutable attempt");
        attempts.set(record.payload.receipt.fingerprint, record.payload.receipt);
      } else if (record.payload.kind === "core-role-invalidation") {
        if (!evaluations.has(record.payload.evaluationRef)) throw new Error("Role invalidation has no retained evaluation; stop for host review");
      } else if (record.payload.kind === "core-role-attempt-evaluation") {
        const payload = record.payload, evaluation = evaluations.get(payload.evaluationRef);
        const attempt = attempts.get(payload.receiptFingerprint)?.identity.requirementAttempts?.find(item => item.requirementId === payload.result.id && item.definitionHash === payload.result.definitionHash);
        const key = contentHash({ receiptFingerprint: payload.receiptFingerprint, requirementId: payload.result.id, definitionHash: payload.result.definitionHash, subjectSnapshotHash: payload.subjectSnapshotHash });
        if (!evaluation || !attempt || attempt.definitionRevision !== payload.definitionRevision || evaluation.subjectSnapshotHash !== payload.subjectSnapshotHash
          || payload.settlementKey !== key || settlementKeys.has(key)
          || (payload.result.state !== "stale" && contentHash(evaluation.result.requirements.find(item => item.id === payload.result.id)) !== contentHash(payload.result))) throw new Error("Role attempt settlement has invalid immutable references; stop for host review");
        settlementKeys.add(key);
      } else {
        const active = coreHistory.at(-1);
        if (!active || record.payload.definitionRevision !== active.revisionHash || record.payload.result.setId !== "core-roles" || record.payload.result.revisionHash !== active.specHash) throw new Error("Core role evaluation has no active definition; stop for host review.");
        const expected = coreRoleDefinitions({ source: { id: sourceId } }, active.roster).map(item => ({ id: item.id, definitionHash: contentHash(item) }));
        const actual = record.payload.result.requirements.map(item => ({ id: item.id, definitionHash: item.definitionHash }));
        if (contentHash(expected.sort((a, b) => a.id.localeCompare(b.id))) !== contentHash(actual.sort((a, b) => a.id.localeCompare(b.id)))) throw new Error("Historical core role evaluation definition inventory mismatch");
        evaluations.set(contentHash(record.payload), record.payload);
      }
    }
  } catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
});

export function requirementSnapshotInputs<T extends { requirementJournal?: LedgerRecord[] }>(snapshot: T): Omit<T, "requirementJournal"> {
  const { requirementJournal: _history, ...inputs } = snapshot;
  return inputs;
}

export function requirementJournalBindingIssues(snapshot: {
  requirementJournal?: LedgerRecord[]; requirementDefinitions?: RequirementSet[]; coreRoleRequirementDefinitions?: CoreRoleRequirementDefinition[];
  reconciliationObligations?: { receipt: CompilerFinishReceipt }[];
}, sourceId: string, sourceSha256: string, requireHistory = false): string[] {
  if (!snapshot.requirementJournal) return requireHistory && (snapshot.requirementDefinitions?.length || snapshot.coreRoleRequirementDefinitions?.length) ? ["REQUIREMENT_JOURNAL_MISSING"] : []; // Historical bundles predate full journal transport.
  const parsed = requirementJournalSchema.safeParse(snapshot.requirementJournal);
  if (!parsed.success) return ["REQUIREMENT_JOURNAL_INVALID"];
  const history = parsed.data, issues: string[] = [];
  if (history.some(record => record.sourceId !== sourceId)) issues.push("REQUIREMENT_JOURNAL_SOURCE_MISMATCH");
  const scenes = history.flatMap(record => record.payload.kind === "definition" ? [record.payload.definition] : []);
  const roles = history.flatMap(record => record.payload.kind === "core-role-definition" ? [record.payload.definition] : []);
  if (contentHash(scenes) !== contentHash(snapshot.requirementDefinitions ?? []) || contentHash(roles) !== contentHash(snapshot.coreRoleRequirementDefinitions ?? [])) issues.push("REQUIREMENT_JOURNAL_DEFINITIONS_MISMATCH");
  if (scenes.some(set => set.spec.sourceSha256 !== sourceSha256) || roles.some(definition => definition.sourceSha256 !== sourceSha256)) issues.push("REQUIREMENT_JOURNAL_SOURCE_MISMATCH");
  for (const record of history) {
    if (record.payload.kind !== "core-role-attempt") continue;
    const retained = record.payload.receipt;
    if (!(snapshot.reconciliationObligations ?? []).some(item => contentHash(item.receipt) === contentHash(retained))) issues.push("REQUIREMENT_JOURNAL_RECEIPT_MISSING");
  }
  return issues;
}
