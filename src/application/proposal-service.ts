import path from "node:path";
import { convergeWorldProposals } from "../compiler/converge.js";
import { PossibilityCommitService } from "../compiler/possibility-commit.js";
import { CompilerCommitService, type CanonicalProposalKind } from "../compiler/validator.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { ProposalStore, type ProposalStatus as StoredProposalStatus } from "../world/canonical-model.js";
import { contentHash } from "../world/canonical.js";
import {
  proposalAcceptRequestSchema,
  proposalConvergenceResultSchema,
  proposalConvergeRequestSchema,
  proposalDecisionResultSchema,
  proposalDetailSchema,
  proposalPageSchema,
  proposalRejectRequestSchema,
  proposalSummarySchema,
  type ProposalAcceptRequest,
  type ProposalConvergenceResult,
  type ProposalConvergeRequest,
  type ProposalDecisionResult,
  type ProposalDetail,
  type ProposalPage,
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

const DEFAULT_PROPOSAL_PAGE_LIMIT = 75;
const MAX_PROPOSAL_PAGE_LIMIT = 500;
const PROPOSAL_PAGE_CACHE_TTL_MS = 60_000;
const MAX_CACHED_PROPOSAL_LISTS = 6;

export type ProposalPageInput = {
  status?: ProposalStatus;
  kind?: string;
  cursor?: string;
  limit?: number;
};

type CachedProposalList = {
  sourceId: string;
  status: ProposalStatus;
  kind: string | null;
  snapshotId: string;
  items: ProposalSummary[];
  facets: Record<string, number>;
  expiresAt: number;
};

export interface ProposalApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  mutations?: WebMutationJournal;
}

export class ProposalApplicationService {
  readonly root: string;
  private readonly store: ProposalStore;
  private readonly mutations: WebMutationJournal;
  private readonly pageCache = new Map<string, CachedProposalList>();

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

  async listPage(sourceId: string, input: ProposalPageInput = {}): Promise<ProposalPage> {
    const status = input.status ?? "pending";
    const limit = input.limit ?? DEFAULT_PROPOSAL_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROPOSAL_PAGE_LIMIT) {
      throw webError(400, "PROPOSAL_PAGE_LIMIT_INVALID", `Proposal page limit must be an integer between 1 and ${MAX_PROPOSAL_PAGE_LIMIT}.`, {
        kind: "after-user-action",
      });
    }
    const endpoint = proposalListEndpoint(sourceId, status, input.kind);
    const cursor = input.cursor ? readProposalCursor(input.cursor, endpoint) : undefined;
    if (cursor && (cursor.status !== status || cursor.kind !== (input.kind ?? null))) throw invalidProposalCursor(endpoint);
    const cached = cursor ? this.pageCache.get(cursor.snapshotId) : undefined;
    if (cursor && cached && cached.expiresAt > Date.now() && cached.sourceId === sourceId
      && cached.status === status && cached.kind === (input.kind ?? null)) {
      return proposalPage(cached, cursor.offset, limit, endpoint);
    }
    const all = await this.list(sourceId, status);
    const facets = countKinds(all);
    const items = input.kind ? all.filter((summary) => summary.kind === input.kind) : all;
    const snapshotId = contentHash({
      sourceId,
      status,
      kind: input.kind ?? null,
      proposals: items.map(({ id, kind, createdAt }) => ({ id, kind, createdAt })),
    });
    const offset = input.cursor
      ? decodeProposalCursor(input.cursor, { snapshotId, status, kind: input.kind, endpoint })
      : 0;
    const pageSet: CachedProposalList = {
      sourceId,
      status,
      kind: input.kind ?? null,
      snapshotId,
      items,
      facets,
      expiresAt: Date.now() + PROPOSAL_PAGE_CACHE_TTL_MS,
    };
    this.rememberPageSet(pageSet);
    return proposalPage(pageSet, offset, limit, endpoint);
  }

  private rememberPageSet(pageSet: CachedProposalList): void {
    const now = Date.now();
    for (const [snapshotId, cached] of this.pageCache) {
      if (cached.expiresAt <= now) this.pageCache.delete(snapshotId);
    }
    this.pageCache.delete(pageSet.snapshotId);
    this.pageCache.set(pageSet.snapshotId, pageSet);
    while (this.pageCache.size > MAX_CACHED_PROPOSAL_LISTS) {
      const oldest = this.pageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pageCache.delete(oldest);
    }
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
    const accepted = [
      ...convergence.canonical.accepted,
      ...convergence.possibilities.accepted.map((id) => ({ id, kind: "possibility" })),
    ];
    const blocked = [
      ...convergence.canonical.blocked,
      ...convergence.possibilities.blocked.map((item) => ({ ...item, kind: "possibility" })),
    ];
    const staging = convergence.staging;
    const result = proposalConvergenceResultSchema.parse({
      sourceId,
      counts: { accepted: accepted.length, blocked: blocked.length, staging: staging.length },
      acceptedPreview: accepted.slice(0, 50),
      blockedPreview: blocked.slice(0, 50),
      stagingPreview: staging.slice(0, 50),
      truncated: accepted.length > 50 || blocked.length > 50 || staging.length > 50,
      reused: false,
    });
    this.options.events.publish("catalog.invalidated", {
      reason: "proposals-converged",
      sourceId,
      accepted: result.counts.accepted,
      blocked: result.counts.blocked,
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

type ProposalCursor = {
  version: 1;
  snapshotId: string;
  offset: number;
  status: ProposalStatus;
  kind: string | null;
};

function encodeProposalCursor(cursor: ProposalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function proposalPage(pageSet: CachedProposalList, offset: number, limit: number, endpoint: string): ProposalPage {
  if (offset > pageSet.items.length) {
    throw webError(409, "PROPOSAL_PAGE_CURSOR_STALE", "The proposal page cursor points beyond the current immutable listing. Refresh the first page, copy its page.nextCursor exactly, and retry at most once; do not guess a cursor.", {
      kind: "after-refresh",
      discoveryEndpoint: endpoint,
      copyField: "page.nextCursor",
      maxAttempts: 1,
    });
  }
  const items = pageSet.items.slice(offset, offset + limit);
  const loaded = offset + items.length;
  const nextCursor = loaded < pageSet.items.length
    ? encodeProposalCursor({
      version: 1,
      snapshotId: pageSet.snapshotId,
      offset: loaded,
      status: pageSet.status,
      kind: pageSet.kind,
    })
    : null;
  return proposalPageSchema.parse({
    version: 1,
    items,
    page: {
      snapshotId: pageSet.snapshotId,
      offset,
      limit,
      loaded,
      total: pageSet.items.length,
      nextCursor,
    },
    facets: { kinds: pageSet.facets },
  });
}

function decodeProposalCursor(
  value: string,
  expected: { snapshotId: string; status: ProposalStatus; kind?: string; endpoint: string },
): number {
  const cursor = readProposalCursor(value, expected.endpoint);
  if (cursor.status !== expected.status || cursor.kind !== (expected.kind ?? null)) {
    throw invalidProposalCursor(expected.endpoint);
  }
  if (cursor.snapshotId !== expected.snapshotId) {
    throw webError(409, "PROPOSAL_PAGE_CURSOR_STALE", "The proposal listing changed while pages were being read. Refresh the first page, copy its page.nextCursor exactly, and retry at most once; do not reuse the stale cursor.", {
      kind: "after-refresh",
      discoveryEndpoint: expected.endpoint,
      copyField: "page.nextCursor",
      maxAttempts: 1,
    });
  }
  return cursor.offset;
}

function readProposalCursor(value: string, endpoint: string): ProposalCursor {
  let cursor: ProposalCursor;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ProposalCursor;
  } catch {
    throw invalidProposalCursor(endpoint);
  }
  if (cursor.version !== 1 || !Number.isInteger(cursor.offset) || cursor.offset < 0
    || typeof cursor.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(cursor.snapshotId)
    || !["pending", "accepted", "rejected"].includes(cursor.status)
    || (cursor.kind !== null && typeof cursor.kind !== "string")) {
    throw invalidProposalCursor(endpoint);
  }
  return cursor;
}

function invalidProposalCursor(endpoint: string) {
  return webError(400, "PROPOSAL_PAGE_CURSOR_INVALID", "The proposal page cursor is invalid for this listing. Read the first page, copy page.nextCursor exactly, and retry at most once; do not guess or retry unchanged.", {
    kind: "after-refresh",
    discoveryEndpoint: endpoint,
    copyField: "page.nextCursor",
    maxAttempts: 1,
  });
}

function proposalListEndpoint(sourceId: string, status: ProposalStatus, kind?: string): string {
  const query = new URLSearchParams({ status });
  if (kind) query.set("kind", kind);
  return `/api/v1/novels/${encodeURIComponent(sourceId)}/proposals?${query.toString()}`;
}

function countKinds(items: readonly ProposalSummary[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[item.kind] = (result[item.kind] ?? 0) + 1;
  return result;
}
