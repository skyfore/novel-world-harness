import crypto from "node:crypto";
import { ActorModelStore } from "../world/actors.js";
import { canonicalJson } from "../world/canonical.js";
import {
  CanonicalModelStore,
  ProposalStore,
  type ProposalRejectionReport,
  type ProposalSummary,
} from "../world/canonical-model.js";
import { InitialWorldStore, initialWorldSchema, type InitialWorld } from "../world/initial.js";
import {
  attributionSchema,
  canonicalEventSchema,
  evidenceAssertionSchema,
  evidenceRefSchema,
  idSchema,
  type Attribution,
  type CanonicalEvent,
  type EvidenceAssertion,
  type EvidenceRef,
  type ValidationIssue,
} from "../world/model.js";
import { findKnowledgeDeltas, isCommunicatingKnowledgeSource } from "../world/knowledge-semantics.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../world/state.js";
import { SourceAnnotationStore } from "./annotations.js";
import { quarantineInvalidResolutionBindings, type QuarantinedProposal } from "./converge.js";
import {
  ENTITY_RESOLUTION_ONTOLOGY_VERSION,
  EntityResolutionStore,
  type IdentityResolutionProposal,
} from "./entity-resolution.js";
import { EvidenceVerifier } from "./evidence.js";
import { EventResolutionStore } from "./event-resolution.js";
import {
  compilerPayloadEvidence,
  compilerProposalLogicalIdentity,
  compilerProposalSchemas,
  CompilerProposalService,
  type CompilerProposalKind,
} from "./proposals.js";
import {
  CompilerCommitService,
  CompilerValidator,
  type CanonicalProposalKind,
  type CompilerValidationCatalog,
} from "./validator.js";

const LEGACY_DIAGNOSTIC_CODE = "LEGACY_REJECTION_DIAGNOSTIC_UNAVAILABLE";
const RECOVERY_WORKER = "legacy-rejection-recovery";
const CANONICAL_KINDS = new Set<CompilerProposalKind>([
  "entity",
  "proposition",
  "attribution",
  "claim",
  "canonical-event",
  "event-participation",
  "event-relation",
  "spatial-relation",
  "world-rule",
  "initial-world",
  "character-goal",
  "character-model",
]);

export type LegacyInitialWorldRepair = {
  payload: InitialWorld;
  evidenceAssertions?: EvidenceAssertion[];
};

export type LegacyArtifactRepair = {
  proposalId: string;
  sourceProposalId?: string;
  kind: CanonicalProposalKind;
  logicalIdentity: string;
  transformations: string[];
};

export type LegacyRecoverySkip = {
  sourceProposalId?: string;
  kind: string;
  logicalIdentity?: string;
  errors: ValidationIssue[];
};

export type LegacyCompilerRecoveryPlan = {
  version: 1;
  sourceId: string;
  missingCanonicalEventIds: string[];
  artifacts: LegacyArtifactRepair[];
  unresolvedMentionIds: string[];
  rejectionDiagnosticsToBackfill: number;
  skipped: LegacyRecoverySkip[];
};

export type LegacyCompilerRecoveryResult = {
  plan: LegacyCompilerRecoveryPlan;
  applied: boolean;
  rejectionDiagnosticsBackfilled: number;
  identityResolutionProposalIds: string[];
  accepted: Array<{ id: string; kind: CanonicalProposalKind }>;
  blocked: Array<{ id: string; kind: CanonicalProposalKind; errors: ValidationIssue[] }>;
  quarantinedResolutions: QuarantinedProposal[];
};

export type LegacyCompilerRecoveryOptions = {
  apply?: boolean;
  includeGraphArtifacts?: boolean;
  fillMissingIdentityResolutions?: boolean;
  initialWorld?: LegacyInitialWorldRepair;
};

type LegacyRejectedCandidate = {
  summary: ProposalSummary;
  kind: CanonicalProposalKind;
  payload: unknown;
  evidence: EvidenceRef[];
  evidenceAssertions: EvidenceAssertion[];
  logicalIdentity: string;
};

type PreparedArtifactRepair = LegacyArtifactRepair & {
  payload: unknown;
  evidence: EvidenceRef[];
  evidenceAssertions: EvidenceAssertion[];
};

type PreparedRecovery = {
  plan: LegacyCompilerRecoveryPlan;
  artifacts: PreparedArtifactRepair[];
  unresolvedResolutionProposals: IdentityResolutionProposal[];
};

/**
 * Recover only artifacts that can be tied to a concrete legacy failure mode:
 * dangling accepted event resolutions, their direct semantic dependencies and
 * participations, quotation-traced holder attributions rejected or
 * misclassified by legacy holder semantics, or graph records that pass current
 * record-local validation. Old rejected envelopes stay immutable; every
 * recovery is a new proposal.
 */
export async function recoverLegacyCompilerState(
  workspaceRoot: string,
  sourceIdInput: string,
  options: LegacyCompilerRecoveryOptions = {},
): Promise<LegacyCompilerRecoveryResult> {
  const sourceId = idSchema.parse(sourceIdInput);
  const prepared = await prepareLegacyRecovery(workspaceRoot, sourceId, options);
  if (!options.apply) {
    return {
      plan: prepared.plan,
      applied: false,
      rejectionDiagnosticsBackfilled: 0,
      identityResolutionProposalIds: [],
      accepted: [],
      blocked: [],
      quarantinedResolutions: [],
    };
  }

  const store = new ProposalStore(workspaceRoot);
  const pendingBefore = await store.list("pending", sourceId);
  if (pendingBefore.length) {
    throw new Error(
      `Legacy recovery requires a clean source proposal queue; ${sourceId} still has pending proposal(s): ${pendingBefore.map((item) => item.id).join(", ")}.`,
    );
  }

  const rejectionDiagnosticsBackfilled = await backfillLegacyProposalRejectionDiagnostics(
    workspaceRoot,
    sourceId,
  );

  const identityStore = new EntityResolutionStore(workspaceRoot);
  const identityResolutionProposalIds: string[] = [];
  for (const proposal of prepared.unresolvedResolutionProposals) {
    await identityStore.stage(sourceId, proposal);
    identityResolutionProposalIds.push(proposal.id);
  }
  if (identityResolutionProposalIds.length) {
    await identityStore.commitProposals(sourceId, identityResolutionProposalIds);
  }

  const proposals = new CompilerProposalService(workspaceRoot);
  for (const artifact of prepared.artifacts) {
    await proposals.submit(artifact.kind, {
      proposalId: artifact.proposalId,
      payload: artifact.payload,
      evidence: artifact.evidence,
      evidenceAssertions: artifact.evidenceAssertions,
      generatedBy: { worker: RECOVERY_WORKER },
    });
  }

  const convergence = await new CompilerCommitService(workspaceRoot).acceptAllValid(sourceId);
  const repairIds = new Set(prepared.artifacts.map((item) => item.proposalId));
  for (const blocked of convergence.blocked) {
    if (!repairIds.has(blocked.id)) {
      throw new Error(`Legacy recovery unexpectedly processed unrelated proposal ${blocked.id}.`);
    }
    await store.reject(blocked.id, blocked.errors);
  }
  const quarantinedResolutions = await quarantineInvalidResolutionBindings(workspaceRoot, sourceId);
  return {
    plan: prepared.plan,
    applied: true,
    rejectionDiagnosticsBackfilled,
    identityResolutionProposalIds,
    accepted: convergence.accepted,
    blocked: convergence.blocked,
    quarantinedResolutions,
  };
}

/**
 * Historical versions moved proposals to rejected without recording why. The
 * original cause cannot be reconstructed, so this backfill says that plainly
 * and attaches a separately labelled current structural/evidence re-check.
 */
export async function backfillLegacyProposalRejectionDiagnostics(
  workspaceRoot: string,
  sourceIdInput?: string,
): Promise<number> {
  const sourceId = sourceIdInput === undefined ? undefined : idSchema.parse(sourceIdInput);
  const store = new ProposalStore(workspaceRoot);
  const canon = new CanonicalModelStore(workspaceRoot);
  const validator = new CompilerValidator(
    canon,
    new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    new ActorModelStore(workspaceRoot),
  );
  const catalog = await validator.loadCatalog();
  const evidence = new EvidenceVerifier(workspaceRoot);
  let written = 0;
  for (const summary of await store.list("rejected", sourceId)) {
    if (await store.readRejection(summary.id)) continue;
    const envelope = await store.readEnvelope("rejected", summary.id);
    const currentIssues: ValidationIssue[] = [];
    try {
      if (!isCanonicalKind(summary.kind)) {
        currentIssues.push({
          code: "UNSUPPORTED_CURRENT_REEVALUATION",
          message: `Current structural re-evaluation does not handle proposal kind ${summary.kind}.`,
        });
      } else {
        const payload = compilerProposalSchemas[summary.kind].parse(envelope.payload);
        const validation = validator.validateWithCatalog(summary.kind, payload, catalog, {
          graphScope: summary.kind === "event-relation" || summary.kind === "spatial-relation" ? "record" : "catalog",
        });
        currentIssues.push(...validation.errors);
        const legacyEvidence = evidenceRefSchema.array().parse(envelope.evidence ?? []);
        const assertions = evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []);
        const [legacyInspection, exactInspection] = await Promise.all([
          evidence.inspectAll([...compilerPayloadEvidence(payload), ...legacyEvidence]),
          evidence.inspectAssertions(assertions),
        ]);
        currentIssues.push(...legacyInspection.issues, ...exactInspection.issues);
      }
    } catch (error) {
      currentIssues.push({
        code: "CURRENT_REEVALUATION_EXCEPTION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const diagnostics: ValidationIssue[] = [{
      code: LEGACY_DIAGNOSTIC_CODE,
      message: "The historical compiler version did not persist the original rejection reason. The following separately labelled findings are a current deterministic re-evaluation, not a reconstruction of that historical reason.",
    }];
    if (currentIssues.length) {
      diagnostics.push(...uniqueIssues(currentIssues).map((item) => ({
        code: `LEGACY_CURRENT_${item.code}`,
        message: `Current deterministic re-evaluation: ${item.message}`,
        ...(item.path ? { path: item.path } : {}),
      })));
    } else {
      diagnostics.push({
        code: "LEGACY_CURRENTLY_VALID_IN_ISOLATION",
        message: "The proposal passes current record-local structural and evidence-integrity validation in isolation.",
      });
    }
    await store.recordRejection(summary.id, summary.kind, diagnostics);
    written += 1;
  }
  return written;
}

async function prepareLegacyRecovery(
  workspaceRoot: string,
  sourceId: string,
  options: LegacyCompilerRecoveryOptions,
): Promise<PreparedRecovery> {
  const store = new ProposalStore(workspaceRoot);
  const canon = new CanonicalModelStore(workspaceRoot);
  const validator = new CompilerValidator(
    canon,
    new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    new ActorModelStore(workspaceRoot),
  );
  const catalog = await validator.loadCatalog();
  const allProposalIds = new Set<string>();
  for (const status of ["pending", "accepted", "rejected"] as const) {
    for (const summary of await store.list(status)) allProposalIds.add(summary.id);
  }

  const rejectedSummaries = await store.list("rejected", sourceId);
  const legacyCandidates: LegacyRejectedCandidate[] = [];
  let rejectionDiagnosticsToBackfill = 0;
  for (const summary of rejectedSummaries) {
    const report = await store.readRejection(summary.id);
    if (!report) rejectionDiagnosticsToBackfill += 1;
    if (!isLegacyUndiagnosed(report) || !isCanonicalKind(summary.kind)) continue;
    const envelope = await store.readEnvelope("rejected", summary.id);
    const payload = compilerProposalSchemas[summary.kind].parse(envelope.payload);
    const logicalIdentity = compilerProposalLogicalIdentity(summary.kind, payload);
    if (!logicalIdentity) continue;
    legacyCandidates.push({
      summary,
      kind: summary.kind,
      payload,
      evidence: evidenceRefSchema.array().parse(envelope.evidence ?? []),
      evidenceAssertions: evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []),
      logicalIdentity,
    });
  }
  const latest = newestByLogicalIdentity(legacyCandidates);
  const skipped: LegacyRecoverySkip[] = [];
  const artifacts: PreparedArtifactRepair[] = [];

  const eventResolutions = await new EventResolutionStore(workspaceRoot).list(sourceId);
  const missingCanonicalEventIds = [...new Set(eventResolutions
    .map((resolution) => resolution.canonicalEventId)
    .filter((eventId): eventId is string => Boolean(eventId) && !catalog.events.has(eventId!)))]
    .sort();

  const transformedEvents = new Map<string, { candidate: LegacyRejectedCandidate; payload: CanonicalEvent; transformations: string[] }>();
  for (const eventId of missingCanonicalEventIds) {
    const candidate = latest.get(`canonical-event:${eventId}`);
    if (!candidate || candidate.kind !== "canonical-event") {
      skipped.push({
        kind: "canonical-event",
        logicalIdentity: `canonical-event:${eventId}`,
        errors: [{ code: "MISSING_LEGACY_EVENT_PROPOSAL", message: `No recoverable rejected proposal exists for dangling canonical event ${eventId}.` }],
      });
      continue;
    }
    const original = canonicalEventSchema.parse(candidate.payload);
    const retainedCheckpoints = (original.characterEntryCheckpoints ?? []).filter((checkpoint) =>
      checkpoint.delta.operations.length + (checkpoint.knowledge?.operations.length ?? 0) > 0);
    const removed = (original.characterEntryCheckpoints?.length ?? 0) - retainedCheckpoints.length;
    const transformations = removed
      ? [`Removed ${removed} empty, non-actionable character-entry checkpoint(s); no state or knowledge fact was invented.`]
      : [];
    transformedEvents.set(eventId, {
      candidate,
      payload: canonicalEventSchema.parse({ ...original, characterEntryCheckpoints: retainedCheckpoints }),
      transformations,
    });
  }

  const requiredAttributionIds = new Set<string>();
  for (const { payload } of transformedEvents.values()) {
    for (const { delta } of findKnowledgeDeltas(payload)) {
      for (const operation of delta.operations) {
        if (operation.op === "learn" && operation.attributionId && !catalog.attributions.has(operation.attributionId)) {
          requiredAttributionIds.add(operation.attributionId);
        }
      }
    }
  }
  const quotationSpeakerRepairs = new Map<string, string>();
  for (const candidate of latest.values()) {
    if (candidate.kind !== "attribution") continue;
    const attribution = attributionSchema.parse(candidate.payload);
    const holder = attribution.holderEntityId ? catalog.entities.get(attribution.holderEntityId) : undefined;
    if (
      !catalog.attributions.has(attribution.id)
      && attribution.holderKind === "character"
      && Boolean(attribution.quotationIds?.length)
      && holder?.kind !== "character"
      && isCommunicatingKnowledgeSource(holder)
    ) {
      requiredAttributionIds.add(attribution.id);
      continue;
    }
    if (!catalog.attributions.has(attribution.id) && attribution.holderKind === "narrator") {
      const speakerEntityId = await resolvedQuotationSpeakerEntityId(
        workspaceRoot,
        sourceId,
        attribution,
        catalog,
      );
      if (speakerEntityId) {
        requiredAttributionIds.add(attribution.id);
        quotationSpeakerRepairs.set(attribution.id, speakerEntityId);
      }
    }
  }
  const transformedAttributions = new Map<string, { candidate: LegacyRejectedCandidate; payload: Attribution; transformations: string[] }>();
  const attributionQueue = [...requiredAttributionIds];
  while (attributionQueue.length) {
    const attributionId = attributionQueue.shift()!;
    if (catalog.attributions.has(attributionId) || transformedAttributions.has(attributionId)) continue;
    const candidate = latest.get(`attribution:${attributionId}`);
    if (!candidate || candidate.kind !== "attribution") {
      skipped.push({
        kind: "attribution",
        logicalIdentity: `attribution:${attributionId}`,
        errors: [{ code: "MISSING_LEGACY_ATTRIBUTION_PROPOSAL", message: `No recoverable rejected attribution exists for event dependency ${attributionId}.` }],
      });
      continue;
    }
    const original = attributionSchema.parse(candidate.payload);
    const holder = original.holderEntityId ? catalog.entities.get(original.holderEntityId) : undefined;
    const canRepairSystemHolder = original.holderKind === "character"
      && holder?.kind !== "character"
      && isCommunicatingKnowledgeSource(holder);
    const quotationSpeakerEntityId = quotationSpeakerRepairs.get(original.id);
    const payload = attributionSchema.parse(
      canRepairSystemHolder
        ? { ...original, holderKind: "system" }
        : quotationSpeakerEntityId
          ? { ...original, holderKind: "character", holderEntityId: quotationSpeakerEntityId }
          : original,
    );
    transformedAttributions.set(attributionId, {
      candidate,
      payload,
      transformations: canRepairSystemHolder
        ? [`Reclassified non-character communicating holder ${original.holderEntityId} from character to system.`]
        : quotationSpeakerEntityId
          ? [`Reclassified narrator holder to quotation-resolved character ${quotationSpeakerEntityId}.`]
          : [],
    });
    if (payload.sourceAttributionId && !catalog.attributions.has(payload.sourceAttributionId)) {
      attributionQueue.push(payload.sourceAttributionId);
    }
  }

  for (const [id, item] of transformedAttributions) catalog.attributions.set(id, item.payload);
  removeInvalidAttributions(validator, catalog, transformedAttributions, skipped);
  for (const [id, item] of transformedEvents) catalog.events.set(id, item.payload);
  removeInvalidEventsToFixpoint(validator, catalog, transformedEvents, skipped);

  for (const item of [...transformedAttributions.values()].sort(compareCandidateItems)) {
    addPreparedRepair(artifacts, allProposalIds, item.candidate, item.payload, item.transformations, skipped);
  }
  for (const item of [...transformedEvents.values()].sort(compareCandidateItems)) {
    addPreparedRepair(artifacts, allProposalIds, item.candidate, item.payload, item.transformations, skipped);
  }

  const recoveredEventIds = new Set(transformedEvents.keys());
  const participationCandidates = [...latest.values()]
    .filter((candidate) => candidate.kind === "event-participation")
    .filter((candidate) => recoveredEventIds.has((candidate.payload as { eventId?: string }).eventId ?? ""))
    .filter((candidate) => !catalog.eventParticipations.has((candidate.payload as { id: string }).id))
    .sort(compareCandidates);
  for (const candidate of participationCandidates) {
    const validation = validator.validateWithCatalog("event-participation", candidate.payload, catalog);
    if (!validation.accepted) {
      skipped.push(skipFor(candidate, validation.errors));
      continue;
    }
    catalog.eventParticipations.set((candidate.payload as { id: string }).id, candidate.payload as never);
    addPreparedRepair(artifacts, allProposalIds, candidate, candidate.payload, [], skipped);
  }

  if (options.includeGraphArtifacts !== false) {
    for (const kind of ["event-relation", "spatial-relation"] as const) {
      const current = kind === "event-relation" ? catalog.eventRelations : catalog.spatialRelations;
      const candidates = [...latest.values()]
        .filter((candidate): candidate is LegacyRejectedCandidate => candidate.kind === kind)
        .filter((candidate) => !current.has((candidate.payload as { id: string }).id))
        .sort(compareCandidates);
      for (const candidate of candidates) {
        const validation = validator.validateWithCatalog(kind, candidate.payload, catalog, { graphScope: "record" });
        if (!validation.accepted) {
          skipped.push(skipFor(candidate, validation.errors));
          continue;
        }
        addPreparedRepair(artifacts, allProposalIds, candidate, candidate.payload, [], skipped);
      }
    }
  }

  if (options.initialWorld && !(await new InitialWorldStore(workspaceRoot).get())) {
    const payload = initialWorldSchema.parse(options.initialWorld.payload);
    const validation = validator.validateWithCatalog("initial-world", payload, catalog);
    if (validation.accepted) {
      const proposalId = repairProposalId("initial-world", { sourceId, payload });
      const logicalIdentity = "initial-world:singleton";
      if (!allProposalIds.has(proposalId)) {
        artifacts.push({
          proposalId,
          kind: "initial-world",
          logicalIdentity,
          payload,
          evidence: [],
          evidenceAssertions: evidenceAssertionSchema.array().parse(options.initialWorld.evidenceAssertions ?? []),
          transformations: ["Added an operator-supplied, source-grounded opening checkpoint because no historical initial-world proposal existed."],
        });
        allProposalIds.add(proposalId);
      }
    } else {
      skipped.push({ kind: "initial-world", logicalIdentity: "initial-world:singleton", errors: validation.errors });
    }
  }

  const unresolvedResolutionProposals = options.fillMissingIdentityResolutions === false
    ? []
    : await missingIdentityResolutionProposals(workspaceRoot, sourceId);
  return {
    plan: {
      version: 1,
      sourceId,
      missingCanonicalEventIds,
      artifacts: artifacts.map(({ payload: _payload, evidence: _evidence, evidenceAssertions: _assertions, ...item }) => item),
      unresolvedMentionIds: unresolvedResolutionProposals.map((proposal) => proposal.payload.mentionId).sort(),
      rejectionDiagnosticsToBackfill,
      skipped,
    },
    artifacts,
    unresolvedResolutionProposals,
  };
}

async function resolvedQuotationSpeakerEntityId(
  workspaceRoot: string,
  sourceId: string,
  attribution: Attribution,
  catalog: CompilerValidationCatalog,
): Promise<string | undefined> {
  if (!attribution.quotationIds?.length) return undefined;
  const annotations = new SourceAnnotationStore(workspaceRoot);
  const resolutions = new EntityResolutionStore(workspaceRoot);
  const speakers = new Set<string>();
  for (const quotationId of attribution.quotationIds) {
    try {
      const quotation = await annotations.read(sourceId, quotationId);
      if (quotation.annotationType !== "quotation" || !quotation.speakerMentionId) return undefined;
      const resolution = await resolutions.currentForMention(sourceId, quotation.speakerMentionId);
      const entityId = resolution?.status === "resolved" || resolution?.status === "new-entity"
        ? resolution.entityId
        : undefined;
      if (!entityId || catalog.entities.get(entityId)?.kind !== "character") return undefined;
      speakers.add(entityId);
    } catch {
      return undefined;
    }
  }
  return speakers.size === 1 ? [...speakers][0] : undefined;
}

function removeInvalidAttributions(
  validator: CompilerValidator,
  catalog: CompilerValidationCatalog,
  candidates: Map<string, { candidate: LegacyRejectedCandidate; payload: Attribution; transformations: string[] }>,
  skipped: LegacyRecoverySkip[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, item] of [...candidates]) {
      const validation = validator.validateWithCatalog("attribution", item.payload, catalog);
      if (validation.accepted) continue;
      candidates.delete(id);
      catalog.attributions.delete(id);
      skipped.push(skipFor(item.candidate, validation.errors));
      changed = true;
    }
  }
}

function removeInvalidEventsToFixpoint(
  validator: CompilerValidator,
  catalog: CompilerValidationCatalog,
  candidates: Map<string, { candidate: LegacyRejectedCandidate; payload: CanonicalEvent; transformations: string[] }>,
  skipped: LegacyRecoverySkip[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, item] of [...candidates]) {
      const validation = validator.validateWithCatalog("canonical-event", item.payload, catalog);
      if (validation.accepted) continue;
      candidates.delete(id);
      catalog.events.delete(id);
      skipped.push(skipFor(item.candidate, validation.errors));
      changed = true;
    }
  }
}

async function missingIdentityResolutionProposals(
  workspaceRoot: string,
  sourceId: string,
): Promise<IdentityResolutionProposal[]> {
  const annotations = await new SourceAnnotationStore(workspaceRoot).list(sourceId, "entity-mention");
  const resolutions = new EntityResolutionStore(workspaceRoot);
  const resolvedMentionIds = new Set((await resolutions.list(sourceId)).map((resolution) => resolution.mentionId));
  const existingProposalIds = new Set<string>();
  for (const status of ["pending", "accepted", "rejected"] as const) {
    for (const summary of await resolutions.listProposals(sourceId, status)) existingProposalIds.add(summary.id);
  }
  const createdAt = new Date().toISOString();
  const proposals: IdentityResolutionProposal[] = [];
  for (const mention of annotations) {
    if (mention.annotationType !== "entity-mention" || resolvedMentionIds.has(mention.id)) continue;
    const proposalId = repairProposalId(`identity-${mention.id}`, { sourceId, mentionId: mention.id });
    if (existingProposalIds.has(proposalId)) continue;
    const resolutionId = repairProposalId(`unresolved-${mention.id}`, { sourceId, mentionId: mention.id });
    proposals.push({
      version: 1,
      id: proposalId,
      payload: {
        version: 1,
        id: resolutionId,
        sourceId,
        mentionId: mention.id,
        status: "unresolved",
        candidates: [],
        rationale: "The historical batch committed this source mention without a grounded identity resolution. It is preserved as unresolved instead of guessing an entity.",
        derivation: {
          runId: `legacy-recovery-${sourceId}`,
          worker: RECOVERY_WORKER,
          ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION,
        },
      },
      generatedBy: { worker: RECOVERY_WORKER },
      createdAt,
    });
  }
  return proposals.sort((left, right) => left.payload.mentionId.localeCompare(right.payload.mentionId));
}

function addPreparedRepair(
  target: PreparedArtifactRepair[],
  allProposalIds: Set<string>,
  candidate: LegacyRejectedCandidate,
  payload: unknown,
  transformations: string[],
  skipped: LegacyRecoverySkip[],
): void {
  const proposalId = repairProposalId(candidate.summary.id, payload);
  if (allProposalIds.has(proposalId)) {
    skipped.push({
      sourceProposalId: candidate.summary.id,
      kind: candidate.kind,
      logicalIdentity: candidate.logicalIdentity,
      errors: [{ code: "LEGACY_RECOVERY_ALREADY_ATTEMPTED", message: `Recovery proposal ${proposalId} already exists in proposal history.` }],
    });
    return;
  }
  target.push({
    proposalId,
    sourceProposalId: candidate.summary.id,
    kind: candidate.kind,
    logicalIdentity: candidate.logicalIdentity,
    payload,
    evidence: candidate.evidence,
    evidenceAssertions: candidate.evidenceAssertions,
    transformations,
  });
  allProposalIds.add(proposalId);
}

function newestByLogicalIdentity(candidates: readonly LegacyRejectedCandidate[]): Map<string, LegacyRejectedCandidate> {
  const selected = new Map<string, LegacyRejectedCandidate>();
  for (const candidate of [...candidates].sort(compareCandidates)) selected.set(candidate.logicalIdentity, candidate);
  return selected;
}

function compareCandidates(left: LegacyRejectedCandidate, right: LegacyRejectedCandidate): number {
  return left.summary.createdAt.localeCompare(right.summary.createdAt) || left.summary.id.localeCompare(right.summary.id);
}

function compareCandidateItems(
  left: { candidate: LegacyRejectedCandidate },
  right: { candidate: LegacyRejectedCandidate },
): number {
  return compareCandidates(left.candidate, right.candidate);
}

function skipFor(candidate: LegacyRejectedCandidate, errors: ValidationIssue[]): LegacyRecoverySkip {
  return {
    sourceProposalId: candidate.summary.id,
    kind: candidate.kind,
    logicalIdentity: candidate.logicalIdentity,
    errors: uniqueIssues(errors),
  };
}

function isLegacyUndiagnosed(report: ProposalRejectionReport | null): boolean {
  return report === null || report.errors.some((item) => item.code === LEGACY_DIAGNOSTIC_CODE);
}

function isCanonicalKind(kind: string): kind is CanonicalProposalKind {
  return CANONICAL_KINDS.has(kind as CompilerProposalKind);
}

function repairProposalId(label: string, value: unknown): string {
  const digest = crypto.createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 160) || "artifact";
  return idSchema.parse(`legacy-repair-${safeLabel}-${digest}`);
}

function uniqueIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const selected = new Map<string, ValidationIssue>();
  for (const item of issues) selected.set(`${item.code}\u0000${item.path ?? ""}\u0000${item.message}`, item);
  return [...selected.values()].sort((left, right) =>
    left.code.localeCompare(right.code)
    || (left.path ?? "").localeCompare(right.path ?? "")
    || left.message.localeCompare(right.message));
}
