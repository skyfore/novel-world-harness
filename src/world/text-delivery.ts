import type { BranchSemanticState } from "./semantic-effects.js";
import { z } from "zod";
import { idSchema, type CommittedEvent } from "./model.js";

export const textDeliverySchema = z.object({
  messageIndex: z.number().int().min(0).max(31),
  recipientId: idSchema,
}).strict();
export type TextDelivery = z.infer<typeof textDeliverySchema>;
export type CommittedTextDelivery = TextDelivery & { eventId: string; authorId: string; content: string };
export type TextHistory = readonly { event: CommittedEvent; textDeliveries?: readonly TextDelivery[] }[];

/** Replay-certified delivery is not a knowledge receipt or evidence that its content is true. */
export function committedTextDeliveries(history: TextHistory, actorId?: string): CommittedTextDelivery[] {
  return history.flatMap(({ event, textDeliveries }) => (textDeliveries ?? []).flatMap(delivery => {
    const message = event.writtenMessages?.[delivery.messageIndex];
    return (!actorId || delivery.recipientId === actorId) && message?.recipientIds.includes(delivery.recipientId) && event.participants.includes(delivery.recipientId)
      ? [{ ...delivery, eventId: event.eventId, authorId: message.authorId, content: message.content }] : [];
  }));
}

export function pendingTextDeliveries(history: TextHistory, semantics: BranchSemanticState, actorId: string): CommittedTextDelivery[] {
  const consumed = new Set(Object.values(semantics.acquisitions ?? {}).flatMap(item => item.actorId === actorId && item.basis.mode === "read" && "messageEventId" in item.basis
    ? [`${item.basis.messageEventId}/${item.basis.messageIndex}`] : []));
  return committedTextDeliveries(history, actorId).filter(item => !consumed.has(`${item.eventId}/${item.messageIndex}`));
}
