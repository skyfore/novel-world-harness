import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceSessionDir } from "../src/agent/runtime-paths.js";

describe("NWH runtime paths", () => {
  it("stores workspace sessions below the user runtime directory", () => {
    const runtimeDir = path.resolve("/tmp/nwh-user-runtime");
    const sessionDir = workspaceSessionDir("/projects/story", runtimeDir);

    expect(path.dirname(path.dirname(sessionDir))).toBe(runtimeDir);
    expect(path.basename(sessionDir)).toMatch(/^story-[a-f0-9]{12}$/);
  });

  it("keeps workspaces with the same basename isolated", () => {
    const runtimeDir = path.resolve("/tmp/nwh-user-runtime");

    expect(workspaceSessionDir("/projects/one/story", runtimeDir))
      .not.toBe(workspaceSessionDir("/projects/two/story", runtimeDir));
  });
});
