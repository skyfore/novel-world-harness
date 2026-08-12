import { LocalFileWorkspace } from "../workspace/local-files.js";

export async function expandFileMentions(input: string, workspace: LocalFileWorkspace): Promise<string> {
  const mentionPattern = /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  const attachments: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(input)) !== null) {
    const filePath = match[1] ?? match[2] ?? match[3];
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const content = await workspace.readFile({ path: filePath });
    attachments.push(`<attached-file path="${filePath}">\n${content}\n</attached-file>`);
  }
  if (!attachments.length) return input;
  return `${input}\n\nLocally resolved file references:\n${attachments.join("\n\n")}`;
}
