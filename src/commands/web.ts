import { spawn } from "node:child_process";
import { stderr, stdout } from "node:process";
import { createWebHost, isLoopbackHost } from "../web/host.js";

export interface WebCommandOptions {
  root: string;
  host?: string;
  port?: number;
  open?: boolean;
  allowRemote?: boolean;
  configPath?: string;
  model?: string;
}

export async function webCommand(options: WebCommandOptions): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3080;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Web port must be an integer between 1 and 65535.");
  if (!isLoopbackHost(host) && !options.allowRemote) {
    throw new Error("Refusing to expose the unauthenticated Web UI beyond loopback. Pass --allow-remote only on a trusted network.");
  }
  if (!isLoopbackHost(host)) {
    stderr.write("Warning: the unauthenticated Novel World Harness Web UI is exposed beyond this machine.\n");
  }

  const app = await createWebHost({
    root: options.root,
    host,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  try {
    const address = await app.listen({ host, port });
    stdout.write(`Novel World Harness Web UI: ${address}\n`);
    if (options.open !== false) openBrowser(address);
    await waitForShutdown();
  } finally {
    await app.close();
  }
}

export function parseWebPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer between 1 and 65535");
  return port;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", (error) => stderr.write(`Could not open a browser automatically: ${error.message}\n`));
    child.unref();
  } catch (error) {
    stderr.write(`Could not open a browser automatically: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
