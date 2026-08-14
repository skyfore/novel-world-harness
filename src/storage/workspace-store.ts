import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";

const STATE_VERSION = 1;

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
  registeredAt: string;
  updatedAt: string;
};

export function defaultProjectForRoot(root: string): HarnessConfig["project"] {
  return {
    name: path.basename(path.resolve(root)) || "novel-world",
    language: "zh-CN",
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
    this.stateDir = path.join(root, ".novel-harness");
    this.sourcesDir = path.join(this.stateDir, "sources");
  }

  static async create(root = process.cwd()): Promise<WorkspaceStore> {
    const realRoot = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    return new WorkspaceStore(realRoot);
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
    if (content.subarray(0, 8_000).includes(0)) throw new Error(`Source must be UTF-8 text: ${inputPath}`);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const md5 = crypto.createHash("md5").update(content).digest("hex");
    const id = sha.slice(0, 20);
    const filePath = path.join(this.sourcesDir, stateFileName(id));
    const existing = await readJson<SourceDocument>(filePath);
    const now = new Date().toISOString();
    const source: SourceDocument = {
      version: STATE_VERSION,
      id,
      title: path.basename(absolute),
      sourcePath: relative.split(path.sep).join("/"),
      contentMd5: md5,
      contentSha256: sha,
      bytes: content.byteLength,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    await atomicJson(filePath, source);
    return source;
  }

  async getSource(id: string): Promise<SourceDocument | null> {
    return readJson<SourceDocument>(path.join(this.sourcesDir, stateFileName(id)));
  }

  async listSources(): Promise<SourceDocument[]> {
    return this.readDirectory<SourceDocument>(this.sourcesDir, (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
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
