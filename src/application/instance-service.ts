import path from "node:path";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import {
  createInstanceRequestSchema,
  createInstanceResultSchema,
  forkInstanceRequestSchema,
  forkInstanceResultSchema,
  instanceDetailSchema,
  type CreateInstanceRequest,
  type CreateInstanceResult,
  type ForkInstanceRequest,
  type ForkInstanceResult,
  type InstanceDetail,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { createWorldBranch } from "../world/instance.js";
import { BranchStore } from "../world/store.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { CatalogService } from "./catalog-service.js";
import { readPreparationSnapshot } from "./preparation-projection.js";

type StoredRequest<T> = { fingerprint: string; result: T };

export interface InstanceApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  cacheRoot?: string;
}

export class InstanceApplicationService {
  readonly root: string;
  private readonly branches: BranchStore;
  private readonly catalog: CatalogService;
  private readonly createRequests = new Map<string, StoredRequest<CreateInstanceResult>>();
  private readonly forkRequests = new Map<string, StoredRequest<ForkInstanceResult>>();

  constructor(private readonly options: InstanceApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.branches = new BranchStore(this.root);
    this.catalog = new CatalogService(this.root);
  }

  async create(inputValue: CreateInstanceRequest): Promise<CreateInstanceResult> {
    const input = createInstanceRequestSchema.parse(inputValue);
    const fingerprint = JSON.stringify(input);
    const previous = this.createRequests.get(input.clientRequestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw this.idempotencyConflict(input.clientRequestId);
      return createInstanceResultSchema.parse({ ...previous.result, reused: true });
    }
    const workspace = await WorkspaceStore.create(this.root);
    const source = await workspace.getSource(input.sourceId);
    if (!source) throw this.sourceNotFound(input.sourceId);

    const existing = await this.findInstance(input.branchId);
    if (existing) {
      if (existing.sourceId !== source.id) {
        throw webError(409, "BRANCH_SOURCE_CONFLICT", `Instance '${input.branchId}' belongs to source '${existing.sourceId ?? "unscoped"}', not '${source.id}'.`, {
          kind: "after-user-action",
          discoveryEndpoint: "/api/v1/instances",
          copyField: "branchId",
          maxAttempts: 1,
        });
      }
      return createInstanceResultSchema.parse({
        instance: existing,
        created: false,
        reused: true,
        usedCanonicalInitial: true,
        ...(existing.preparedRevisionHash ? { preparedRevisionHash: existing.preparedRevisionHash } : {}),
      });
    }

    const preparation = await readPreparationSnapshot(this.root, source.id, input.branchId);
    if (preparation.stage !== "create-branch") {
      throw webError(
        409,
        "SOURCE_NOT_READY_FOR_INSTANCE",
        `Source '${source.id}' is at preparation stage '${preparation.stage}', so instance '${input.branchId}' cannot be created yet.`,
        {
          kind: "after-user-action",
          discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(source.id)}/preparation?branchId=${encodeURIComponent(input.branchId)}`,
          copyField: "nextAction",
          maxAttempts: 1,
        },
        { stage: preparation.stage, nextAction: preparation.nextAction },
      );
    }

    const created = await withWorkspaceOperationLock(this.root, "compiler", async () => {
      const refreshed = await readPreparationSnapshot(this.root, source.id, input.branchId);
      if (refreshed.stage !== "create-branch") {
        throw webError(409, "PREPARATION_CHANGED", `Source '${source.id}' changed to stage '${refreshed.stage}' before instance creation.`, {
          kind: "after-refresh",
          discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(source.id)}/preparation?branchId=${encodeURIComponent(input.branchId)}`,
          copyField: "stage",
          maxAttempts: 1,
        });
      }
      await new PreparedNovelCache(this.root, this.options.cacheRoot).publish(source);
      return createWorldBranch(
        this.root,
        input.branchId,
        undefined,
        source.id,
        this.options.cacheRoot,
        input.entryActorId,
      );
    });
    const instance = await this.requireInstance(input.branchId);
    const result = createInstanceResultSchema.parse({
      instance,
      created: true,
      reused: false,
      usedCanonicalInitial: created.usedCanonicalInitial,
      ...(created.preparedRevisionHash ? { preparedRevisionHash: created.preparedRevisionHash } : {}),
    });
    this.createRequests.set(input.clientRequestId, { fingerprint, result });
    this.options.events.publish("catalog.invalidated", {
      reason: "instance-created",
      sourceId: source.id,
      branchId: input.branchId,
    });
    return result;
  }

  async fork(parentBranchId: string, inputValue: ForkInstanceRequest): Promise<ForkInstanceResult> {
    const input = forkInstanceRequestSchema.parse(inputValue);
    const fingerprint = JSON.stringify({ parentBranchId, ...input });
    const requestKey = `${parentBranchId}:${input.clientRequestId}`;
    const previous = this.forkRequests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw this.idempotencyConflict(input.clientRequestId);
      return forkInstanceResultSchema.parse({ ...previous.result, reused: true });
    }
    if (input.newBranchId === parentBranchId) {
      throw webError(400, "FORK_BRANCH_ID_UNCHANGED", "A fork must use a new branch ID.", { kind: "after-user-action" });
    }
    const parent = await this.requireInstance(parentBranchId);
    const parentBranch = await this.branches.read(parentBranchId);
    const forkCommitId = input.fromCommit ?? parent.headCommitId;
    const existing = await this.findInstance(input.newBranchId);
    if (existing) {
      const existingBranch = await this.branches.read(existing.branchId);
      if (existingBranch.parentBranchId !== parentBranchId || existingBranch.forkCommitId !== forkCommitId) {
        throw webError(409, "FORK_TARGET_CONFLICT", `Instance '${input.newBranchId}' already exists with a different parent or fork commit.`, {
          kind: "after-user-action",
          discoveryEndpoint: "/api/v1/instances",
          copyField: "branchId",
          maxAttempts: 1,
        });
      }
      return forkInstanceResultSchema.parse({
        instance: existing,
        parentBranchId,
        forkCommitId,
        created: false,
        reused: true,
      });
    }

    const { runtime } = await openWorkspaceWorld(this.root, undefined, {
      ...(parentBranch.sourceId ? { sourceId: parentBranch.sourceId } : {}),
      ...(parentBranch.preparedRevisionHash ? { preparedRevisionHash: parentBranch.preparedRevisionHash } : {}),
    });
    try {
      await runtime.forkBranch(parentBranchId, forkCommitId, input.newBranchId, input.name ?? input.newBranchId);
    } catch (error) {
      throw webError(409, "FORK_FAILED", error instanceof Error ? error.message : String(error), {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/instances/${encodeURIComponent(parentBranchId)}`,
        copyField: "history[].id",
        maxAttempts: 1,
      });
    }
    const instance = await this.requireInstance(input.newBranchId);
    const result = forkInstanceResultSchema.parse({
      instance,
      parentBranchId,
      forkCommitId,
      created: true,
      reused: false,
    });
    this.forkRequests.set(requestKey, { fingerprint, result });
    this.options.events.publish("catalog.invalidated", {
      reason: "instance-forked",
      branchId: input.newBranchId,
      parentBranchId,
      forkCommitId,
    });
    return result;
  }

  async get(branchId: string): Promise<InstanceDetail> {
    const instance = await this.requireInstance(branchId);
    const { engine } = await openWorkspaceWorld(this.root, undefined, {
      ...(instance.sourceId ? { sourceId: instance.sourceId } : {}),
      ...(instance.preparedRevisionHash ? { preparedRevisionHash: instance.preparedRevisionHash } : {}),
    });
    const commits: InstanceDetail["history"] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = instance.headCommitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await engine.objects.getCommit(cursor);
      const events = await Promise.all(commit.eventHashes.map(async (hash) => {
        const event = await engine.objects.getEvent(hash);
        return {
          hash,
          eventId: event.eventId,
          title: event.title,
          ...(event.possibilityId ? { possibilityId: event.possibilityId } : {}),
        };
      }));
      commits.push({
        id: cursor,
        ...(commit.parentCommitId ? { parentCommitId: commit.parentCommitId } : {}),
        logicalStep: commit.logicalTime.step,
        eventCount: events.length,
        events,
      });
      cursor = commit.parentCommitId;
    }
    commits.reverse();
    return instanceDetailSchema.parse({ instance, history: commits });
  }

  private async findInstance(branchId: string) {
    return (await this.catalog.read()).instances.find((candidate) => candidate.branchId === branchId);
  }

  private async requireInstance(branchId: string) {
    const instance = await this.findInstance(branchId);
    if (instance) return instance;
    throw webError(404, "INSTANCE_NOT_FOUND", `Unknown world instance '${branchId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/instances",
      copyField: "branchId",
      maxAttempts: 1,
    });
  }

  private sourceNotFound(sourceId: string) {
    return webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private idempotencyConflict(clientRequestId: string) {
    return webError(409, "IDEMPOTENCY_CONFLICT", `Client request '${clientRequestId}' was already used with different input.`, { kind: "none" });
  }
}
