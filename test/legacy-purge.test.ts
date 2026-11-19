import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeLegacyPurge, planLegacyPurge } from "../src/application/legacy-purge.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function write(file: string, content = "x") { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }

describe("legacy purge", () => {
  it("previews old namespaces, caches, loop records, pre-cutover traces and temporary workspaces, and never touches sources or archives", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-purge-")); roots.push(home);
    const main = path.join(home, "workspaces", "v1", "novel-abc");
    await write(path.join(main, "project.json"), "{}");
    await write(path.join(main, "sources", "registry.json"));
    await write(path.join(main, "world", "v3", "canon", "a.json"), "old world");
    await write(path.join(main, "compile-loops", "x", "state.json"));
    await write(path.join(main, "observability", "v1", "runs", "2026-09", "run-old", "manifest.json"));
    await write(path.join(main, "observability", "v1", "runs", "2026-12", "run-new", "manifest.json"));
    const keptBlob = "a".repeat(64), oldBlob = "b".repeat(64);
    await write(path.join(main, "observability", "v1", "runs", "2026-12", "run-new", "events.jsonl"), `{"blobRef":{"sha256":"${keptBlob}"}}\n`);
    await write(path.join(main, "observability", "v1", "blobs", "sha256", "aa", `${keptBlob}.json`), "{}");
    await write(path.join(main, "observability", "v1", "blobs", "sha256", "bb", `${oldBlob}.json`), "{}");
    await write(path.join(main, "observability", "v1", "indexes", "runs.json"), JSON.stringify({ version: 1, runs: [
      { id: "run-old", relativePath: "runs/2026-09/run-old", startedAt: "2026-09-01T00:00:00.000Z", kind: "prepare", status: "succeeded" },
      { id: "run-new", relativePath: "runs/2026-12/run-new", startedAt: "2999-01-01T00:00:00.000Z", kind: "prepare", status: "succeeded" },
    ] }));
    await write(path.join(main, "world", "v4", "compiler", "pipeline", "v1", "x.json"), "current");
    const temporary = path.join(home, "workspaces", "v1", "diag-tmp");
    await write(path.join(temporary, "world", "v3", "a.json"));
    await write(path.join(home, "prepared-novels", "v3", "bundle.json"), "old cache");
    await write(path.join(home, "prepared-novels", "v4", "bundle.json"), "current cache");
    await write(path.join(home, "sources", "v1", "abc", "source.utf8"), "immutable");
    await write(path.join(home, "archives", "novel-abc", "legacy-reference", "pack", "manifest.json"), "{}");

    const plan = await planLegacyPurge({ runtimeDir: home });
    expect(plan.items.map((item) => [item.kind, path.relative(home, item.path)]).sort()).toEqual([
      ["compile-loops", "workspaces/v1/novel-abc/compile-loops"],
      ["prepared-cache", "prepared-novels/v3"],
      ["temporary-workspace", "workspaces/v1/diag-tmp"],
      ["trace-runs", "workspaces/v1/novel-abc/observability/v1"],
      ["world-namespace", "workspaces/v1/novel-abc/world/v3"],
    ].sort());
    expect(plan.items.find((item) => item.kind === "trace-runs")!.runIds).toEqual(["run-old"]);
    // Preview deleted nothing; a stale hash refuses to execute.
    expect(await fs.readFile(path.join(main, "world", "v3", "canon", "a.json"), "utf8")).toBe("old world");
    await expect(executeLegacyPurge("0".repeat(64), { runtimeDir: home })).rejects.toThrow("LEGACY_PURGE_PLAN_CHANGED");

    const result = await executeLegacyPurge(plan.planHash, { runtimeDir: home });
    expect(result.removed).toHaveLength(5);
    for (const gone of ["workspaces/v1/novel-abc/world/v3", "workspaces/v1/novel-abc/compile-loops", "workspaces/v1/diag-tmp", "prepared-novels/v3", "workspaces/v1/novel-abc/observability/v1/runs/2026-09/run-old"]) {
      await expect(fs.access(path.join(home, gone))).rejects.toThrow();
    }
    for (const kept of ["sources/v1/abc/source.utf8", "archives/novel-abc/legacy-reference/pack/manifest.json", "workspaces/v1/novel-abc/world/v4/compiler/pipeline/v1/x.json",
      "prepared-novels/v4/bundle.json", "workspaces/v1/novel-abc/project.json", "workspaces/v1/novel-abc/observability/v1/runs/2026-12/run-new/manifest.json"]) {
      await expect(fs.access(path.join(home, kept))).resolves.toBeUndefined();
    }
    await expect(fs.access(path.join(main, "observability", "v1", "blobs", "sha256", "aa", `${keptBlob}.json`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(main, "observability", "v1", "blobs", "sha256", "bb", `${oldBlob}.json`))).rejects.toThrow();
    const index = JSON.parse(await fs.readFile(path.join(main, "observability", "v1", "indexes", "runs.json"), "utf8")) as { runs: Array<{ id: string }> };
    expect(index.runs.map((run) => run.id)).toEqual(["run-new"]);
    // Idempotent: nothing left to purge.
    expect((await planLegacyPurge({ runtimeDir: home })).items).toEqual([]);
  });
});
