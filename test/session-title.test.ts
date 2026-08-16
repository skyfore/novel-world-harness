import { describe, expect, it } from "vitest";
import { createRenameSessionTool, normalizeSessionTitle } from "../src/agent/session-title.js";

describe("agent-managed session titles", () => {
  it("normalizes meaningful titles and rejects labels that cannot distinguish a session", () => {
    expect(normalizeSessionTitle("  《红楼梦》   ·   林黛玉支线  ")).toBe("《红楼梦》 · 林黛玉支线");
    expect(() => normalizeSessionTitle("New session")).toThrow("too generic");
    expect(() => normalizeSessionTitle("会话")).toThrow("too generic");
  });

  it("lets the agent rename session metadata through a narrow tool", async () => {
    const titles: string[] = [];
    const tool = createRenameSessionTool((title) => titles.push(title));
    const result = await tool.execute(
      "rename-1",
      { title: "三体 · 罗辑黑暗森林演化" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(titles).toEqual(["三体 · 罗辑黑暗森林演化"]);
    expect(result).toMatchObject({ details: { title: "三体 · 罗辑黑暗森林演化" } });
  });
});
