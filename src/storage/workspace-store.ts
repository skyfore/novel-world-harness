import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ensureWorkspaceState, workspaceStateDir } from "../agent/runtime-paths.js";
import type { HarnessConfig } from "../config/schema.js";
import {
  sourceTitleInferenceSchema,
  sourceTitleProposalSchema,
  type SourceTitleInference,
  type SourceTitleProposal,
} from "./novel-title.js";
import { SourceMaterialStore, sourceMaterialIdentity } from "./source-material-store.js";

const STATE_VERSION = 1;
const sourceArchiveMigrations = new Map<string, Promise<void>>();

export type StoredProject = {
  version: 1;
  id: string;
  name: string;
  language: string;
  createdAt: string;
  updatedAt: string;
};

export type SourceDocument = {
  version: 1;
  id: string;
  title: string;
  sourcePath: string;
  contentMd5?: string;
  contentSha256: string;
  bytes: number;
  /** Accepted compiler-model inference; absent means title is only an ingest label. */
  titleInference?: SourceTitleInference;
  /** Retry-safe candidate that becomes active only through finish_compiler_batch. */
  pendingTitleProposal?: SourceTitleProposal;
  registeredAt: string;
  updatedAt: string;
};

export function defaultProjectForRoot(root: string): HarnessConfig["project"] {
  return {
    name: path.basename(path.resolve(root)) || "novel-world",
    language: "zh-CN",
    instructions: [],
  };
}

function slugify(input: string): string {
  return (
    input
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "world"
  );
}

function stateFileName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`Invalid local state id: ${value}`);
  return `${value}.json`;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
}

export class WorkspaceStore {
  readonly root: string;
  readonly stateDir: string;
  private readonly sourcesDir: string;

  private constructor(root: string) {
    this.root = root;
    this.stateDir = workspaceStateDir(root);
    this.sourcesDir = path.join(this.stateDir, "sources");
  }

  static async create(root = process.cwd()): Promise<WorkspaceStore> {
    const resolvedRoot = path.resolve(root);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(resolvedRoot);
      const stat = await fs.stat(realRoot);
      if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (!(await fs.stat(workspaceStateDir(resolvedRoot))).isDirectory()) throw error;
      } catch {
        throw new Error(`Workspace root is not a directory and has no global NWH state: ${root}`);
      }
      realRoot = resolvedRoot;
    }
    await ensureWorkspaceState(realRoot);
    const store = new WorkspaceStore(realRoot);
    let migration = sourceArchiveMigrations.get(store.stateDir);
    if (!migration) {
      migration = store.archiveExistingSources();
      sourceArchiveMigrations.set(store.stateDir, migration);
    }
    try {
      await migration;
    } catch (error) {
      sourceArchiveMigrations.delete(store.stateDir);
      throw error;
    }
    return store;
  }

  async ensureProject(project: HarnessConfig["project"] = defaultProjectForRoot(this.root)): Promise<StoredProject> {
    const filePath = path.join(this.stateDir, "project.json");
    const existing = await readJson<StoredProject>(filePath);
    const now = new Date().toISOString();
    const next: StoredProject = {
      version: STATE_VERSION,
      id: slugify(project.name),
      name: project.name,
      language: project.language,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, next);
    return next;
  }

  async readProject(): Promise<StoredProject | null> {
    return readJson<StoredProject>(path.join(this.stateDir, "project.json"));
  }

  async registerSource(inputPath: string): Promise<SourceDocument> {
    const absolute = await fs.realpath(path.resolve(inputPath));
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === ".novel-harness") {
      throw new Error("Source files must be inside the novel workspace.");
    }
    if (relative.split(path.sep).includes(".novel-harness")) {
      throw new Error("Harness state cannot be registered as source material.");
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`Source is not a file: ${inputPath}`);
    const content = await fs.readFile(absolute);
    return this.registerSourceBytes(path.basename(absolute), content, relative.split(path.sep).join("/"));
  }

  async registerSourceContent(title: string, content: string | Uint8Array): Promise<SourceDocument> {
    const normalizedTitle = title.trim() || "pasted-novel.txt";
    if (normalizedTitle.length > 200 || /[\r\n]/.test(normalizedTitle)) throw new Error("Content source title must be one line of at most 200 characters.");
    return this.registerSourceBytes(normalizedTitle, typeof content === "string" ? Buffer.from(content, "utf8") : content, `content:${normalizedTitle}`);
  }

  async getSource(id: string): Promise<SourceDocument | null> {
    return readJson<SourceDocument>(path.join(this.sourcesDir, stateFileName(id)));
  }

  async listSources(): Promise<SourceDocument[]> {
    return this.readDirectory<SourceDocument>(this.sourcesDir, (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
  }

  async unregisterSource(id: string): Promise<boolean> {
    const filePath = path.join(this.sourcesDir, stateFileName(id));
    try {
      await fs.rm(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async stageSourceTitleProposal(sourceId: string, proposal: SourceTitleProposal): Promise<SourceTitleProposal> {
    const parsed = sourceTitleProposalSchema.parse(proposal);
    if (parsed.sourceId !== sourceId || parsed.evidence.span.sourceId !== sourceId) {
      throw new Error("A novel-title proposal and its evidence must belong to the active source.");
    }
    const source = await this.getSource(sourceId);
    if (!source) throw new Error(`Unknown source id: ${sourceId}`);
    if (source.titleInference) throw new Error(`Source ${sourceId} already has an accepted model-inferred title.`);
    if (source.pendingTitleProposal) {
      const { createdAt: _existingCreatedAt, ...existingIdentity } = source.pendingTitleProposal;
      const { createdAt: _candidateCreatedAt, ...candidateIdentity } = parsed;
      if (isDeepStrictEqual(existingIdentity, candidateIdentity)) return source.pendingTitleProposal;
      throw new Error(`Source ${sourceId} already has pending novel-title proposal ${source.pendingTitleProposal.proposalId}.`);
    }
    await atomicJson(path.join(this.sourcesDir, stateFileName(sourceId)), {
      ...source,
      pendingTitleProposal: parsed,
      updatedAt: new Date().toISOString(),
    });
    return parsed;
  }

  async withdrawSourceTitleProposal(sourceId: string, proposalId: string): Promise<void> {
    const source = await this.getSource(sourceId);
    if (!source?.pendingTitleProposal || source.pendingTitleProposal.proposalId !== proposalId) {
      throw new Error(`Novel-title proposal ${proposalId} is not pending for source ${sourceId}.`);
    }
    const { pendingTitleProposal: _pending, ...retained } = source;
    await atomicJson(path.join(this.sourcesDir, stateFileName(sourceId)), {
      ...retained,
      updatedAt: new Date().toISOString(),
    });
  }

  async commitSourceTitleProposal(sourceId: string, proposalId: string): Promise<SourceDocument> {
    const source = await this.getSource(sourceId);
    if (!source?.pendingTitleProposal || source.pendingTitleProposal.proposalId !== proposalId) {
      throw new Error(`Novel-title proposal ${proposalId} is not pending for source ${sourceId}.`);
    }
    const proposal = sourceTitleProposalSchema.parse(source.pendingTitleProposal);
    const inference = sourceTitleInferenceSchema.parse({
      version: 1,
      sourceId,
      title: proposal.title,
      evidence: proposal.evidence,
      generatedBy: proposal.generatedBy,
      inferredAt: new Date().toISOString(),
    });
    const { pendingTitleProposal: _pending, ...retained } = source;
    const next: SourceDocument = {
      ...retained,
      title: inference.title,
      titleInference: inference,
      updatedAt: inference.inferredAt,
    };
    await atomicJson(path.join(this.sourcesDir, stateFileName(sourceId)), next);
    return next;
  }

  async restoreSourceTitleInference(sourceId: string, value: SourceTitleInference): Promise<SourceDocument> {
    const inference = sourceTitleInferenceSchema.parse(value);
    if (inference.sourceId !== sourceId || inference.evidence.span.sourceId !== sourceId) {
      throw new Error("Restored novel-title inference does not belong to its source.");
    }
    const source = await this.getSource(sourceId);
    if (!source) throw new Error(`Unknown source id: ${sourceId}`);
    const { pendingTitleProposal: _pending, ...retained } = source;
    const next: SourceDocument = {
      ...retained,
      title: inference.title,
      titleInference: inference,
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(path.join(this.sourcesDir, stateFileName(sourceId)), next);
    return next;
  }

  /** Replace prepared title metadata exactly; null restores the local ingest label. */
  async replaceSourceTitleInference(sourceId: string, value: SourceTitleInference | null): Promise<SourceDocument> {
    if (value) return this.restoreSourceTitleInference(sourceId, value);
    const source = await this.getSource(sourceId);
    if (!source) throw new Error(`Unknown source id: ${sourceId}`);
    const { titleInference: _inference, pendingTitleProposal: _pending, ...retained } = source;
    const fallbackTitle = source.sourcePath.startsWith("content:")
      ? source.sourcePath.slice("content:".length)
      : path.basename(source.sourcePath);
    const next: SourceDocument = {
      ...retained,
      title: fallbackTitle || "novel.txt",
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(path.join(this.sourcesDir, stateFileName(sourceId)), next);
    return next;
  }

  private async registerSourceBytes(fallbackTitle: string, content: Uint8Array, sourcePath: string): Promise<SourceDocument> {
    const identity = await new SourceMaterialStore().put(content, fallbackTitle);
    const id = identity.contentSha256.slice(0, 20);
    const filePath = path.join(this.sourcesDir, stateFileName(id));
    const existing = await readJson<SourceDocument>(filePath);
    const titleInference = sourceTitleInferenceSchema.safeParse(existing?.titleInference);
    const pendingTitleProposal = sourceTitleProposalSchema.safeParse(existing?.pendingTitleProposal);
    const now = new Date().toISOString();
    const source: SourceDocument = {
      version: STATE_VERSION,
      id,
      title: titleInference.success ? titleInference.data.title : fallbackTitle,
      sourcePath,
      contentMd5: identity.contentMd5,
      contentSha256: identity.contentSha256,
      bytes: identity.bytes,
      ...(titleInference.success ? { titleInference: titleInference.data } : {}),
      ...(pendingTitleProposal.success ? { pendingTitleProposal: pendingTitleProposal.data } : {}),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, source);
    return source;
  }

  private async archiveExistingSources(): Promise<void> {
    const materials = new SourceMaterialStore();
    for (const source of await this.listSources()) {
      if (await materials.read(source)) continue;
      if (source.sourcePath.startsWith("content:")) continue;
      const absolute = path.resolve(this.root, source.sourcePath);
      try {
        const content = await fs.readFile(absolute);
        const identity = sourceMaterialIdentity(content);
        if (identity.contentSha256 !== source.contentSha256) continue;
        await materials.put(content, source.title);
        if (!source.contentMd5) {
          await atomicJson(path.join(this.sourcesDir, stateFileName(source.id)), { ...source, contentMd5: identity.contentMd5 });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async readDirectory<T>(
    directory: string,
    compare: (left: T, right: T) => number,
  ): Promise<T[]> {
    try {
      const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      const values: T[] = [];
      for (const name of files) {
        const value = await readJson<T>(path.join(directory, name));
        if (value !== null) values.push(value);
      }
      return values.sort(compare);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
