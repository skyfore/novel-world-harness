import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { redactTraceText } from "../../trace/redaction.js";
export type ChildOutcome = { code: number | null; signal: string | null; error: string | null; timedOut: boolean; cancelled: boolean };

/** Own process groups only; hook errors never spawn reviewers from this layer. */
export async function runLoopChild(options: {
  command: string; args: string[]; cwd: string; prefix: string; timeoutMs: number;
  signal: AbortSignal; stdin?: string; onLine?: (line: string) => void; onSpawn?: (pid: number) => void;
}): Promise<ChildOutcome> {
  options.signal.throwIfAborted();
  return new Promise((resolve) => {
    const result: ChildOutcome = { code: null, signal: null, error: null, timedOut: false, cancelled: false };
    const child = spawn(options.command, options.args, { cwd: options.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let killTimer: NodeJS.Timeout | undefined;
    let bytes = 0;
    let stopping = false;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") result.error ??= String(error); }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 10_000);
    };
    const abort = () => { result.cancelled = true; stop(); };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, options.timeoutMs);
    for (const [stream, suffix] of [[child.stdout, "stdout.jsonl"], [child.stderr, "stderr.log"]] as const) {
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16_000_000) { result.error ??= "AUDIT_OUTPUT_LIMIT"; stop(); }
      });
      const lines = createInterface({ input: stream });
      lines.on("line", line => {
        try {
          const safe = redactTraceText(line);

          if (bytes > 16_000_000) throw new Error("AUDIT_OUTPUT_LIMIT: stop; retain existing logs.");
          appendFileSync(`${options.prefix}.${suffix}`, safe + "\n", { mode: 0o600 });
          if (stream === child.stdout) options.onLine?.(safe);
        } catch (error) { result.error ??= String(error); stop(); }
      });
    }
    child.on("spawn", () => {
      try { options.onSpawn?.(child.pid!); } catch (error) { result.error = String(error); stop(); }
    });
    child.on("error", error => { result.error = redactTraceText(String(error)); });
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") { result.error ??= String(error); stop(); } });
    child.stdin.end(options.stdin ?? "");
    child.on("close", (code, signal) => {
      if (stopping) kill("SIGKILL"); // Reap remaining group members even if the parent exits before the grace timer.
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      resolve({ ...result, code, signal });
    });
  });
}
