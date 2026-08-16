import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NwhInteractionMode } from "./nwh-extension.js";

export const NWH_WORKING_FRAMES = ["(o,o)", "(O,o)", "(o,O)", "(o,o)"];

const EYE_FRAMES = ["o,o", "o,o", "-,-", "o,o", "o,O", "o,o"];
const ANIMATION_INTERVAL_MS = 420;
const ANIMATION_TICKS = 12;

export type NwhWelcomeOptions = {
  mode: NwhInteractionMode;
  freshConversation: boolean;
};

type ConversationEntry = {
  type: string;
  message?: { role?: string; customType?: string; display?: boolean };
  customType?: string;
  display?: boolean;
};

export function isFreshConversation(entries: readonly ConversationEntry[]): boolean {
  return !entries.some((entry) => {
    if (entry.type === "message") {
      if (entry.message?.role === "user" || entry.message?.role === "assistant") return true;
      return entry.message?.role === "custom" && entry.message.display !== false;
    }
    if (entry.type === "custom_message") return entry.display !== false;
    return entry.type === "compaction" || entry.type === "branch_summary";
  });
}

/**
 * Player input is intercepted before Pi appends a normal user message, then
 * persisted as `nwh-play`; narrator prose is persisted as `nwh-narrator`.
 * Those custom entries therefore are the durable signal that a transcript
 * already contains world context. Looking only for `role=user` misclassifies a
 * long-running player transcript as new and launches a duplicate narrator.
 */
export function hasPlayerConversation(entries: readonly ConversationEntry[]): boolean {
  return entries.some((entry) => {
    const customType = entry.type === "custom_message" ? entry.customType : entry.message?.customType;
    return customType === "nwh-play" || customType === "nwh-narrator";
  });
}

type RenderRequester = {
  requestRender(): void;
};

function copyLines(options: NwhWelcomeOptions): string[] {
  const subtitle = options.mode === "compiler"
    ? "Evidence-backed compiler proposals"
    : "Evidence-backed stories, executable worlds";

  if (!options.freshConversation) {
    return [
      "NWH  Novel World Harness",
      subtitle,
      options.mode === "compiler"
        ? "Welcome back. Continue the compiler task or type /status."
        : "Welcome back. Use /continue for the latest saved world, /switch to change worlds, or /status for details.",
      "Use /help whenever you need the command map.",
      "",
    ];
  }

  if (options.mode === "compiler") {
    return [
      "NWH  Novel World Harness",
      subtitle,
      "1  Sign in with /login, then choose with /model",
      "2  Paste a novel path to start the world compiler loop",
      "3  Continue with /compile-next; /help shows every command",
    ];
  }

  return [
    "NWH  Novel World Harness",
    subtitle,
    "1  Sign in with /login, then choose with /model",
    "2  /novels, /instances and /characters show what is ready",
    "3  /play or /continue enters a world; paste a novel path to compile",
  ];
}

export function renderNwhWelcome(
  theme: Pick<Theme, "bold" | "fg">,
  options: NwhWelcomeOptions,
  frameIndex: number,
  width: number,
): string[] {
  const eyes = EYE_FRAMES[frameIndex % EYE_FRAMES.length] ?? EYE_FRAMES[0];
  const copy = copyLines(options);

  if (width < 48) {
    const freshHint = options.mode === "compiler" ? "/login -> /model" : "/continue, /switch, or paste a novel";
    const returningHint = options.mode === "compiler" ? "Continue compiler. /status" : "Welcome back. /continue · /switch · /create-instance";
    return [
      `${theme.fg("accent", `(${eyes})`)} ${theme.bold("NWH")}`,
      theme.fg("muted", options.freshConversation ? freshHint : returningHint),
      theme.fg("dim", options.freshConversation ? "paste novel path -> compile" : "/help for commands"),
    ];
  }

  if (width < 78) {
    return [
      `${theme.fg("accent", `(${eyes})`)}  ${theme.bold(copy[0] ?? "NWH")}`,
      theme.fg("muted", copy[1] ?? ""),
      ...copy.slice(2).filter(Boolean).map((line) => theme.fg("dim", line)),
    ];
  }

  const mascot = [
    "     ,_,   ",
    `    (${eyes})  `,
    "    /)__)  ",
    "     \" \"   ",
    "           ",
  ];

  return mascot.map((line, index) => {
    const text = copy[index] ?? "";
    const styled = index === 0
      ? theme.bold(theme.fg("accent", text))
      : index === 1
        ? theme.fg("muted", text)
        : theme.fg("dim", text);
    return `${theme.fg("accent", line)} ${styled}`.trimEnd();
  });
}

export function createNwhWelcomeHeader(
  tui: RenderRequester,
  theme: Pick<Theme, "bold" | "fg">,
  options: NwhWelcomeOptions,
) {
  let frameIndex = 0;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  timer = setInterval(() => {
    ticks += 1;
    frameIndex = (frameIndex + 1) % EYE_FRAMES.length;
    if (ticks >= ANIMATION_TICKS) {
      frameIndex = 0;
      stop();
    }
    tui.requestRender();
  }, ANIMATION_INTERVAL_MS);
  timer.unref();

  return {
    render(width: number): string[] {
      return renderNwhWelcome(theme, options, frameIndex, width);
    },
    invalidate() {},
    dispose: stop,
  };
}
