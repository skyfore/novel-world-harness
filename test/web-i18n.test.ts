import { describe, expect, it } from "vitest";
import { translateMessage } from "../apps/web/src/i18n.js";

describe("web interface translations", () => {
  it("renders shipped Chinese copy with interpolated values", () => {
    expect(translateMessage("zh-CN", "World control room")).toBe("世界控制台");
    expect(translateMessage("zh-CN", "{nodes} nodes · {edges} edges", { nodes: 12, edges: 7 }))
      .toBe("12 个节点 · 7 条边");
  });

  it("keeps English as the stable fallback for domain and diagnostic copy", () => {
    expect(translateMessage("en", "Show archived ({count})", { count: 3 })).toBe("Show archived (3)");
    expect(translateMessage("zh-CN", "provider-specific diagnostic")).toBe("provider-specific diagnostic");
  });
});
