export const NWH_DOUBLE_CTRL_C_WINDOW_MS = 2_000;

export type NwhCtrlCDecision = "arm" | "exit";

export class NwhDoubleCtrlCExit {
  private armedAt: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = NWH_DOUBLE_CTRL_C_WINDOW_MS,
  ) {}

  press(): NwhCtrlCDecision {
    const pressedAt = this.now();
    if (
      this.armedAt !== undefined
      && pressedAt >= this.armedAt
      && pressedAt - this.armedAt <= this.windowMs
    ) {
      this.armedAt = undefined;
      return "exit";
    }
    this.armedAt = pressedAt;
    return "arm";
  }
}

