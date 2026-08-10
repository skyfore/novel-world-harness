import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type StoredSession = {
  version: 1;
  id: string;
  root: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: MessageParam[];
};

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly latestPath: string;

  constructor(private readonly root: string) {
    const stateDir = path.join(root, ".novel-harness");
    this.sessionsDir = path.join(stateDir, "sessions");
    this.latestPath = path.join(stateDir, "latest-session");
  }

  create(model: string): StoredSession {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: `${now.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
      root: this.root,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  async loadLatest(): Promise<StoredSession | null> {
    try {
      const id = (await fs.readFile(this.latestPath, "utf8")).trim();
      if (!id) return null;
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("The latest session id is invalid.");
      const raw = await fs.readFile(path.join(this.sessionsDir, `${id}.json`), "utf8");
      const value = JSON.parse(raw) as StoredSession;
      if (value.version !== 1 || value.root !== this.root || !Array.isArray(value.messages)) {
        throw new Error("The latest session is incompatible with this workspace.");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session: StoredSession): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    const destination = path.join(this.sessionsDir, `${session.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.writeFile(this.latestPath, `${session.id}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
