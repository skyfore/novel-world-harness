import { stdout as output, stderr } from "node:process";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../agent/pi-session.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import type { PiLiveTestOptions } from "../agent/pi-session.js";

export type PlayCommandOptions = {
  configPath: string;
  allowMissingConfig?: boolean;
  root?: string;
  model?: string;
  continueSession?: boolean;
  saveSession?: boolean;
  printPrompt?: string;
  tuiMode?: TuiMode;
  liveTest?: PiLiveTestOptions;
};

async function optionalConfig(options: PlayCommandOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function playCommand(options: PlayCommandOptions): Promise<void> {
  const workspace = await LocalFileWorkspace.create(options.root ?? process.cwd());
  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const model = options.model ?? profile?.model;
  const saveSession = options.saveSession ?? true;
  const printMode = options.printPrompt !== undefined;
  let textStarted = false;
  const session = await PiAgentSession.create({
    workspace,
    profile,
    model,
    continueSession: options.continueSession,
    saveSession,
    ...(options.liveTest ? { liveTest: options.liveTest } : {}),
    ...(printMode ? { onText(delta: string) {
      textStarted = true;
      output.write(delta);
    } } : {}),
    ...(printMode ? { onTool(name: string, toolInput: unknown) {
      const details = toolInput as Record<string, unknown>;
      const target = details.path ?? details.query;
      stderr.write(`\n↳ ${name}${target ? ` ${String(target)}` : ""}\n`);
    } } : {}),
  });

  try {
    if (options.printPrompt !== undefined) {
      textStarted = false;
      await session.prompt(options.printPrompt);
      if (textStarted) output.write("\n");
      return;
    }
    await session.runInteractive({ tuiMode: options.tuiMode });
  } finally {
    await session.dispose();
  }
}
