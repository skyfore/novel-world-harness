import { spawn } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { redactTraceText } from "../../trace/redaction.js";
import { readOnlyNodeArgs } from "./dedicated-session.js";
export type ChildOutcome = { code: number | null; signal: string | null; error: string | null; timedOut: boolean; cancelled: boolean };

/** Enforce history/owner immutability before execution, including host tests and
 * workers. CAP_SYS_ADMIN stays dropped. CAP_SETFCAP permits Codex's nested UID-0
 * sandbox mapping on Linux >=5.12; it does not permit remounting these bindings. */
export function immutableChildCommand(command: string, args: string[], files: string[]) {
  const paths = [...new Set(files)].sort();
  for (const file of paths) if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error("COMPILE_LOOP_IMMUTABLE_PATH: missing or aliased history; no child dispatch.");
  return { command: "/usr/bin/bwrap", args: ["--die-with-parent", "--cap-drop", "ALL", "--cap-add", "CAP_SETFCAP", "--bind", "/", "/",
    ...paths.flatMap(file => ["--ro-bind", file, file]), "--", command, ...args] };
}

/** Keep the trusted Codex transport outside an extra mount sandbox: its exec
 * service cannot spawn under that nesting. Its own enforced permission profile
 * makes every agent tool treat history/locks as read-only before execution. */
export function codexGuardCommand(command: string, args: string[], files: string[], mode: "read-only" | "workspace-write") {
  if (path.basename(command) !== "codex" || !files.length) throw new Error("COMPILE_LOOP_CODEX_GUARD_SCOPE");
  const filesystem: Record<string, string> = { ":root": "read" };
  if (mode === "workspace-write") Object.assign(filesystem, { ":workspace_roots": "write", ":slash_tmp": "write", ":tmpdir": "write" });
  for (const file of files) {
    if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error("COMPILE_LOOP_IMMUTABLE_PATH");
    filesystem[file] = "read";
  }
  const filtered = args.filter((arg, i) => !(arg === "-c" && args[i + 1]?.startsWith("sandbox_mode=")) && !(i > 0 && args[i - 1] === "-c" && arg.startsWith("sandbox_mode=")));
  const toml = Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  return { command, args: ["-c", 'default_permissions="nwh_loop_guard"', "-c", `permissions.nwh_loop_guard.filesystem={${toml}}`, ...filtered] };
}

/** Own process groups only; hook errors never spawn reviewers from this layer. */
export async function runLoopChild(options: {
  command: string; args: string[]; cwd: string; prefix: string; timeoutMs: number;
  signal: AbortSignal; stdin?: string; onLine?: (line: string) => void; onSpawn?: (pid: number) => void;
  immutablePaths?: string[];
  codexFilePolicy?: "read-only" | "workspace-write";
  readOnlyRootDirectory?: string;
}): Promise<ChildOutcome> {
  options.signal.throwIfAborted();
  if (options.readOnlyRootDirectory && (options.command !== process.execPath || options.readOnlyRootDirectory !== options.prefix + ".sandbox"
    || realpathSync(options.readOnlyRootDirectory) !== options.readOnlyRootDirectory)) throw new Error("COMPILE_LOOP_CHECK_SANDBOX_SCOPE");
  const invocation = options.codexFilePolicy ? codexGuardCommand(options.command, options.args, options.immutablePaths ?? [], options.codexFilePolicy)
    : options.readOnlyRootDirectory ? { command: "/usr/bin/bwrap", args: readOnlyNodeArgs(options.cwd, options.readOnlyRootDirectory, options.args) }
    : options.immutablePaths?.length ? immutableChildCommand(options.command, options.args, options.immutablePaths) : options;
  return new Promise((resolve) => {
    const result: ChildOutcome = { code: null, signal: null, error: null, timedOut: false, cancelled: false };
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
