import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default async function setup(): Promise<() => Promise<void>> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-vitest-home-"));
  process.env.NWH_HOME = runtimeRoot;
  return async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  };
}
