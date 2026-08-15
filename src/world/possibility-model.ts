import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { possibilitySchema, type Possibility } from "./model.js";

export const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
export type PossibilityTemplate = z.infer<typeof possibilityTemplateSchema>;
type TemplateRef = { version: 1; id: string; hash: string; updatedAt: string };
export type PossibilityRevisionRef = { id: string; hash: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_CANONICAL_PREFIX = "canon-";

export class PossibilityTemplateStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon", "possibilities");
  }

  async put(input: PossibilityTemplate): Promise<void> {
    const value = possibilityTemplateSchema.parse(input);
    const id = safeTemplateId(value.id);
    const hash = contentHash(value);
    const revisionPath = path.join(this.root, "revisions", id, `${hash}.json`);
    await writeImmutable(revisionPath, value);
    await atomicJson(path.join(this.root, "refs", `${id}.json`), { version: 1, id, hash, updatedAt: new Date().toISOString() } satisfies TemplateRef);
  }

  async get(idInput: string): Promise<PossibilityTemplate> {
    const id = safeId(idInput);
    const ref = await this.readRef(id);
    return this.getRevision(id, ref.hash);
  }

  async getRevision(idInput: string, hash: string): Promise<PossibilityTemplate> {
    const id = safeId(idInput);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid possibility revision hash: ${hash}`);
    const value = possibilityTemplateSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, "revisions", id, `${hash}.json`), "utf8")));
    if (contentHash(value) !== hash) throw new Error(`Corrupt possibility template ${id}@${hash}`);
    return value;
  }

  async currentRevision(idInput: string): Promise<PossibilityRevisionRef | null> {
    const id = safeId(idInput);
    try {
      const ref = await this.readRef(id);
      return { id, hash: ref.hash };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(idInput: string): Promise<void> {
    const id = safeId(idInput);
    await fs.rm(path.join(this.root, "refs", `${id}.json`), { force: true });
  }

  async list(): Promise<PossibilityTemplate[]> {
    const directory = path.join(this.root, "refs");
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values: PossibilityTemplate[] = [];
    for (const name of names) values.push(await this.get(name.slice(0, -5)));
    return values;
  }

  async materialize(branchId: string, commitId: string): Promise<Possibility[]> {
    return (await this.list()).map((template) => ({ ...template, branchId, evaluatedAtCommit: commitId }));
  }

  private async readRef(id: string): Promise<TemplateRef> {
    const value = JSON.parse(await fs.readFile(path.join(this.root, "refs", `${id}.json`), "utf8")) as TemplateRef;
    if (value.version !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error(`Invalid possibility template ref: ${id}`);
    return value;
  }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Possibility revision collision: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function safeTemplateId(value: string): string {
  const id = safeId(value);
  if (id.startsWith(RESERVED_CANONICAL_PREFIX)) {
    throw new Error(`Possibility template id uses reserved canonical namespace: ${id}`);
  }
  return id;
}

function safeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe possibility id: ${value}`);
  return value;
}
