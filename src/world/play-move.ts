import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "./canonical.js";
import { idSchema } from "./model.js";
import { worldStorageRoot } from "./paths.js";
import type { PerformPlayTurnOptions, PlayTurnOutcome } from "./play-experience.js";

/** Transport receipts only. Branch commits remain the authority for world truth.
 * An exclusive immutable intent prevents two workers from executing one move.
 * Missing completion is uncertain execution, never permission to execute again.
 */
export class PlayMoveStore {
  readonly directory: string;
  admitted = false;
  private readonly requestHash: string;

  constructor(private readonly options: PerformPlayTurnOptions & { playerMoveId: string }) {
    this.directory = path.join(worldStorageRoot(options.root), "play", "moves", idSchema.parse(options.branchId), contentHash(idSchema.parse(options.playerMoveId)));
    const { root: _root, translator: _translator, adjudicator: _adjudicator, contextResolver: _resolver,
      contextObserver: _observer, worldResponseResolver: _world, canonicalAttachmentResolver: _canonical,
      npcResponseReasoner: _npc, actorReasoner: _actor, beforeCommit: _commit, runId: _run, origin: _origin,
      ...request } = options;
    this.requestHash = contentHash({ ...request, advanceBackground: options.advanceBackground ?? 0, advanceActors: options.advanceActors ?? 1 });
  }

  async begin(): Promise<PlayTurnOutcome | undefined> {
    if (await this.publish("intent.json", this.intent())) { this.admitted = true; return undefined; }
    const saved = await this.lookup();
    if (!saved) throw this.recoveryRequired("The original move intent disappeared during admission");
    return saved;
  }

  async lookup(): Promise<PlayTurnOutcome | undefined> {
    let previous: unknown;
    try { previous = await this.read("intent.json"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw this.recoveryRequired(`The original move intent cannot be read: ${String(error)}`);
    }
    if (contentHash(previous) !== contentHash(this.intent())) throw new Error("PLAY_MOVE_ID_CONFLICT: This playerMoveId already belongs to a different request. Inspect the original move; do not change its input or retry it as a new action.");
    let completed: { requestHash: string; outcomeHash: string; outcome: PlayTurnOutcome };
    try {
      const value = await this.read("outcome.json");
      z.object({ requestHash: z.string(), outcomeHash: z.string(), outcome: z.object({
        finalHead: idSchema, result: z.object({ branchId: idSchema, actorId: idSchema }),
      }) }).parse(value);
      completed = value as typeof completed;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw this.recoveryRequired(`The retained move receipt cannot be read: ${String(error)}`);
      throw this.recoveryRequired("The original move is still running or stopped before its completion receipt");
    }
    if (completed.requestHash !== this.requestHash || contentHash(completed.outcome) !== completed.outcomeHash
      || completed.outcome.result.branchId !== this.options.branchId || completed.outcome.result.actorId !== this.options.actorId) {
      throw this.recoveryRequired("The retained move receipt changed");
    }
    return completed.outcome;
  }

  private intent() {
    return { version: 1, requestHash: this.requestHash, branchId: this.options.branchId, playerMoveId: this.options.playerMoveId };
  }

  async complete(outcome: PlayTurnOutcome): Promise<void> {
    const receipt = { requestHash: this.requestHash, outcomeHash: contentHash(outcome), outcome };
    if (!await this.publish("outcome.json", receipt) && contentHash(await this.read("outcome.json")) !== contentHash(receipt)) {
      throw this.recoveryRequired("Conflicting completion receipts");
    }
  }

  recoveryRequired(reason: string): Error {
    return new Error(`PLAY_MOVE_RECOVERY_REQUIRED: ${reason}. Preserve '${this.directory}' and inspect the original trace and branch history. Do not repeat the action, change its move ID, or infer that an error rolled back a committed event.`);
  }

  private async read(name: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
  }

  private async publish(name: string, value: unknown): Promise<boolean> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, path.join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return true;
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
