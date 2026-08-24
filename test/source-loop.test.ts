import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import {
  markSourceLoopBatchComplete,
  parseStandaloneSourcePath,
  prepareNextSourceLoopTurn,
  prepareSourceLoopFromContent,
  prepareSourceLoopFromInput,
} from "../src/compiler/source-loop.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { readSourceMaterial } from "../src/storage/source-material-store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; novel: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-loop-"));
  roots.push(root);
  const novel = path.join(root, "novel world.txt");
  const content = Array.from(
    { length: 8 },
    (_, index) => `第${index + 1}章\n人物${index + 1}进入城池，得知事件${index + 1}。\n`,
  ).join("\n");
  await fs.writeFile(novel, content, "utf8");
  return { root, novel };
}

describe("novel source compiler loop", () => {
  it("recognizes standalone quoted, unquoted and @ source paths", () => {
    expect(parseStandaloneSourcePath("'fixtures/三国演义.txt'")).toBe("fixtures/三国演义.txt");
    expect(parseStandaloneSourcePath("@\"novels/my book.txt\"")).toBe("novels/my book.txt");
    expect(parseStandaloneSourcePath("novel.txt")).toBe("novel.txt");
    expect(parseStandaloneSourcePath("分析 novel.txt 的人物")).toBeUndefined();
  });

  it("registers, segments and resumes compiler batches from a pasted path", async () => {
    const { root, novel } = await fixture();
    const first = await prepareSourceLoopFromInput(root, `'${novel}'`);
    expect(first?.status).toBe("ready");
    if (!first || first.status !== "ready") throw new Error("expected first compiler turn");

    expect(first.source.sourcePath).toBe("novel world.txt");
    expect(first.totalBatches).toBeGreaterThan(1);
    expect(first.prompt).toContain("Execute the novel-world compiler loop now");
    expect(first.prompt).toContain("EvidenceRef");
    expect(first.prompt).toContain("人物1进入城池");
    expect(first.prompt).not.toContain("novel world.txt");
    await expect(fs.stat(path.join(workspaceStateDir(root), "sources", `${first.source.id}.json`))).resolves.toBeDefined();
    await expect((await WorkspaceStore.create(root)).readProject()).resolves.toMatchObject({
      name: path.basename(root),
      language: "zh-CN",
    });

    await markSourceLoopBatchComplete(root, first.source.id, first.batch.id);
    const second = await prepareNextSourceLoopTurn(root, first.source.id);
    expect(second?.status).toBe("ready");
    if (!second || second.status !== "ready") throw new Error("expected second compiler turn");
    expect(second.completedBatches).toBe(1);
    expect(second.batch.id).not.toBe(first.batch.id);

    let next = second;
    while (next.status === "ready") {
      await markSourceLoopBatchComplete(root, next.source.id, next.batch.id);
      next = await prepareNextSourceLoopTurn(root, next.source.id);
    }
    expect(next).toMatchObject({
      status: "complete",
      source: { id: second.source.id },
    });
  });

  it("leaves ordinary conversation input unchanged", async () => {
    const { root } = await fixture();
    await expect(prepareSourceLoopFromInput(root, "请分析刘备的角色目标")).resolves.toBeNull();
  });

  it("archives direct content and compiles it without creating a source file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-content-"));
    roots.push(root);
    const exactContent = "\n第一章\n人物进入城池。\n\n";
    const preparation = await prepareSourceLoopFromContent(root, exactContent, { title: "inline.txt" });

    expect(preparation.status).toBe("ready");
    expect(preparation.source).toMatchObject({ title: "inline.txt", sourcePath: "content:inline.txt" });
    if (preparation.status !== "ready") throw new Error("expected compiler turn");
    expect(preparation.prompt).toContain("人物进入城池");
    expect((await readSourceMaterial(root, preparation.source)).toString("utf8")).toBe(exactContent);
    await expect(fs.stat(path.join(root, "inline.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, ".novel-harness"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses configured project metadata when a pasted path initializes local state", async () => {
    const { root, novel } = await fixture();
    await fs.writeFile(
      path.join(root, "novel-harness.yaml"),
      "version: 1\nproject:\n  name: configured-world\n  language: en\n",
      "utf8",
    );

    await prepareSourceLoopFromInput(root, `'${novel}'`);

    await expect((await WorkspaceStore.create(root)).readProject()).resolves.toMatchObject({
      id: "configured-world",
      name: "configured-world",
      language: "en",
    });
  });

  it("does not let a TUI source turn reclassify configured guidance as novel evidence", async () => {
    const { root } = await fixture();
    const guidance = path.join(root, "NWH.md");
    await fs.writeFile(guidance, "Trusted harness guidance.\n", "utf8");
    await fs.writeFile(
      path.join(root, "novel-harness.yaml"),
      "version: 1\nproject:\n  name: configured-world\n  instructions:\n    - NWH.md\n",
      "utf8",
    );

    await expect(prepareSourceLoopFromInput(root, guidance))
      .rejects.toThrow("configured as trusted project guidance");
  });

  it("does not turn a standalone source-code attachment into a novel compiler loop", async () => {
    const { root } = await fixture();
    const codePath = path.join(root, "compiler.ts");
    await fs.writeFile(codePath, "export const compiler = true;\n", "utf8");
    await expect(prepareSourceLoopFromInput(root, `@${codePath}`)).resolves.toBeNull();
  });
});
