import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { idSchema } from "./model.js";

export const activePlaySessionSchema = z.object({
  version: z.literal(1),
  branchId: idSchema,
  actorId: idSchema,
  lastCommitId: idSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ActivePlaySession = z.infer<typeof activePlaySessionSchema>;

export class PlaySessionStore {
  readonly filePath: string;
  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "play", "active.json");
  }
  async read(): Promise<ActivePlaySession | null> {
    try {
      return activePlaySessionSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async write(input: Omit<ActivePlaySession, "version" | "updatedAt">): Promise<ActivePlaySession> {
    const value = activePlaySessionSchema.parse({
      version: 1,
      ...input,
      updatedAt: new Date().toISOString(),
    });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    return value;
  }
}
