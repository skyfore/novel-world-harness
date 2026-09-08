export class CompilerInterruptedError extends Error {
  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`Compiler interrupted by ${signal}; retained drafts can be resumed after lock release.`);
    this.name = "AbortError";
  }
  get exitCode(): number { return this.signal === "SIGINT" ? 130 : 143; }
}

/** Let cooperative model cancellation unwind through the workspace lock's
 * finally. SIGKILL and host loss still require explicit stale-lock recovery. */
export async function withCompilerSignals<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new CompilerInterruptedError("SIGINT"));
  const terminate = () => controller.abort(new CompilerInterruptedError("SIGTERM"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { return await run(controller.signal); }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
