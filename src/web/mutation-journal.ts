import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { redactTraceSecrets } from "../trace/redaction.js";
import { apiErrorSchema } from "./contracts.js";
import { WebApplicationError, webError } from "./errors.js";

const mutationFailureSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  detail: apiErrorSchema,
}).strict();

const mutationRecordSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  kind: z.string().min(1),
  scopeId: z.string().min(1),
  clientRequestId: z.string().min(1),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  result: z.unknown().optional(),
  failure: mutationFailureSchema.optional(),
}).strict();

type MutationRecord = z.infer<typeof mutationRecordSchema>;

export type DurableMutationInput = {
  kind: string;
  scopeId: string;
  clientRequestId: string;
  request: unknown;
};

export type DurableMutationResult<T> = {
  value: T;
  reused: boolean;
};

/**
 * Durable idempotency for short Web commands.
 *
 * Only a stable request fingerprint and the sanitized result are persisted;
 * request bodies (including source text) never enter this journal. A process
 * crash leaves an explicit interrupted record so an unknown mutation outcome
 * cannot be replayed unchanged.
 */
export class WebMutationJournal {
  readonly root: string;
  private initialization?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "web", "v1", "mutations");
  }

  initialize(): Promise<void> {
    this.initialization ??= this.exclusive(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      for (const name of (await fs.readdir(this.root)).filter((candidate) => candidate.endsWith(".json")).sort()) {
        const filePath = path.join(this.root, name);
        const record = mutationRecordSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
        if (name !== this.fileName(record.key)) {
          throw new Error(`Mutation journal '${name}' does not match key '${record.key}'.`);
        }
        if (record.status !== "running") continue;
        await this.atomicWrite(filePath, mutationRecordSchema.parse({
          ...record,
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          failure: {
            statusCode: 409,
            detail: {
              code: "MUTATION_INTERRUPTED",
              message: "The Web Host stopped while this command was running. Its outcome is unknown; reconcile the authoritative snapshot and do not replay it unchanged.",
              retry: { kind: "none" },
            },
          },
        }));
      }
    });
    return this.initialization;
  }

  async execute<T>(input: DurableMutationInput, mutate: () => Promise<T>): Promise<DurableMutationResult<T>> {
    await this.initialize();
    return this.exclusive(async () => {
      const key = mutationKey(input);
      const requestFingerprint = stableFingerprint(input.request);
      const filePath = path.join(this.root, this.fileName(key));
      const previous = await this.read(filePath);
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw webError(409, "IDEMPOTENCY_CONFLICT", `Client request '${input.clientRequestId}' was already used with different input.`, { kind: "none" });
        }
        if (previous.status === "succeeded") {
          return { value: structuredClone(previous.result) as T, reused: true };
        }
        if (previous.status === "failed" && previous.failure) {
          throw new WebApplicationError(previous.failure.statusCode, previous.failure.detail);
        }
        throw webError(409, "MUTATION_INTERRUPTED", `Client request '${input.clientRequestId}' has an unknown outcome after a host interruption. Refresh authoritative state and use a new request only after reconciliation.`, {
          kind: "none",
        });
      }

      const started = mutationRecordSchema.parse({
        version: 1,
        key,
        kind: input.kind,
        scopeId: input.scopeId,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await this.atomicWrite(filePath, started);
      try {
        const value = await mutate();
        await this.atomicWrite(filePath, mutationRecordSchema.parse({
          ...started,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          result: redactTraceSecrets(value),
        }));
        return { value, reused: false };
      } catch (error) {
        const failure = mutationFailure(error);
        await this.atomicWrite(filePath, mutationRecordSchema.parse({
          ...started,
          status: "failed",
          finishedAt: new Date().toISOString(),
          failure,
        }));
        throw error;
      }
    });
  }

  private async read(filePath: string): Promise<MutationRecord | null> {
    try {
      return mutationRecordSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private fileName(key: string): string {
    return `${crypto.createHash("sha256").update(key).digest("hex")}.json`;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async atomicWrite(filePath: string, value: MutationRecord): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function mutationKey(input: Pick<DurableMutationInput, "kind" | "scopeId" | "clientRequestId">): string {
  return `${input.kind}:${input.scopeId}:${input.clientRequestId}`;
}

function stableFingerprint(input: unknown): string {
  return crypto.createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`;
  if (input && typeof input === "object") {
    return `{${Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input) ?? "null";
}

function mutationFailure(error: unknown): z.infer<typeof mutationFailureSchema> {
  if (error instanceof WebApplicationError) {
    return mutationFailureSchema.parse(redactTraceSecrets({ statusCode: error.statusCode, detail: error.detail }));
  }
  return mutationFailureSchema.parse(redactTraceSecrets({
    statusCode: 500,
    detail: {
      code: "INTERNAL_ERROR",
      message: "The command failed before a durable result was recorded. Inspect the authoritative state before issuing a new request.",
      retry: { kind: "none" },
    },
  }));
}
