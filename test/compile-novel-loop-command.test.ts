import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as supervisor from "../src/runtime/compile-loop/supervisor.js";
import * as compiler from "../src/commands/compile-novel.js";
import { compileNovelWithLoop } from "../src/commands/compile-novel-loop.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it("the ordinary full command enters supervision with the exact registered immutable source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-loop-command-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "A character waits by the door.");
  const run = vi.spyOn(supervisor, "runCompileLoop").mockResolvedValue({ phase: "DONE" } as never);
  const direct = vi.spyOn(compiler, "compileNovelCommand").mockRejectedValue(new Error("must use supervision"));
  await compileNovelWithLoop({ root, sourceId: source.id, model: "openai-codex/gpt-6.1-sol" });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ sourceHash: source.contentSha256,
    engineerModel: "gpt-5.6-sol", request: expect.objectContaining({ sourceId: source.id, model: "openai-codex/gpt-6.1-sol" }) }));
  expect(direct).not.toHaveBeenCalled();
});
it.each([{ phase: "status" as const }, { phase: "roles" as const }, { loop: false }])("%j keeps explicit single-invocation semantics", async selection => {
  const run = vi.spyOn(supervisor, "runCompileLoop").mockRejectedValue(new Error("must not start supervision"));
  const direct = vi.spyOn(compiler, "compileNovelCommand").mockResolvedValue(undefined);
  await compileNovelWithLoop({ root: "/unused", sourceId: "source-1", ...selection });
  expect(direct).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
});
