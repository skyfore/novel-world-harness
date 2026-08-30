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
import { webError } from "../web/errors.js";
import { readPreparationSnapshot } from "./preparation-projection.js";

type StoredRegistration = {
  fingerprint: string;
  result: SourceRegistrationResult;
};

export interface SourceApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  configPath?: string;
}

export class SourceApplicationService {
  readonly root: string;
  private readonly requests = new Map<string, StoredRegistration>();

  constructor(private readonly options: SourceApplicationServiceOptions) {
    this.root = path.resolve(options.root);
  }

  async register(inputValue: SourceRegistrationRequest): Promise<SourceRegistrationResult> {
    const input = sourceRegistrationRequestSchema.parse(inputValue);
    const fingerprint = crypto.createHash("sha256")
      .update(input.title)
      .update("\0")
      .update(input.content)
      .digest("hex");
    const previous = this.requests.get(input.clientRequestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw webError(
          409,
          "IDEMPOTENCY_CONFLICT",
          `Client request '${input.clientRequestId}' was already used with different source content.`,
          { kind: "none" },
        );
      }
      return sourceRegistrationResultSchema.parse({ ...previous.result, reused: true });
    }

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
    this.requests.set(input.clientRequestId, { fingerprint, result });
    this.options.events.publish("catalog.invalidated", {
      reason: alreadyRegistered ? "source-refreshed" : "source-registered",
      sourceId: ingested.document.id,
    });
    return result;
  }
}
