import { stderr, stdout } from "node:process";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
import { loadConfig, profileForRole } from "../config/load.js";

export type CompileCommandOptions = {
  root: string;
  configPath: string;
  allowMissingConfig?: boolean;
  model?: string;
  saveSession?: boolean;
  prompt?: string;
};

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
  let wroteText = false;
  const session = await createPiCompilerSession({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    saveSession: options.saveSession ?? true,
    onText(delta) {
      wroteText = true;
      stdout.write(delta);
    },
    onTool(name, input) {
      const details = input as Record<string, unknown>;
      stderr.write(`\n↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}\n`);
    },
  });
  try {
    const prompt = options.prompt?.trim() || `Inspect the novel workspace and build a small, evidence-backed compiler batch. Start by searching and reading relevant source spans. Prefer stable entity proposals first, then claims, world rules, and canonical events whose references can be validated. Use propose_state_delta or propose_possibility only when they are useful staging artifacts. Do not attempt to commit anything and do not describe pending proposals as truth.`;
    await session.prompt(prompt);
    if (wroteText) stdout.write("\n");
  } finally {
    session.dispose();
  }
}

