export type ModelRequestLimits = Readonly<{
  maxModelCalls: number;
  maxRequestBytes: number;
  maxTotalPayloadBytes: number;
}>;

/** Host byte/step limits, NOT an estimate of tokenizer usage or output tokens. */
export const ACTOR_MODEL_REQUEST_LIMITS: ModelRequestLimits = Object.freeze({
  maxModelCalls: 32,
  maxRequestBytes: 512_000,
  maxTotalPayloadBytes: 8_000_000,
});

export type ModelRequestUsage = {
  modelCalls: number;
  payloads: number;
  totalPayloadBytes: number;
  largestRequestBytes: number;
};

export class ModelRequestBudgetError extends Error {
  constructor(readonly usage: ModelRequestUsage, readonly limits: ModelRequestLimits, reason: string) {
    super(`Model request budget exhausted: ${reason}. Stop this invocation and preserve its diagnostics; `
      + "do not retry in a fresh model session, trim required evidence, or commit a partial proposal. "
      + "Only the host may start a narrower task or explicitly revise the budget.");
    this.name = "ModelRequestBudgetError";
  }
}

/** Shared across all tool-loop calls and adapter-owned protocol-recovery sessions. */
export class ModelRequestBudget {
  readonly limits: ModelRequestLimits;
  private usage: ModelRequestUsage = { modelCalls: 0, payloads: 0, totalPayloadBytes: 0, largestRequestBytes: 0 };
  private failure?: ModelRequestBudgetError;
  private closed = false;
  private tokenUsage = { reports: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

  /** An ended host operation cannot dispatch late callbacks into another turn. */
  close(): void { this.closed = true; }
  assertUsable(): void {
    this.assertAvailable();
    if (this.closed) this.fail("host operation already ended");
  }
  isBlocked(): boolean { return this.failure !== undefined; }
  report() { return { limits: { ...this.limits }, usage: this.snapshot(), providerUsage: { ...this.tokenUsage }, blocked: this.isBlocked(), closed: this.closed }; }

  /** Actual provider reports, not token estimates. Partial/error responses still consume resources. */
  observeUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }): void {
    this.tokenUsage.reports += 1;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.tokenUsage[key] += value;
    }
    const cost = usage.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) this.tokenUsage.cost += cost;
  }

  constructor(limits: ModelRequestLimits = ACTOR_MODEL_REQUEST_LIMITS) {
    for (const key of ["maxModelCalls", "maxRequestBytes", "maxTotalPayloadBytes"] as const) {
      const value = limits[key];
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid model request limit '${key}'.`);
    }
    this.limits = Object.freeze({ ...limits });
  }

  snapshot(): ModelRequestUsage { return { ...this.usage }; }

  /** Count actual agent model steps, including retries routed through streamFunction. */
  beginCall(context: unknown): void {
    this.assertUsable();
    if (this.usage.modelCalls >= this.limits.maxModelCalls) this.fail("model-call limit reached");
    const bytes = this.measure(context);
    this.checkSize(bytes);
    this.usage.modelCalls += 1;
    this.usage.largestRequestBytes = Math.max(this.usage.largestRequestBytes, bytes);
  }

  /** Check the final provider JSON AFTER Pi's payload extensions have transformed it. */
  admitPayload(payload: unknown): void {
    this.assertUsable();
    const bytes = this.measure(payload);
    this.checkSize(bytes);
    if (this.usage.totalPayloadBytes + bytes > this.limits.maxTotalPayloadBytes) {
      this.fail("cumulative provider-payload byte limit reached");
    }
    this.usage.payloads += 1;
    this.usage.totalPayloadBytes += bytes;
    this.usage.largestRequestBytes = Math.max(this.usage.largestRequestBytes, bytes);
  }

  private measure(value: unknown): number {
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return this.fail("request is not JSON serializable");
      return Buffer.byteLength(text, "utf8");
    } catch (error) {
      if (error === this.failure) throw error;
      return this.fail("request is not JSON serializable");
    }
  }

  private checkSize(bytes: number): void {
    if (bytes > this.limits.maxRequestBytes) this.fail(`request requires ${bytes} UTF-8 bytes`);
  }

  private assertAvailable(): void { if (this.failure) throw this.failure; }
  private fail(reason: string): never {
    this.failure ??= new ModelRequestBudgetError(this.snapshot(), this.limits, reason);
    throw this.failure;
  }
}

