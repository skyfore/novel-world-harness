import { describe, expect, it } from "vitest";
import {
  buildCharacterLexicon,
  buildLexicalInventory,
  scanNameOccurrences,
  scanSpeechSpans,
} from "../src/compiler/lexical-inventory.js";

const entities = [
  { id: "lu", kind: "character", canonicalName: "路明非", aliases: ["明非", "李嘉图·M·路"] },
  { id: "nono", kind: "character", canonicalName: "陈墨瞳", aliases: ["诺诺"] },
  { id: "caesar", kind: "character", canonicalName: "恺撒·加图索", aliases: ["索尼克"] },
  { id: "man", kind: "character", canonicalName: "男人", aliases: [] },
  { id: "aki-1", kind: "character", canonicalName: "酒德亚纪", aliases: ["亚纪"] },
  { id: "aki-2", kind: "character", canonicalName: "亚纪", aliases: [] },
  { id: "ship", kind: "artifact", canonicalName: "摩尼亚赫号", aliases: [] },
];
const mention = (id: string, surface: string, form = "proper") => ({ annotationType: "entity-mention", id, surface, form });
const resolution = (id: string, mentionId: string, entityId: string) => ({ id, mentionId, status: "resolved", entityId });
const annotations = [
  mention("m1", "路明非"), mention("m2", "诺诺"), mention("m3", "恺撒"), mention("m4", "男人", "nominal"),
  mention("m5", "亚纪"), mention("m6", "亚纪"), mention("m7", "酒德亚纪"), mention("m8", "摩尼亚赫号"),
];
const entityResolutions = [
  resolution("r1", "m1", "lu"), resolution("r2", "m2", "nono"), resolution("r3", "m3", "caesar"), resolution("r4", "m4", "man"),
  resolution("r5", "m5", "aki-1"), resolution("r6", "m6", "aki-2"), resolution("r7", "m7", "aki-1"), resolution("r8", "m8", "ship"),
];
const bytes = (text: string) => Buffer.from(text, "utf8");
const slice = (source: Buffer, start: number, end: number) => source.subarray(start, end).toString("utf8");

describe("lexical inventory", () => {
  it("separates direct speech from quoted terms and keeps multi-paragraph quotations open", () => {
    const source = bytes("\t“你好。”路明非说。\n\t背后“啪”的一声。\n\t所谓“龙墓”之说。\n\t“这是第一段，\n\t“这是第二段。”\n");
    const spans = scanSpeechSpans(source);
    expect(spans.map((span) => [slice(source, span.startByte, span.endByte), span.kind, span.closed])).toEqual([
      ["“你好。”", "speech", true],
      ["“啪”", "embedded", true],
      ["“龙墓”", "embedded", true],
      ["“这是第一段，", "speech", false],
      ["“这是第二段。”", "speech", true],
    ]);
  });

  it("only matches proper names attested by resolved mentions, never generic nouns or shared names", () => {
    const lexicon = buildCharacterLexicon({ entities, annotations, entityResolutions });
    expect(lexicon.entries.map((entry) => `${entry.surface}:${entry.entityId}`)).toEqual([
      "恺撒:caesar", "恺撒·加图索:caesar", "明非:lu", "诺诺:nono", "路明非:lu", "酒德亚纪:aki-1",
    ]);
    expect(lexicon.collisions).toEqual([{ surface: "亚纪", entityIds: ["aki-1", "aki-2"] }]);
    const source = bytes("路明非和恺撒·加图索见到了那个男人，明非说亚纪来了。");
    expect(scanNameOccurrences(source, lexicon).map((item) => `${slice(source, item.startByte, item.endByte)}:${item.entityId}`))
      .toEqual(["路明非:lu", "恺撒·加图索:caesar", "明非:lu"]);
  });

  it("attributes speakers from post-cues, pre-cues and continuations, and abstains when unsure", () => {
    const text = [
      "\t“你看他神不守舍的。”诺诺说，“估计会走错。”",
      "\t恺撒双手展开：“卡塞尔学院，恺撒·加图索。”",
      "\t“我也是。”他说。",
      "\t路明非抬头，看见恺撒伸出手，“请上来。”",
      "\t“滚！”路明非的手机响了。",
      "\t路明非愣住了。“你说什么？”",
      "\t“是啊！”恺撒点头。",
    ].join("\n");
    const source = bytes(text);
    const inventory = buildLexicalInventory({ source, entities, annotations, entityResolutions });
    expect(inventory.cues.map((cue) => [slice(source, cue.speechStartByte, cue.speechEndByte), cue.entityId, cue.rule, slice(source, cue.cueStartByte, cue.cueEndByte)])).toEqual([
      ["“你看他神不守舍的。”", "nono", "post-cue", "诺诺"],
      ["“估计会走错。”", "nono", "continuation", "诺诺"],
      ["“卡塞尔学院，恺撒·加图索。”", "caesar", "pre-cue", "恺撒"],
      ["“是啊！”", "caesar", "post-cue", "恺撒"],
    ]);
    expect(inventory.speech.filter((span) => span.kind === "speech")).toHaveLength(8);
  });

  it("reports exact UTF-8 byte offsets around astral characters", () => {
    const source = bytes("𠀀“好。”路明非说。");
    const [span] = scanSpeechSpans(source);
    expect(span!.startByte).toBe(4);
    expect(slice(source, span!.startByte, span!.endByte)).toBe("“好。”");
    const inventory = buildLexicalInventory({ source, entities, annotations, entityResolutions });
    expect(slice(source, inventory.cues[0]!.cueStartByte, inventory.cues[0]!.cueEndByte)).toBe("路明非");
  });
});
