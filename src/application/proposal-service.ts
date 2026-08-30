import path from "node:path";
import { convergeWorldProposals } from "../compiler/converge.js";
import { PossibilityCommitService } from "../compiler/possibility-commit.js";
import { CompilerCommitService, type CanonicalProposalKind } from "../compiler/validator.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { ProposalStore, type ProposalStatus as StoredProposalStatus } from "../world/canonical-model.js";
import {
  proposalAcceptRequestSchema,
  proposalConvergenceResultSchema,
  proposalConvergeRequestSchema,
  proposalDecisionResultSchema,
  proposalDetailSchema,
  proposalRejectRequestSchema,
  proposalSummarySchema,
  type ProposalAcceptRequest,
  type ProposalConvergenceResult,
  type ProposalConvergeRequest,
  type ProposalDecisionResult,
  type ProposalDetail,
  type ProposalRejectRequest,
  type ProposalStatus,
  type ProposalSummary,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { WebMutationJournal } from "../web/mutation-journal.js";

const canonicalKinds = new Set<CanonicalProposalKind>([
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

export interface ProposalApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  mutations?: WebMutationJournal;
}

export class ProposalApplicationService {
  readonly root: string;
  private readonly store: ProposalStore;
  private readonly mutations: WebMutationJournal;

  constructor(private readonly options: ProposalApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.store = new ProposalStore(this.root);
    this.mutations = options.mutations ?? new WebMutationJournal(this.root);
  }

  async list(sourceId: string, status: ProposalStatus = "pending", kind?: string): Promise<ProposalSummary[]> {
    await this.requireSource(sourceId);
    const summaries = await this.store.list(status, sourceId);
    return summaries
      .filter((summary) => !kind || summary.kind === kind)
      .map((summary) => proposalSummarySchema.parse({ ...summary, status }));
  }

  async get(proposalId: string, requestedStatus?: ProposalStatus): Promise<ProposalDetail> {
    const found = await this.find(proposalId, requestedStatus);
    const envelope = await this.store.readEnvelope(found.status, proposalId);
    const rejection = found.status === "rejected" ? await this.store.readRejection(proposalId) : null;
    return proposalDetailSchema.parse({
      summary: { ...found.summary, status: found.status },
      envelope,
      rejection,
    });
  }

  async accept(proposalId: string, inputValue: ProposalAcceptRequest): Promise<ProposalDecisionResult> {
    const input = proposalAcceptRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "proposal-accept",
      scopeId: proposalId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.acceptOnce(proposalId));
    return proposalDecisionResultSchema.parse({
      ...execution.value,
      reused: execution.reused || execution.value.reused,
    });
  }

  private async acceptOnce(proposalId: string): Promise<ProposalDecisionResult> {
    const found = await this.find(proposalId);
    if (found.status === "accepted") {
      return proposalDecisionResultSchema.parse({
        proposalId,
        kind: found.summary.kind,
        status: "accepted",
        accepted: true,
        reused: true,
        errors: [],
        warnings: [],
      });
    }
    if (found.status === "rejected") {
      throw webError(409, "PROPOSAL_ALREADY_REJECTED", `Proposal '${proposalId}' is already rejected and immutable. Submit a corrected proposal under a new ID.`, {
        kind: "none",
      });
    }
    const kind = found.summary.kind;
    if (kind !== "possibility" && !canonicalKinds.has(kind as CanonicalProposalKind)) {
      throw webError(
        409,
        "PROPOSAL_STAGING_ONLY",
        `Proposal '${proposalId}' has staging-only kind '${kind}' and cannot be committed individually. Complete its compiler batch or use source-scoped convergence.`,
        {
          kind: "after-user-action",
          discoveryEndpoint: "/api/v1/novels",
          copyField: "id",
          maxAttempts: 1,
        },
      );
    }

    const result = await withWorkspaceOperationLock(this.root, "compiler", async () => {
      if (kind === "possibility") {
        const validation = await new PossibilityCommitService(this.root).accept(proposalId);
        return proposalDecisionResultSchema.parse({
          proposalId,
          kind,
          status: validation.accepted ? "accepted" : "pending",
          accepted: validation.accepted,
          reused: false,
          errors: validation.errors,
          warnings: [],
        });
      }
      const validation = await new CompilerCommitService(this.root).accept(kind as CanonicalProposalKind, proposalId);
      return proposalDecisionResultSchema.parse({
        proposalId,
        kind,
        status: validation.accepted ? "accepted" : "pending",
        accepted: validation.accepted,
        reused: false,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    });
    this.options.events.publish("catalog.invalidated", {
      reason: result.accepted ? "proposal-accepted" : "proposal-validation-blocked",
      proposalId,
      kind,
    });
    return result;
  }

  async reject(proposalId: string, inputValue: ProposalRejectRequest): Promise<ProposalDecisionResult> {
    const input = proposalRejectRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "proposal-reject",
      scopeId: proposalId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.rejectOnce(proposalId, input.reason));
    return proposalDecisionResultSchema.parse({
      ...execution.value,
      reused: execution.reused || execution.value.reused,
    });
  }

  private async rejectOnce(proposalId: string, reason: string): Promise<ProposalDecisionResult> {
    const found = await this.find(proposalId);
    if (found.status === "accepted") {
      throw webError(409, "PROPOSAL_ALREADY_ACCEPTED", `Proposal '${proposalId}' is already committed and cannot be rejected.`, { kind: "none" });
    }
    if (found.status === "rejected") {
      const result = proposalDecisionResultSchema.parse({
        proposalId,
        kind: found.summary.kind,
        status: "rejected",
        accepted: false,
        reused: true,
        errors: (await this.store.readRejection(proposalId))?.errors ?? [],
        warnings: [],
      });
      return result;
    }

    const report = await withWorkspaceOperationLock(this.root, "compiler", () => this.store.reject(proposalId, [{
      code: "WEB_USER_REJECTED",
      message: reason,
    }]));
    const result = proposalDecisionResultSchema.parse({
      proposalId,
      kind: found.summary.kind,
      status: "rejected",
      accepted: false,
      reused: false,
      errors: report.errors,
      warnings: [],
    });
    this.options.events.publish("catalog.invalidated", {
      reason: "proposal-rejected",
      proposalId,
      kind: found.summary.kind,
    });
    return result;
  }

  async converge(sourceId: string, inputValue: ProposalConvergeRequest): Promise<ProposalConvergenceResult> {
    const input = proposalConvergeRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "proposal-converge",
      scopeId: sourceId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.convergeOnce(sourceId));
    return proposalConvergenceResultSchema.parse({
      ...execution.value,
      reused: execution.reused || execution.value.reused,
    });
  }

  private async convergeOnce(sourceId: string): Promise<ProposalConvergenceResult> {
    await this.requireSource(sourceId);
    const convergence = await withWorkspaceOperationLock(this.root, "compiler", () => convergeWorldProposals(this.root, sourceId));
    const result = proposalConvergenceResultSchema.parse({
      sourceId,
      accepted: [
        ...convergence.canonical.accepted,
        ...convergence.possibilities.accepted.map((id) => ({ id, kind: "possibility" })),
      ],
      blocked: [
        ...convergence.canonical.blocked,
        ...convergence.possibilities.blocked.map((item) => ({ ...item, kind: "possibility" })),
      ],
      staging: convergence.staging,
      reused: false,
    });
    this.options.events.publish("catalog.invalidated", {
      reason: "proposals-converged",
      sourceId,
      accepted: result.accepted.length,
      blocked: result.blocked.length,
    });
    return result;
  }

  private async requireSource(sourceId: string): Promise<void> {
    const workspace = await WorkspaceStore.create(this.root);
    if (await workspace.getSource(sourceId)) return;
    throw webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private async find(
    proposalId: string,
    requestedStatus?: ProposalStatus,
  ): Promise<{ status: StoredProposalStatus; summary: Omit<ProposalSummary, "status"> }> {
    const statuses: StoredProposalStatus[] = requestedStatus
      ? [requestedStatus]
      : ["pending", "accepted", "rejected"];
    for (const status of statuses) {
      const summary = (await this.store.list(status)).find((candidate) => candidate.id === proposalId);
      if (summary) return { status, summary };
    }
    throw webError(404, "PROPOSAL_NOT_FOUND", `Unknown ${requestedStatus ? `${requestedStatus} ` : ""}proposal '${proposalId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }
}
