import { describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { NwhTask, showNwhTask, taskSummary } from "../src/agent/nwh-task.js";

describe("NWH long-running tasks", () => {
  it("publishes progress and settles without rejecting its observable completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = new NwhTask("reparse-source", "Reparse Novel", "Starting");
    const states: string[] = [];
    task.subscribe(() => states.push(task.snapshot.activity));
    task.start(async () => {
      task.update("Compiler batch 2/148");
      task.log("↳ propose_entity liubei");
      await gate;
    });

    expect(task.snapshot.status).toBe("running");
    expect(task.snapshot.logs).toEqual(["↳ propose_entity liubei"]);
    release();
    await task.completion;
    expect(task.snapshot.status).toBe("completed");
    expect(states).toContain("Compiler batch 2/148");
    expect(taskSummary(task, task.snapshot.startedAt + 3_000)).toContain("3s");
  });

  it("retains task errors for /tasks inspection", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.start(async () => { throw new Error("provider unavailable"); });
    await task.completion;
    expect(task.snapshot).toMatchObject({ status: "failed", error: "provider unavailable" });
    expect(task.snapshot.logs.at(-1)).toBe("Error: provider unavailable");
  });

  it("moves a focused running task to the background with left arrow", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.start(() => new Promise<void>(() => {}));
    const ui = {
      custom: async (factory: (...args: unknown[]) => unknown) => new Promise<"background">((resolve) => {
        const component = factory(
          { requestRender() {} },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        ) as { handleInput?: (data: string) => void };
        component.handleInput?.("\x1b[D");
      }),
    } as unknown as ExtensionUIContext;

    await expect(showNwhTask(ui, task)).resolves.toBe("background");
    expect(task.snapshot.status).toBe("running");
  });
});
