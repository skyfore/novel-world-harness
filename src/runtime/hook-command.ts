import { Command } from "commander";
import { currentRuntimeHooks } from "./hooks.js";

/** Commander keeps parsing/dispatch; hooks surround only the selected action. */
export class HookCommand extends Command {
  override createCommand(name?: string): Command { return new HookCommand(name); }
  override action(handler: (...args: any[]) => void | Promise<void>): this {
    return super.action(async (...args: any[]) => {
      const names: string[] = [];
      for (let command: Command | null = this; command; command = command.parent) names.unshift(command.name());
      await currentRuntimeHooks().run("command", names.join(" "), { workspaceRoot: this.optsWithGlobals().root },
        async () => { await handler.apply(this, args); });
    });
  }
}
