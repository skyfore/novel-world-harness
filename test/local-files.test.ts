import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandFileMentions } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; workspace: LocalFileWorkspace }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-workspace-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "chapters"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await fs.mkdir(path.join(root, ".novel-harness"), { recursive: true });
  await fs.writeFile(path.join(root, "chapters", "one.md"), "第一章\n曹操进入大厅。\n众人沉默。\n", "utf8");
  await fs.writeFile(path.join(root, "chapters", "two.md"), "第二章\n曹操离开大厅。\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "ignored", "secret.txt"), "曹操", "utf8");
  await fs.writeFile(path.join(root, ".novel-harness", "session.json"), "曹操", "utf8");
  await fs.writeFile(path.join(root, ".env"), "ANTHROPIC_API_KEY=secret", "utf8");
  return { root, workspace: await LocalFileWorkspace.create(root) };
}

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("LocalFileWorkspace", () => {
  it("lists source files while excluding state and dependency directories", async () => {
    const { workspace } = await fixture();
    await expect(workspace.listFiles()).resolves.toEqual([
      "chapters/one.md",
      "chapters/two.md",
    ]);
  });

  it("reads bounded, numbered line ranges", async () => {
    const { workspace } = await fixture();
    const result = await workspace.readFile({ path: "chapters/one.md", startLine: 2, endLine: 3 });
    expect(result).toContain("chapters/one.md:2-3");
    expect(result).toContain("2: 曹操进入大厅。");
    expect(result).toContain("3: 众人沉默。");
    expect(result).not.toContain("[truncated");
  });

  it("searches files locally and returns evidence locations", async () => {
    const { workspace } = await fixture();
    await expect(workspace.searchFiles({ query: "曹操" })).resolves.toEqual([
      "chapters/one.md:2: 曹操进入大厅。",
      "chapters/two.md:2: 曹操离开大厅。",
    ]);
  });

  it("rejects traversal and symbolic-link escapes", async () => {
    const { root, workspace } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-outside-"));
    temporaryDirectories.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
    await expect(workspace.readFile({ path: "../secret.txt" })).rejects.toThrow("outside the workspace");
    await expect(workspace.readFile({ path: "escape.txt" })).rejects.toThrow("resolves outside the workspace");
  });

  it("excludes credentials and private harness state from direct reads", async () => {
    const { workspace } = await fixture();
    await expect(workspace.readFile({ path: ".env" })).rejects.toThrow("excluded from local tools");
    await expect(workspace.readFile({ path: ".novel-harness/session.json" })).rejects.toThrow("excluded from local tools");
  });
});

describe("expandFileMentions", () => {
  it("resolves quoted and unquoted local file references once", async () => {
    const { workspace } = await fixture();
    const result = await expandFileMentions(
      "比较 @chapters/one.md 和 @\"chapters/two.md\"，再看一次 @chapters/one.md",
      workspace,
    );
    expect(result.match(/<attached-file/g)).toHaveLength(2);
    expect(result).toContain("曹操进入大厅");
    expect(result).toContain("曹操离开大厅");
  });

  it("does not treat an email address as a file reference", async () => {
    const { workspace } = await fixture();
    await expect(expandFileMentions("联系 editor@example.com", workspace)).resolves.toBe("联系 editor@example.com");
  });
});

