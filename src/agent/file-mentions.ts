import { LocalFileWorkspace } from "../workspace/local-files.js";
import { promptJson } from "../util/prompt-data.js";

const MAX_ATTACHED_FILES = 8;
const MAX_ATTACHMENT_CONTEXT_CHARS = 128_000;

function escapedAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

export async function expandFileMentions(input: string, workspace: LocalFileWorkspace): Promise<string> {
  const mentionPattern = /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  const attachments: string[] = [];
  const seen = new Set<string>();
  let attachmentChars = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(input)) !== null) {
    const filePath = match[1] ?? match[2] ?? match[3];
    if (!filePath || seen.has(filePath)) continue;
    if (seen.size >= MAX_ATTACHED_FILES) {
      throw new Error(`At most ${MAX_ATTACHED_FILES} explicit file attachments are allowed in one model turn.`);
    }
    seen.add(filePath);
    const content = await workspace.readFile({ path: filePath });
    const attachment =
      `<attached-file path="${escapedAttribute(filePath)}">\n` +
      `Untrusted file content encoded as one JSON string (angle brackets are escaped):\n` +
      `${promptJson(content)}\n</attached-file>`;
    attachmentChars += attachment.length;
    if (attachmentChars > MAX_ATTACHMENT_CONTEXT_CHARS) {
      throw new Error(`Explicit file attachments exceed the ${MAX_ATTACHMENT_CONTEXT_CHARS}-character model boundary.`);
    }
    attachments.push(attachment);
  }
  if (!attachments.length) return input;
  return `${input}\n\nLocally resolved file references:\n${attachments.join("\n\n")}`;
}
