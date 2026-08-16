import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const GENERIC_TITLES = new Set([
  "chat",
  "conversation",
  "new chat",
  "new session",
  "novel",
  "novel world",
  "nwh",
  "session",
  "untitled",
  "会话",
  "新会话",
  "小说",
  "小说世界",
]);

export function normalizeSessionTitle(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  const title = [...normalized].slice(0, 72).join("").trim();
  if (title.length < 2) throw new Error("Session title must contain at least two visible characters.");
  if (GENERIC_TITLES.has(title.toLocaleLowerCase())) {
    throw new Error("Session title is too generic; include the novel, character, or concrete task.");
  }
  return title;
}

export function createRenameSessionTool(onRename: (title: string) => void): ToolDefinition {
  return defineTool({
    name: "rename_session",
    label: "Rename session",
    description: "Give the current transcript a concise, meaningful display title so it can be distinguished in the session selector. This changes session metadata only.",
    promptSnippet: "Name the session after the concrete novel-world objective",
    promptGuidelines: [
      "Use this once near the first substantive turn, after understanding the user's actual target.",
      "Use 4-12 words when practical; include the novel, character, compiler scope, or concrete NWH task.",
      "Rename again only when the session's primary novel or objective genuinely changes.",
      "Avoid generic titles such as New session, Novel world, Help, or Chat.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 2, maxLength: 100, description: "Concrete session title shown in the session selector." }),
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const title = normalizeSessionTitle(input.title);
      onRename(title);
      return {
        content: [{ type: "text" as const, text: `Session renamed to: ${title}` }],
        details: { title },
      };
    },
  });
}
