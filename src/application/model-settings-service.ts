import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import YAML from "yaml";
import { defaultProjectForRoot } from "../storage/workspace-store.js";
import { redactTraceSecrets } from "../trace/pi-trace.js";
import {
  modelProfileListSchema,
  modelRoleSchema,
  providerCredentialRequestSchema,
  providerCredentialResultSchema,
  providerLoginRequestSchema,
  updateModelProfileRequestSchema,
  type AuthInteractionSnapshot,
  type ModelProfileList,
  type ModelRole,
  type OperationAccepted,
  type ProviderCredentialRequest,
  type ProviderCredentialResult,
  type ProviderLoginRequest,
  type UpdateModelProfileRequest,
} from "../web/contracts.js";
import { AuthInteractionManager } from "../web/auth-interaction-manager.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { WebMutationJournal } from "../web/mutation-journal.js";
import { OperationManager } from "../web/operation-manager.js";
import type { ModelCatalogReader, ModelCredentialRuntime } from "./model-catalog-service.js";

const MODEL_ROLES = modelRoleSchema.options;

export interface ModelSettingsApplicationServiceOptions {
  root: string;
  configPath?: string;
  catalog: ModelCatalogReader;
  credentials?: ModelCredentialRuntime;
  operations: OperationManager;
  interactions: AuthInteractionManager;
  events: WebEventBroker;
  mutations?: WebMutationJournal;
}

export class ModelSettingsApplicationService {
  readonly root: string;
  readonly configPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly mutations: WebMutationJournal;

  constructor(private readonly options: ModelSettingsApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.configPath = path.resolve(options.configPath ?? path.join(this.root, "novel-harness.yaml"));
    this.mutations = options.mutations ?? new WebMutationJournal(this.root);
  }

  async listProfiles(): Promise<ModelProfileList> {
    const document = await this.readConfigDocument();
    const raw = asRecord(document.toJS());
    const llm = asRecord(raw.llm);
    const profiles = asRecord(llm.profiles);
    const routing = asRecord(llm.routing);
    const defaultProfileId = stringValue(llm.defaultProfile);
    return modelProfileListSchema.parse({
      version: 1,
      configPath: this.configPath,
      ...(defaultProfileId ? { defaultProfileId } : {}),
      roles: MODEL_ROLES.map((role) => {
        const routed = stringValue(routing[role]);
        const profileId = routed ?? defaultProfileId;
        const profile = profileId ? asRecord(profiles[profileId]) : {};
        const providerId = stringValue(profile.provider);
        const modelId = stringValue(profile.model);
        const thinking = modelThinking(profile.thinkingLevel);
        return {
          role,
          ...(profileId ? { profileId } : {}),
          ...(providerId ? { providerId } : {}),
          ...(modelId ? { modelId } : {}),
          ...(thinking ? { thinkingLevel: thinking } : {}),
          inheritedDefault: !routed && Boolean(defaultProfileId),
        };
      }),
    });
  }

  async updateProfile(roleValue: string, inputValue: UpdateModelProfileRequest): Promise<ModelProfileList> {
    const role = modelRoleSchema.parse(roleValue);
    const input = updateModelProfileRequestSchema.parse(inputValue);
    await this.mutations.execute({
      kind: "model-profile-update",
      scopeId: role,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.updateProfileOnce(role, input));
    return this.listProfiles();
  }

  private async updateProfileOnce(role: ModelRole, input: UpdateModelProfileRequest): Promise<void> {
    const catalog = await this.options.catalog.read();
    const selected = catalog.models.find((model) => model.providerId === input.providerId && model.id === input.modelId);
    if (!selected) {
      throw webError(400, "MODEL_NOT_FOUND", `Unknown Pi model '${input.providerId}/${input.modelId}'. Refresh the model catalog and copy an exact providerId/id pair.`, {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/models",
        copyField: "providerId,id",
        maxAttempts: 1,
      });
    }
    await this.exclusive(async () => {
      const document = await this.readConfigDocument();
      this.ensureConfigFoundation(document);
      const profileId = `web-${role}`;
      document.setIn(["llm", "profiles", profileId], {
        provider: input.providerId,
        model: input.modelId,
        thinkingLevel: input.thinkingLevel,
      });
      if (!stringValue(asRecord(asRecord(document.toJS()).llm).defaultProfile)) {
        document.setIn(["llm", "defaultProfile"], profileId);
      }
      document.setIn(["llm", "routing", role], profileId);
      await this.atomicWrite(document.toString());
    });
    this.options.events.publish("model.catalog.changed", { reason: "profile-updated", role });
  }

  async startLogin(providerId: string, inputValue: ProviderLoginRequest): Promise<OperationAccepted> {
    const input = providerLoginRequestSchema.parse(inputValue);
    const credentials = this.requireCredentialRuntime();
    const previous = this.options.operations.findByClientRequest("provider-login", providerId, input.clientRequestId);
    if (previous) {
      return this.options.operations.start({
        kind: "provider-login",
        scopeId: providerId,
        clientRequestId: input.clientRequestId,
        request: input,
        run: async () => { throw new Error("An idempotent provider login must not execute twice."); },
      });
    }
    const provider = (await this.options.catalog.read()).providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw webError(404, "PROVIDER_NOT_FOUND", `Unknown Pi provider '${providerId}'.`, {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/models/providers",
        copyField: "id",
        maxAttempts: 1,
      });
    }
    if (!provider.authTypes.includes(input.authType)) {
      throw webError(409, "PROVIDER_AUTH_TYPE_UNAVAILABLE", `Provider '${providerId}' does not offer interactive ${input.authType} login.`, { kind: "none" });
    }
    const accepted = this.options.operations.start({
      kind: "provider-login",
      scopeId: providerId,
      clientRequestId: input.clientRequestId,
      request: input,
      run: async (context) => {
        let seed = input.apiKey;
        const knownSecrets = input.apiKey ? [input.apiKey] : [];
        const replaceSecrets = (value: unknown): unknown => safeAuthValue(value, knownSecrets);
        context.update("authenticating", { providerId, authType: input.authType });
        try {
          const result = await credentials.login(providerId, input.authType, {
            signal: context.signal,
            prompt: async (prompt: AuthPrompt) => {
              if (seed !== undefined && (prompt.type === "secret" || prompt.type === "text")) {
                const answer = seed;
                seed = undefined;
                return answer;
              }
              return this.options.interactions.request(
                context.operationId,
                providerId,
                prompt,
                context.signal,
                (interaction: AuthInteractionSnapshot) => context.update(
                  interaction.status === "pending" ? "waiting-for-user" : "authenticating",
                  { interaction },
                ),
              );
            },
            notify: (event: AuthEvent) => context.update("authenticating", { authEvent: replaceSecrets(event) }),
          });
          this.options.events.publish("model.catalog.changed", { reason: "provider-login", providerId });
          return providerCredentialResultSchema.parse(result);
        } catch (error) {
          throw new Error(safeErrorMessage(error, input.apiKey ? [input.apiKey] : []));
        } finally {
          seed = undefined;
        }
      },
    });
    return accepted;
  }

  async logout(providerId: string, inputValue: ProviderCredentialRequest): Promise<ProviderCredentialResult> {
    const input = providerCredentialRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "provider-logout",
      scopeId: providerId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const credentials = this.requireCredentialRuntime();
      const catalog = await this.options.catalog.read();
      if (!catalog.providers.some((provider) => provider.id === providerId)) {
        throw webError(404, "PROVIDER_NOT_FOUND", `Unknown Pi provider '${providerId}'.`, {
          kind: "after-refresh",
          discoveryEndpoint: "/api/v1/models/providers",
          copyField: "id",
          maxAttempts: 1,
        });
      }
      const result = providerCredentialResultSchema.parse(await credentials.logout(providerId));
      this.options.events.publish("model.catalog.changed", { reason: "provider-logout", providerId });
      return result;
    });
    return providerCredentialResultSchema.parse(execution.value);
  }

  private requireCredentialRuntime(): ModelCredentialRuntime {
    if (!this.options.credentials) {
      throw webError(503, "MODEL_CREDENTIAL_RUNTIME_UNAVAILABLE", "This Web Host has a read-only model catalog and cannot change Pi credentials.", { kind: "none" });
    }
    return this.options.credentials;
  }

  private async readConfigDocument(): Promise<YAML.Document> {
    try {
      const document = YAML.parseDocument(await fs.readFile(this.configPath, "utf8"));
      if (document.errors.length) throw new Error(`Cannot edit invalid YAML at ${this.configPath}: ${document.errors[0]!.message}`);
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new YAML.Document({
        version: 1,
        project: defaultProjectForRoot(this.root),
      });
    }
  }

  private ensureConfigFoundation(document: YAML.Document): void {
    const root = asRecord(document.toJS());
    if (root.version === undefined) document.set("version", 1);
    if (!root.project) document.set("project", defaultProjectForRoot(this.root));
    const llm = asRecord(root.llm);
    if (!root.llm) {
      document.set("llm", document.createNode({ profiles: {}, routing: {} }));
      return;
    }
    if (!llm.profiles) document.setIn(["llm", "profiles"], {});
    if (!llm.routing) document.setIn(["llm", "routing"], {});
  }

  private async atomicWrite(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.configPath);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function modelThinking(value: unknown): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}

function safeAuthValue(value: unknown, secrets: string[]): unknown {
  let serialized = JSON.stringify(redactTraceSecrets(value));
  for (const secret of secrets) if (secret) serialized = serialized.split(secret).join("[REDACTED]");
  return JSON.parse(serialized) as unknown;
}

function safeErrorMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join("[REDACTED]");
  return String(redactTraceSecrets(message));
}
