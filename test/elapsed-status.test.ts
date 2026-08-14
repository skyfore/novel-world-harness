import { afterEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, startElapsedStatus } from "../src/util/elapsed-status.js";

afterEach(() => vi.useRealTimers());

describe("elapsed operation status", () => {
  it("updates a TUI status every second and stops cleanly", () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const status = startElapsedStatus({
      label: "Compiler batch 2/148",
      activity: "waiting for model response or tool call",
      onStatus: (message) => messages.push(message),
    });

    expect(messages.at(-1)).toBe("Compiler batch 2/148 · waiting for model response or tool call · elapsed 0s");
    vi.advanceTimersByTime(2_000);
    expect(messages.at(-1)).toContain("elapsed 2s");
    status.update("last tool call propose_entity liubei");
    expect(messages.at(-1)).toContain("last tool call propose_entity liubei");
    status.stop("model response received; verifying finish handshake");
    const count = messages.length;
    vi.advanceTimersByTime(5_000);
    expect(messages).toHaveLength(count);
  });

  it("uses a throttled textual heartbeat when no live status renderer exists", () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const status = startElapsedStatus({
      label: "Compiler prompt",
      activity: "waiting",
      onHeartbeat: (message) => messages.push(message),
    });

    vi.advanceTimersByTime(14_999);
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(messages.at(-1)).toContain("elapsed 15s");
    status.stop();
  });

  it("formats elapsed minutes compactly", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(63_900)).toBe("1m 03s");
  });
});
