import path from "node:path";
import { CatalogService } from "./catalog-service.js";
import { resolvePreparationBranchId, inspectPreparation, type PreparationInspection } from "../workflow/prepare.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { ProposalStore } from "../world/canonical-model.js";
import {
  preparationSnapshotSchema,
  type CompilerAuditSummary,
  type PreparationNextAction,
  type PreparationSnapshot,
} from "../web/contracts.js";
import { webError } from "../web/errors.js";

export async function readPreparationSnapshot(
  rootValue: string,
  sourceId: string,
  requestedBranchId?: string,
): Promise<PreparationSnapshot> {
  const root = path.resolve(rootValue);
  const workspace = await WorkspaceStore.create(root);
  const source = await workspace.getSource(sourceId);
  if (!source) {
    throw webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }
  const branchId = await resolvePreparationBranchId(root, source, requestedBranchId);
  const [inspection, catalog, accepted, rejected] = await Promise.all([
    inspectPreparation(root, { sourceId, branchId }),
    new CatalogService(root).read(),
    new ProposalStore(root).list("accepted", sourceId),
    new ProposalStore(root).list("rejected", sourceId),
  ]);
  const novel = catalog.novels.find((candidate) => candidate.id === sourceId);
  if (!novel) {
    throw webError(409, "SOURCE_CATALOG_MISMATCH", `Source '${sourceId}' exists but is missing from the Web catalog.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/bootstrap",
      copyField: "catalog.novels[].id",
      maxAttempts: 1,
    });
  }
  const totalBatches = inspection.totalBatches;
  const completedBatches = Math.min(inspection.completedBatches, totalBatches);
  return preparationSnapshotSchema.parse({
    version: 1,
    source: novel,
    branchId: inspection.branchId,
    stage: inspection.stage,
    nextAction: nextActionFor(inspection),
    progress: {
      completedBatches,
      totalBatches,
      remainingBatches: Math.max(0, totalBatches - completedBatches),
      ratio: totalBatches === 0 ? 0 : completedBatches / totalBatches,
    },
    proposalCounts: {
      pending: inspection.pending.length,
      accepted: accepted.length,
      rejected: rejected.length,
    },
    repairReasons: inspection.repairReasons ?? [],
    ...(inspection.audit ? { audit: projectAudit(inspection.audit) } : {}),
    updatedAt: new Date().toISOString(),
  });
}

function nextActionFor(inspection: PreparationInspection): PreparationNextAction {
  switch (inspection.stage) {
    case "needs-source": return "register-source";
    case "choose-source": return "choose-source";
    case "compile": return "compile";
    case "review": return "review-proposals";
    case "repair": return "repair-analysis";
    case "needs-initial-world": return "generate-initial-world";
    case "create-branch": return "create-instance";
    case "ready": return "play";
  }
}

function projectAudit(audit: NonNullable<PreparationInspection["audit"]>): CompilerAuditSummary {
  return {
    canonical: {
      entities: audit.canonical.entities,
      propositions: audit.canonical.propositions,
      attributions: audit.canonical.attributions,
      claims: audit.canonical.claims,
      events: audit.canonical.events,
      eventParticipations: audit.canonical.eventParticipations,
      eventRelations: audit.canonical.eventRelations,
      spatialRelations: audit.canonical.spatialRelations,
      rules: audit.canonical.rules,
      initialWorld: audit.canonical.initialWorld,
      characterGoals: audit.canonical.characterGoals,
      characterModels: audit.canonical.characterModels,
      possibilities: audit.canonical.possibilities,
    },
    evidence: {
      artifactsChecked: audit.evidence.artifactsChecked,
      referencesChecked: audit.evidence.referencesChecked,
      invalidReferences: audit.evidence.invalidReferences,
      assertionsChecked: audit.evidence.assertionsChecked,
      invalidAssertions: audit.evidence.invalidAssertions,
      exactBindingRatio: audit.evidence.exactBindingRatio,
    },
    observations: {
      structuralUnits: audit.observations.structuralUnits,
      accountedUnits: audit.observations.accountedUnits,
      unaccountedUnits: audit.observations.unaccountedUnits,
      blockingUnits: audit.observations.blockingUnits,
      unitCoverage: audit.observations.unitCoverage,
      byteCoverage: audit.observations.byteCoverage,
    },
    consistency: {
      causalGraphValid: audit.consistency.causalGraphValid,
      narrativeGraphNavigable: audit.consistency.narrativeGraphNavigable,
      semanticReady: audit.consistency.semanticReady,
      causalComponents: audit.consistency.causalComponents,
      semanticIssues: audit.consistency.semanticIssues,
    },
    readiness: {
      structural: audit.readiness.structural,
      evidence: audit.readiness.evidence,
      accounting: audit.readiness.accounting,
      resolution: audit.readiness.resolution,
      semantic: audit.readiness.semantic,
      runtime: audit.readiness.runtime,
      publication: audit.readiness.publication,
      unknownDimensions: audit.readiness.unknownDimensions,
      blockingIssues: audit.readiness.blockingIssues,
    },
    notes: audit.notes,
  };
}
