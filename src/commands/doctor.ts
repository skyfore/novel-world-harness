import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../config/load.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { ok, fail, heading } from "../util/terminal.js";

function nodeVersionOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function doctorCommand(configPath: string): Promise<void> {
  let failed = false;
  heading("Novel World Harness doctor");

  if (nodeVersionOk()) ok(`Node ${process.versions.node}`);
  else {
    fail(`Node ${process.versions.node}; Novel World Harness requires Node >= 22.19.0`);
    failed = true;
  }

  const config = await loadConfig(configPath);
  ok(`Config valid: ${configPath}`);

  const root = path.dirname(path.resolve(configPath));
  await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);
  ok(`Local workspace readable and writable: ${root}`);

  for (const [name, profile] of Object.entries(config.llm.profiles)) {
    if (!profile.apiKeyEnv) {
      ok(`LLM profile '${name}' delegates authentication to Pi (${profile.provider})`);
    } else if (process.env[profile.apiKeyEnv]) {
      ok(`LLM profile '${name}' credential env present (${profile.apiKeyEnv})`);
    } else {
      fail(`LLM profile '${name}' missing env ${profile.apiKeyEnv}`);
      failed = true;
    }
  }

  if (await LocalFileWorkspace.hasRipgrep()) {
    ok("ripgrep available for local file search");
  } else {
    ok("ripgrep unavailable; safe Node file search fallback will be used");
  }

  if (failed) process.exitCode = 1;
}

