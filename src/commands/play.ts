import { stdout as output, stderr } from "node:process";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { formatRetryNotice, PiAgentSession } from "../agent/pi-session.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import type { PlaySceneRequest } from "../world/play-opening.js";

export type PlayCommandOptions = {
  configPath: string;
  allowMissingConfig?: boolean;
  root?: string;
  model?: string;
  continueSession?: boolean;
  sessionId?: string;
  saveSession?: boolean;
  printPrompt?: string;
  tuiMode?: TuiMode;
  activeWorldScene?: PlaySceneRequest;
};

export function resolvePlaySessionContinuation(options: Pick<PlayCommandOptions, "continueSession" | "printPrompt" | "sessionId">): boolean {
  return options.sessionId !== undefined || (options.continueSession ?? options.printPrompt === undefined);
}

async function optionalConfig(options: PlayCommandOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function playCommand(options: PlayCommandOptions): Promise<void> {
  if (options.sessionId && options.continueSession === false) {
    throw new Error("Choose either --session or --new-session, not both.");
  }
  const workspace = await LocalFileWorkspace.create(options.root ?? process.cwd());
  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "narrator").profile : undefined;
  const model = options.model ?? profile?.model;
  const saveSession = options.saveSession ?? true;
  const printMode = options.printPrompt !== undefined;
  const continueSession = resolvePlaySessionContinuation(options);
  let textStarted = false;
  const session = await PiAgentSession.create({
    workspace,
    profile,
    model,
    ...(config?.project.instructions.length
      ? { projectInstructionPaths: config.project.instructions }
      : {}),
    continueSession,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    saveSession,
    trackLastOpenedSession: !printMode,
    ...(options.activeWorldScene !== undefined ? { activeWorldScene: options.activeWorldScene } : {}),
    ...(printMode ? { onRetry(event) {
      stderr.write(`\n${formatRetryNotice(event)}\n`);
    } } : {}),
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
