import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webError } from "../src/web/errors.js";
import { WebMutationJournal } from "../src/web/mutation-journal.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-mutation-journal-"));
  roots.push(root);
  return root;
}

describe("Web mutation journal", () => {
  it("replays a successful short command across host restarts without persisting its request body", async () => {
    const root = await workspace();
    const requestCanary = "request-body-must-not-be-persisted";
    let executions = 0;
    const input = {
      kind: "source-register",
      scopeId: "workspace",
      clientRequestId: "register-1",
      request: { title: "novel.txt", content: requestCanary },
    };
    const first = await new WebMutationJournal(root).execute(input, async () => {
      executions += 1;
      return { sourceId: "source-1" };
    });
    const replay = await new WebMutationJournal(root).execute(input, async () => {
      executions += 1;
      return { sourceId: "should-not-run" };
    });

    expect(first).toEqual({ value: { sourceId: "source-1" }, reused: false });
    expect(replay).toEqual({ value: { sourceId: "source-1" }, reused: true });
    expect(executions).toBe(1);
    const persisted = (await Promise.all((await fs.readdir(new WebMutationJournal(root).root))
      .map((name) => fs.readFile(path.join(new WebMutationJournal(root).root, name), "utf8")))).join("\n");
    expect(persisted).not.toContain(requestCanary);
    await expect(new WebMutationJournal(root).execute({
      ...input,
      request: { title: "different.txt", content: "different" },
    }, async () => ({ sourceId: "unreachable" }))).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("marks an orphaned running command interrupted and forbids unchanged replay", async () => {
    const root = await workspace();
    const input = {
      kind: "play-session-remove",
      scopeId: "play-main",
      clientRequestId: "remove-1",
      request: { clientRequestId: "remove-1" },
    };
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    void new WebMutationJournal(root).execute(input, async () => {
      entered();
      return new Promise<never>(() => undefined);
    });
    await running;

    const restarted = new WebMutationJournal(root);
    await restarted.initialize();
    await expect(restarted.execute(input, async () => ({ unreachable: true }))).rejects.toMatchObject({
      detail: { code: "MUTATION_INTERRUPTED", retry: { kind: "none" } },
    });
  });

  it("replays a bounded API failure instead of executing the command again", async () => {
    const root = await workspace();
    const input = {
      kind: "proposal-reject",
      scopeId: "proposal-1",
      clientRequestId: "reject-1",
      request: { reason: "needs review" },
    };
    let executions = 0;
    const fail = async () => {
      executions += 1;
      throw webError(409, "PROPOSAL_ALREADY_ACCEPTED", "The proposal is already accepted.", { kind: "none" });
    };
    await expect(new WebMutationJournal(root).execute(input, fail)).rejects.toMatchObject({
      detail: { code: "PROPOSAL_ALREADY_ACCEPTED" },
    });
    await expect(new WebMutationJournal(root).execute(input, fail)).rejects.toMatchObject({
      detail: { code: "PROPOSAL_ALREADY_ACCEPTED" },
    });
    expect(executions).toBe(1);
  });
});
