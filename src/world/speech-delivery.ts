import { z } from "zod";
import { idSchema, type CommittedEvent } from "./model.js";
import type { BranchSemanticState } from "./semantic-effects.js";

export const speechDeliverySchema = z.object({ utteranceIndex: z.number().int().min(0).max(31), recipientId: idSchema, delivery: z.enum(["physical", "remote"]) }).strict();
export type SpeechDelivery = z.infer<typeof speechDeliverySchema>;
export type CommittedSpeechDelivery = SpeechDelivery & { eventId: string; speakerId: string; content: string };
export type SpeechHistory = readonly { event: CommittedEvent; speechDeliveries?: readonly SpeechDelivery[] }[];

/** Only the replay reducer creates delivery proofs; raw utterances alone are insufficient. */
export function committedSpeechDeliveries(history: SpeechHistory): CommittedSpeechDelivery[] {
  return history.flatMap(({ event, speechDeliveries }) => (speechDeliveries ?? []).flatMap(item => {
    const utterance = event.spokenUtterances?.[item.utteranceIndex];
    return utterance?.addresseeIds.includes(item.recipientId) && event.participants.includes(item.recipientId)
      ? [{ ...item, eventId: event.eventId, speakerId: utterance.speakerId, content: utterance.content }] : [];
  }));
}

export function pendingSpeechDeliveries(history: SpeechHistory, semantics: BranchSemanticState, actorId: string): CommittedSpeechDelivery[] {
  const consumed = new Set(Object.values(semantics.acquisitions ?? {}).flatMap(item => item.actorId === actorId && (item.basis.mode === "told" || item.basis.mode === "deceived-misattributed")
    ? [`${item.basis.utteranceEventId ?? item.introducedBy.eventId}/${item.basis.utteranceIndex}`] : []));
  return committedSpeechDeliveries(history).filter(item => item.recipientId === actorId && !consumed.has(`${item.eventId}/${item.utteranceIndex}`));
}
