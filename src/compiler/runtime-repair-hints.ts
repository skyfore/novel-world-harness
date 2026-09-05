import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import {
  runtimeCompilerRepairHintSchema,
  type RuntimeCompilerRepairHint,
} from "../world/runtime-context.js";

export type PersistedRuntimeCompilerRepairHint = RuntimeCompilerRepairHint & {
  id: string;
  recordedAt: string;
};

/**
 * Immutable, non-authoritative inbox for evidence gaps discovered during play.
 * Publishing compiler artifacts remains an explicit proposal/validation flow.
 */
export class RuntimeCompilerRepairHintStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(
      worldStorageRoot(workspaceRoot),
      "compiler",
      "runtime-repair-hints",
      "v1",
    );
  }

  async record(inputValue: RuntimeCompilerRepairHint): Promise<PersistedRuntimeCompilerRepairHint> {
    const input = runtimeCompilerRepairHintSchema.parse(inputValue);
    const id = `runtime-gap-${contentHash(input).slice(0, 24)}`;
    const filePath = this.filePath(input.sourceId, id);
    try {
      const existing = JSON.parse(await fs.readFile(filePath, "utf8")) as PersistedRuntimeCompilerRepairHint;
      if (existing.id !== id || contentHash(stripPersistence(existing)) !== contentHash(input)) {
        throw new Error(`Runtime compiler repair hint '${id}' failed its content-integrity check.`);
      }
      return structuredClone(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const persisted: PersistedRuntimeCompilerRepairHint = {
      ...structuredClone(input),
      id,
      recordedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.read(input.sourceId, id).then((value) => {
        if (!value) throw new Error(`Runtime compiler repair hint '${id}' publication raced without a durable result.`);
        return value;
      });
    }
    return persisted;
  }

  async read(sourceId: string, id: string): Promise<PersistedRuntimeCompilerRepairHint | null> {
    idSchema.parse(sourceId);
    if (!/^runtime-gap-[a-f0-9]{24}$/.test(id)) throw new Error(`Invalid runtime compiler repair hint id: ${id}`);
    try {
      const value = JSON.parse(await fs.readFile(this.filePath(sourceId, id), "utf8")) as PersistedRuntimeCompilerRepairHint;
      const input = runtimeCompilerRepairHintSchema.parse(stripPersistence(value));
      const expectedId = `runtime-gap-${contentHash(input).slice(0, 24)}`;
      if (value.id !== expectedId || typeof value.recordedAt !== "string") {
        throw new Error(`Runtime compiler repair hint '${id}' failed its content-integrity check.`);
      }
      return structuredClone({ ...input, id: value.id, recordedAt: value.recordedAt });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(sourceId: string): Promise<PersistedRuntimeCompilerRepairHint[]> {
    idSchema.parse(sourceId);
    const directory = path.join(this.root, sourceId);
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values = await Promise.all(names.map((name) => this.read(sourceId, name.slice(0, -5))));
    return values.filter((value): value is PersistedRuntimeCompilerRepairHint => Boolean(value));
  }

  private filePath(sourceId: string, id: string): string {
    idSchema.parse(sourceId);
    if (!/^runtime-gap-[a-f0-9]{24}$/.test(id)) throw new Error(`Invalid runtime compiler repair hint id: ${id}`);
    return path.join(this.root, sourceId, `${id}.json`);
  }
}

function stripPersistence(value: PersistedRuntimeCompilerRepairHint): RuntimeCompilerRepairHint {
  const { id: _id, recordedAt: _recordedAt, ...input } = value;
  return input;
}
