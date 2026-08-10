import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function initCommand(target = process.cwd()): Promise<void> {
  const root = path.resolve(target);
  await fs.mkdir(root, { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, "../../config.example.yaml");
  const destination = path.join(root, "novel-harness.yaml");
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    console.log(`Created ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.log(`${destination} already exists; left unchanged.`);
      return;
    }
    throw error;
  }
}
