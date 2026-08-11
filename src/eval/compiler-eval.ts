import { z } from "zod";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore } from "../world/canonical-model.js";

const edgeSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();

export const compilerGoldSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    expectedEntityIds: z.array(z.string().min(1)).default([]),
    expectedClaimIds: z.array(z.string().min(1)).default([]),
    expectedEventIds: z.array(z.string().min(1)).default([]),
    expectedCausalEdges: z.array(edgeSchema).default([]),
    expectedRuleIds: z.array(z.string().min(1)).default([]),
    expectedGoalIds: z.array(z.string().min(1)).default([]),
    expectedCharacterModelActorIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CompilerGold = z.infer<typeof compilerGoldSchema>;

export type SetMetric = {
  expected: number;
  actual: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  missing: string[];
  unexpected: string[];
};

export type CompilerEvaluationReport = {
  version: 1;
  suite: string;
  entities: SetMetric;
  claims: SetMetric;
  events: SetMetric;
  causalEdges: SetMetric;
  rules: SetMetric;
  goals: SetMetric;
  characterModels: SetMetric;
  macroF1: number | null;
};

export async function evaluateCompilerAgainstGold(workspaceRoot: string, goldInput: unknown): Promise<CompilerEvaluationReport> {
  const gold = compilerGoldSchema.parse(goldInput);
  const canon = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  const [entities, claims, events, rules, goals, models] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    actors.listGoals(),
    actors.listModels(),
  ]);

  const eventEdges = events.flatMap((event) => event.causalParents.map((parent) => edgeId(parent, event.id)));
  const report: CompilerEvaluationReport = {
    version: 1,
    suite: gold.name,
    entities: setMetric(gold.expectedEntityIds, entities.map((entity) => entity.id)),
    claims: setMetric(gold.expectedClaimIds, claims.map((claim) => claim.id)),
    events: setMetric(gold.expectedEventIds, events.map((event) => event.id)),
    causalEdges: setMetric(gold.expectedCausalEdges.map((edge) => edgeId(edge.from, edge.to)), eventEdges),
    rules: setMetric(gold.expectedRuleIds, rules.map((rule) => rule.id)),
    goals: setMetric(gold.expectedGoalIds, goals.map((goal) => goal.id)),
    characterModels: setMetric(gold.expectedCharacterModelActorIds, models.map((model) => model.actorId)),
    macroF1: null,
  };
  const f1s = [report.entities, report.claims, report.events, report.causalEdges, report.rules, report.goals, report.characterModels]
    .map((metric) => metric.f1)
    .filter((value): value is number => value !== null);
  report.macroF1 = f1s.length ? f1s.reduce((sum, value) => sum + value, 0) / f1s.length : null;
  return report;
}

function setMetric(expectedInput: readonly string[], actualInput: readonly string[]): SetMetric {
  const expected = new Set(expectedInput);
  const actual = new Set(actualInput);
  const matchedIds = [...expected].filter((id) => actual.has(id));
  const precision = actual.size ? matchedIds.length / actual.size : expected.size ? 0 : null;
  const recall = expected.size ? matchedIds.length / expected.size : actual.size ? null : null;
  const f1 = precision !== null && recall !== null
    ? precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall)
    : null;
  return {
    expected: expected.size,
    actual: actual.size,
    matched: matchedIds.length,
    precision,
    recall,
    f1,
    missing: [...expected].filter((id) => !actual.has(id)).sort(),
    unexpected: [...actual].filter((id) => !expected.has(id)).sort(),
  };
}

function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}
