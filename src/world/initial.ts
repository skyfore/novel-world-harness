import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { evidenceRefSchema, idSchema, knowledgeDeltaSchema, stateDeltaSchema, storyTimeSchema } from "./model.js";

export const openingCheckpointSchema = z
  .object({
    mode: z.enum(["chronological", "textual-frame", "custom"]),
    storyTime: storyTimeSchema.optional(),
    narrativeLayerId: idSchema.optional(),
    beforeCanonicalEventId: idSchema.optional(),
    rationale: z.string().trim().min(1).max(1000),
  })
  .strict();
export type OpeningCheckpoint = z.infer<typeof openingCheckpointSchema>;

export const initialWorldSchema = z
  .object({
    version: z.literal(1),
    delta: stateDeltaSchema,
    knowledge: knowledgeDeltaSchema.optional(),
    checkpoint: openingCheckpointSchema.optional(),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type InitialWorld = z.infer<typeof initialWorldSchema>;
export type InitialWorldRevisionRef = { hash: string };
type StoredInitialWorldRef = { version: 1; hash: string; updatedAt: string };

export class InitialWorldStore {
  readonly filePath: string;
  readonly root: string;
  constructor(workspaceRoot: string) {
    const canonRoot = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon");
    this.filePath = path.join(canonRoot, "initial-world.json");
    this.root = path.join(canonRoot, "initial-world");
  }

  async put(input: InitialWorld): Promise<void> {
    const value = initialWorldSchema.parse(input);
    await this.migrateLegacy();
    const hash = contentHash(value);
    await writeImmutable(this.revisionPath(hash), value);
    await atomicJson(this.refPath(), { version: 1, hash, updatedAt: new Date().toISOString() } satisfies StoredInitialWorldRef);
  }

  async get(): Promise<InitialWorld | null> {
    const ref = await this.readRef();
    if (ref) return this.getRevision(ref.hash);
    try {
      return initialWorldSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async currentRevision(): Promise<InitialWorldRevisionRef | null> {
    const ref = await this.readRef();
    if (ref) return { hash: ref.hash };
    const legacy = await this.readLegacy();
    return legacy ? { hash: contentHash(legacy) } : null;
  }

  async getRevision(hash: string): Promise<InitialWorld> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid initial-world revision hash: ${hash}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.revisionPath(hash), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.readLegacy();
      if (!legacy || contentHash(legacy) !== hash) {
        throw Object.assign(new Error(`Initial-world revision not found: ${hash}`), { code: "ENOENT" });
      }
      raw = legacy;
    }
    const value = initialWorldSchema.parse(raw);
    if (contentHash(value) !== hash) throw new Error(`Corrupt initial-world revision ${hash}`);
    return value;
  }

  async clear(): Promise<void> {
    await this.migrateLegacy();
    await fs.rm(this.refPath(), { force: true });
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = await this.readLegacy();
    if (!legacy) return;
    await writeImmutable(this.revisionPath(contentHash(legacy)), legacy);
    await fs.rm(this.filePath, { force: true });
  }

  private async readLegacy(): Promise<InitialWorld | null> {
    try { return initialWorldSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async readRef(): Promise<StoredInitialWorldRef | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.refPath(), "utf8")) as StoredInitialWorldRef;
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error("Invalid initial-world ref");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private refPath(): string { return path.join(this.root, "current.json"); }
  private revisionPath(hash: string): string { return path.join(this.root, "revisions", `${hash}.json`); }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Initial-world revision collision: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
