import crypto from "node:crypto";
import path from "node:path";
import { ingestWorkspaceContent } from "../commands/ingest.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { loadOptionalConfig } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import {
  sourceRegistrationRequestSchema,
  sourceRegistrationResultSchema,
  type SourceRegistrationRequest,
  type SourceRegistrationResult,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { WebMutationJournal } from "../web/mutation-journal.js";
import { readPreparationSnapshot } from "./preparation-projection.js";

export interface SourceApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  configPath?: string;
  mutations?: WebMutationJournal;
}

export class SourceApplicationService {
  readonly root: string;
  private readonly mutations: WebMutationJournal;

  constructor(private readonly options: SourceApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.mutations = options.mutations ?? new WebMutationJournal(this.root);
  }

  async register(inputValue: SourceRegistrationRequest): Promise<SourceRegistrationResult> {
    const input = sourceRegistrationRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "source-register",
      scopeId: "workspace",
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const workspace = await WorkspaceStore.create(this.root);
      const sourceId = crypto.createHash("sha256").update(input.content).digest("hex").slice(0, 20);
      const alreadyRegistered = Boolean(await workspace.getSource(sourceId));
      const configPath = this.options.configPath ?? path.join(this.root, "novel-harness.yaml");
      const config = await loadOptionalConfig(configPath);
      const ingested = await ingestWorkspaceContent(this.root, input.title, input.content, config?.project);
      await new PreparedNovelCache(this.root).restore(ingested.document);
      const preparation = await readPreparationSnapshot(this.root, ingested.document.id);
      const result = sourceRegistrationResultSchema.parse({
        source: preparation.source,
        segmentCount: ingested.manifest.segments.length,
        structuralUnitCount: ingested.structure.units.length,
        reused: alreadyRegistered,
        preparation,
      });
      this.options.events.publish("catalog.invalidated", {
        reason: alreadyRegistered ? "source-refreshed" : "source-registered",
        sourceId: ingested.document.id,
      });
      return result;
    });
    return sourceRegistrationResultSchema.parse({
      ...execution.value,
      reused: execution.reused || execution.value.reused,
    });
  }
}
