export type ElapsedStatusOptions = {
  label: string;
  activity: string;
  onStatus?: (message: string) => void;
  onHeartbeat?: (message: string) => void;
  statusIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

export type ElapsedStatus = {
  update(activity: string): void;
  stop(activity?: string): void;
};

export function startElapsedStatus(options: ElapsedStatusOptions): ElapsedStatus {
  const sink = options.onStatus ?? options.onHeartbeat;
  if (!sink) return { update() {}, stop() {} };

  const startedAt = Date.now();
  let activity = options.activity;
  let stopped = false;
  const render = () => `${options.label} · ${activity} · elapsed ${formatElapsed(Date.now() - startedAt)}`;
  const emit = () => sink(render());
  emit();
  const intervalMs = options.onStatus
    ? (options.statusIntervalMs ?? 1_000)
    : (options.heartbeatIntervalMs ?? 15_000);
  const timer = setInterval(emit, intervalMs);
  timer.unref();

  return {
    update(nextActivity) {
      if (stopped) return;
      // Streaming providers can deliver reasoning and text one token at a
      // time. Re-emitting an unchanged activity for every delta floods a
      // non-interactive terminal without conveying new progress; the timer
      // already supplies the elapsed heartbeat.
      if (nextActivity === activity) return;
      activity = nextActivity;
      emit();
    },
    stop(finalActivity) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (finalActivity) {
        activity = finalActivity;
        emit();
      }
    },
  };
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
