import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";

/**
 * Give provider reasoning a stable visual boundary from the assistant's answer.
 * This only changes Pi's rendered Markdown; session content and model context are
 * left untouched.
 */
export const styleNwhThinkingMarkdown: MarkdownTransformer = (markdown, context) => {
  if (context.messageType !== "assistant-thinking" || !markdown.trim()) return markdown;
  const quoted = markdown.split("\n").map((line) => `> ${line}`);
  return [
    `> **Thinking${context.isStreaming ? "…" : ""}** · Ctrl+O toggles details`,
    ">",
    ...quoted,
  ].join("\n");
};
