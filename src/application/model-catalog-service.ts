import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelCatalogSchema, type ModelCatalog } from "../web/contracts.js";

export interface ModelCatalogReader {
  read(): Promise<ModelCatalog>;
}

export class PiModelCatalogService implements ModelCatalogReader {
  private runtimePromise?: Promise<ModelRuntime>;

  constructor(private readonly piAgentDir = getAgentDir()) {}

  async read(): Promise<ModelCatalog> {
    try {
      const runtime = await this.runtime();
      const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
      const models = runtime.getModels().map((model) => ({
        id: model.id,
        providerId: model.provider,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        available: available.has(`${model.provider}/${model.id}`),
      })).sort((left, right) => left.providerId.localeCompare(right.providerId) || left.name.localeCompare(right.name));
      const modelCounts = new Map<string, number>();
      for (const model of models) modelCounts.set(model.providerId, (modelCounts.get(model.providerId) ?? 0) + 1);
      const providers = runtime.getProviders().map((provider) => {
        const auth = runtime.getProviderAuthStatus(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          configured: auth.configured,
          ...(auth.source ? { authSource: auth.source } : {}),
          ...(auth.label ? { authLabel: auth.label } : {}),
          modelCount: modelCounts.get(provider.id) ?? 0,
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
      return modelCatalogSchema.parse({ providers, models });
    } catch (error) {
      return modelCatalogSchema.parse({
        providers: [],
        models: [],
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      authPath: path.join(this.piAgentDir, "auth.json"),
      modelsPath: path.join(this.piAgentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return this.runtimePromise;
  }
}
