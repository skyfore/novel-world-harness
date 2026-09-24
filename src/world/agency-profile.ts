import { z } from "zod";
import { idSchema, type Entity, type EvidenceAssertion, type ParticipantPresence, type ValidationIssue, type ActionInvocation, type StateDelta, type SpokenUtterance, type WrittenMessage } from "./model.js";
import { contentHash } from "./canonical.js";
import type { ActionSchema } from "./action-ontology.js";
import type { ProcessTemplate } from "./process-ontology.js";
import type { ProcessState } from "./process-effects.js";
import { isActionableKnowledge, type KnowledgeState } from "./knowledge.js";
import { mechanismIsDisclosed } from "./mechanism-visibility.js";

type Catalog = {
  processTemplates?: ReadonlyMap<string, ProcessTemplate>;
  actionSchemas?: ReadonlyMap<string, ActionSchema>;
};

/** Capability metadata never creates a running session, a body, or a world effect. */
export function validateAgencyProfile(entity: Entity, catalog: Catalog): ValidationIssue[] {
  const profile = entity.agencyProfile;
  if (!profile) return [];
  const errors: ValidationIssue[] = [];
  const fail = (code: string, message: string, path: string) => errors.push({ code, message, path });
  const sources = new Set(entity.evidence.map(ref => ref.span.sourceId));
  if (sources.size !== 1) fail("AGENCY_SOURCE_REQUIRED", "Agency capabilities need one source, with exact field evidence; unknown is not permission.", "agencyProfile");
  for (const [index, channel] of profile.channels.entries()) {
    const path = `agencyProfile.channels.${index}`;
    const template = catalog.processTemplates?.get(channel.processTemplateId);
    if (!template) {
      fail("AGENCY_PROCESS_MISSING", "Discover the process-template in the same source with find_compiler_artifacts; copy results[].readArguments.ref into read_compiler_artifact.ref, then payload.id into processTemplateId. One corrected retry only; stop if absent, never guess or retry unchanged.", `${path}.processTemplateId`);
      continue;
    }
    if (template.induction.kind === "source-pattern" && (!template.evidence.length || template.evidence.some(ref => !sources.has(ref.span.sourceId)))) fail("AGENCY_SOURCE_MISMATCH", "Channel process evidence belongs to another source.", path);
    const actor = template.ownerRoles.find(role => role.id === channel.actorRoleId);
    const peer = template.ownerRoles.find(role => role.id === channel.peerRoleId);
    const carrier = template.ownerRoles.find(role => role.id === channel.carrierRoleId);
    if (!actor || actor.minCardinality !== 1 || actor.maxCardinality !== 1 || !actor.allowedEntityKinds.includes(entity.kind)
      || !peer || peer.minCardinality < 1 || !carrier || carrier.minCardinality < 1
      || carrier.allowedEntityKinds.some(kind => kind !== "artifact")) {
      fail("AGENCY_ROLE_MISMATCH", "A channel requires a single actor role, nonempty peer role and distinct artifact carrier role in its process template.", path);
    }
    if (channel.activePhaseIds.some(id => !template.phases.some(phase => phase.id === id && !phase.terminal))) fail("AGENCY_PHASE_MISMATCH", "Active channel phases must be nonterminal phases of this exact process template.", `${path}.activePhaseIds`);
    if (channel.actionSchemaId) {
      const action = catalog.actionSchemas?.get(channel.actionSchemaId);
      if (!action) fail("AGENCY_ACTION_MISSING", "Discover the same-source action-schema with find_compiler_artifacts, copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into actionSchemaId. One corrected retry only; stop without inventing a physical-control mechanism.", `${path}.actionSchemaId`);
      else if (action.initiatorRoleId !== channel.actorRoleId || [channel.actorRoleId, channel.peerRoleId, channel.carrierRoleId].some(id => !action.roles.some(role => role.id === id))) fail("AGENCY_ACTION_ROLE_MISMATCH", "Physical control must use the same actor, peer and carrier role IDs in its action mechanism.", `${path}.actionSchemaId`);
      else if (action.induction.kind === "source-pattern" && (!action.evidence.length || action.evidence.some(ref => !sources.has(ref.span.sourceId)))) fail("AGENCY_SOURCE_MISMATCH", "Physical-control mechanism evidence belongs to another source.", `${path}.actionSchemaId`);
    }
  }
  return errors;
}

export function validateAgencyProfileEvidence(entity: Entity, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const profile = entity.agencyProfile;
  if (!profile) return [];
  const required = ["/agencyProfile/agency", "/agencyProfile/embodiment"];
  profile.channels.forEach((channel, index) => {
    const prefix = `/agencyProfile/channels/${index}`;
    for (const key of ["modality", "processTemplateId", "actorRoleId", "peerRoleId", "carrierRoleId", ...(channel.actionSchemaId ? ["actionSchemaId"] : [])]) required.push(`${prefix}/${key}`);
    channel.activePhaseIds.forEach((_, phase) => required.push(`${prefix}/activePhaseIds/${phase}`));
  });
  return required.filter(path => !assertions.some(item => item.target.artifactKind === "entity" && item.target.artifactId === entity.id
    && item.target.jsonPointer === path && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length))
    .map(path => ({ code: "AGENCY_EVIDENCE_REQUIRED", path, message: "Agency and channel capabilities require their own exact source selectors. Inspect the same-source segment and correct once; stop if unsupported, without upgrading a representation or guessing a capability." }));
}

export const agencyDecisionViewSchema = z.object({
  agency: z.enum(["autonomous", "none", "unknown"]),
  embodiment: z.enum(["bodily", "mediated", "unknown"]),
  channels: z.array(z.object({
    id: idSchema, processId: idSchema, processTemplateId: idSchema,
    modality: z.enum(["audio", "audiovisual", "text", "physical-control"]),
    peerEntityIds: z.array(idSchema), carrierEntityIds: z.array(idSchema), actionSchemaId: idSchema.optional(),
  }).strict()),
}).strict();
export type AgencyDecisionView = z.infer<typeof agencyDecisionViewSchema>;

/** Read-only actor-scoped projection. A reported channel still requires action adjudication. */
export function projectAgencyChannels(entity: Entity, processes: ProcessState, catalog: Catalog, scope: {
  visibleEntityIds: ReadonlySet<string>; knownClaimIds: ReadonlySet<string>; sourceId?: string;
}): AgencyDecisionView | undefined {
  const profile = entity.agencyProfile;
  if (!profile) return undefined; // Legacy is unverified, never auto-upgraded.
  if (scope.sourceId && entity.evidence.some(ref => ref.span.sourceId !== scope.sourceId)) return undefined;
  const channels: AgencyDecisionView["channels"] = [];
  if (profile.agency === "autonomous" && !validateAgencyProfile(entity, catalog).length) for (const channel of profile.channels) {
    const template = catalog.processTemplates!.get(channel.processTemplateId)!;
    if (!mechanismIsDisclosed(template, scope)) continue;
    if (channel.actionSchemaId && !mechanismIsDisclosed(catalog.actionSchemas!.get(channel.actionSchemaId)!, scope)) continue;
    for (const process of Object.values(processes.instances)) {
      if (process.templateId !== template.id || process.status !== "running" || !channel.activePhaseIds.includes(process.phaseId)) continue;
      const actors = process.ownerBindings.find(role => role.roleId === channel.actorRoleId)?.entityIds ?? [];
      const peers = process.ownerBindings.find(role => role.roleId === channel.peerRoleId)?.entityIds ?? [];
      const carriers = process.ownerBindings.find(role => role.roleId === channel.carrierRoleId)?.entityIds ?? [];
      if (actors.length !== 1 || actors[0] !== entity.id || !peers.length || !carriers.length || [...peers, ...carriers].some(id => !scope.visibleEntityIds.has(id))) continue;
      channels.push({ id: channel.id, processId: process.id, processTemplateId: template.id, modality: channel.modality,
        peerEntityIds: [...peers], carrierEntityIds: [...carriers], ...(channel.actionSchemaId ? { actionSchemaId: channel.actionSchemaId } : {}) });
    }
  }
  channels.sort((a, b) => a.id.localeCompare(b.id) || a.processId.localeCompare(b.processId));
  return { agency: profile.agency, embodiment: profile.embodiment, channels };
}

/** An identity appearing in a photo, memory or mention is not a live actor there. */
export function agencyPresenceIssues(entity: Entity | undefined, presence: ParticipantPresence["mode"] | undefined): ValidationIssue[] {
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message: `${message} Preserve the head and stop for host agency/channel review; do not change the presence label, guess a mechanism or retry unchanged.`, path: "actorId" }];
  if (presence && ["represented", "mentioned", "memory", "dream"].includes(presence)) return fail("AGENCY_NOT_LIVE", "This occurrence represents an identity without granting it current agency.");
  if (entity?.agencyProfile && entity.agencyProfile.agency !== "autonomous") return fail("AGENCY_UNAVAILABLE", "This entity has no established autonomous agency.");
  if (entity?.agencyProfile?.embodiment === "mediated" && presence === "physical") return fail("AGENCY_BODY_REQUIRED", "A mediated entity cannot be relabeled as physically embodied.");
  return [];
}

/** Resolve only pre-event, disclosed channel authority and exact process roles. */
export function resolveAgencyChannel(actorId: string, binding: { channelId: string; processId: string } | undefined,
  participants: readonly string[], context: Catalog & { entities: ReadonlyMap<string, Entity>; sourceId?: string }, processes: ProcessState, knowledge: KnowledgeState) {
  const entity = context.entities.get(actorId);
  const channel = entity?.agencyProfile?.channels.find(item => item.id === binding?.channelId);
  const process = binding ? processes.instances[binding.processId] : undefined;
  if (!entity || entity.agencyProfile?.agency !== "autonomous" || !channel || !process
    || process.templateId !== channel.processTemplateId || process.status !== "running" || !channel.activePhaseIds.includes(process.phaseId)) return undefined;
  const template = context.processTemplates?.get(channel.processTemplateId);
  const action = channel.actionSchemaId ? context.actionSchemas?.get(channel.actionSchemaId) : undefined;
  const scope = { sourceId: context.sourceId, knownClaimIds: new Set(Object.values(knowledge.actors[actorId] ?? {}).filter(isActionableKnowledge).map(fact => fact.claimId)) };
  if (!template || !mechanismIsDisclosed(template, scope) || channel.actionSchemaId && (!action || !mechanismIsDisclosed(action, scope))) return undefined;
  const actor = process.ownerBindings.find(role => role.roleId === channel.actorRoleId)?.entityIds ?? [];
  const peers = process.ownerBindings.find(role => role.roleId === channel.peerRoleId)?.entityIds ?? [];
  const carriers = process.ownerBindings.find(role => role.roleId === channel.carrierRoleId)?.entityIds ?? [];
  if (actor.length !== 1 || actor[0] !== actorId || !peers.length || !carriers.length
    || [...actor, ...peers, ...carriers].some(id => !participants.includes(id))) return undefined;
  return { channel, process, peers };
}

/** Validate explicit session use before any same-event process or state effects. */
export function validateAgencyUse(event: {
  actorId?: string; participants: string[]; participantPresence?: ParticipantPresence[];
  spokenUtterances?: SpokenUtterance[]; writtenMessages?: WrittenMessage[]; action?: ActionInvocation;
}, delta: StateDelta, context: Catalog & { entities: ReadonlyMap<string, Entity>; sourceId?: string }, processes: ProcessState, knowledge: KnowledgeState): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const presence = (id: string) => event.participantPresence?.find(item => item.entityId === id)?.mode;
  const needsChannel = (entity: Entity | undefined) => entity?.agencyProfile && entity.agencyProfile.embodiment !== "bodily"
    || Boolean(entity && presence(entity.id) === "remote");
  const fail = (message: string, path: string) => errors.push({ code: "AGENCY_CHANNEL_UNAVAILABLE", path,
    message: `${message} Preserve the head and stop for host channel reconstruction. Do not guess process IDs, relabel presence, substitute a communication channel for physical control or retry unchanged.` });
  const resolve = (actorId: string, binding: { channelId: string; processId: string } | undefined) => resolveAgencyChannel(actorId, binding, event.participants, context, processes, knowledge);

  if (event.actorId) {
    const actor = context.entities.get(event.actorId);
    errors.push(...agencyPresenceIssues(actor, presence(event.actorId)));
    const physicalChange = delta.operations.some(op => !(op.op === "set" && op.entityId === event.actorId && op.field === "character.plan"));
    const binding = event.action?.lane === "schema-bound" ? event.action.channelBinding : undefined;
    if (needsChannel(actor) && physicalChange || binding) {
      const access = resolve(event.actorId, binding);
      const action = event.action;
      if (!access || access.channel.modality !== "physical-control" || action?.lane !== "schema-bound" || action.schemaId !== access.channel.actionSchemaId
        || [access.channel.actorRoleId, access.channel.peerRoleId, access.channel.carrierRoleId].some(roleId =>
          contentHash(action.roleBindings.find(role => role.roleId === roleId)?.entityIds ?? []) !== contentHash(access.process.ownerBindings.find(role => role.roleId === roleId)?.entityIds ?? []))) {
        fail("Physical effects require this actor's active physical-control session and its exact action mechanism/role bindings.", "action.channelBinding");
      }
    }
  }
  for (const [index, utterance] of (event.spokenUtterances ?? []).entries()) {
    const speaker = context.entities.get(utterance.speakerId);
    errors.push(...agencyPresenceIssues(speaker, presence(utterance.speakerId)));
    if (!needsChannel(speaker) && !utterance.channelBinding) continue;
    const access = resolve(utterance.speakerId, utterance.channelBinding);
    if (!access || !["audio", "audiovisual"].includes(access.channel.modality) || utterance.addresseeIds.some(id => !access.peers.includes(id))) {
      fail("Remote audible speech needs an active audio session binding this speaker, these addressees and its actual carrier.", `spokenUtterances.${index}.channelBinding`);
    }
  }
  for (const [index, message] of (event.writtenMessages ?? []).entries()) {
    const path = `writtenMessages.${index}`;
    const parties = [message.authorId, ...message.recipientIds];
    if (parties.some(id => context.entities.get(id)?.kind !== "character" || !event.participants.includes(id)
      || !["physical", "remote"].includes(presence(id) ?? "")) || event.actorId && message.authorId !== event.actorId) {
      fail("Text delivery requires an actual character author and explicitly live character recipients; an actor may only author its own messages.", path);
    }
    for (const id of parties) errors.push(...agencyPresenceIssues(context.entities.get(id), presence(id)));
    const access = resolve(message.authorId, message.channelBinding);
    if (!access || access.channel.modality !== "text" || message.recipientIds.some(id => !access.peers.includes(id))) {
      fail("Written messages require this author's disclosed, already-running text session, exact recipient peers and actual carrier.", `${path}.channelBinding`);
    }
  }
  return errors;
}

/** Host event envelope for speech already bound to this actor's current view. */
export function agencySpeechEnvelope(utterances: readonly SpokenUtterance[], channels: AgencyDecisionView["channels"]): {
  participants: string[]; participantPresence: ParticipantPresence[];
} | undefined {
  const remote = utterances.filter(utterance => utterance.channelBinding);
  if (!remote.length) return undefined;
  const participants = new Set<string>(), remoteIds = new Set<string>();
  for (const utterance of remote) {
    const binding = utterance.channelBinding!;
    const channel = channels.find(channel => channel.id === binding.channelId && channel.processId === binding.processId);
    if (!channel || !["audio", "audiovisual"].includes(channel.modality) || utterance.addresseeIds.some(id => !channel.peerEntityIds.includes(id))) {
      throw new Error("AGENCY_CHANNEL_UNAVAILABLE: Speech binding is absent from the current actor view. Preserve the head and stop for host reconstruction; never guess or retry unchanged.");
    }
    for (const id of [utterance.speakerId, ...channel.peerEntityIds, ...channel.carrierEntityIds]) participants.add(id);
    for (const id of [utterance.speakerId, ...channel.peerEntityIds]) remoteIds.add(id);
  }
  return { participants: [...participants].sort(), participantPresence: [...remoteIds].sort().map(entityId => ({ entityId, mode: "remote" })) };
}
