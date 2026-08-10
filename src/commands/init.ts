import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOVEL_INSTRUCTIONS = `# Novel workspace

## Goal

Describe the novel or world this workspace represents and the current compilation goal.

## Sources

- Put source chapters or scenes in a clear local directory.
- Record edition, translation, and canon boundaries here.

## Terminology

- Add canonical character, location, faction, and artifact names.
- Record aliases that must not be merged.

## Harness constraints

- Source evidence is authoritative.
- Separate world truth from what each character knows.
- Treat model output as a proposal until it is validated and committed.
`;

async function createIfMissing(destination: string, content: string): Promise<void> {
  try {
    await fs.writeFile(destination, content, { encoding: "utf8", flag: "wx" });
    console.log(`Created ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.log(`${destination} already exists; left unchanged.`);
      return;
    }
    throw error;
  }
}

export async function initCommand(target = process.cwd()): Promise<void> {
  const root = path.resolve(target);
  await fs.mkdir(root, { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, "../../config.example.yaml");
  const config = await fs.readFile(source, "utf8");
  await createIfMissing(path.join(root, "novel-harness.yaml"), config);
  await createIfMissing(path.join(root, "NOVEL.md"), NOVEL_INSTRUCTIONS);
}
