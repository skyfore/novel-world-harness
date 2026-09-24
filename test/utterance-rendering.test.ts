import { expect, it } from "vitest";
import { committedUtteranceId, renderNarrationBlocks, type LockedUtterance } from "../src/world/utterance-rendering.js";

it.each([
  { event: "ada-at-the-gate", names: ["Ada", "Bo"], words: ["Wait.", "Please. Wait.", "Wait."] },
  { event: "neri-in-the-hall", names: ["Venn", "Neri"], words: ["别走。", "她说：“别走。”", "别走。"] },
])("preserves ordered repeated and nested speech by identity: $event", scene => {
  const locked: LockedUtterance[] = scene.words.map((text, index) => ({ utteranceId: committedUtteranceId(scene.event, index), speaker: scene.names[index % 2]!, addressees: [], text, mode: "verbatim" }));
  const speech = locked.map(item => ({ kind: "committed-utterance", utteranceId: item.utteranceId }));
  const document = (blocks: unknown[]) => ({ version: "narration-blocks-v1", blocks });
  const prose = { kind: "prose", text: "A hinge moved in the silence.\n" };
  const exact = `${prose.text}${scene.words.join("")}`;
  expect(renderNarrationBlocks(document([prose, ...speech]), locked)).toBe(exact);
  expect(new Set(locked.map(item => item.utteranceId)).size).toBe(3);
  expect(committedUtteranceId(scene.event, 0)).toBe(locked[0]!.utteranceId);
  expect(() => renderNarrationBlocks(document([...speech].reverse()), locked)).toThrow("out-of-order");
  expect(() => renderNarrationBlocks(document(speech.slice(0, 2)), locked)).toThrow("omitted");
  expect(() => renderNarrationBlocks(document([speech[0], ...speech]), locked)).toThrow("duplicate");
  expect(() => renderNarrationBlocks(document([{ kind: "committed-utterance", utteranceId: "guessed" }]), locked)).toThrow("unknown");
  expect(() => renderNarrationBlocks(document([{ kind: "prose", text: `echo ${scene.words[0]}` }, ...speech]), locked)).toThrow("overlapping short utterance");
  expect(() => renderNarrationBlocks(document([{ kind: "prose", text: scene.words[0]!.slice(0, 1) }, { kind: "prose", text: scene.words[0]!.slice(1) }, ...speech]), locked)).toThrow("overlapping short utterance");
  expect(() => renderNarrationBlocks(document([{ kind: "prose", text: locked[0]!.utteranceId }, ...speech]), locked)).toThrow("internal utterance ID");
  expect(() => renderNarrationBlocks(document(speech), [{ ...locked[0]!, utteranceId: undefined }])).toThrow("host frame review");
  expect(() => renderNarrationBlocks(document(speech), [locked[0]!, locked[0]!])).toThrow("host frame review");
});

it("does not mistake two legitimate long utterances for duplicate prose paragraphs", async () => {
  const { settlePlaySceneNarration } = await import("../src/world/play-opening.js");
  const text = "The bridge is closed. The last cart crossed before sunset, and the guards have carried the chains back into the tower.";
  const locked: LockedUtterance[] = [0, 1].map(index => ({ utteranceId: committedUtteranceId("guard-report", index), speaker: "Ada", addressees: ["Bo"], text, mode: "verbatim" }));
  const blocks = { version: "narration-blocks-v1" as const, blocks: [
    { kind: "committed-utterance" as const, utteranceId: locked[0]!.utteranceId! },
    { kind: "prose" as const, text: "\n\n" },
    { kind: "committed-utterance" as const, utteranceId: locked[1]!.utteranceId! },
  ] };
  const frame = { actor: { name: "Ada" }, narrativeContract: { person: "third" as const, focalCharacter: "Ada", narratorAddressesPlayer: false as const, dialogueMayUseFirstOrSecondPerson: true as const }, resolvedAct: { rawUtterance: text, worldStatus: "accepted" as const, actualOutcomes: [], lockedUtterances: locked } };
  const narration = renderNarrationBlocks(blocks, locked);
  expect(settlePlaySceneNarration({ narration, blocks }, { frame, purpose: "turn" })).toBe(`${text}\n\n${text}`);
  expect(() => settlePlaySceneNarration(narration, { frame, purpose: "turn" })).toThrow("requires narration-blocks-v1");
  expect(() => settlePlaySceneNarration({ narration: `${narration} altered`, blocks }, { frame, purpose: "turn" })).toThrow("differs from validated blocks");
});
