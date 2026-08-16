import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NWH_WORKING_FRAMES } from "./nwh-welcome.js";

export type NwhModelLoadingPhase = "waiting" | "thinking" | "streaming" | "tool";

export const NWH_MODEL_LOADING_MESSAGES: Record<NwhModelLoadingPhase, readonly string[]> = {
  waiting: [
    "正在翻阅世界档案…",
    "正在梳理人物与时间线…",
    "正在核对当前上下文…",
    "正在寻找可靠的回答路径…",
    "正在把线索放回故事里…",
  ],
  thinking: [
    "正在沿着因果关系推演…",
    "正在区分事实与可能性…",
    "正在整理回答的结构…",
    "正在检查有没有遗漏线索…",
  ],
  streaming: [
    "回答正在抵达…",
    "正在把思路写成回应…",
    "正在组织清晰的表达…",
    "正在继续输出内容…",
  ],
  tool: [
    "正在检查所需证据…",
    "正在执行必要步骤…",
    "正在等待工具返回…",
  ],
};

const PHASE_LABELS: Record<NwhModelLoadingPhase, string> = {
  waiting: "模型正在思考",
  thinking: "模型正在推演",
  streaming: "模型正在输出",
  tool: "模型正在调用工具",
};

export function chooseNwhModelLoadingMessage(
  phase: NwhModelLoadingPhase,
  random: () => number = Math.random,
  previous?: string,
): string {
  const pool = NWH_MODEL_LOADING_MESSAGES[phase];
  const sampled = Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)));
  if (pool[sampled] !== previous || pool.length === 1) return pool[sampled]!;
  return pool[(sampled + 1) % pool.length]!;
}

type LoadingUi = Pick<ExtensionContext["ui"], "setWidget" | "theme">;

export type NwhModelLoadingIndicator = {
  setPhase(phase: NwhModelLoadingPhase, detail?: string): void;
  stop(): void;
};

export function createNwhModelLoadingIndicator(
  ui: LoadingUi,
  options: {
    random?: () => number;
    intervalMs?: number;
    messageTicks?: number;
  } = {},
): NwhModelLoadingIndicator {
  const random = options.random ?? Math.random;
  const intervalMs = options.intervalMs ?? 180;
  const messageTicks = options.messageTicks ?? 12;
  let phase: NwhModelLoadingPhase = "waiting";
  let detail: string | undefined;
  let frameIndex = 0;
  let ticks = 0;
  let message = chooseNwhModelLoadingMessage(phase, random);
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const frame = NWH_WORKING_FRAMES[frameIndex % NWH_WORKING_FRAMES.length] ?? NWH_WORKING_FRAMES[0];
    const detailText = detail ? ` · ${detail}` : "";
    const pet = ui.theme.fg("accent", frame);
    const status = ui.theme.fg("dim", `${PHASE_LABELS[phase]} · ${message}${detailText} · Esc 可中止`);
    ui.setWidget("nwh-model-loading", [`${pet}  ${status}`], { placement: "aboveEditor" });
  };

  render();
  const timer = setInterval(() => {
    if (stopped) return;
    ticks += 1;
    frameIndex = (frameIndex + 1) % NWH_WORKING_FRAMES.length;
    if (ticks % messageTicks === 0) message = chooseNwhModelLoadingMessage(phase, random, message);
    render();
  }, intervalMs);
  timer.unref();

  return {
    setPhase(nextPhase, nextDetail) {
      if (stopped) return;
      const changed = nextPhase !== phase;
      const detailChanged = nextDetail !== detail;
      if (!changed && !detailChanged) return;
      phase = nextPhase;
      detail = nextDetail;
      if (changed) {
        ticks = 0;
        message = chooseNwhModelLoadingMessage(phase, random, message);
      }
      render();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      ui.setWidget("nwh-model-loading", undefined, { placement: "aboveEditor" });
    },
  };
}
