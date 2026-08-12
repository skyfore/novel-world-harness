import { stderr, stdout } from "node:process";
import { formatRetryNotice } from "../agent/pi-session.js";
import type { TuiMode } from "@earendil-works/pi-coding-agent";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
import { compilerBatchFailure } from "../compiler/batch-outcome.js";
import { loadConfig, profileForRole } from "../config/load.js";

export type CompileCommandOptions = {
  root: string;
  configPath: string;
  allowMissingConfig?: boolean;
  model?: string;
  saveSession?: boolean;
  prompt?: string;
  tuiMode?: TuiMode;
};

const DEFAULT_COMPILER_PROMPT = `Inspect the novel workspace and build a small, evidence-backed compiler batch. Start by searching and reading relevant source spans. Prefer stable entity proposals first, then claims, world rules, and canonical events whose references can be validated. Use propose_state_delta or propose_possibility only when they are useful staging artifacts. Do not attempt to commit anything and do not describe pending proposals as truth.`;

async function optionalConfig(options: CompileCommandOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function compileCommand(options: CompileCommandOptions): Promise<void> {
  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "controller").profile : undefined;
  const printMode = options.prompt !== undefined;
  let wroteText = false;
  const session = await createPiCompilerSession({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    saveSession: options.saveSession ?? true,
    ...(printMode ? { onRetry(event) {
      stderr.write(`\n${formatRetryNotice(event)}\n`);
    } } : {}),
    ...(printMode ? { onText(delta: string) {
      wroteText = true;
      stdout.write(delta);
    } } : {}),
    ...(printMode ? { onTool(name: string, input: unknown) {
      const details = input as Record<string, unknown>;
      stderr.write(`\n↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}\n`);
    } } : {}),
  });
  try {
    if (options.prompt !== undefined) {
      const report = await session.promptWithReport(options.prompt.trim() || DEFAULT_COMPILER_PROMPT);
      const failure = compilerBatchFailure(report);
      if (failure) throw new Error(`Compiler prompt was not completed: ${failure}.`);
      if (wroteText) stdout.write("\n");
      return;
    }
    await session.runInteractive({ tuiMode: options.tuiMode, initialMessage: DEFAULT_COMPILER_PROMPT });
  } finally {
    await session.dispose();
  }
}
