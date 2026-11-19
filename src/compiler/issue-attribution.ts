import type { ValidationIssue } from "../world/model.js";
import { closureKindSchema, type ClosureKind } from "./closure.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

/**
 * Issues that describe the whole novel rather than one compiled node. They
 * gate only full-novel certification, never an individual cut.
 */
export const GLOBAL_ISSUE_CODES: ReadonlySet<string> = new Set([
  "ROSTER_REVIEW_INCOMPLETE", "ROSTER_NO_MAJOR_CHARACTERS", "ROSTER_ASSESSMENT_BLOCKED", "NOVEL_ROSTER_REQUIRED",
  "MAJOR_ROLE_DENOMINATOR_CHANGED", "MAJOR_ROLE_NOT_CERTIFIED", "MAJOR_ROLE_ROSTER_MISMATCH", "MAJOR_ROLE_ROSTER_STALE",
  "CORE_ROLE_REQUIREMENTS_BLOCKED", "CORE_ROLE_REQUIREMENT_NOT_CERTIFIED", "CORE_ROLE_DEFINITION_NOT_CERTIFIED", "CORE_ROLE_ATTEMPT_DEFINITION_MISMATCH",
  "REQUIREMENT_EVALUATION_BLOCKED", "REQUIREMENT_NOT_CERTIFIED", "REQUIREMENT_JOURNAL_INVALID", "SEMANTIC_REVIEW_NOT_CERTIFIED",
  "UPSTREAM_REPAIR_UNRESOLVED", "UPSTREAM_REPAIR_SNAPSHOT_INVALID", "RECONCILIATION_OBLIGATION_UNRESOLVED", "ROLE_REVIEW_FINISH_NOT_CERTIFIED",
  "ENTRY_EVALUATION_CONTEXT_INVALID", "SOURCE_ACCOUNTING_STALE", "SOURCE_ACCOUNTING_INVENTORY_INVALID", "SOURCE_PARTITION_INVALID",
  "NOVEL_PLAY_QUALITY_MISSING", "NOVEL_PLAY_NOT_RUN", "NOVEL_EVALUATION_NOT_RUN",
]);

/** Compiler artifact kinds named in messages, mapped onto closure-graph node kinds. */
const ARTIFACT_KIND_NODES: Readonly<Record<string, ClosureKind>> = {
  "action-schema": "action", "action-constraint": "constraint", "norm-template": "norm", "process-template": "process",
  "world-rule": "rule", "rule": "rule", "event-execution": "event-execution", "semantic-effect": "semantic-effect",
  "character-goal": "goal", "goal": "goal", "canonical-event": "event", "event": "event", "entity": "entity",
  "scene-occurrence": "scene", "scene": "scene", "event-relation": "event-relation", "spatial-relation": "spatial",
  "acquisition": "acquisition", "perception-observation": "perception-observation", "utterance-expression": "utterance-expression",
  "proposition": "proposition", "attribution": "attribution", "claim": "claim", "event-frame": "frame", "initial-world": "initial",
};
const CLOSURE_KINDS: ReadonlySet<string> = new Set(closureKindSchema.options);
/** When a message names several known artifacts, the most specific playable node wins. */
const TOKEN_PRIORITY: readonly ClosureKind[] = ["event", "scene", "action", "event-execution", "semantic-effect", "entity", "goal", "rule", "norm", "process", "unit"];

export type IssueAttributionCatalog = {
  ids: ReadonlyMap<ClosureKind, ReadonlySet<string>>;
  units: ReadonlySet<string>;
  sourceId?: string;
};

export function issueAttributionCatalog(bundle: Pick<PreparedNovelBundle, "canonical"> & { source?: { id: string }; compilerSnapshot?: Pick<PreparedNovelBundle["compilerSnapshot"], "structure"> }): IssueAttributionCatalog {
  const c = bundle.canonical;
  const ids = new Map<ClosureKind, ReadonlySet<string>>([
    ["event", new Set(c.events.map((item) => item.id))],
    ["scene", new Set(c.sceneOccurrences.map((item) => item.id))],
    ["action", new Set(c.actionSchemas.map((item) => item.id))],
    ["event-execution", new Set((c.eventExecutions ?? []).map((item) => item.id))],
    ["semantic-effect", new Set((c.semanticEffects ?? []).map((item) => item.id))],
    ["entity", new Set(c.entities.map((item) => item.id))],
    ["goal", new Set(c.goals.map((item) => item.id))],
    ["rule", new Set(c.rules.map((item) => item.id))],
    ["norm", new Set((c.normTemplates ?? []).map((item) => item.id))],
    ["process", new Set((c.processTemplates ?? []).map((item) => item.id))],
  ]);
  const units = new Set(bundle.compilerSnapshot?.structure?.units.map((unit) => unit.id) ?? []);
  ids.set("unit", units);
  return { ids, units, ...(bundle.source?.id ? { sourceId: bundle.source.id } : {}) };
}

/**
 * The closure-graph node an issue belongs to (`kind/id`), or undefined for a
 * novel-wide issue. Uses the structured path first, then an explicit
 * `artifact-kind/id` reference in the message, then a known artifact ID.
 */
export function issueNodeKey(issue: ValidationIssue, catalog: IssueAttributionCatalog): string | undefined {
  if (GLOBAL_ISSUE_CODES.has(issue.code)) return undefined;
  const path = issue.path?.trim();
  if (path) {
    const [kind, id] = path.split("/");
    if (kind && id && CLOSURE_KINDS.has(kind)) return `${kind}/${id}`;
    if (catalog.units.has(path)) return `unit/${path}`;
  }
  // Explicit references: `artifact-kind/id` or `artifact-kind 'id'`.
  for (const match of issue.message.matchAll(/([a-z][a-z-]*)(?:\/|\s+')([A-Za-z0-9][A-Za-z0-9._:-]*)/g)) {
    const kind = ARTIFACT_KIND_NODES[match[1]!] ?? (CLOSURE_KINDS.has(match[1]!) ? match[1] as ClosureKind : undefined);
    if (kind === "initial" && catalog.sourceId) return `initial/${catalog.sourceId}`;
    if (kind && catalog.ids.get(kind)?.has(match[2]!)) return `${kind}/${match[2]}`;
  }
  const tokens = new Set(issue.message.match(/[A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9]/g) ?? []);
  for (const kind of TOKEN_PRIORITY) {
    const known = catalog.ids.get(kind);
    if (!known) continue;
    for (const token of tokens) if (known.has(token)) return `${kind}/${token}`;
  }
  return undefined;
}

/** Fill a missing path with the issue's node; existing paths are preserved. */
export function attributeIssues<T extends ValidationIssue>(issues: readonly T[], catalog: IssueAttributionCatalog): T[] {
  return issues.map((issue) => {
    if (issue.path?.trim()) return issue;
    const node = issueNodeKey(issue, catalog);
    return node ? { ...issue, path: node } : issue;
  });
}

/** Split issues into node-attributed and novel-wide (unattributed) sets. */
export function partitionIssueAttribution<T extends ValidationIssue>(issues: readonly T[], catalog: IssueAttributionCatalog): { attributed: Array<T & { node: string }>; global: T[] } {
  const attributed: Array<T & { node: string }> = [], global: T[] = [];
  for (const issue of issues) {
    const node = issueNodeKey(issue, catalog);
    if (node) attributed.push({ ...issue, node });
    else global.push(issue);
  }
  return { attributed, global };
}
