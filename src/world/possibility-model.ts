import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { possibilitySchema, type Possibility } from "./model.js";

export const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
export type PossibilityTemplate = z.infer<typeof possibilityTemplateSchema>;
type TemplateRef = { version: 1; id: string; hash: string; updatedAt: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PossibilityTemplateStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "canon", "possibilities");
  }

  async put(input: PossibilityTemplate): Promise<void> {
    const value = possibilityTemplateSchema.parse(input);
    const id = safeId(value.id);
    const hash = contentHash(value);
    const revisionPath = path.join(this.root, "revisions", id, `${hash}.json`);
    await writeImmutable(revisionPath, value);
    await atomicJson(path.join(this.root, "refs", `${id}.json`), { version: 1, id, hash, updatedAt: new Date().toISOString() } satisfies TemplateRef);
  }

  async get(idInput: string): Promise<PossibilityTemplate> {
    const id = safeId(idInput);
    const ref = await this.readRef(id);
    const value = possibilityTemplateSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, "revisions", id, `${ref.hash}.json`), "utf8")));
    if (contentHash(value) !== ref.hash) throw new Error(`Corrupt possibility template ${id}@${ref.hash}`);
    return value;
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

function safeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe possibility id: ${value}`);
  return value;
}

