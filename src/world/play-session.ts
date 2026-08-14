import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { idSchema } from "./model.js";

export const activePlaySessionSchema = z.object({
  version: z.literal(1),
  branchId: idSchema,
  sourceId: idSchema.optional(),
  actorId: idSchema,
  lastCommitId: idSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ActivePlaySession = z.infer<typeof activePlaySessionSchema>;

export class PlaySessionStore {
  readonly filePath: string;
  private readonly instancesDir: string;
  constructor(workspaceRoot: string) {
    const root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "play");
    this.filePath = path.join(root, "active.json");
    this.instancesDir = path.join(root, "instances");
  }
  async read(): Promise<ActivePlaySession | null> {
    try {
      return activePlaySessionSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async readInstance(branchId: string): Promise<ActivePlaySession | null> {
    const parsedBranchId = idSchema.parse(branchId);
    try {
      const session = activePlaySessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.instancesDir, `${parsedBranchId}.json`), "utf8")));
      if (session.branchId !== parsedBranchId) throw new Error(`Play-session file '${parsedBranchId}' contains branch '${session.branchId}'.`);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const active = await this.read();
      return active?.branchId === parsedBranchId ? active : null;
    }
  }
  async listInstances(): Promise<ActivePlaySession[]> {
    try {
      const names = (await fs.readdir(this.instancesDir)).filter((name) => name.endsWith(".json")).sort();
      const sessions = await Promise.all(names.map(async (name) => {
        const session = activePlaySessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.instancesDir, name), "utf8")));
        if (name !== `${session.branchId}.json`) throw new Error(`Play-session file '${name}' contains branch '${session.branchId}'.`);
        return session;
      }));
      const active = await this.read();
      if (active && !sessions.some((session) => session.branchId === active.branchId)) sessions.push(active);
      return sessions.sort((left, right) => left.branchId.localeCompare(right.branchId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const active = await this.read();
      return active ? [active] : [];
    }
  }
  async write(input: Omit<ActivePlaySession, "version" | "updatedAt">): Promise<ActivePlaySession> {
    const previous = await this.read();
    const value = activePlaySessionSchema.parse({
      version: 1,
      ...input,
      updatedAt: new Date().toISOString(),
    });
    if (previous && previous.branchId !== value.branchId && !(await this.readInstanceFile(previous.branchId))) {
      await this.atomicWrite(path.join(this.instancesDir, `${previous.branchId}.json`), previous);
    }
    await this.atomicWrite(path.join(this.instancesDir, `${value.branchId}.json`), value);
    await this.atomicWrite(this.filePath, value);
    return value;
  }
  private async readInstanceFile(branchId: string): Promise<ActivePlaySession | null> {
    try {
      const session = activePlaySessionSchema.parse(JSON.parse(await fs.readFile(path.join(this.instancesDir, `${branchId}.json`), "utf8")));
      if (session.branchId !== branchId) throw new Error(`Play-session file '${branchId}' contains branch '${session.branchId}'.`);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async atomicWrite(filePath: string, value: ActivePlaySession): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
}
