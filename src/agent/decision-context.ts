import { actorDecisionViewSchema } from "../world/actor-decision-view.js";
import { contractFieldKeys } from "../world/actor-contracts.js";
import { contentHash } from "../world/canonical.js";

export type DecisionContextRequirements = {
  version: "decision-context/v1";
  snapshotHash: string;
  sections: readonly string[];
  recordRefs: readonly string[];
  hostChecksRequired: boolean;
};

/**
 * A conservative dependency package over an ALREADY actor-safe, opaque view.
 * Keep the complete disclosed contract/state/identity vocabulary together.
 * Natural-language motives and undisclosed host checks are not proven here.
 */
export function decisionContextRequirements(
  context: Readonly<Record<string, unknown>>,
): DecisionContextRequirements | undefined {
  if (context.decision === undefined) return undefined;
  const decision = actorDecisionViewSchema.parse(context.decision);
  const fields = new Set(contractFieldKeys(decision));
  const recordRefs: string[] = [];
  if (Array.isArray(context.knowledge)) context.knowledge.forEach((entry, index) => {
    const predicate = entry?.claim?.predicate;
    if (typeof predicate !== "string") return;
    const normalized = predicate.normalize("NFKC").trim();
    if (normalized.startsWith("state:") && fields.has(normalized.slice(6))) {
      recordRefs.push(`knowledge:${index}`);
    }
  });
  const contracts = [
    ...decision.capabilities.actions, ...decision.capabilities.processes, ...decision.capabilities.norms,
    ...decision.constraints.actions, ...decision.constraints.worldRules,
  ];
  return {
    version: "decision-context/v1",
    snapshotHash: contentHash(context),
    sections: [
      "decision", "actorId", "selfState", "scene", "presentEntities",
      "referenceableEntities", "ownedEntityState", "spatialRelations",
      "writableEntityIds", "writableStateFields",
    ],
    recordRefs,
    hostChecksRequired: contracts.some((contract) => contract.hostChecksRequired),
  };
}

export type DecisionContextManifest = {
  version: "decision-context/v1";
  /** Binds only the isolated visible snapshot, not canonical truth or branch certification. */
  snapshotHash: string;
  status: "retained" | "blocked";
  requiredRecordRefs: string[];
  hostChecksRequired: boolean;
  maxModelChars: number;
  modelChars?: number;
};

export class DecisionContextBudgetError extends Error {
  constructor(readonly manifest: DecisionContextManifest) {
    super(`Decision dependency package exceeds the ${manifest.maxModelChars}-character model boundary. `
      + "Stop this inference; the host must narrow the decision task or explicitly revise its budget. "
      + "Do not drop contracts, guess missing dependencies, or retry unchanged.");
    this.name = "DecisionContextBudgetError";
  }
}
