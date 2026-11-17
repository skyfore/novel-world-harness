import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const HARNESS_INSTRUCTIONS = `# Novel World Harness workspace

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
  const config = YAML.stringify({
    version: 1,
    project: {
      name: path.basename(root) || "novel-world",
      language: "zh-CN",
      instructions: ["NWH.md"],
    },
  });
  await createIfMissing(path.join(root, "novel-harness.yaml"), config);
  await createIfMissing(path.join(root, "NWH.md"), HARNESS_INSTRUCTIONS);
}
