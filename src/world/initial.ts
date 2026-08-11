import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { evidenceRefSchema, stateDeltaSchema } from "./model.js";

export const initialWorldSchema = z
  .object({
    version: z.literal(1),
    delta: stateDeltaSchema,
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type InitialWorld = z.infer<typeof initialWorldSchema>;

export class InitialWorldStore {
  readonly filePath: string;
  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".novel-harness", "world", "v1", "canon", "initial-world.json");
  }

  async put(input: InitialWorld): Promise<void> {
    const value = initialWorldSchema.parse(input);
    const serialized = `${canonicalJson(value)}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(this.filePath, "utf8")) !== serialized) {
        throw new Error("Canonical initial world already exists with different content");
      }
    }
  }

  async get(): Promise<InitialWorld | null> {
    try {
      return initialWorldSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
