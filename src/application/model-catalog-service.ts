import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import {
  modelCatalogSchema,
  providerCredentialResultSchema,
  type ModelCatalog,
  type ProviderCredentialResult,
} from "../web/contracts.js";

export interface ModelCatalogReader {
  read(): Promise<ModelCatalog>;
}

export interface ModelCredentialRuntime extends ModelCatalogReader {
  login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<ProviderCredentialResult>;
  logout(providerId: string): Promise<ProviderCredentialResult>;
}

export class PiModelCatalogService implements ModelCredentialRuntime {
  private runtimePromise?: Promise<ModelRuntime>;

  constructor(private readonly piAgentDir = getAgentDir()) {}

  async read(): Promise<ModelCatalog> {
    try {
      const runtime = await this.runtime();
      const credentials = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
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
        const authTypes: AuthType[] = [];
        if (provider.auth.apiKey?.login) authTypes.push("api_key");
        if (provider.auth.oauth) authTypes.push("oauth");
        return {
          id: provider.id,
          name: provider.name,
          configured: auth.configured,
          ...(auth.source ? { authSource: auth.source } : {}),
          ...(auth.label ? { authLabel: auth.label } : {}),
          ...(credentials.get(provider.id) ? { credentialType: credentials.get(provider.id) } : {}),
          authTypes,
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

  async login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<ProviderCredentialResult> {
    const runtime = await this.runtime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`Unknown Pi provider '${providerId}'. Use /api/v1/models/providers and copy an exact id.`);
    const supported = authType === "api_key" ? Boolean(provider.auth.apiKey?.login) : Boolean(provider.auth.oauth);
    if (!supported) throw new Error(`Pi provider '${providerId}' does not support interactive ${authType} login.`);
    await runtime.login(providerId, authType, interaction);
    return this.credentialResult(runtime, providerId, authType);
  }

  async logout(providerId: string): Promise<ProviderCredentialResult> {
    const runtime = await this.runtime();
    if (!runtime.getProvider(providerId)) throw new Error(`Unknown Pi provider '${providerId}'. Use /api/v1/models/providers and copy an exact id.`);
    await runtime.logout(providerId);
    return this.credentialResult(runtime, providerId);
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

  private credentialResult(runtime: ModelRuntime, providerId: string, authType?: AuthType): ProviderCredentialResult {
    const status = runtime.getProviderAuthStatus(providerId);
    return providerCredentialResultSchema.parse({
      providerId,
      configured: status.configured,
      ...(authType ? { authType } : {}),
      ...(status.source ? { authSource: status.source } : {}),
      ...(status.label ? { authLabel: status.label } : {}),
    });
  }
}
