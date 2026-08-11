import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markSourceLoopBatchComplete,
  parseStandaloneSourcePath,
  prepareNextSourceLoopTurn,
  prepareSourceLoopFromInput,
} from "../src/compiler/source-loop.js";

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
    await expect(fs.stat(path.join(root, ".novel-harness", "sources", `${first.source.id}.json`))).resolves.toBeDefined();

    await markSourceLoopBatchComplete(root, first.source.id, first.batch.id);
    const second = await prepareNextSourceLoopTurn(root, first.source.id);
    expect(second?.status).toBe("ready");
    if (!second || second.status !== "ready") throw new Error("expected second compiler turn");
    expect(second.completedBatches).toBe(1);
    expect(second.batch.id).not.toBe(first.batch.id);

    await markSourceLoopBatchComplete(root, second.source.id, second.batch.id);
    await expect(prepareNextSourceLoopTurn(root, second.source.id)).resolves.toMatchObject({
      status: "complete",
      source: { id: second.source.id },
    });
  });

  it("leaves ordinary conversation input unchanged", async () => {
    const { root } = await fixture();
    await expect(prepareSourceLoopFromInput(root, "请分析刘备的角色目标")).resolves.toBeNull();
  });

  it("does not turn a standalone source-code attachment into a novel compiler loop", async () => {
    const { root } = await fixture();
    const codePath = path.join(root, "compiler.ts");
    await fs.writeFile(codePath, "export const compiler = true;\n", "utf8");
    await expect(prepareSourceLoopFromInput(root, `@${codePath}`)).resolves.toBeNull();
  });
});
