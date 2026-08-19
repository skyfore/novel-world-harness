import { describe, expect, it } from "vitest";
import { classifyPlayerInput } from "../src/world/player-input-route.js";

describe("player input routing", () => {
  it("uses only the explicit /ooc protocol and never semantic text classification", () => {
    expect(classifyPlayerInput("/ooc: 当前时间线在哪里？")).toBe("meta");
    expect(classifyPlayerInput("/OOC what is the current branch?")).toBe("meta");
    expect(classifyPlayerInput("OOC: 当前时间线在哪里？")).toBe("in-world");
    expect(classifyPlayerInput("当前时间线在哪里？")).toBe("in-world");
    expect(classifyPlayerInput("what chapter is this?")).toBe("in-world");
    expect(classifyPlayerInput("系统为什么不能继续？")).toBe("in-world");
  });
});
