import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadOptionalConfig } from "../config/load.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { ok, fail, heading } from "../util/terminal.js";

function nodeVersionOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function doctorCommand(configPath: string, piAgentDir = getAgentDir()): Promise<void> {
  let failed = false;
  heading("Novel World Harness doctor");

  if (nodeVersionOk()) ok(`Node ${process.versions.node}`);
  else {
    fail(`Node ${process.versions.node}; Novel World Harness requires Node >= 22.19.0`);
    failed = true;
  }

  const root = path.dirname(path.resolve(configPath));
  const config = await loadOptionalConfig(configPath);
  if (config) ok(`Config valid: ${configPath}`);
  else ok(`No config file; using provider-neutral Pi defaults in ${root}`);

  await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);
  ok(`Local workspace readable and writable: ${root}`);

  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(piAgentDir, "auth.json"),
      modelsPath: path.join(piAgentDir, "models.json"),
      allowModelNetwork: false,
    });
    const authenticatedProviders = new Set<string>();
    for (const provider of runtime.getProviders()) {
      if (runtime.getProviderAuthStatus(provider.id).configured) authenticatedProviders.add(provider.id);
    }
    for (const credential of await runtime.listCredentials()) authenticatedProviders.add(credential.providerId);

    if (config?.llm) {
      for (const [name, profile] of Object.entries(config.llm.profiles)) {
        if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) {
          ok(`LLM profile '${name}' credential env present (${profile.apiKeyEnv})`);
        } else if (authenticatedProviders.has(profile.provider)) {
          ok(`LLM profile '${name}' has Pi-managed authentication (${profile.provider})`);
        } else {
          const envHint = profile.apiKeyEnv ? ` or set ${profile.apiKeyEnv}` : "";
          fail(`LLM profile '${name}' is not authenticated (${profile.provider}); use Pi /login${envHint}`);
          failed = true;
        }
      }
    } else if (authenticatedProviders.size) {
      ok(`Pi-managed authentication available for ${[...authenticatedProviders].sort().join(", ")}`);
    } else {
      fail("No authenticated Pi provider found; open nwh and use /login, then /model");
      failed = true;
    }
  } catch {
    fail(`Pi authentication state could not be read; check ${path.join(piAgentDir, "auth.json")} permissions and format`);
    failed = true;
  }

  if (await LocalFileWorkspace.hasRipgrep()) {
    ok("ripgrep available for local file search");
  } else {
    ok("ripgrep unavailable; safe Node file search fallback will be used");
  }

  if (failed) process.exitCode = 1;
}
