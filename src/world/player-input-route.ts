import type { PlayOpeningFrame } from "./play-opening.js";

export type PlayerInputRoute = "in-world" | "meta";

/** World text is never semantically classified by host code. Leaving the
 * fiction is an explicit UI protocol (`/ooc`), independent of language. */
export function classifyPlayerInput(value: string): PlayerInputRoute {
  const text = value.normalize("NFKC").trim();
  const lower = text.toLocaleLowerCase();
  return lower === "/ooc"
    || lower.startsWith("/ooc ")
    || lower.startsWith("/ooc:")
    ? "meta"
    : "in-world";
}

export function renderPlayerMetaResponse(frame: PlayOpeningFrame, question: string): string {
  const storyTime = [...frame.recentVisibleEvents].reverse().find((event) => event.storyTime)?.storyTime;
  const time = storyTime ? formatStoryTime(storyTime) : "原作证据没有给出更精确的可见时间";
  const location = frame.scene.label
    ?? frame.presentEntities.find((entity) => entity.kind === "location")?.name
    ?? "尚未被 committed state 精确命名的场景";
  const threads = frame.activeThreads.length
    ? frame.activeThreads.slice(0, 3).map((thread) => `“${thread.summary}”`).join("；")
    : "暂无对角色可见的活动线程";
  return [
    `这是场外查询，不会作为 ${frame.actor.name} 的行动提交，也不会推进时间。`,
    `当前分支停在 committed step ${frame.logicalStep}；可见故事时间为${time}，所在场景是${location}。`,
    `当前可感知的牵引是：${threads}。系统只说明已经提交且对角色可见的内容，不会用未来 canon 回答“接下来必然发生什么”。`,
    question.trim().startsWith("/") ? "若要继续角色行动，直接输入行动；若要退出扮演模式，使用 /leave。" : "你可以继续追问场外状态，也可以直接描述下一步角色行动。",
  ].join("\n\n");
}

function formatStoryTime(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "未知";
  const time = value as Record<string, unknown>;
  if (time.kind === "exact") return ` ${String(time.value)}`;
  if (time.kind === "range") return ` ${String(time.earliest)} 至 ${String(time.latest)}`;
  if (time.kind === "ordinal") return ` ${String(time.label)}`;
  if (time.kind === "relative") return `相对于事件 ${String(time.anchorEventId)} 的${String(time.relation)}`;
  return "未知";
}
