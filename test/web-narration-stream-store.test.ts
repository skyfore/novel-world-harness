import { describe, expect, it, vi } from "vitest";
import { NarrationStreamStore } from "../apps/web/src/narration-stream-store.js";

describe("Web narration stream store", () => {
  it("coalesces high-frequency deltas into one external-store notification per frame", () => {
    const frames: Array<() => void> = [];
    const store = new NarrationStreamStore((flush) => frames.push(flush));
    const listener = vi.fn();
    const unsubscribe = store.subscribe("operation-1", listener);

    for (let index = 0; index < 320; index += 1) store.append("operation-1", "·");

    expect(frames).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot("operation-1")).toBe("");
    frames.shift()!();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.snapshot("operation-1")).toBe("·".repeat(320));

    store.append("operation-1", "done");
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.snapshot("operation-1")).toBe(`${"·".repeat(320)}done`);

    store.complete("operation-1");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.snapshot("operation-1")).toBe("");
    unsubscribe();
  });

  it("drops a pending frame after the authoritative operation completes", () => {
    const frames: Array<() => void> = [];
    const store = new NarrationStreamStore((flush) => frames.push(flush));
    const listener = vi.fn();
    store.subscribe("operation-2", listener);
    store.append("operation-2", "unsettled");
    store.complete("operation-2");

    frames.shift()!();
    expect(store.snapshot("operation-2")).toBe("");
    expect(listener).not.toHaveBeenCalled();
  });
});
