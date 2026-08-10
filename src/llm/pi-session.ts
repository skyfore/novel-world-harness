import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "../config/schema.js";
import { profileForRole } from "../config/load.js";

export type PiAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export type PiSessionFactory = {
  create(role: string, systemPrompt: string): Promise<PiAgentSession>;
};

async function ensureModelsOverride(
  stateDir: string,
  config: HarnessConfig,
): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true });
  const modelsPath = path.join(stateDir, "pi-models.json");
  const providers: Record<string, unknown> = {};

  for (const profile of Object.values(config.llm.profiles)) {
    if (!profile.baseUrl) continue;
    const existing = (providers[profile.provider] as Record<string, unknown> | undefined) ?? {};
    providers[profile.provider] = {
      ...existing,
      baseUrl: profile.baseUrl,
      ...(profile.apiProtocol ? { api: profile.apiProtocol } : {}),
    };
  }

  await fs.writeFile(modelsPath, JSON.stringify({ providers }, null, 2) + "\n", "utf8");
  return modelsPath;
}

export async function createPiSessionFactory(
  config: HarnessConfig,
  cwd = process.cwd(),
): Promise<PiSessionFactory> {
  const stateDir = path.resolve(cwd, ".novel-harness");
  const modelsPath = await ensureModelsOverride(stateDir, config);
  const authPath = path.join(stateDir, "pi-auth.json");
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });

  for (const profile of Object.values(config.llm.profiles)) {
    if (!profile.apiKeyEnv) continue;
    const key = process.env[profile.apiKeyEnv];
    if (key) await modelRuntime.setRuntimeApiKey(profile.provider, key);
  }

  return {
    async create(role: string, systemPrompt: string) {
      const { profile } = profileForRole(config, role);
      const model = modelRuntime.getModel(profile.provider, profile.model);
      if (!model) {
        throw new Error(
          `Pi could not resolve model ${profile.provider}/${profile.model}. ` +
            `Check provider catalog or custom model configuration.`,
        );
      }

      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2 },
        compaction: { enabled: true },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: stateDir,
        settingsManager,
        systemPromptOverride: () => systemPrompt,
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir: stateDir,
        model,
        thinkingLevel: profile.thinkingLevel,
        modelRuntime,
        noTools: "all",
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      });
      return session;
    },
  };
}
