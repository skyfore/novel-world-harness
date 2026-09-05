import { describe, expect, it } from "vitest";
import { NWH_DOUBLE_CTRL_C_WINDOW_MS, NwhDoubleCtrlCExit } from "../src/agent/nwh-exit.js";

describe("NWH double Ctrl+C exit", () => {
  it("requires a second press inside the visible confirmation window", () => {
    let now = 1_000;
    const exit = new NwhDoubleCtrlCExit(() => now);

    expect(exit.press()).toBe("arm");
    now += NWH_DOUBLE_CTRL_C_WINDOW_MS;
    expect(exit.press()).toBe("exit");
  });

  it("re-arms after the confirmation window expires", () => {
    let now = 1_000;
    const exit = new NwhDoubleCtrlCExit(() => now);

    expect(exit.press()).toBe("arm");
    now += NWH_DOUBLE_CTRL_C_WINDOW_MS + 1;
    expect(exit.press()).toBe("arm");
    now += 1;
    expect(exit.press()).toBe("exit");
  });
});
