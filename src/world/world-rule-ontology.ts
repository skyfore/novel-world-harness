import { canonicalJson } from "./canonical.js";
import {
  type ControlledWorldRule,
  type Entity,
  type EvidenceAssertion,
  type EvidenceRef,
  type Predicate,
  type ValidationIssue,
  type WorldRule,
  type WorldState,
} from "./model.js";
import { policyStoryScopeActive } from "./policy-time.js";
import { evaluatePredicate } from "./state.js";

export const WORLD_RULE_ONTOLOGY_VERSION = "world-rule-v2" as const;

export type WorldRuleReferenceCatalog = {
  entities: ReadonlyMap<string, Pick<Entity, "kind">>;
  events: ReadonlyMap<string, unknown>;
  claims: ReadonlySet<string>;
  rules: ReadonlyMap<string, WorldRule>;
};

export type EffectiveWorldRule = {
  id: string;
  name: string;
  rule: WorldRule;
  enforcement: "hard-state" | "normative";
  requires: Predicate[];
  forbids: Predicate[];
};

export type WorldRuleResolution = {
  effective: EffectiveWorldRule[];
  inactive: Array<{
    ruleId: string;
    reason: "contested" | "outside-time" | "not-applicable" | "exception" | "overridden";
    exceptionId?: string;
    overridingRuleId?: string;
  }>;
};

export type ModelVisibleWorldRule = {
  name: string;
  scope: WorldRule["scope"];
  enforcement: "hard-state" | "normative";
  appliesWhen: Predicate[];
  requires: Predicate[];
  forbids: Predicate[];
};

export function isControlledWorldRule(rule: WorldRule): rule is ControlledWorldRule {
  return "ontologyVersion" in rule && rule.ontologyVersion === WORLD_RULE_ONTOLOGY_VERSION;
}

/** Physical/magical mechanics define valid world states; social/legal rules do not erase agency. */
export function isHardStateRule(rule: WorldRule): boolean {
  return rule.kind === "physical" || rule.kind === "magical";
}

export function isNormativeWorldRule(rule: WorldRule): rule is ControlledWorldRule {
  return ["social", "legal", "institutional"].includes(rule.kind);
}

export function worldRuleRequires(rule: WorldRule): Predicate[] {
  return rule.clauses
    .filter((clause) => clause.status === "supported" && clause.modality === "require")
    .map((clause) => structuredClone(clause.predicate));
}

export function worldRuleForbids(rule: WorldRule): Predicate[] {
  return rule.clauses
    .filter((clause) => clause.status === "supported" && clause.modality === "forbid")
    .map((clause) => structuredClone(clause.predicate));
}

export function worldRulePredicates(rule: WorldRule): Predicate[] {
  return [
    ...rule.appliesWhen,
    ...rule.clauses.map((clause) => clause.predicate),
    ...rule.exceptions.flatMap((exception) => exception.appliesWhen),
  ];
}

/** All portable evidence, including per-clause and per-exception evidence. */
export function worldRuleEvidence(rule: WorldRule): EvidenceRef[] {
  return [
    ...rule.evidence,
    ...(rule.counterEvidence ?? []),
    ...rule.clauses.flatMap((clause) => [...clause.evidence, ...(clause.counterEvidence ?? [])]),
    ...rule.exceptions.flatMap((exception) => [...exception.evidence, ...(exception.counterEvidence ?? [])]),
  ];
}

/**
 * Validate identities, references, jurisdictions, and explicit superiority as
 * one catalog. Priority never resolves a conflict on its own: only a declared
 * overridesRuleIds edge can suppress a lower, defeasible rule.
 */
export function validateWorldRuleCatalog(
  rules: Iterable<WorldRule>,
  catalog: WorldRuleReferenceCatalog,
): ValidationIssue[] {
  const values = [...rules];
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const visibleRules = new Map(catalog.rules);
  for (const rule of values) visibleRules.set(rule.id, rule);

  for (const [index, rule] of values.entries()) {
    const prefix = `worldRules.${index}`;
    if (ids.has(rule.id)) {
      issues.push(issue("DUPLICATE_WORLD_RULE", `Duplicate world rule ${rule.id}`, `${prefix}.id`));
    }
    ids.add(rule.id);
    worldRulePredicates(rule).forEach((predicate, predicateIndex) =>
      validateRulePredicate(predicate, { ...catalog, rules: visibleRules }, `${prefix}.predicates.${predicateIndex}`, issues));
    if (rule.kind === "physical" && rule.authorityEntityId) {
      issues.push(issue("PHYSICAL_RULE_HAS_AUTHORITY", `Physical rule ${rule.id} cannot be issued by an authority`, `${prefix}.authorityEntityId`));
    }
    if ((rule.kind === "legal" || rule.kind === "institutional") && !rule.authorityEntityId) {
      issues.push(issue("MISSING_RULE_AUTHORITY", `${rule.kind} rule ${rule.id} requires an authority entity`, `${prefix}.authorityEntityId`));
    }
    if (rule.authorityEntityId) {
      const authority = catalog.entities.get(rule.authorityEntityId);
      if (!authority) {
        issues.push(issue("UNKNOWN_RULE_AUTHORITY", `Rule ${rule.id} references unknown authority ${rule.authorityEntityId}`, `${prefix}.authorityEntityId`));
      } else if (!["character", "faction", "institution"].includes(authority.kind)) {
        issues.push(issue("INVALID_RULE_AUTHORITY", `Rule authority ${rule.authorityEntityId} is ${authority.kind}; expected character, faction, or institution`, `${prefix}.authorityEntityId`));
      }
    }
    rule.jurisdictionEntityIds.forEach((entityId, jurisdictionIndex) => {
      const entity = catalog.entities.get(entityId);
      if (!entity) {
        issues.push(issue("UNKNOWN_RULE_JURISDICTION", `Rule ${rule.id} references unknown jurisdiction ${entityId}`, `${prefix}.jurisdictionEntityIds.${jurisdictionIndex}`));
        return;
      }
      const expectedKind = rule.scope === "location"
        ? "location"
        : rule.scope === "faction"
          ? "faction"
          : rule.scope === "institution"
            ? "institution"
            : undefined;
      if (expectedKind && entity.kind !== expectedKind) {
        issues.push(issue("INVALID_RULE_JURISDICTION", `${rule.scope}-scoped rule ${rule.id} references ${entity.kind} jurisdiction ${entityId}`, `${prefix}.jurisdictionEntityIds.${jurisdictionIndex}`));
      }
    });
    if (rule.scope !== "global" && !rule.appliesWhen.some((predicate) =>
      predicateMentionsAnyEntity(predicate, new Set(rule.jurisdictionEntityIds)))) {
      issues.push(issue(
        "UNBOUND_RULE_JURISDICTION",
        `Rule ${rule.id} declares a bounded jurisdiction but no applicability predicate binds it`,
        `${prefix}.appliesWhen`,
      ));
    }
    rule.knownByClaimIds.forEach((claimId, claimIndex) => {
      if (!catalog.claims.has(claimId)) {
        issues.push(issue("UNKNOWN_RULE_KNOWLEDGE", `Rule ${rule.id} references unknown knowledge claim ${claimId}`, `${prefix}.knownByClaimIds.${claimIndex}`));
      }
    });
    const required = new Set(rule.clauses
      .filter((clause) => clause.status === "supported" && clause.modality === "require")
      .map((clause) => canonicalJson(clause.predicate)));
    const forbidden = new Set(rule.clauses
      .filter((clause) => clause.status === "supported" && clause.modality === "forbid")
      .map((clause) => canonicalJson(clause.predicate)));
    if (rule.appliesWhen.some((predicate) => forbidden.has(canonicalJson(predicate)))) {
      issues.push(issue("SELF_FORBIDDING_WORLD_RULE", `Rule ${rule.id} forbids the same condition that makes it applicable`, `${prefix}.clauses`));
    }
    for (const [clauseIndex, clause] of rule.clauses.entries()) {
      if (clause.status === "supported" && clause.modality === "forbid" && required.has(canonicalJson(clause.predicate))) {
        issues.push(issue("CONTRADICTORY_WORLD_RULE", `Rule ${rule.id} both requires and forbids the same predicate`, `${prefix}.clauses.${clauseIndex}.predicate`));
      }
    }
    rule.overridesRuleIds.forEach((targetId, overrideIndex) => {
      const target = visibleRules.get(targetId);
      const path = `${prefix}.overridesRuleIds.${overrideIndex}`;
      if (!target) {
        issues.push(issue("UNKNOWN_OVERRIDDEN_RULE", `Rule ${rule.id} overrides unknown rule ${targetId}`, path));
      } else {
        if (!target.defeasible) {
          issues.push(issue("INDEFEASIBLE_RULE_OVERRIDE", `Rule ${rule.id} cannot override indefeasible rule ${targetId}`, path));
        }
        if (rule.priority <= target.priority) {
          issues.push(issue("INVALID_RULE_PRIORITY", `Overriding rule ${rule.id} priority ${rule.priority} must exceed ${targetId} priority ${target.priority}`, path));
        }
      }
    });
  }

  const overrideGraph = new Map<string, Set<string>>();
  for (const rule of values) {
    overrideGraph.set(rule.id, new Set(rule.overridesRuleIds.filter((id) => visibleRules.has(id))));
  }
  for (const cycle of directedCycles(overrideGraph)) {
    issues.push(issue("WORLD_RULE_OVERRIDE_CYCLE", `World-rule override cycle: ${cycle.join(" -> ")}`, "worldRules"));
  }
  return issues;
}

/** Exact host-resolved assertions are mandatory for the rule and every item. */
export function validateWorldRuleEvidenceAssertions(
  rule: WorldRule,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  const selected = assertions.filter((assertion) => assertion.target.artifactKind === "world-rule"
    && assertion.target.artifactId === rule.id);
  const issues: ValidationIssue[] = [];
  const nestedPointer = /^\/(?:clauses|exceptions)\/(?:0|[1-9]\d*)(?:\/|$)/;
  validateEvidenceBinding(
    { id: rule.id, basis: rule.basis, status: rule.status, evidence: rule.evidence, counterEvidence: rule.counterEvidence },
    selected.filter((assertion) => !nestedPointer.test(assertion.target.jsonPointer)),
    "rule",
    issues,
  );
  rule.clauses.forEach((clause, index) => validateEvidenceBinding(
    clause,
    selected.filter((assertion) => pointerWithin(assertion.target.jsonPointer, `/clauses/${index}`)),
    `clauses.${index}`,
    issues,
  ));
  rule.exceptions.forEach((exception, index) => validateEvidenceBinding(
    exception,
    selected.filter((assertion) => pointerWithin(assertion.target.jsonPointer, `/exceptions/${index}`)),
    `exceptions.${index}`,
    issues,
  ));
  return issues;
}

/** Resolve only committed active IDs; contested semantics never execute. */
export function resolveEffectiveWorldRules(
  rules: ReadonlyMap<string, WorldRule>,
  state: WorldState,
): WorldRuleResolution {
  const inactive: WorldRuleResolution["inactive"] = [];
  const candidates: WorldRule[] = [];
  for (const ruleId of [...state.activeRuleIds].sort()) {
    const rule = rules.get(ruleId);
    if (!rule) continue;
    if (rule.status === "contested") {
      inactive.push({ ruleId, reason: "contested" });
      continue;
    }
    if (!policyStoryScopeActive(state.logicalTime.storyTime, rule.validStoryTime, new Set())) {
      inactive.push({ ruleId, reason: "outside-time" });
      continue;
    }
    if (!rule.appliesWhen.every((predicate) => evaluatePredicate(state, predicate))) {
      inactive.push({ ruleId, reason: "not-applicable" });
      continue;
    }
    const matchedException = rule.exceptions
      .filter((exception) => exception.status === "supported")
      .find((exception) => exception.appliesWhen.every((predicate) => evaluatePredicate(state, predicate)));
    if (matchedException) {
      inactive.push({ ruleId, reason: "exception", exceptionId: matchedException.id });
      continue;
    }
    candidates.push(rule);
  }

  candidates.sort((left, right) => {
    return right.priority - left.priority || left.id.localeCompare(right.id);
  });
  const effectiveRules: WorldRule[] = [];
  for (const candidate of candidates) {
    const overriding = effectiveRules.find((rule) => rule.overridesRuleIds.includes(candidate.id));
    if (overriding) {
      inactive.push({ ruleId: candidate.id, reason: "overridden", overridingRuleId: overriding.id });
      continue;
    }
    effectiveRules.push(candidate);
  }
  return {
    effective: effectiveRules
      .map((rule) => ({
        id: rule.id,
        name: rule.name,
        rule,
        enforcement: isHardStateRule(rule) ? "hard-state" as const : "normative" as const,
        requires: worldRuleRequires(rule),
        forbids: worldRuleForbids(rule),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    inactive: inactive.sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  };
}

/**
 * Actor/model projection. Enforcement is independent from disclosure: hidden
 * or unknown rules still constrain the engine, but never enter a model prompt.
 */
export function modelVisibleWorldRules(
  rules: readonly EffectiveWorldRule[],
  input: {
    knownClaimIds: ReadonlySet<string>;
    visibleEntityIds: ReadonlySet<string>;
    observableEntityIds: ReadonlySet<string>;
    entities: ReadonlyMap<string, Pick<Entity, "kind">>;
  },
): ModelVisibleWorldRule[] {
  return rules.flatMap((effective): ModelVisibleWorldRule[] => {
    const rule = effective.rule;
    if (rule.visibility === "engine") return [];
    if (rule.visibility === "knowledge"
      && !rule.knownByClaimIds.some((claimId) => input.knownClaimIds.has(claimId))) return [];
    if (rule.visibility === "observable" && rule.scope !== "global"
      && !rule.jurisdictionEntityIds.some((entityId) => input.observableEntityIds.has(entityId))) return [];
    const predicates = [...rule.appliesWhen, ...effective.requires, ...effective.forbids];
    if (!predicates.every((predicate) => predicateEntityReferences(predicate, input.entities)
      .every((entityId) => input.visibleEntityIds.has(entityId)))) return [];
    return [{
      name: rule.name,
      scope: rule.scope,
      enforcement: effective.enforcement,
      appliesWhen: structuredClone(rule.appliesWhen),
      requires: structuredClone(effective.requires),
      forbids: structuredClone(effective.forbids),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function validateEvidenceBinding(
  semantic: {
    id: string;
    basis: "explicit" | "inferred";
    status: "supported" | "contested";
    evidence: readonly EvidenceRef[];
    counterEvidence?: readonly EvidenceRef[];
  },
  assertions: readonly EvidenceAssertion[],
  path: string,
  issues: ValidationIssue[],
): void {
  const supports = assertions.filter((assertion) => assertion.relation === "supports");
  const contradicts = assertions.filter((assertion) => assertion.relation === "contradicts");
  if (!supports.length) {
    issues.push(issue("MISSING_EXACT_WORLD_RULE_SUPPORT", `World-rule semantic ${semantic.id} requires exact supporting evidence`, path));
  }
  if (semantic.status === "contested" && !contradicts.length) {
    issues.push(issue("MISSING_EXACT_WORLD_RULE_COUNTER_EVIDENCE", `Contested world-rule semantic ${semantic.id} requires exact contradicting evidence`, `${path}.counterEvidence`));
  }
  if (semantic.status === "supported" && contradicts.length) {
    issues.push(issue("UNDECLARED_WORLD_RULE_CONTEST", `World-rule semantic ${semantic.id} has contradicting evidence but is marked supported`, `${path}.status`));
  }
  if (!sameSet(assertionEvidenceKeys(supports), new Set(semantic.evidence.map(evidenceKey)))) {
    issues.push(issue("WORLD_RULE_SUPPORT_BINDING_MISMATCH", `World-rule semantic ${semantic.id} evidence does not exactly match supporting assertions`, `${path}.evidence`));
  }
  if (!sameSet(assertionEvidenceKeys(contradicts), new Set((semantic.counterEvidence ?? []).map(evidenceKey)))) {
    issues.push(issue("WORLD_RULE_COUNTER_BINDING_MISMATCH", `World-rule semantic ${semantic.id} counter-evidence does not exactly match contradicting assertions`, `${path}.counterEvidence`));
  }
  if (semantic.basis === "explicit" && !supports.some((assertion) => assertion.strength === "explicit")) {
    issues.push(issue("MISSING_EXACT_EXPLICIT_WORLD_RULE_SUPPORT", `Explicit world-rule semantic ${semantic.id} requires exact explicit support`, `${path}.basis`));
  }
}

function validateRulePredicate(
  predicate: Predicate,
  catalog: WorldRuleReferenceCatalog,
  path: string,
  issues: ValidationIssue[],
): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => validateRulePredicate(item, catalog, `${path}.items.${index}`, issues));
    return;
  }
  if (predicate.op === "not") {
    validateRulePredicate(predicate.item, catalog, `${path}.item`, issues);
    return;
  }
  if (predicate.op === "rule-active") {
    if (!catalog.rules.has(predicate.ruleId)) {
      issues.push(issue("UNKNOWN_WORLD_RULE_REFERENCE", `Rule predicate references unknown rule ${predicate.ruleId}`, `${path}.ruleId`));
    }
    return;
  }
  if (predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") {
    if (predicate.time.kind === "relative") {
      issues.push(issue("UNEXECUTABLE_RELATIVE_RULE_TIME", "World-rule predicates cannot compare an unresolved relative story time; activate/deactivate the rule through committed events", `${path}.time`));
    }
    return;
  }
  if ("entityId" in predicate && !catalog.entities.has(predicate.entityId)) {
    issues.push(issue("UNKNOWN_WORLD_RULE_ENTITY", `Rule predicate references unknown entity ${predicate.entityId}`, `${path}.entityId`));
  }
  if (predicate.op === "entity-in" && !catalog.entities.has(predicate.member)) {
    issues.push(issue("UNKNOWN_WORLD_RULE_MEMBER", `Rule predicate references unknown member ${predicate.member}`, `${path}.member`));
  }
}

function predicateMentionsAnyEntity(predicate: Predicate, ids: ReadonlySet<string>): boolean {
  if (predicate.op === "all" || predicate.op === "any") return predicate.items.some((item) => predicateMentionsAnyEntity(item, ids));
  if (predicate.op === "not") return predicateMentionsAnyEntity(predicate.item, ids);
  if ("entityId" in predicate && ids.has(predicate.entityId)) return true;
  if (predicate.op === "entity-in" && ids.has(predicate.member)) return true;
  if (predicate.op === "fact-equals") {
    if (typeof predicate.value === "string" && ids.has(predicate.value)) return true;
    if (Array.isArray(predicate.value) && predicate.value.some((value) => ids.has(value))) return true;
  }
  return false;
}

function predicateEntityReferences(
  predicate: Predicate,
  entities: ReadonlyMap<string, Pick<Entity, "kind">>,
): string[] {
  if (predicate.op === "all" || predicate.op === "any") {
    return [...new Set(predicate.items.flatMap((item) => predicateEntityReferences(item, entities)))];
  }
  if (predicate.op === "not") return predicateEntityReferences(predicate.item, entities);
  const references: string[] = [];
  if ("entityId" in predicate) references.push(predicate.entityId);
  if (predicate.op === "entity-in") references.push(predicate.member);
  if (predicate.op === "fact-equals") {
    if (typeof predicate.value === "string" && entities.has(predicate.value)) references.push(predicate.value);
    if (Array.isArray(predicate.value)) {
      references.push(...predicate.value.filter((value) => entities.has(value)));
    }
  }
  return [...new Set(references)];
}

function pointerWithin(pointer: string, prefix: string): boolean {
  return pointer === prefix || pointer.startsWith(`${prefix}/`);
}

function evidenceKey(reference: EvidenceRef): string {
  return canonicalJson(reference);
}

function assertionEvidenceKeys(assertions: readonly EvidenceAssertion[]): Set<string> {
  return new Set(assertions.flatMap((assertion) => assertion.anchors.map((anchor) => evidenceKey({
    span: {
      sourceId: anchor.sourceId,
      startByte: anchor.startByte,
      endByte: anchor.endByte,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      quoteHash: anchor.exactHash,
    },
    strength: assertion.strength,
  }))));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function directedCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = [...new Set(cycle.slice(0, -1))].sort().join("\u0000");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const target of [...(graph.get(node) ?? [])].sort()) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}
