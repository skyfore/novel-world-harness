import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { z } from "zod";

export const LIVE_TOKEN_BUDGET_HARD_LIMIT = 100_000_000;
export const MIN_LIVE_MAX_OUTPUT_TOKENS = 16;
export const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_LIVE_MAX_REQUESTS = 12;

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const tokenUsageSchema = z.object({
  input: nonNegativeSafeInteger,
  output: nonNegativeSafeInteger,
  cacheRead: nonNegativeSafeInteger,
  cacheWrite: nonNegativeSafeInteger,
  totalTokens: nonNegativeSafeInteger,
  reasoning: nonNegativeSafeInteger.optional(),
});

const requestBaseSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  runId: z.string().min(1),
  maxRequests: positiveSafeInteger.optional(),
  contextCeiling: positiveSafeInteger,
  outputCap: positiveSafeInteger,
  startedAt: z.string().datetime({ offset: true }),
}).strict();

const reservedRequestSchema = requestBaseSchema.extend({
  status: z.literal("reserved"),
}).strict();

const settledRequestSchema = requestBaseSchema.extend({
  status: z.literal("settled"),
  finishedAt: z.string().datetime({ offset: true }),
  stopReason: z.string().min(1),
  usage: tokenUsageSchema.optional(),
  chargedTokens: positiveSafeInteger,
  conservative: z.boolean(),
  failure: z.string().min(1).optional(),
}).strict();

const liveTokenRequestSchema = z.discriminatedUnion("status", [reservedRequestSchema, settledRequestSchema]);

const ledgerStateSchema = z.object({
  version: z.literal(1),
  campaignId: z.string().min(1),
  limit: positiveSafeInteger.max(LIVE_TOKEN_BUDGET_HARD_LIMIT),
  createdAt: z.string().datetime({ offset: true }),
  requests: z.record(z.string(), liveTokenRequestSchema),
}).strict();

const lockOwnerSchema = z.object({
  version: z.literal(1),
  pid: positiveSafeInteger,
  hostname: z.string().min(1),
  id: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type LiveTokenUsage = z.infer<typeof tokenUsageSchema>;
export type LiveTokenRequest = z.infer<typeof liveTokenRequestSchema>;
type LedgerState = z.infer<typeof ledgerStateSchema>;

export type LiveTokenReservationInput = {
  provider: string;
  model: string;
  runId: string;
  maxRequests?: number;
  contextCeiling: number;
  outputCap: number;
};

export type LiveTokenReservation = Extract<LiveTokenRequest, { status: "reserved" }>;
export type SettledLiveTokenRequest = Extract<LiveTokenRequest, { status: "settled" }>;

export type LiveTokenSettlement = {
  stopReason: string;
  usage?: LiveTokenUsage;
  failure?: string;
};

export type LiveTokenBudgetStatus = {
  campaignId: string;
  limit: number;
  chargedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  requests: number;
  settledRequests: number;
  reservedRequests: number;
  conservativeChargeTokens: number;
  reportedUsage: LiveTokenUsage;
  breached: boolean;
};

export type LiveTokenLedgerOptions = {
  filePath: string;
  campaignId?: string;
  limit?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  now?: () => Date;
  idFactory?: () => string;
};

export type LiveTokenLockOwner = z.infer<typeof lockOwnerSchema>;

export type LiveTokenLockRepairOptions = {
  filePath: string;
  expectedOwnerId: string;
};

export class LiveTokenBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTokenBudgetError";
  }
}

export class LiveTokenBudgetExceededError extends LiveTokenBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "LiveTokenBudgetExceededError";
  }
}

export class LiveRequestLimitError extends LiveTokenBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "LiveRequestLimitError";
  }
}

export class LiveRequestTimeoutError extends LiveTokenBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "LiveRequestTimeoutError";
  }
}

export class LiveTokenLedger {
  readonly filePath: string;
  readonly campaignId: string;
  readonly limit: number;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  private constructor(options: Required<Omit<LiveTokenLedgerOptions, "filePath">> & { filePath: string }) {
    this.filePath = path.resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.campaignId = options.campaignId;
    this.limit = options.limit;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.lockRetryMs = options.lockRetryMs;
    this.now = options.now;
    this.idFactory = options.idFactory;
  }

  static async inspectLock(filePath: string): Promise<LiveTokenLockOwner | undefined> {
    const lockPath = liveTokenLockPath(filePath);
    let raw: string;
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseLockOwner(raw, lockPath);
  }

  /**
   * Explicitly removes a lock only when its exact owner was inspected by the caller,
   * belongs to this host, and its PID is no longer alive. Active, malformed, remote,
   * or changed locks are always refused.
   */
  static async repairStaleLock(options: LiveTokenLockRepairOptions): Promise<boolean> {
    if (!options.expectedOwnerId) throw new LiveTokenBudgetError("expectedOwnerId must not be empty.");
    const lockPath = liveTokenLockPath(options.filePath);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    try {
      const raw = await handle.readFile("utf8");
      const owner = parseLockOwner(raw, lockPath);
      if (owner.id !== options.expectedOwnerId) {
        throw new LiveTokenBudgetError(
          `Live token ledger lock owner changed: expected '${options.expectedOwnerId}', found '${owner.id}'.`,
        );
      }
      if (owner.hostname !== os.hostname()) {
        throw new LiveTokenBudgetError(
          `Cannot verify lock owner ${owner.id}: host '${owner.hostname}' differs from '${os.hostname()}'.`,
        );
      }
      if (processIsAlive(owner.pid)) {
        throw new LiveTokenBudgetError(
          `Refusing to repair live token ledger lock ${lockPath}: owner PID ${owner.pid} is still alive.`,
        );
      }

      const openedStat = await handle.stat();
      let currentHandle: fs.FileHandle;
      try {
        currentHandle = await fs.open(lockPath, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new LiveTokenBudgetError(`Live token ledger lock ${lockPath} changed during stale-lock repair.`);
        }
        throw error;
      }
      try {
        const [currentRaw, currentStat] = await Promise.all([currentHandle.readFile("utf8"), currentHandle.stat()]);
        if (currentRaw !== raw || currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
          throw new LiveTokenBudgetError(`Live token ledger lock ${lockPath} changed during stale-lock repair.`);
        }
      } finally {
        await currentHandle.close();
      }

      await fs.unlink(lockPath);
      await syncDirectory(path.dirname(lockPath));
      return true;
    } finally {
      await handle.close();
    }
  }

  static async open(options: LiveTokenLedgerOptions): Promise<LiveTokenLedger> {
    if (!options.filePath.trim()) throw new LiveTokenBudgetError("filePath must not be empty.");
    const limit = requirePositiveInteger(options.limit ?? LIVE_TOKEN_BUDGET_HARD_LIMIT, "live token budget");
    if (limit > LIVE_TOKEN_BUDGET_HARD_LIMIT) {
      throw new LiveTokenBudgetError(
        `Live token budget ${limit} exceeds the hard limit of ${LIVE_TOKEN_BUDGET_HARD_LIMIT}.`,
      );
    }
    const lockTimeoutMs = requireNonNegativeInteger(options.lockTimeoutMs ?? 5_000, "lockTimeoutMs");
    const lockRetryMs = requirePositiveInteger(options.lockRetryMs ?? 10, "lockRetryMs");
    const ledger = new LiveTokenLedger({
      filePath: options.filePath,
      campaignId: options.campaignId ?? "default",
      limit,
      lockTimeoutMs,
      lockRetryMs,
      now: options.now ?? (() => new Date()),
      idFactory: options.idFactory ?? (() => crypto.randomUUID()),
    });
    await ledger.withLock(async () => {
      const existing = await ledger.readStateIfPresent();
      if (existing) {
        ledger.assertIdentity(existing);
        return;
      }
      await ledger.writeState({
        version: 1,
        campaignId: ledger.campaignId,
        limit: ledger.limit,
        createdAt: ledger.now().toISOString(),
        requests: {},
      });
    });
    return ledger;
  }

  async reserve(input: LiveTokenReservationInput): Promise<LiveTokenReservation> {
    const validated = validateReservationInput(input);
    return this.withLock(async () => {
      const state = await this.readRequiredState();
      this.assertIdentity(state);
      const status = statusFromState(state);
      if (status.breached) {
        throw new LiveTokenBudgetExceededError("The live token ledger is breached; no further provider requests are allowed.");
      }
      if (validated.contextCeiling > status.remainingTokens) {
        throw new LiveTokenBudgetExceededError(
          `Live token budget exhausted: request ceiling ${validated.contextCeiling} exceeds ${status.remainingTokens} remaining token(s).`,
        );
      }
      const sameRun = Object.values(state.requests).filter((request) => request.runId === validated.runId);
      const persistedLimits = sameRun.flatMap((request) => request.maxRequests === undefined ? [] : [request.maxRequests]);
      const runLimit = Math.min(validated.maxRequests ?? DEFAULT_LIVE_MAX_REQUESTS, ...persistedLimits);
      if (sameRun.length >= runLimit) {
        throw new LiveRequestLimitError(
          `Live provider request limit reached (${runLimit} for run ${validated.runId}).`,
        );
      }

      let id = this.idFactory();
      while (state.requests[id]) id = this.idFactory();
      const reservation: LiveTokenReservation = {
        ...validated,
        id,
        status: "reserved",
        startedAt: this.now().toISOString(),
      };
      state.requests[id] = reservation;
      await this.writeState(state);
      return reservation;
    });
  }

  async settle(reservationId: string, settlement: LiveTokenSettlement): Promise<SettledLiveTokenRequest> {
    if (!reservationId) throw new LiveTokenBudgetError("reservationId must not be empty.");
    if (!settlement.stopReason) throw new LiveTokenBudgetError("stopReason must not be empty.");
    return this.withLock(async () => {
      const state = await this.readRequiredState();
      this.assertIdentity(state);
      const request = state.requests[reservationId];
      if (!request) throw new LiveTokenBudgetError(`Unknown live token reservation: ${reservationId}`);
      if (request.status === "settled") return request;

      const parsedUsage = parseUsage(settlement.usage);
      const reportedCharge = parsedUsage ? chargedUsageTokens(parsedUsage) : 0;
      const trustworthy = isTrustworthyStopReason(settlement.stopReason) && reportedCharge > 0 && !settlement.failure;
      const chargedTokens = trustworthy ? reportedCharge : request.contextCeiling;
      const settled: SettledLiveTokenRequest = {
        ...request,
        status: "settled",
        finishedAt: this.now().toISOString(),
        stopReason: settlement.stopReason,
        ...(parsedUsage ? { usage: parsedUsage } : {}),
        chargedTokens,
        conservative: !trustworthy,
        ...(settlement.failure ? { failure: settlement.failure } : {}),
      };
      state.requests[reservationId] = settled;
      await this.writeState(state);
      return settled;
    });
  }

  async settleFailure(reservationId: string, failure: unknown, stopReason = "error"): Promise<SettledLiveTokenRequest> {
    return this.settle(reservationId, { stopReason, failure: errorMessage(failure) });
  }

  async status(): Promise<LiveTokenBudgetStatus> {
    return this.withLock(async () => {
      const state = await this.readRequiredState();
      this.assertIdentity(state);
      return statusFromState(state);
    });
  }

  private assertIdentity(state: LedgerState): void {
    if (state.campaignId !== this.campaignId) {
      throw new LiveTokenBudgetError(
        `Live token ledger campaign mismatch: expected '${this.campaignId}', found '${state.campaignId}'.`,
      );
    }
    if (state.limit !== this.limit) {
      throw new LiveTokenBudgetError(
        `Live token ledger limit mismatch: expected ${this.limit}, found ${state.limit}. The limit is immutable.`,
      );
    }
  }

  private async readRequiredState(): Promise<LedgerState> {
    const state = await this.readStateIfPresent();
    if (!state) throw new LiveTokenBudgetError(`Live token ledger disappeared: ${this.filePath}`);
    return state;
  }

  private async readStateIfPresent(): Promise<LedgerState | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return ledgerStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new LiveTokenBudgetError(
        `Invalid live token ledger ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async writeState(state: LedgerState): Promise<void> {
    const validated = ledgerStateSchema.parse(state);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.filePath);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    const owner = JSON.stringify({
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    let acquiredHandle: fs.FileHandle | undefined;
    while (!acquiredHandle) {
      let candidate: fs.FileHandle | undefined;
      try {
        candidate = await fs.open(this.lockPath, "wx", 0o600);
        await candidate.writeFile(`${owner}\n`, "utf8");
        await candidate.sync();
        acquiredHandle = candidate;
      } catch (error) {
        if (candidate) {
          await candidate.close().catch(() => undefined);
          await fs.unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new LiveTokenBudgetError(
            `Timed out waiting for live token ledger lock ${this.lockPath}. Refusing to bypass a possibly active lock.`,
          );
        }
        await delay(this.lockRetryMs);
      }
    }
    const handle = acquiredHandle;

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }
}

export type LiveModelLike = {
  provider: string;
  id: string;
  api?: string;
  contextWindow: number;
  maxTokens: number;
};

export type LiveStreamOptionsLike = {
  maxTokens?: number;
  maxRetries?: number;
  deferred?: false | { window?: "15m" | "1h" | "24h" };
  signal?: AbortSignal;
};

export type LiveAssistantMessageLike = {
  stopReason?: string;
  usage?: LiveTokenUsage;
};

export type LiveResultStreamLike<TMessage> = AsyncIterable<unknown> & {
  result(): Promise<TMessage>;
};

export type LiveStreamFunction<TModel, TContext, TOptions, TMessage, TStream> = (
  model: TModel,
  context: TContext,
  options?: TOptions,
) => TStream | Promise<TStream>;

export type BudgetedLiveStreamFunction<TModel, TContext, TOptions, TMessage, TStream> = ((
  model: TModel,
  context: TContext,
  options?: TOptions,
) => TStream) & {
  getRequestCount(): number;
};

export type LiveStreamBudgetOptions = {
  ledger: LiveTokenLedger;
  runId: string;
  maxOutputTokens?: number;
  maxRequests?: number;
  requestTimeoutMs?: number;
};

export function wrapLiveStreamFunction<
  TModel extends LiveModelLike,
  TContext,
  TOptions extends LiveStreamOptionsLike,
  TMessage extends LiveAssistantMessageLike,
  TStream extends LiveResultStreamLike<TMessage>,
>(
  streamFunction: LiveStreamFunction<TModel, TContext, TOptions, TMessage, TStream>,
  policy: LiveStreamBudgetOptions,
): BudgetedLiveStreamFunction<TModel, TContext, TOptions, TMessage, TStream> {
  if (!policy.runId) throw new LiveTokenBudgetError("runId must not be empty.");
  const configuredOutputCap = requirePositiveInteger(
    policy.maxOutputTokens ?? DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
    "maxOutputTokens",
  );
  if (configuredOutputCap < MIN_LIVE_MAX_OUTPUT_TOKENS) {
    throw new LiveTokenBudgetError(`maxOutputTokens must be at least ${MIN_LIVE_MAX_OUTPUT_TOKENS}.`);
  }
  const maxRequests = requirePositiveInteger(policy.maxRequests ?? DEFAULT_LIVE_MAX_REQUESTS, "maxRequests");
  const requestTimeoutMs = requirePositiveInteger(policy.requestTimeoutMs ?? 120_000, "requestTimeoutMs");
  let requestCount = 0;

  const wrapped = (model: TModel, context: TContext, options?: TOptions): TStream => {
    const contextCeiling = requirePositiveInteger(model.contextWindow, "model.contextWindow");
    const modelOutputCap = requirePositiveInteger(model.maxTokens, "model.maxTokens");
    const optionOutputCap = options?.maxTokens === undefined
      ? Number.MAX_SAFE_INTEGER
      : requirePositiveInteger(options.maxTokens, "options.maxTokens");
    const outputCap = Math.min(configuredOutputCap, modelOutputCap, optionOutputCap);
    if (outputCap < MIN_LIVE_MAX_OUTPUT_TOKENS) {
      throw new LiveTokenBudgetError(
        `Effective output cap for ${model.provider}/${model.id} must be at least ${MIN_LIVE_MAX_OUTPUT_TOKENS}.`,
      );
    }
    const cappedModel = { ...model, maxTokens: outputCap } as TModel;
    const timeoutController = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const cappedOptions = { ...options, maxTokens: outputCap, maxRetries: 0, deferred: false, signal } as TOptions;

    let reservation: LiveTokenReservation | undefined;
    let settlement: Promise<SettledLiveTokenRequest> | undefined;

    const settleOnce = (next: LiveTokenSettlement): Promise<SettledLiveTokenRequest> => {
      if (!reservation) {
        return Promise.reject(new LiveTokenBudgetError("Cannot settle a live request before its reservation is durable."));
      }
      settlement ??= policy.ledger.settle(reservation.id, next);
      return settlement;
    };

    const proxy = createLazyLiveAssistantMessageEventStream(async (output) => {
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        reservation = await policy.ledger.reserve({
          provider: model.provider,
          model: model.id,
          runId: policy.runId,
          maxRequests,
          contextCeiling,
          outputCap,
        });
        requestCount += 1;
        const timeoutError = new LiveRequestTimeoutError(
          `Live provider request timed out after ${requestTimeoutMs}ms for ${model.provider}/${model.id}.`,
        );
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            timeoutController.abort(timeoutError);
            reject(timeoutError);
          }, requestTimeoutMs);
        });
        const provider = (async () => {
          const stream = await streamFunction(cappedModel, context, cappedOptions);
          for await (const event of stream) {
            if (timedOut || isTerminalStreamEvent(event)) continue;
            output.push(event as never);
          }
          return stream.result();
        })();
        const message = await Promise.race([provider, deadline]);
        await settleOnce({
          stopReason: message.stopReason ?? "unknown",
          ...(message.usage ? { usage: message.usage } : {}),
        });
        output.push(terminalStreamEvent(message) as never);
      } catch (error) {
        if (reservation) {
          await settleOnce({ stopReason: "error", failure: errorMessage(error) }).catch(() => undefined);
        }
        const stopReason = error instanceof LiveRequestTimeoutError ? "aborted" : "error";
        const failure = syntheticErrorMessage(model, error, stopReason) as unknown as TMessage;
        output.push({ type: "error", reason: stopReason, error: failure } as never);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
    return proxy as unknown as TStream;
  };

  return Object.assign(wrapped, { getRequestCount: () => requestCount });
}

function createLazyLiveAssistantMessageEventStream(
  startOperation: (output: AssistantMessageEventStream) => Promise<void>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const originalIterator = output[Symbol.asyncIterator].bind(output);
  const originalResult = output.result.bind(output);
  let started = false;
  const startOnce = () => {
    if (started) return;
    started = true;
    void startOperation(output);
  };
  output[Symbol.asyncIterator] = () => {
    startOnce();
    return originalIterator();
  };
  output.result = () => {
    startOnce();
    return originalResult();
  };
  return output;
}

export function chargedUsageTokens(usage: LiveTokenUsage): number {
  const parsed = tokenUsageSchema.parse(usage);
  const componentTotal = safeSum([parsed.input, parsed.output, parsed.cacheRead, parsed.cacheWrite]);
  return Math.max(parsed.totalTokens, componentTotal);
}

function statusFromState(state: LedgerState): LiveTokenBudgetStatus {
  let chargedTokens = 0;
  let reservedTokens = 0;
  let settledRequests = 0;
  let reservedRequests = 0;
  let conservativeChargeTokens = 0;
  let breached = false;
  const reportedUsage: LiveTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };

  for (const request of Object.values(state.requests)) {
    if (request.status === "reserved") {
      reservedRequests += 1;
      reservedTokens = safeSum([reservedTokens, request.contextCeiling]);
      continue;
    }
    settledRequests += 1;
    chargedTokens = safeSum([chargedTokens, request.chargedTokens]);
    if (request.chargedTokens > request.contextCeiling) breached = true;
    if (request.usage) {
      reportedUsage.input = safeSum([reportedUsage.input, request.usage.input]);
      reportedUsage.output = safeSum([reportedUsage.output, request.usage.output]);
      reportedUsage.cacheRead = safeSum([reportedUsage.cacheRead, request.usage.cacheRead]);
      reportedUsage.cacheWrite = safeSum([reportedUsage.cacheWrite, request.usage.cacheWrite]);
      reportedUsage.totalTokens = safeSum([reportedUsage.totalTokens, request.usage.totalTokens]);
      if (request.usage.reasoning !== undefined) {
        reportedUsage.reasoning = safeSum([reportedUsage.reasoning ?? 0, request.usage.reasoning]);
      }
    }
    if (request.conservative) conservativeChargeTokens = safeSum([conservativeChargeTokens, request.chargedTokens]);
  }

  const consumed = safeSum([chargedTokens, reservedTokens]);
  if (consumed > state.limit) breached = true;
  return {
    campaignId: state.campaignId,
    limit: state.limit,
    chargedTokens,
    reservedTokens,
    remainingTokens: Math.max(0, state.limit - consumed),
    requests: settledRequests + reservedRequests,
    settledRequests,
    reservedRequests,
    conservativeChargeTokens,
    reportedUsage,
    breached,
  };
}

function validateReservationInput(input: LiveTokenReservationInput): LiveTokenReservationInput {
  if (!input.provider) throw new LiveTokenBudgetError("provider must not be empty.");
  if (!input.model) throw new LiveTokenBudgetError("model must not be empty.");
  if (!input.runId) throw new LiveTokenBudgetError("runId must not be empty.");
  return {
    provider: input.provider,
    model: input.model,
    runId: input.runId,
    maxRequests: requirePositiveInteger(input.maxRequests ?? DEFAULT_LIVE_MAX_REQUESTS, "maxRequests"),
    contextCeiling: requirePositiveInteger(input.contextCeiling, "contextCeiling"),
    outputCap: requirePositiveInteger(input.outputCap, "outputCap"),
  };
}

function isTerminalStreamEvent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return type === "done" || type === "error";
}

function terminalStreamEvent<TMessage extends LiveAssistantMessageLike>(message: TMessage): unknown {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { type: "error", reason: message.stopReason, error: message };
  }
  const reason = message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "deferred"
    ? message.stopReason
    : "stop";
  return { type: "done", reason, message };
}

function syntheticErrorMessage<TModel extends LiveModelLike>(
  model: TModel,
  error: unknown,
  stopReason: "error" | "aborted" = "error",
): unknown {
  return {
    role: "assistant",
    content: [],
    api: model.api ?? "unknown",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: errorMessage(error),
    timestamp: Date.now(),
  };
}

function parseUsage(value: LiveTokenUsage | undefined): LiveTokenUsage | undefined {
  if (value === undefined) return undefined;
  const parsed = tokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isTrustworthyStopReason(value: string): boolean {
  return value === "stop" || value === "toolUse" || value === "length";
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LiveTokenBudgetError(`${name} must be a positive safe integer.`);
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new LiveTokenBudgetError(`${name} must be a non-negative safe integer.`);
  return value;
}

function safeSum(values: number[]): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) throw new LiveTokenBudgetError("Live token accounting exceeded the safe integer range.");
  }
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const rendered = String(error);
  return rendered || "unknown live provider failure";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function liveTokenLockPath(filePath: string): string {
  return `${path.resolve(filePath)}.lock`;
}

function parseLockOwner(raw: string, lockPath: string): LiveTokenLockOwner {
  try {
    return lockOwnerSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new LiveTokenBudgetError(
      `Invalid live token ledger lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
