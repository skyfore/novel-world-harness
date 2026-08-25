import { z } from "zod";
import { validateActionKnowledge } from "./action-gate.js";
import { observeCommittedEvent } from "./actor-visible.js";
import { contentHash } from "./canonical.js";
import { projectCharacterDevelopment } from "./development.js";
import type { WorldEngine } from "./engine.js";
import {
  actorAffectSchema,
  eventProposalSchema,
  knowledgeDeltaSchema,
  knowledgeStatusSchema,
  predicateSchema,
  stateDeltaSchema,
  type ActorAffect,
  type CommittedEvent,
  type EventProposal,
  type Predicate,
  type ValidationReport,
} from "./model.js";
import {
  buildActorScopedActionContext,
  playerActionCandidateSchema,
  playerActionTranslationContext,
  playerInteractionSchema,
  validatePlayerActionGrounding,
  validatePlayerActionScope,
  validatePlayerActionSpatialScope,
  type PlayerActionCandidate,
  type PlayerActionTranslationContext,
  type PlayerInteraction,
} from "./player-action.js";
import { committedHistory } from "./scene.js";
import { modelVisibleCharacterOntology, type ModelVisibleCharacterOntology } from "./character-ontology.js";
import { deepFreeze } from "../util/immutable.js";

const npcResponseKindSchema = z.enum(["speak", "gesture", "refuse", "ignore", "other"]);
export type NpcResponseKind = z.infer<typeof npcResponseKindSchema>;

export const npcReactionEmotionSchema = actorAffectSchema.omit({ actorId: true });
export type NpcReactionEmotion = z.infer<typeof npcReactionEmotionSchema>;

/**
 * Model proposal only. Branch identity, actor identity, time, causality,
 * participants, progress, and evidence remain host-owned.
 */
export const npcReactionCandidateSchema = z.object({
  responseKind: npcResponseKindSchema,
  eventTitle: z.string().trim().min(1).max(500),
  npcObservation: z.string().trim().min(1).max(1_000),
  playerObservation: z.string().trim().min(1).max(1_000),
  emotion: npcReactionEmotionSchema,
  interaction: playerInteractionSchema.optional(),
  preconditions: z.array(predicateSchema).default([]),
  proposedDelta: stateDeltaSchema,
  proposedKnowledge: knowledgeDeltaSchema.optional(),
  communicatedClaimIds: z.array(z.string().min(1)).max(32).default([]),
  requiresKnowledge: z.array(z.string().min(1)).max(64).default([]),
  forbidsKnowledge: z.array(z.string().min(1)).max(64).default([]),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.responseKind === "speak" && value.interaction?.kind !== "speech") {
    ctx.addIssue({ code: "custom", message: "A speak response requires an exact speech interaction", path: ["interaction"] });
  }
  if (value.responseKind === "gesture" && value.interaction?.kind !== "gesture" && value.interaction?.kind !== "physical") {
    ctx.addIssue({ code: "custom", message: "A gesture response requires a perceptible gesture or physical interaction", path: ["interaction"] });
  }
});
export type NpcReactionCandidate = z.infer<typeof npcReactionCandidateSchema>;

export type NpcPerceivedMessage = {
  kind: "perceived-event";
  text: string;
  order: number;
  speaker?: string;
};

export type NpcReactionReasoningInput = Readonly<{
  npc: { id: string; name: string };
  player: { id: string; name: string };
  trigger: {
    title: string;
    perceivedSummary: string;
    interaction: PlayerInteraction;
  };
  actorContext: PlayerActionTranslationContext;
  development: {
    elapsedDays: number;
    ageYears?: number;
    lifeStage?: { value: string; source: "explicit-state" | "generic-age-band" };
    model?: {
      traits: Record<string, number>;
      decisionBiases: Record<string, number>;
      dispositions?: ModelVisibleCharacterOntology["dispositions"];
      appraisals?: ModelVisibleCharacterOntology["appraisals"];
      development?: ModelVisibleCharacterOntology["development"];
    };
    currentAffect?: Omit<ActorAffect, "actorId">;
    recentExperiences: Array<{ summary: string; progressChannels: string[] }>;
  };
  activeGoals: Array<{ description: string; priority: number }>;
  /** Host constraints, not facts the NPC is licensed to state as knowledge. */
  activeWorldRules: Array<{
    name: string;
    scope: string;
    appliesWhen: Predicate[];
    requires: Predicate[];
    forbids: Predicate[];
  }>;
  /** Exact latest actor-perceived events, not the player-only scene transcript. */
  recentPerceivedMessages: readonly NpcPerceivedMessage[];
  /** Consecutive local exchange events with no state, knowledge, time, or scene movement. */
  repetitionDepth: number;
  /** Complete actor-perceived archive for read-only related-message retrieval. */
  relatedPerceivedMessages: readonly NpcPerceivedMessage[];
}>;

export type NpcReactionReasoner = (
  input: NpcReactionReasoningInput,
) => Promise<unknown> | unknown;

export type NpcReactionEvent = {
  eventHash: string;
  title: string;
  actorId: string;
  responseKind: NpcResponseKind;
  emotion: NpcReactionEmotion;
  /** Host-side audit trace; none when reporting a previously committed idempotent response. */
  trace?: {
    candidate: NpcReactionCandidate;
    proposal: EventProposal;
    validation: ValidationReport;
  };
};

export type NpcReactionBatchResult = {
  newHead: string;
  responses: NpcReactionEvent[];
  failures: Array<{ actorId: string; error: string }>;
};

/**
 * React every directly addressed, present NPC to one already committed player
 * interaction. The LLM can propose only a bounded actor action; deterministic
 * gates validate it before a causally linked actor event is committed.
 */
export async function respondToNpcInteractions(input: {
  engine: WorldEngine;
  branchId: string;
  playerId: string;
  sourceId?: string;
  playerCandidate: PlayerActionCandidate;
  triggerEvent: CommittedEvent;
  reasoner: NpcReactionReasoner;
}): Promise<NpcReactionBatchResult> {
  const candidate = playerActionCandidateSchema.parse(input.playerCandidate);
  const interaction = candidate.intent?.controlledAct?.interaction;
  let currentHead = await input.engine.branches.readHead(input.branchId);
  if (!interaction) return { newHead: currentHead, responses: [], failures: [] };

  const responses: NpcReactionEvent[] = [];
  const failures: Array<{ actorId: string; error: string }> = [];
  for (const npcId of [...new Set(interaction.addresseeIds)].filter((id) => id !== input.playerId).sort()) {
    try {
      const existing = (await committedHistory(input.engine, currentHead)).find(({ event }) =>
        event.actorId === npcId
        && event.causalParents.includes(input.triggerEvent.eventId)
        && event.progress?.noveltyKey.startsWith(npcReactionNoveltyPrefix(input.triggerEvent.eventId, npcId)));
      if (existing) {
        const affect = existing.event.actorAffects?.find((entry) => entry.actorId === npcId);
        responses.push({
          eventHash: existing.eventHash,
          title: existing.event.title,
          actorId: npcId,
          responseKind: responseKindFromNovelty(existing.event.progress?.noveltyKey),
          emotion: affect
            ? { label: affect.label, intensity: affect.intensity, ...(affect.expression ? { expression: affect.expression } : {}) }
            : { label: "unspecified", intensity: 0 },
        });
        continue;
      }
      const response = await respondOneNpc({ ...input, npcId, interaction, atCommit: currentHead });
      currentHead = response.newHead;
      responses.push(response.event);
    } catch (error) {
      failures.push({ actorId: npcId, error: error instanceof Error ? error.message : String(error) });
      currentHead = await input.engine.branches.readHead(input.branchId);
    }
  }
  return { newHead: currentHead, responses, failures };
}

async function respondOneNpc(input: {
  engine: WorldEngine;
  branchId: string;
  playerId: string;
  npcId: string;
  sourceId?: string;
  playerCandidate: PlayerActionCandidate;
  triggerEvent: CommittedEvent;
  interaction: PlayerInteraction;
  atCommit: string;
  reasoner: NpcReactionReasoner;
}): Promise<{ newHead: string; event: NpcReactionEvent }> {
  const [worldContext, state, history, actorContext, development] = await Promise.all([
    input.engine.contextForCommit(input.atCommit),
    input.engine.projector.project(input.atCommit),
    committedHistory(input.engine, input.atCommit),
    buildActorScopedActionContext(input.engine, input.npcId, input.atCommit, undefined, input.sourceId),
    projectCharacterDevelopment(input.engine, input.npcId, input.atCommit),
  ]);
  const npc = worldContext.entities.get(input.npcId);
  if (!npc || npc.kind !== "character") throw new Error(`Interaction addressee '${input.npcId}' is not a character.`);
  if (!input.triggerEvent.participants.includes(input.npcId)) {
    throw new Error(`NPC '${input.npcId}' did not participate in the triggering interaction.`);
  }
  const playerIdentity = [...actorContext.presentEntities, ...actorContext.referenceableEntities]
    .find((entity) => entity.id === input.playerId);
  if (!playerIdentity || !actorContext.presentEntities.some((entity) => entity.id === input.playerId)) {
    throw new Error(`NPC '${input.npcId}' cannot currently perceive the player as present.`);
  }
  const triggerObservation = observeCommittedEvent(input.triggerEvent, input.npcId);
  if (!triggerObservation) throw new Error(`NPC '${input.npcId}' has no actor-scoped observation of the trigger.`);

  const visibleNames = new Map(actorContext.referenceableEntities.map((entity) => [entity.id, entity.name]));
  const perceivedMessages = history.flatMap(({ event }) => {
    const observation = observeCommittedEvent(event, input.npcId);
    if (!observation) return [];
    return [{
      kind: "perceived-event" as const,
      text: observation.summary,
      order: 0,
      ...(event.actorId && visibleNames.has(event.actorId) ? { speaker: visibleNames.get(event.actorId)! } : {}),
    }];
  }).map((message, order) => ({ ...message, order }));
  const activeGoalIds = new Set(development.activeGoalIds);
  const activeGoals = (worldContext.actorGoals ?? [])
    .filter((goal) => goal.actorId === input.npcId && activeGoalIds.has(goal.id))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .map((goal) => ({ description: goal.description, priority: goal.priority }));
  const activeWorldRules = state.activeRuleIds.flatMap((ruleId) => {
    const rule = worldContext.rules.get(ruleId);
    return rule ? [{
      name: rule.name,
      scope: rule.scope,
      appliesWhen: structuredClone(rule.appliesWhen),
      requires: structuredClone(rule.requires ?? []),
      forbids: structuredClone(rule.forbids ?? []),
    }] : [];
  });
  const currentAffect = [...history].reverse()
    .flatMap(({ event }) => event.actorAffects ?? [])
    .find((affect) => affect.actorId === input.npcId);
  const visibleOntology = development.model
    ? modelVisibleCharacterOntology(development.model, (entityId) => visibleNames.get(entityId))
    : undefined;
  const repetitionDepth = npcExchangeStagnationDepth(history, input.playerId, input.npcId);
  const rawProposal = await input.reasoner(deepFreeze({
    npc: { id: npc.id, name: npc.canonicalName },
    player: { id: input.playerId, name: playerIdentity.name },
    trigger: {
      title: input.triggerEvent.title,
      perceivedSummary: triggerObservation.summary,
      interaction: structuredClone(input.interaction),
    },
    actorContext: playerActionTranslationContext(actorContext),
    development: {
      elapsedDays: development.elapsedDays,
      ...(development.ageYears !== undefined ? { ageYears: development.ageYears } : {}),
      ...(development.lifeStage ? { lifeStage: structuredClone(development.lifeStage) } : {}),
      ...(development.model ? {
        model: {
          traits: structuredClone(development.model.traits),
          decisionBiases: structuredClone(development.model.decisionBiases),
          ...(visibleOntology?.dispositions.length ? { dispositions: structuredClone(visibleOntology.dispositions) } : {}),
          ...(visibleOntology?.appraisals.length ? { appraisals: structuredClone(visibleOntology.appraisals) } : {}),
          ...(visibleOntology?.development.length ? { development: structuredClone(visibleOntology.development) } : {}),
        },
      } : {}),
      ...(currentAffect ? {
        currentAffect: {
          label: currentAffect.label,
          intensity: currentAffect.intensity,
          ...(currentAffect.expression ? { expression: currentAffect.expression } : {}),
        },
      } : {}),
      recentExperiences: development.recentLivedExperiences.map((experience) => ({
        summary: experience.title,
        progressChannels: [...experience.progressChannels],
      })),
    },
    activeGoals,
    activeWorldRules,
    repetitionDepth,
    recentPerceivedMessages: perceivedMessages.slice(-10),
    relatedPerceivedMessages: perceivedMessages,
  } satisfies NpcReactionReasoningInput));
  const reaction = npcReactionCandidateSchema.parse(structuredClone(rawProposal));
  if (reaction.interaction) {
    const distinctAddressees = [...new Set(reaction.interaction.addresseeIds)];
    if (distinctAddressees.length !== 1 || distinctAddressees[0] !== input.playerId) {
      throw new Error("An NPC reaction may directly address only the triggering player in this response lane.");
    }
  }

  const scopedCandidate = reactionAsPlayerCandidate(reaction, input.playerId);
  const issues = [
    ...validatePlayerActionScope(scopedCandidate, actorContext),
    ...validatePlayerActionGrounding(scopedCandidate, actorContext),
    ...await validatePlayerActionSpatialScope(input.engine, scopedCandidate, input.npcId, input.atCommit, input.sourceId),
  ];
  if (issues.length) {
    throw new Error(`NPC response proposal failed actor scope: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  }

  const communicated = [...new Set(reaction.communicatedClaimIds)].map((claimId) => {
    const known = actorContext.knowledge.find((entry) => entry.claimId === claimId && entry.status !== "disbelieves");
    if (!known) throw new Error(`NPC cannot communicate unknown or disbelieved claim '${claimId}'.`);
    return {
      op: "learn" as const,
      actorId: input.playerId,
      claimId,
      status: knowledgeStatusSchema.parse("heard"),
      confidence: known.confidence,
      sourceActorId: input.npcId,
    };
  });
  const knowledgeOperations = [
    ...(reaction.proposedKnowledge?.operations ?? []),
    ...communicated,
  ];
  const proposedKnowledge = knowledgeOperations.length
    ? knowledgeDeltaSchema.parse({ version: 1, operations: knowledgeOperations })
    : undefined;
  const channels = [
    ...(reaction.proposedDelta.operations.length ? ["state" as const] : []),
    ...(knowledgeOperations.length ? ["knowledge" as const] : []),
    "relationship" as const,
    "consequence" as const,
  ];
  const proposal = eventProposalSchema.parse({
    proposalId: `npc-response-${contentHash({
      triggerEventId: input.triggerEvent.eventId,
      npcId: input.npcId,
      reaction,
    }).slice(0, 24)}`,
    branchId: input.branchId,
    expectedParentCommit: input.atCommit,
    source: "actor",
    actorId: input.npcId,
    title: reaction.eventTitle,
    actorObservations: [
      { actorId: input.npcId, summary: boundedText(reaction.npcObservation) },
      { actorId: input.playerId, summary: playerVisibleReaction(reaction) },
    ],
    ...(reaction.interaction?.kind === "speech"
      ? {
          spokenUtterances: [{
            speakerId: input.npcId,
            addresseeIds: [input.playerId],
            content: reaction.interaction.content,
            channel: "audible" as const,
          }],
        }
      : {}),
    actorAffects: [{ actorId: input.npcId, ...reaction.emotion }],
    participants: [input.npcId, input.playerId],
    participantPresence: [input.npcId, input.playerId].map((entityId) => ({ entityId, mode: "physical" as const })),
    proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
    preconditions: reaction.preconditions,
    proposedDelta: reaction.proposedDelta,
    ...(proposedKnowledge ? { proposedKnowledge } : {}),
    causalParents: [input.triggerEvent.eventId],
    evidence: [],
    progress: {
      version: 1,
      channels: [...new Set(channels)],
      threadIds: [],
      noveltyKey: npcReactionNoveltyKey(input.triggerEvent.eventId, input.npcId, reaction.responseKind),
    },
  });
  const gate = await validateActionKnowledge(input.engine, {
    proposal,
    requiresKnowledge: reaction.requiresKnowledge,
    forbidsKnowledge: reaction.forbidsKnowledge,
  });
  if (!gate.accepted) {
    throw new Error(`NPC response failed knowledge gate: ${gate.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  }
  const committed = await input.engine.commitProposal(proposal);
  if (!committed.report.accepted || !committed.eventHash) {
    throw new Error(`NPC response failed engine validation: ${committed.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ") || "missing event hash"}`);
  }
  return {
    newHead: committed.newHead,
    event: {
      eventHash: committed.eventHash,
      title: reaction.eventTitle,
      actorId: input.npcId,
      responseKind: reaction.responseKind,
      emotion: structuredClone(reaction.emotion),
      trace: {
        candidate: structuredClone(reaction),
        proposal: structuredClone(proposal),
        validation: structuredClone(committed.report),
      },
    },
  };
}

function npcExchangeStagnationDepth(
  history: Awaited<ReturnType<typeof committedHistory>>,
  playerId: string,
  npcId: string,
): number {
  let depth = 0;
  for (const { event, delta } of [...history].reverse()) {
    if (event.title === "Genesis") break;
    if (!event.participants.includes(playerId) || !event.participants.includes(npcId)) continue;
    const sceneMoved = Boolean(event.progress?.scene && event.progress.scene.kind !== "stay");
    if (delta.operations.length || event.knowledgeDeltaHash || event.timeAdvance || sceneMoved) break;
    depth += 1;
  }
  return depth;
}

function reactionAsPlayerCandidate(reaction: NpcReactionCandidate, playerId: string): PlayerActionCandidate {
  return playerActionCandidateSchema.parse({
    title: reaction.eventTitle,
    intent: {
      kind: "act",
      summary: reaction.eventTitle,
      controlledAct: {
        eventTitle: reaction.eventTitle,
        actorObservation: reaction.npcObservation,
        ...(reaction.interaction ? { interaction: reaction.interaction } : {}),
      },
      targets: [{ kind: "entity", entityId: playerId }],
    },
    participants: [playerId],
    preconditions: reaction.preconditions,
    proposedDelta: reaction.proposedDelta,
    ...(reaction.proposedKnowledge ? { proposedKnowledge: reaction.proposedKnowledge } : {}),
    requiresKnowledge: reaction.requiresKnowledge,
    forbidsKnowledge: reaction.forbidsKnowledge,
  });
}

function playerVisibleReaction(reaction: NpcReactionCandidate): string {
  const expression = reaction.emotion.expression ? ` ${reaction.emotion.expression}` : "";
  if (reaction.responseKind === "speak" && reaction.interaction?.kind === "speech") {
    return boundedText(`面前的人回答：“${reaction.interaction.content}”${expression}`);
  }
  if (reaction.responseKind === "refuse") {
    const speech = reaction.interaction?.kind === "speech" ? `，并说：“${reaction.interaction.content}”` : "";
    return boundedText(`面前的人明确拒绝了你的要求${speech}${expression}`);
  }
  if (reaction.responseKind === "ignore") {
    return boundedText(`面前的人选择不回答你。${expression || ` ${reaction.playerObservation}`}`);
  }
  if (reaction.interaction?.kind === "gesture") {
    return boundedText(`面前的人向你做出动作：${reaction.interaction.description}${expression}`);
  }
  if (reaction.interaction?.kind === "physical") {
    return boundedText(`面前的人与你发生直接互动：${reaction.interaction.description}${expression}`);
  }
  return boundedText(`${reaction.playerObservation}${expression}`);
}

function boundedText(value: string): string {
  const characters = Array.from(value.trim());
  return characters.length <= 1_000 ? characters.join("") : `${characters.slice(0, 999).join("")}…`;
}

function npcReactionNoveltyPrefix(triggerEventId: string, npcId: string): string {
  return `npc-reaction:${contentHash({ triggerEventId, npcId }).slice(0, 32)}:`;
}

function npcReactionNoveltyKey(triggerEventId: string, npcId: string, kind: NpcResponseKind): string {
  return `${npcReactionNoveltyPrefix(triggerEventId, npcId)}${kind}`;
}

function responseKindFromNovelty(noveltyKey: string | undefined): NpcResponseKind {
  const parsed = npcResponseKindSchema.safeParse(noveltyKey?.split(":").at(-1));
  return parsed.success ? parsed.data : "other";
}
