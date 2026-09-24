import { agencyPresenceIssues, validateAgencyUse, resolveAgencyChannel } from "./agency-profile.js";
import type { ProcessState } from "./process-effects.js";
import { validateKnowledgeSemanticReferences } from "./knowledge-semantics.js";
import { contentHash } from "./canonical.js";
import type { Acquisition } from "./acquisition.js";
import type { KnowledgeState, KnowledgeReducerContext } from "./knowledge.js";
import type { BranchSemanticState } from "./semantic-effects.js";
import type { KnowledgeDelta, KnowledgeOperation, ParticipantPresence, SpokenUtterance, ValidationIssue, WorldState } from "./model.js";

export type BranchAcquisitionOccurrence = {
  eventId: string;
  participants: readonly string[];
  participantPresence?: readonly ParticipantPresence[];
  spokenUtterances?: readonly SpokenUtterance[];
  processesBefore?: ProcessState;
  before: WorldState;
  after: WorldState;
};
export function branchAcquisitionRevision(value: NonNullable<BranchSemanticState["acquisitions"]>[string]): string {
  // Commit provenance is tracked separately; hashing it would make provisional
  // validation differ from replay or introduce a commit/hash cycle.
  const { introducedBy: _provenance, ...record } = value;
  return contentHash(record);
}

/** Dependencies come from this event, prior certified delivery, and actor experience. */
export function validateBranchAcquisitionOperation(operation: KnowledgeOperation, context: KnowledgeReducerContext, knowledge: KnowledgeState): ValidationIssue[] {
  if (operation.op !== "learn") return [];
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message: `${message}. Preserve head and proposal; stop unchanged retries. For a handle miss only, re-read the current isolated actor prompt and copy decision.experiences[].acquisitionId for at most one corrected retry. If no offered experience matches, stop; never guess IDs, import another branch or delete provenance.`, path: "acquisitionId" }];
  const coherence = validateKnowledgeSemanticReferences(operation, { ...context, claims: context.claims ?? new Map() }, "knowledge");
  if (coherence.length) return coherence;
  const records = context.branchSemantics.acquisitions ?? {};
  if (!operation.acquisitionId) {
    if (Object.values(records).some(value => value.actorId === operation.actorId && value.claimId === operation.claimId)) return fail("BRANCH_ACQUISITION_REQUIRED", "This branch content has an explicit experience contract");
    return [];
  }
  const value = records[operation.acquisitionId];
  if (!value) return fail("BRANCH_ACQUISITION_MISSING", "Experience is absent from this branch's history");
  const occurrence = context.branchOccurrence;
  if (!occurrence || value.introducedBy.eventId !== occurrence.eventId || knowledge.acquisitions?.[value.id]) return fail("BRANCH_ACQUISITION_CUT_MISMATCH", "Experience may be acquired only in its introducing event; later recall requires remembered mode");
  if (context.acquisitions?.has(value.id)) return fail("BRANCH_ACQUISITION_ID_COLLISION", "Branch experience collides with canonical identity");
  if (value.actorId !== operation.actorId || value.claimId !== operation.claimId || value.propositionId !== operation.propositionId || value.basis.mode !== operation.acquisitionMode) return fail("BRANCH_ACQUISITION_CONTENT_MISMATCH", "Recipient, content and mode must match the event record");
  if (context.entities.get(value.actorId)?.kind !== "character" || !occurrence.participants.includes(value.actorId)) return fail("BRANCH_ACQUISITION_RECIPIENT_MISMATCH", "Acquiring character must participate in this event");
  const status = !value.reception.understood || value.reception.belief === "undecided" ? "heard" : value.reception.belief === "rejected" ? "disbelieves" : "believes";
  if (operation.status !== status) return fail("BRANCH_ACQUISITION_RECEPTION_MISMATCH", "Receipt, understanding and belief are distinct; experience does not establish world truth");
  const basis = value.basis;
  if (operation.perceptionId || operation.expressionId !== ("expressionId" in basis ? basis.expressionId : undefined)
    || operation.attributionId !== ("attributionId" in basis ? basis.attributionId : undefined)) return fail("BRANCH_ACQUISITION_BASIS_MISMATCH", "Operation must preserve exactly its branch basis");
  const proposition = context.branchSemantics.propositions[value.propositionId] ?? context.propositions?.get(value.propositionId);
  if (!proposition) return fail("BRANCH_ACQUISITION_CONTENT_MISSING", "The proposition is not present in this frozen scope");
  const physical = (id: string) => occurrence.participantPresence?.some(item => item.entityId === id && item.mode === "physical");
  const location = (id: string) => occurrence.after.values[id]?.[context.entities.get(id)?.kind === "character" ? "character.location" : "artifact.location"];
  let sourceActorId: string | undefined;
  if (basis.mode === "told" || basis.mode === "deceived-misattributed") {
    const past = basis.utteranceEventId ? context.committedSpeech?.find(item => item.eventId === basis.utteranceEventId && item.utteranceIndex === basis.utteranceIndex && item.recipientId === value.actorId) : undefined;
    if (basis.utteranceEventId && !past) return [{ code: "BRANCH_SPEECH_HISTORY_UNAVAILABLE", path: "basis.utteranceEventId", message: "The exact prior utterance was not delivered to this actor in this branch. Preserve head and proposal. Read the current isolated decision.pendingSpeech; copy the same entry’s eventId, utteranceIndex and speakerId for at most one corrected retry. If absent or outside scope, stop; never guess IDs, import another branch or repeat unchanged." }];
    if (past && Object.values(records).some(record => record.id !== value.id && record.actorId === value.actorId && (record.basis.mode === "told" || record.basis.mode === "deceived-misattributed")
      && (record.basis.utteranceEventId ?? record.introducedBy.eventId) === past.eventId && record.basis.utteranceIndex === past.utteranceIndex)) return [{ code: "BRANCH_SPEECH_ALREADY_RECEIVED", path: "basis.utteranceEventId", message: "This actor already received the utterance. Preserve head and proposal; stop this consumed receipt attempt. Later recall requires remembered mode using the actor’s own decision.experiences[].acquisitionId; never retry the receipt or duplicate the utterance." }];
    const utterance = past ? { speakerId: past.speakerId, addresseeIds: [past.recipientId], content: past.content, channel: "audible" as const } : occurrence.spokenUtterances?.[basis.utteranceIndex];
    const attribution = context.branchSemantics.attributions[basis.attributionId] ?? context.attributions?.get(basis.attributionId);
    if (!utterance || !utterance.addresseeIds.includes(value.actorId)
      || !attribution || attribution.propositionId !== value.propositionId || attribution.holderKind !== "character" || attribution.holderEntityId !== utterance.speakerId) return fail("BRANCH_ACQUISITION_EXPRESSION_MISMATCH", "Spoken receipt needs the exact delivered utterance, intended recipient and matching source attribution");
    if (!past) {
      const accessIssues = speechReceiptAccessIssues(value.actorId, utterance, occurrence, context, knowledge);
      if (accessIssues.length) return accessIssues;
    }
    sourceActorId = utterance.speakerId;
    if (basis.mode === "deceived-misattributed" && (basis.actualSourceActorId !== sourceActorId || context.entities.get(basis.believedSourceActorId)?.kind !== "character")) return fail("BRANCH_ACQUISITION_SOURCE_MISMATCH", "Preserve distinct actual and believed sources");
  } else if (basis.mode === "observed") {
    const target = context.entities.get(basis.entityId);
    const supported = basis.field === "location.open" ? target?.kind === "location" && basis.entityId === basis.locationId && typeof basis.value === "boolean"
      : target?.kind === "character" && basis.value === basis.locationId && physical(basis.entityId);
    if (!supported || !physical(value.actorId) || context.entities.get(basis.locationId)?.kind !== "location" || location(value.actorId) !== basis.locationId
      || occurrence.after.values[basis.entityId]?.[basis.field] !== basis.value) return fail("BRANCH_ACQUISITION_ACCESS_UNPROVEN", "Direct vision requires proven current location and an observable state value");
    const object = proposition.object.kind === "entity" ? proposition.object.entityId : proposition.object.kind === "literal" ? proposition.object.value : undefined;
    if (proposition.subjectEntityId !== basis.entityId || proposition.relationId !== basis.field || object !== basis.value || proposition.polarity !== "positive" || proposition.modality !== "asserted") return fail("BRANCH_ACQUISITION_PHENOMENON_MISMATCH", "Observed content must be the actual phenomenon, not a relabeled report");
  } else if (basis.mode === "read" && "messageEventId" in basis) {
    const past = context.committedText?.find(item => item.eventId === basis.messageEventId && item.messageIndex === basis.messageIndex && item.recipientId === value.actorId);
    if (!past) return [{ code: "BRANCH_TEXT_HISTORY_UNAVAILABLE", path: "basis.messageEventId", message: "This exact message was not delivered to this actor in this branch. Preserve head and proposal; copy one current decision.pendingMessages entry’s eventId, messageIndex and authorId for at most one corrected retry. If absent, stop; never guess, import another branch or retry unchanged." }];
    if (Object.values(records).some(record => record.id !== value.id && record.actorId === value.actorId && record.basis.mode === "read" && "messageEventId" in record.basis
      && record.basis.messageEventId === past.eventId && record.basis.messageIndex === past.messageIndex)) return [{ code: "BRANCH_TEXT_ALREADY_RECEIVED", path: "basis.messageEventId", message: "This actor already received this message. Stop this consumed receipt attempt; preserve head. Later recall uses remembered with this actor’s decision.experiences[].acquisitionId, never duplicate the message or receipt." }];
    const mode = occurrence.participantPresence?.find(item => item.entityId === value.actorId)?.mode;
    if ((mode !== "physical" && mode !== "remote") || agencyPresenceIssues(context.entities.get(value.actorId), mode).length) return fail("BRANCH_ACQUISITION_ACCESS_UNPROVEN", "An inactive or represented identity cannot read a delivered message");
    const attribution = context.branchSemantics.attributions[basis.attributionId] ?? context.attributions?.get(basis.attributionId);
    if (!attribution || attribution.propositionId !== value.propositionId || attribution.holderKind !== "character"
      || attribution.holderEntityId !== past.authorId || attribution.attitude !== "asserts") return fail("BRANCH_ACQUISITION_EXPRESSION_MISMATCH", "Message reading needs the exact delivered author and matching reported-content attribution");
  } else if (basis.mode === "read") {
    const expression = context.utteranceExpressions?.get(basis.expressionId), attribution = context.attributions?.get(basis.attributionId);
    if (!occurrence.participants.includes(basis.documentId) || context.entities.get(basis.documentId)?.kind !== "artifact"
      || !expression || expression.modality !== "writing" || expression.documentId !== basis.documentId || expression.propositionId !== value.propositionId
      || !expression.addresseeIds.includes(value.actorId) || attribution?.holderKind !== "document" || attribution.holderEntityId !== basis.documentId
      || attribution.propositionId !== value.propositionId || !attribution.expressionIds?.includes(expression.id)
      || !context.realizedCanonicalEventIds?.has(expression.canonicalEventId)) return fail("BRANCH_ACQUISITION_DOCUMENT_UNAVAILABLE", "Reading requires the exact already-realized document expression and its recipient/source attribution");
    if (basis.channelBinding) {
      const mode = occurrence.participantPresence?.find(item => item.entityId === value.actorId)?.mode;
      const access = occurrence.processesBefore && resolveAgencyChannel(value.actorId, basis.channelBinding, occurrence.participants, context, occurrence.processesBefore, knowledge);
      if ((mode !== "physical" && mode !== "remote") || agencyPresenceIssues(context.entities.get(value.actorId), mode).length
        || !access || access.channel.modality !== "text" || !access.peers.includes(basis.documentId)) return [{ code: "BRANCH_TEXT_CHANNEL_UNPROVEN", path: "basis.channelBinding", message: "Remote reading requires the reader’s own disclosed text channel with this document and its carrier in the committed pre-event session. Preserve head and proposal; stop for host channel reconstruction. Never guess IDs, borrow another actor’s channel, relabel presence or start/resume access in this same event." }];
    } else if (!basis.locationId || !physical(value.actorId) || agencyPresenceIssues(context.entities.get(value.actorId), "physical").length || context.entities.get(basis.locationId)?.kind !== "location"
      || location(value.actorId) !== basis.locationId || location(basis.documentId) !== basis.locationId) return fail("BRANCH_ACQUISITION_DOCUMENT_UNAVAILABLE", "Physical reading requires the reader and document at the exact proven location");
  } else {
    const ids = basis.mode === "remembered" ? [basis.priorAcquisitionId] : basis.premiseAcquisitionIds;
    for (const id of ids) {
      const priorBranch = records[id], prior: Acquisition | typeof priorBranch | undefined = priorBranch ?? context.acquisitions?.get(id);
      const receipt = knowledge.acquisitions?.[id];
      if (!prior || !receipt || receipt.actorId !== value.actorId || !receipt.reception.understood
        || receipt.revisionHash !== (priorBranch ? branchAcquisitionRevision(priorBranch) : contentHash(prior))) return fail("BRANCH_ACQUISITION_PRIOR_UNAVAILABLE", "This actor lacks the exact committed understood experience");
      if (basis.mode === "remembered" && prior.propositionId !== value.propositionId) return fail("BRANCH_ACQUISITION_MEMORY_MISMATCH", "Memory must retain its original content");
      if (basis.mode === "inferred" && (receipt.reception.belief !== "accepted" || !Object.values(knowledge.actors[value.actorId] ?? {}).some(fact => fact.acquisitionId === id && fact.propositionId === prior.propositionId && ["knows", "believes"].includes(fact.status)))) return fail("BRANCH_ACQUISITION_PREMISE_UNAVAILABLE", "Inference requires each premise in pre-event accepted knowledge");
    }
  }
  if (operation.sourceActorId !== sourceActorId) return fail("BRANCH_ACQUISITION_SOURCE_MISMATCH", "Operation source differs from its actual occurrence");
  return [];
}

/** A record cannot be smuggled into history without its validated recipient operation. */
export function branchAcquisitionPairingIssues(semantics: BranchSemanticState, eventId: string, delta?: KnowledgeDelta): ValidationIssue[] {
  return Object.values(semantics.acquisitions ?? {}).filter(value => value.introducedBy.eventId === eventId).flatMap(value => {
    const operations = delta?.operations.filter(op => op.op === "learn" && op.acquisitionId === value.id) ?? [];
    return operations.length === 1 ? [] : [{ code: "BRANCH_ACQUISITION_PAIR_REQUIRED", message: "Each new experience needs exactly one matching learn operation; preserve the proposal and stop unchanged retries.", path: "proposedKnowledge" }];
  });
}

export function hasBranchAcquisitionContract(operation: KnowledgeOperation, semantics: BranchSemanticState): boolean {
  if (operation.op !== "learn") return false;
  return Boolean(operation.acquisitionId?.startsWith("branch-acquisition-") || operation.acquisitionId && semantics.acquisitions?.[operation.acquisitionId]
    || !operation.acquisitionId && Object.values(semantics.acquisitions ?? {}).some(value => value.actorId === operation.actorId && value.claimId === operation.claimId));
}

/** Delivery is a sensory permission; it does not infer understanding or belief. */
export function speechReceiptAccessIssues(actorId: string, utterance: SpokenUtterance, occurrence: BranchAcquisitionOccurrence, context: KnowledgeReducerContext, knowledge: KnowledgeState): ValidationIssue[] {
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, path: "spokenUtterances", message: message + ". Preserve head and stop for host channel/source review; never guess IDs, relabel presence or retry unchanged." }];
  if (!occurrence.participants.includes(actorId) || !utterance.addresseeIds.includes(actorId)) return fail("BRANCH_ACQUISITION_RECIPIENT_MISMATCH", "The recipient is not an actual addressee in this occurrence");
  const physical = (id: string) => occurrence.participantPresence?.some(item => item.entityId === id && item.mode === "physical");
  const location = (id: string) => occurrence.after.values[id]?.[context.entities.get(id)?.kind === "character" ? "character.location" : "artifact.location"];
  const recipientMode = occurrence.participantPresence?.find(item => item.entityId === actorId)?.mode;
  if (recipientMode !== "physical" && recipientMode !== "remote" || agencyPresenceIssues(context.entities.get(actorId), recipientMode).length) return fail("BRANCH_ACQUISITION_ACCESS_UNPROVEN", "An image, mention or inactive identity cannot receive this speech");
  if (utterance.channelBinding || !physical(actorId) || !physical(utterance.speakerId)) {
    if (!utterance.channelBinding || !occurrence.processesBefore) return fail("BRANCH_ACQUISITION_CHANNEL_UNPROVEN", "Remote receipt requires an explicit speech channel and the committed process state before this event");
    const issues = validateAgencyUse({ participants: [...occurrence.participants], participantPresence: occurrence.participantPresence ? [...occurrence.participantPresence] : undefined,
      spokenUtterances: [utterance] }, { version: 1, operations: [] }, context, occurrence.processesBefore, knowledge);
    if (issues.length) return fail("BRANCH_ACQUISITION_CHANNEL_UNPROVEN", `Remote receipt has no valid pre-event audio channel: ${issues.map(issue => issue.code).join(", ")}`);
  } else if (location(actorId) && location(utterance.speakerId) && location(actorId) !== location(utterance.speakerId)) return fail("BRANCH_ACQUISITION_ACCESS_UNPROVEN", "Speaker and recipient are at different known locations");
  return [];
}
