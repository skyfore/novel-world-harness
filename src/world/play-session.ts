import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { idSchema } from "./model.js";

const timestampSchema = z.string().datetime({ offset: true });
const playSessionStatusSchema = z.enum(["active", "idle", "archived", "detached"]);

export const legacyActivePlaySessionSchema = z.object({
  version: z.literal(1),
  branchId: idSchema,
  sourceId: idSchema.optional(),
  actorId: idSchema,
  lastCommitId: idSchema,
  updatedAt: timestampSchema,
}).strict();

export const activePlaySessionSchema = z.object({
  version: z.literal(2),
  id: idSchema,
  branchId: idSchema,
  sourceId: idSchema.optional(),
  actorId: idSchema,
  lastCommitId: idSchema,
  title: z.string().trim().min(1).max(200),
  status: playSessionStatusSchema,
  conversationId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const storedPlaySessionSchema = z.union([legacyActivePlaySessionSchema, activePlaySessionSchema]);

export type LegacyActivePlaySession = z.infer<typeof legacyActivePlaySessionSchema>;
export type ActivePlaySession = z.infer<typeof activePlaySessionSchema>;
export type PlaySessionStatus = z.infer<typeof playSessionStatusSchema>;

export type WritePlaySessionInput = {
  branchId: string;
  sourceId?: string;
  actorId: string;
  lastCommitId: string;
  id?: string;
  title?: string;
  conversationId?: string;
};

export class PlaySessionStore {
  readonly filePath: string;
  private readonly instancesDir: string;

  constructor(workspaceRoot: string) {
    const root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "play");
    this.filePath = path.join(root, "active.json");
    this.instancesDir = path.join(root, "instances");
  }

  async read(): Promise<ActivePlaySession | null> {
    const stored = await this.readPath(this.filePath);
    if (!stored) return null;
    const session = upgradePlaySession(stored);
    if (session.status !== "active") {
      throw new Error(`Active play-session pointer '${session.id}' has non-active status '${session.status}'.`);
    }
    if (stored.version === 1) {
      await this.atomicWrite(this.instanceFile(session.branchId), session);
      await this.atomicWrite(this.filePath, session);
    }
    return session;
  }

  async readInstance(branchIdValue: string): Promise<ActivePlaySession | null> {
    const branchId = idSchema.parse(branchIdValue);
    return (await this.listInstances()).find((session) => session.branchId === branchId) ?? null;
  }

  async getById(sessionIdValue: string): Promise<ActivePlaySession | null> {
    const sessionId = idSchema.parse(sessionIdValue);
    return (await this.listInstances()).find((session) => session.id === sessionId) ?? null;
  }

  async listInstances(): Promise<ActivePlaySession[]> {
    const sessions = new Map<string, ActivePlaySession>();
    try {
      const names = (await fs.readdir(this.instancesDir)).filter((name) => name.endsWith(".json")).sort();
      for (const name of names) {
        const stored = await this.readPath(path.join(this.instancesDir, name));
        if (!stored) continue;
        const session = upgradePlaySession(stored);
        const expectedNames = new Set([`${session.branchId}.json`, `${session.id}.json`]);
        if (!expectedNames.has(name)) {
          throw new Error(`Play-session file '${name}' contains session '${session.id}' for branch '${session.branchId}'.`);
        }
        const previous = sessions.get(session.id);
        if (!previous || Date.parse(session.updatedAt) >= Date.parse(previous.updatedAt)) sessions.set(session.id, session);
        if (stored.version === 1) await this.atomicWrite(this.instanceFile(session.branchId), session);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const active = await this.read();
    if (active) sessions.set(active.id, active);
    return [...sessions.values()].sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || Number(right.status === "active") - Number(left.status === "active")
      || left.branchId.localeCompare(right.branchId)
      || left.id.localeCompare(right.id));
  }

  async write(input: WritePlaySessionInput): Promise<ActivePlaySession> {
    const branchId = idSchema.parse(input.branchId);
    const actorId = idSchema.parse(input.actorId);
    const lastCommitId = idSchema.parse(input.lastCommitId);
    const sourceId = input.sourceId === undefined ? undefined : idSchema.parse(input.sourceId);
    const previousActive = await this.read();
    const existing = input.id
      ? await this.getById(idSchema.parse(input.id))
      : await this.readInstance(branchId);
    const now = new Date().toISOString();

    if (previousActive && previousActive.id !== (input.id ?? existing?.id ?? playSessionIdForBranch(branchId))) {
      await this.atomicWrite(this.recordFile(previousActive), activePlaySessionSchema.parse({
        ...previousActive,
        status: "idle",
        updatedAt: now,
      }));
    }

    const effectiveSourceId = sourceId ?? existing?.sourceId;
    const value = activePlaySessionSchema.parse({
      version: 2,
      id: input.id ?? existing?.id ?? playSessionIdForBranch(branchId),
      branchId,
      ...(effectiveSourceId ? { sourceId: effectiveSourceId } : {}),
      actorId,
      lastCommitId,
      title: input.title ?? existing?.title ?? branchId,
      status: "active",
      conversationId: input.conversationId ?? existing?.conversationId ?? playConversationIdForBranch(branchId),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.atomicWrite(this.recordFile(value), value);
    await this.atomicWrite(this.filePath, value);
    return value;
  }

  async activate(sessionIdValue: string): Promise<ActivePlaySession> {
    const session = await this.requireById(sessionIdValue);
    if (session.status === "detached") throw new Error(`Play session '${session.id}' is detached because its branch no longer exists.`);
    if (session.status === "archived") throw new Error(`Play session '${session.id}' is archived. Restore it before continuing.`);
    return this.write({
      id: session.id,
      branchId: session.branchId,
      ...(session.sourceId ? { sourceId: session.sourceId } : {}),
      actorId: session.actorId,
      lastCommitId: session.lastCommitId,
      title: session.title,
      conversationId: session.conversationId,
    });
  }

  async updateMetadata(
    sessionIdValue: string,
    patch: { title?: string; status?: Exclude<PlaySessionStatus, "active"> },
  ): Promise<ActivePlaySession> {
    const session = await this.requireById(sessionIdValue);
    const updated = activePlaySessionSchema.parse({
      ...session,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString(),
    });
    await this.atomicWrite(this.recordFile(updated), updated);
    const active = await this.read();
    if (active?.id === updated.id) {
      if (updated.status === "active") await this.atomicWrite(this.filePath, updated);
      else await fs.rm(this.filePath, { force: true });
    }
    return updated;
  }

  async restore(sessionIdValue: string): Promise<ActivePlaySession> {
    const session = await this.requireById(sessionIdValue);
    if (session.status !== "archived") return session;
    const restored = activePlaySessionSchema.parse({
      ...session,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    await this.atomicWrite(this.recordFile(restored), restored);
    return restored;
  }

  async removeSession(sessionIdValue: string): Promise<ActivePlaySession> {
    const session = await this.requireById(sessionIdValue);
    await fs.rm(this.recordFile(session), { force: true });
    const active = await this.read();
    if (active?.id === session.id) await fs.rm(this.filePath, { force: true });
    return session;
  }

  async removeInstance(branchIdValue: string): Promise<ActivePlaySession | null> {
    const branchId = idSchema.parse(branchIdValue);
    const active = await this.read();
    const sessions = (await this.listInstances()).filter((session) => session.branchId === branchId);
    await Promise.all(sessions.map((session) => fs.rm(this.recordFile(session), { force: true })));
    if (active?.branchId !== branchId) return active;
    await fs.rm(this.filePath, { force: true });
    const next = (await this.listInstances()).find((session) => session.status === "idle");
    return next ? this.activate(next.id) : null;
  }

  async detachInstance(branchIdValue: string): Promise<{
    detachedSession: ActivePlaySession | null;
    nextActiveSession: ActivePlaySession | null;
  }> {
    const branchId = idSchema.parse(branchIdValue);
    const active = await this.read();
    const sessions = (await this.listInstances()).filter((session) => session.branchId === branchId);
    let detachedSession: ActivePlaySession | null = null;
    for (const session of sessions) {
      const detached = activePlaySessionSchema.parse({
        ...session,
        status: "detached",
        updatedAt: new Date().toISOString(),
      });
      await this.atomicWrite(this.recordFile(detached), detached);
      if (session.id === active?.id || !detachedSession) detachedSession = detached;
    }
    if (active?.branchId !== branchId) return { detachedSession, nextActiveSession: active };
    await fs.rm(this.filePath, { force: true });
    const next = (await this.listInstances()).find((candidate) => candidate.status === "idle");
    return {
      detachedSession,
      nextActiveSession: next ? await this.activate(next.id) : null,
    };
  }

  private async requireById(sessionId: string): Promise<ActivePlaySession> {
    const session = await this.getById(sessionId);
    if (!session) throw new Error(`Unknown play session '${sessionId}'. Use /play-sessions to list sessions in this workspace.`);
    return session;
  }

  private async readPath(filePath: string): Promise<z.infer<typeof storedPlaySessionSchema> | null> {
    try {
      return storedPlaySessionSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private instanceFile(branchId: string): string {
    return path.join(this.instancesDir, `${branchId}.json`);
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.instancesDir, `${sessionId}.json`);
  }

  private recordFile(session: ActivePlaySession): string {
    return session.id === playSessionIdForBranch(session.branchId)
      ? this.instanceFile(session.branchId)
      : this.sessionFile(session.id);
  }

  private async atomicWrite(filePath: string, value: ActivePlaySession): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
}

export function playSessionIdForBranch(branchIdValue: string): string {
  return idSchema.parse(`play-${idSchema.parse(branchIdValue)}`);
}

export function playConversationIdForBranch(branchIdValue: string): string {
  return idSchema.parse(`conversation-${idSchema.parse(branchIdValue)}`);
}

export function newPlaySessionIdentity(): { id: string; conversationId: string } {
  const suffix = crypto.randomUUID();
  return {
    id: idSchema.parse(`play-${suffix}`),
    conversationId: idSchema.parse(`conversation-${suffix}`),
  };
}

function upgradePlaySession(session: z.infer<typeof storedPlaySessionSchema>): ActivePlaySession {
  if (session.version === 2) return structuredClone(session);
  return activePlaySessionSchema.parse({
    version: 2,
    id: playSessionIdForBranch(session.branchId),
    branchId: session.branchId,
    ...(session.sourceId ? { sourceId: session.sourceId } : {}),
    actorId: session.actorId,
    lastCommitId: session.lastCommitId,
    title: session.branchId,
    status: "active",
    conversationId: playConversationIdForBranch(session.branchId),
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
  });
}
