import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/load.js";
import { createPiSessionFactory } from "../llm/pi-session.js";

const SYSTEM_PROMPT = `You are the terminal shell for Novel World Harness.
The executable world runtime is not yet enabled in Phase 0. Do not invent or mutate world state.
Help the developer inspect the architecture, configuration, and next implementation work.
When asked to role-play a novel character, explain that canon state replay must be implemented first.`;

export async function playCommand(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const pi = await createPiSessionFactory(config);
  const session = await pi.create("narrator", SYSTEM_PROMPT);

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output.write(event.assistantMessageEvent.delta);
    }
  });

  const rl = readline.createInterface({ input, output });
  console.log("Novel World Harness interactive shell (Phase 0). Type /exit to quit.");
  try {
    while (true) {
      const line = (await rl.question("\nnwh> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      await session.prompt(line);
      output.write("\n");
    }
  } finally {
    rl.close();
  }
}
