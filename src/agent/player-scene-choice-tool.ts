import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";

const OUT_OF_WORLD_CHOICE_LANGUAGE = /(?:玩家|选项|剧情|故事线|支线|任务线程|世界(?:状态|条件)|已提交|可回放|语言模型|\bllm\b|\bsystem\b|\bcommitted\b|\baffordance\b)/iu;
const ABSTRACT_CHOICE_LANGUAGE = /(?:如何(?:回应|处理).{0,20}关系|重新界定.{0,20}关系方向|落实.{0,20}接触计划|离开原地寻找新接触点|选定处理当前局势的立场|把既定立场变成实际行动|迫使当前分歧进入决定阶段|换一个方向建立支线|确定一个可执行目标|让压力先走一步|确定.{0,30}(?:接触方式|关系方向)|(?:决定|考虑|思考|确定)(?:一下)?(?:下一步|如何).{0,20}(?:做|行动|处理|回应)|(?:采取|开始|落实)(?:下一步|具体|实际)?行动|推进(?:当前)?(?:局势|关系|任务)|寻找.{0,30}(?:能让当前局势|接触点|支线)|建立(?:新的?)?支线|关系方向|可执行目标)/u;

export const playerSceneChoiceSchema = z.object({
  action: z.string().trim().min(2).max(240),
}).strict().superRefine((choice, ctx) => {
  if (OUT_OF_WORLD_CHOICE_LANGUAGE.test(choice.action)) {
    ctx.addIssue({
      code: "custom",
      path: ["action"],
      message: "A player choice must stay in character and must not expose story, system, or world-model terminology.",
    });
  }
  if (ABSTRACT_CHOICE_LANGUAGE.test(choice.action)) {
    ctx.addIssue({
      code: "custom",
      path: ["action"],
      message: "A player choice must be a concrete immediate act or spoken line, not an abstract direction or plan category.",
    });
  }
});

export const playerSceneChoicesSchema = z.object({
  choices: z.array(playerSceneChoiceSchema).min(2).max(4),
}).strict().superRefine(({ choices }, ctx) => {
  const seen = new Set<string>();
  choices.forEach((choice, index) => {
    const normalized = choice.action.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    if (seen.has(normalized)) {
      ctx.addIssue({ code: "custom", path: ["choices", index, "action"], message: "Player choices must be distinct." });
    }
    seen.add(normalized);
  });
});

export type PlayerSceneChoice = z.infer<typeof playerSceneChoiceSchema>;

export type PlayerSceneChoiceCaptureTool = {
  tool: ToolDefinition;
  getChoices(): PlayerSceneChoice[];
  getExecutionAttempts(): number;
  reset(): void;
};

function prepareArguments(value: unknown): z.infer<typeof playerSceneChoicesSchema> {
  if (typeof value !== "string") return value as z.infer<typeof playerSceneChoicesSchema>;
  try {
    return JSON.parse(value) as z.infer<typeof playerSceneChoicesSchema>;
  } catch {
    throw new Error("Scene-choice tool arguments must be valid JSON.");
  }
}

/**
 * A capture-only sink for suggested player utterances. The tool has no world,
 * file, store, or commit access. Suggestions are not capabilities or world
 * proposals: selecting one still enters the ordinary player-action translation
 * and deterministic validation pipeline.
 */
export function createPlayerSceneChoiceCaptureTool(): PlayerSceneChoiceCaptureTool {
  let choices: PlayerSceneChoice[] = [];
  let captured = false;
  let executionAttempts = 0;
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(playerSceneChoicesSchema);
  const parameters = Type.Unsafe<z.infer<typeof playerSceneChoicesSchema>>(jsonSchema as TSchema);
  const tool = defineTool({
    name: "propose_player_choices",
    label: "Propose player choices",
    description: "Capture 2-4 concrete actor-grounded actions or spoken lines. These are suggestions only and cannot commit or mutate world truth.",
    promptSnippet: "After the streamed scene prose, capture concrete in-character actions or dialogue",
    promptGuidelines: [
      "Base every choice only on the supplied committed actor frame.",
      "Write the exact immediate action or spoken line the actor could perform now; do not write labels, explanations, outcomes, or abstract directions.",
      "Use behavioralContext as characterization guidance only. Never expose its trait, bias, or goal metadata in a choice.",
      "Never predict another character's response, invent an entity, or duplicate a choice.",
    ],
    parameters,
    prepareArguments,
    async execute(_id, input, signal) {
      executionAttempts += 1;
      signal?.throwIfAborted();
      if (captured) throw new Error("Only one scene-choice set may be captured per narration attempt.");
      const parsed = playerSceneChoicesSchema.parse(input);
      choices = structuredClone(parsed.choices);
      captured = true;
      return {
        content: [{
          type: "text" as const,
          text: "Concrete player choices captured. End the response now without adding more narration.",
        }],
        details: { captured: choices.length },
      };
    },
  });
  return {
    tool,
    getChoices: () => structuredClone(choices),
    getExecutionAttempts: () => executionAttempts,
    reset() {
      choices = [];
      captured = false;
      executionAttempts = 0;
    },
  };
}
