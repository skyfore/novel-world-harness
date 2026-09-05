import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createRelatedMessageAccess } from "../src/agent/related-message-retrieval.js";

function text(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .flatMap((item) => item.type === "text" && item.text ? [item.text] : [])
    .join("\n");
}

describe("related-message retrieval skill", () => {
  it("searches an already scoped archive and returns exact paged message text", async () => {
    const access = createRelatedMessageAccess([
      { kind: "scene", text: "The door remained shut.", order: 0 },
      { kind: "player", text: "你还记得我们在旧桥边约定的暗号吗？", order: 1, status: "accepted" },
      { kind: "perceived-event", text: "The witness heard the question about the old bridge.", order: 2 },
    ]);
    const find = access.tools.find((tool) => tool.name === "find_related_messages")!;
    const read = access.tools.find((tool) => tool.name === "read_related_message")!;
    const found = JSON.parse(text(await find.execute(
      "find",
      { query: "旧桥 暗号" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { results: Array<{ ref: string; preview: string }> };

    expect(found.results[0]?.preview).toContain("旧桥边约定的暗号");
    const exact = JSON.parse(text(await read.execute(
      "read",
      { ref: found.results[0]!.ref, offset: 0, max_chars: 30_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { chunk: string };
    expect(exact.chunk).toContain("你还记得我们在旧桥边约定的暗号吗？");
    expect(exact.chunk).toContain('"status":"accepted"');
  });
});
