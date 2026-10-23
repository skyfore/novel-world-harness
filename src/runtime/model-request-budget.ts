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

export type ModelRequestBudgetState = {
  usage: ModelRequestUsage;
  blocked: boolean;
  failure?: { code: string; message: string };
  progress?: { lastProgressCall: number; milestones: string[] };
};

export class ModelRequestBudgetError extends Error {
  constructor(readonly usage: ModelRequestUsage, readonly limits: ModelRequestLimits, reason: string, readonly reasonCode = "unknown") {
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
  private progress = { lastProgressCall: 0, milestones: [] as string[] };
  private tokenUsage = { reports: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

  /** An ended host operation cannot dispatch late callbacks into another turn. */
  close(): void { this.closed = true; }
  assertUsable(): void {
    this.assertAvailable();
    if (this.closed) this.fail("host operation already ended");
  }
  isBlocked(): boolean { return this.failure !== undefined; }
  report() { return { modelCallsMode: this.policy.modelCallsMode ?? "enforce", requestBytesMode: this.policy.requestBytesMode ?? "enforce", totalBytesMode: this.policy.totalBytesMode ?? "enforce", limits: { ...this.limits }, usage: this.snapshot(),
    ...(this.policy.modelCallsMode === "progress" ? { progress: { ...this.progress, milestones: [...this.progress.milestones], callsWithoutProgress: this.usage.modelCalls - this.progress.lastProgressCall, stallWindowCalls: this.limits.maxModelCalls } } : {}),
    providerUsage: { ...this.tokenUsage }, blocked: this.isBlocked(), closed: this.closed }; }

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

  constructor(limits: ModelRequestLimits = ACTOR_MODEL_REQUEST_LIMITS, private readonly persistence?: {
    initial?: ModelRequestBudgetState;
    save: (state: ModelRequestBudgetState) => void;
  }, private readonly policy: { modelCallsMode?: "enforce" | "observe" | "progress"; requestBytesMode?: "observe" | "enforce"; totalBytesMode?: "observe" | "enforce" } = {}) {
    for (const key of ["maxModelCalls", "maxRequestBytes", "maxTotalPayloadBytes"] as const) {
      const value = limits[key];
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid model request limit '${key}'.`);
    }
    this.limits = Object.freeze({ ...limits });
    if (persistence?.initial) {
      const { usage, blocked } = persistence.initial;
      if (Object.values(usage).some(v => !Number.isSafeInteger(v) || v < 0)
        || ((this.policy.modelCallsMode ?? "enforce") === "enforce" && usage.modelCalls > limits.maxModelCalls) || (this.policy.totalBytesMode !== "observe" && usage.totalPayloadBytes > limits.maxTotalPayloadBytes) || (this.policy.requestBytesMode !== "observe" && usage.largestRequestBytes > limits.maxRequestBytes)) throw new Error("Invalid persisted model budget; stop for host review");
      this.usage = {...usage};
      const progress = persistence.initial.progress;
      if (progress) {
        if (!Number.isSafeInteger(progress.lastProgressCall) || progress.lastProgressCall < 0 || progress.lastProgressCall > usage.modelCalls
          || !Array.isArray(progress.milestones) || progress.milestones.some(key => typeof key !== "string" || !key.trim())
          || new Set(progress.milestones).size !== progress.milestones.length) throw new Error("Invalid persisted progress; stop for host review");
        this.progress = { lastProgressCall: progress.lastProgressCall, milestones: [...progress.milestones] };
      }
      if (blocked) this.failure = new ModelRequestBudgetError(this.snapshot(), this.limits, "retained hard stop", persistence.initial.failure?.code ?? "unknown");
    }
  }

  snapshot(): ModelRequestUsage { return { ...this.usage }; }

  /** Host-validated, immutable milestones only. Never expose this as a model
   * tool or feed it arbitrary output hashes, reads, heartbeats or self-reports. */
  recordValidatedProgress(milestone: string): boolean {
    if (this.policy.modelCallsMode !== "progress") return false;
    this.assertUsable();
    if (!milestone.trim()) throw new Error("A validated milestone needs a stable identity");
    if (this.progress.milestones.includes(milestone)) return false;
    this.progress.milestones.push(milestone);
    this.progress.lastProgressCall = this.usage.modelCalls;
    this.persist();
    return true;
  }

  /** Count actual agent model steps, including retries routed through streamFunction. */
  beginCall(context: unknown): void {
    this.assertUsable();
    if ((this.policy.modelCallsMode ?? "enforce") === "enforce" && this.usage.modelCalls >= this.limits.maxModelCalls) this.fail("model-call limit reached", "call-limit");
    if (this.policy.modelCallsMode === "progress" && this.usage.modelCalls - this.progress.lastProgressCall >= this.limits.maxModelCalls) {
      this.fail(`no new validated progress in ${this.limits.maxModelCalls} model calls`, "no-progress");
    }
    const bytes = this.measure(context);
    this.checkSize(bytes);
    this.usage.modelCalls += 1;
    this.usage.largestRequestBytes = Math.max(this.usage.largestRequestBytes, bytes);
    this.persist();
  }

  /** Check the final provider JSON AFTER Pi's payload extensions have transformed it. */
  admitPayload(payload: unknown): void {
    this.assertUsable();
    const bytes = this.measure(payload);
    this.checkSize(bytes);
    if (this.policy.totalBytesMode !== "observe" && this.usage.totalPayloadBytes + bytes > this.limits.maxTotalPayloadBytes) {
      this.fail("cumulative provider-payload byte limit reached", "total-payload");
    }
    this.usage.payloads += 1;
    this.usage.totalPayloadBytes += bytes;
    this.usage.largestRequestBytes = Math.max(this.usage.largestRequestBytes, bytes);
    this.persist();
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
    if (this.policy.requestBytesMode !== "observe" && bytes > this.limits.maxRequestBytes) this.fail(`request requires ${bytes} UTF-8 bytes`, "request-size");
  }

  private persist(): void {
    try { this.persistence?.save({usage: this.snapshot(), blocked: this.isBlocked(),
      ...(this.policy.modelCallsMode === "progress" ? { progress: { ...this.progress, milestones: [...this.progress.milestones] } } : {}),
      ...(this.failure?{failure:{code:this.failure.reasonCode,message:this.failure.message}}:{})}); }
    catch (error) { this.failure ??= new ModelRequestBudgetError(this.snapshot(), this.limits, `usage publication failed: ${String(error)}`); throw this.failure; }
  }
  private assertAvailable(): void { if (this.failure) throw this.failure; }
  private fail(reason: string, code = "unknown"): never {
    this.failure ??= new ModelRequestBudgetError(this.snapshot(), this.limits, reason, code);
    this.persist();
    throw this.failure;
  }
}
