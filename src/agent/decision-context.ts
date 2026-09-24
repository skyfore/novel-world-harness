import type { DecisionScope } from "../world/decision-scope.js";
import { playerActionCandidateSchema } from "../world/player-action.js";
import { actorDecisionViewSchema } from "../world/actor-decision-view.js";
import { contractFieldKeys } from "../world/actor-contracts.js";
import { contentHash } from "../world/canonical.js";

export type DecisionContextRequirements = {
  version: "decision-context/v2";
  snapshotHash: string;
  sections: readonly string[];
  recordRefs: readonly string[];
  hostChecksRequired: boolean;
  dependencyEdges: Array<{ from: string; to: string; reason: "contract-field" | "personal-experience" | "candidate-knowledge" | "candidate-action" | "candidate-channel" | "candidate-speech-receipt" | "candidate-text-receipt" | "candidate-message-receipt" }>;
};

/**
 * A conservative dependency package over an ALREADY actor-safe, opaque view.
 * Keep the complete disclosed contract/state/identity vocabulary together.
 * Natural-language motives and undisclosed host checks are not proven here.
 */
export function decisionContextRequirements(
  context: Readonly<Record<string, unknown>>,
): DecisionContextRequirements | undefined {
  if (context.decision === undefined && context.intendedCandidate === undefined) return undefined;
  const decision = actorDecisionViewSchema.parse(context.decision ?? { goals: [], appraisals: [], relationships: [], obligations: [], norms: [], processes: [] });
  const candidate = context.intendedCandidate === undefined ? undefined : playerActionCandidateSchema.parse(context.intendedCandidate);
  const fields = new Set(contractFieldKeys(decision));
  if (candidate) for (const field of contractFieldKeys(candidate)) fields.add(field);
  const candidateClaims = new Set([...(candidate?.requiresKnowledge ?? []), ...(candidate?.forbidsKnowledge ?? []),
    ...(candidate?.proposedKnowledge?.operations.map(op => op.claimId).filter(id => !id.startsWith("local-")) ?? [])]);
  const foundCandidateClaims = new Set<string>();
  const recordRefs: string[] = [];
  const dependencyEdges: DecisionContextRequirements["dependencyEdges"] = [];
  const experienceClaims = new Set((decision.experiences ?? []).map(item => item.claimId));
  const foundExperienceClaims = new Set<string>();
  if (Array.isArray(context.knowledge)) context.knowledge.forEach((entry, index) => {
    const predicate = entry?.claim?.predicate;
    if (candidateClaims.has(entry?.claimId)) {
      foundCandidateClaims.add(entry.claimId);
      recordRefs.push(`knowledge:${index}`);
      dependencyEdges.push({ from: "intendedCandidate", to: `knowledge:${index}`, reason: "candidate-knowledge" });
    }
    if (experienceClaims.has(entry?.claimId)) {
      foundExperienceClaims.add(entry.claimId);
      recordRefs.push(`knowledge:${index}`);
      dependencyEdges.push({ from: "decision:experiences", to: `knowledge:${index}`, reason: "personal-experience" });
    }
    if (typeof predicate !== "string") return;
    const normalized = predicate.normalize("NFKC").trim();
    const field = normalized.startsWith("state:") ? normalized.slice(6) : normalized;
    if (fields.has(field)) {
      recordRefs.push(`knowledge:${index}`);
      dependencyEdges.push({ from: "decision:contracts", to: `knowledge:${index}`, reason: "contract-field" });
    }
  });
  if ([...experienceClaims].some(id => !foundExperienceClaims.has(id)) || [...candidateClaims].some(id => !foundCandidateClaims.has(id))) {
    throw new DecisionContextDependencyError();
  }
  const selectedAction = candidate?.action?.lane === "schema-bound" ? candidate.action.schemaId : undefined;
  if (selectedAction) {
    const actionIndex = decision.capabilities.actions.findIndex(action => action.id === selectedAction);
    if (actionIndex < 0) throw new DecisionContextDependencyError();
    dependencyEdges.push({ from: "intendedCandidate", to: `decision:capabilities:actions:${actionIndex}`, reason: "candidate-action" });
  }
  const interaction = candidate?.intent?.controlledAct?.interaction;
  const bindings = [interaction?.kind === "speech" ? interaction.channelBinding : undefined,
    candidate?.action?.lane === "schema-bound" ? candidate.action.channelBinding : undefined,
    ...(candidate?.proposedSemantics?.operations.flatMap(op => op.op === "record-acquisition" && op.acquisition.basis.mode === "read" && "channelBinding" in op.acquisition.basis && op.acquisition.basis.channelBinding ? [op.acquisition.basis.channelBinding] : []) ?? [])];
  for (const binding of bindings) {
    if (!binding) continue;
    const index = decision.agency?.channels.findIndex(channel => channel.id === binding.channelId && channel.processId === binding.processId) ?? -1;
    if (index < 0) throw new DecisionContextDependencyError();
    dependencyEdges.push({ from: "intendedCandidate", to: `decision:agency:channels:${index}`, reason: "candidate-channel" });
  }
  for (const operation of candidate?.proposedSemantics?.operations ?? []) {
    if (operation.op !== "record-acquisition") continue;
    const basis = operation.acquisition.basis;
    if (basis.mode === "read" && "channelBinding" in basis && basis.channelBinding) {
      const index = decision.readableTexts?.findIndex(item => item.expressionId === basis.expressionId && item.attributionId === basis.attributionId && item.documentId === basis.documentId
        && item.propositionId === operation.acquisition.propositionId && item.channelBinding.channelId === basis.channelBinding!.channelId && item.channelBinding.processId === basis.channelBinding!.processId) ?? -1;
      if (index < 0) throw new DecisionContextDependencyError();
      dependencyEdges.push({ from: "intendedCandidate", to: `decision:readableTexts:${index}`, reason: "candidate-text-receipt" });
    }
    if (basis.mode === "read" && "messageEventId" in basis) {
      const index = decision.pendingMessages?.findIndex(item => item.eventId === basis.messageEventId && item.messageIndex === basis.messageIndex) ?? -1;
      if (index < 0) throw new DecisionContextDependencyError();
      dependencyEdges.push({ from: "intendedCandidate", to: `decision:pendingMessages:${index}`, reason: "candidate-message-receipt" });
    }
    if ((basis.mode !== "told" && basis.mode !== "deceived-misattributed") || !basis.utteranceEventId) continue;
    const index = decision.pendingSpeech?.findIndex(item => item.eventId === basis.utteranceEventId && item.utteranceIndex === basis.utteranceIndex) ?? -1;
    if (index < 0) throw new DecisionContextDependencyError();
    dependencyEdges.push({ from: "intendedCandidate", to: `decision:pendingSpeech:${index}`, reason: "candidate-speech-receipt" });
  }
  const contracts = [
    ...decision.capabilities.actions, ...decision.capabilities.processes, ...decision.capabilities.norms,
    ...decision.constraints.actions, ...decision.constraints.worldRules,
  ];
  return {
    version: "decision-context/v2",
    snapshotHash: contentHash(context),
    sections: [
      ...(candidate ? ["intendedCandidate"] : []),
      "decision", "actorId", "selfState", "scene", "presentEntities",
      "referenceableEntities", "ownedEntityState", "spatialRelations",
      "writableEntityIds", "writableStateFields",
    ],
    recordRefs: [...new Set(recordRefs)],
    dependencyEdges,
    hostChecksRequired: contracts.some((contract) => contract.hostChecksRequired),
  };
}

export type DecisionContextManifest = {
  version: "decision-context/v2";
  scope?: DecisionScope;
  scopeHash?: string;
  /** Binds only the isolated visible snapshot, not canonical truth or branch certification. */
  snapshotHash: string;
  status: "retained" | "blocked";
  requiredRecordRefs: string[];
  hostChecksRequired: boolean;
  maxModelChars: number;
  modelChars?: number;
  modelUtf8Bytes?: number;
  dependencyEdges: DecisionContextRequirements["dependencyEdges"];
  records: Array<{ ref: string; selected: boolean; reason: "required-section" | "required-dependency" | "optional-ranking" | "omitted-budget"; chars: number; utf8Bytes: number }>;
};

/** The input is already actor-filtered: an absent dependency cannot be recovered from canon. */
export class DecisionContextDependencyError extends Error {
  constructor() {
    super("Actor decision dependency has no matching knowledge content or action contract in this isolated snapshot. Stop inference; the host must rebuild the same actor/head view. Do not guess content, search another scope, or retry unchanged.");
    this.name = "DecisionContextDependencyError";
  }
}

export class DecisionContextBudgetError extends Error {
  constructor(readonly manifest: DecisionContextManifest) {
    super(`Decision dependency package exceeds the ${manifest.maxModelChars}-character model boundary. `
      + "Stop this inference; the host must narrow the decision task or explicitly revise its budget. "
      + "Do not drop contracts, guess missing dependencies, or retry unchanged.");
    this.name = "DecisionContextBudgetError";
  }
}
