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
      task.appendReasoning("private reasoning");
      task.appendModelOutput("Reviewing evidence\x1b[31m now.");
      task.appendToolEvent("call", "propose_entity", { proposal_id: "liubei" });
      await gate;
    });

    expect(task.snapshot.status).toBe("running");
    expect(task.snapshot.logs).toEqual(["↳ propose_entity liubei"]);
    expect(task.snapshot.reasoningCharacters).toBe("private reasoning".length);
    expect(task.snapshot.modelOutput).toContain("Reviewing evidence␛[31m now.");
    expect(task.snapshot.modelOutput).toContain("[tool call] propose_entity");
    expect(task.snapshot.modelOutput).toContain('"proposal_id": "liubei"');
    release();
    await task.completion;
    expect(task.snapshot.status).toBe("completed");
    expect(states).toContain("Compiler batch 2/148");
    expect(taskSummary(task, task.snapshot.startedAt + 3_000)).toContain("3s");
  });

  it("does not duplicate elapsed time already supplied by a live compiler heartbeat", () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.update("Compiler batch 2/148 · waiting · elapsed 48s");
    expect(taskSummary(task, task.snapshot.startedAt + 49_000)).toBe(
      "Reparse Novel · running · Compiler batch 2/148 · waiting · elapsed 48s",
    );
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
    task.appendReasoning("summary");
    task.appendModelOutput("I am reviewing chapter evidence now.");
    let rendered: string[] = [];
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
        ) as { render: (width: number) => string[]; handleInput?: (data: string) => void };
        rendered = component.render(100);
        component.handleInput?.("\x1b[D");
      }),
    } as unknown as ExtensionUIContext;

    await expect(showNwhTask(ui, task)).resolves.toBe("background");
    expect(task.snapshot.status).toBe("running");
    expect(rendered.join("\n")).toContain("Model output · unverified proposal commentary");
    expect(rendered.join("\n")).toContain("I am reviewing chapter evidence now.");
    expect(rendered.join("\n")).toContain("Provider reasoning stream received: 7 characters");
  });
});
