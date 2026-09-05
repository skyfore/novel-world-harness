# ADR 0005: Conversation continuity and reactive NPC responses

- **Status:** Accepted
- **Date:** 2026-08-21
- **Scope:** Player transcript continuity, model context retrieval, directed interaction, NPC response, affect, and causal commitment

## Context

Committed event summaries are necessary world evidence, but they are a poor
substitute for the exact latest conversation. Repeatedly sending only a compact
commit summary loses wording, reference, conversational promises, unanswered
questions, and the distinction between a player request and its eventual world
result. That can make otherwise related turns look like independent tests.

The previous automatic actor lane also required a compiled character goal or
model before it could produce a candidate. A player could direct a clear
question at a present NPC, commit the player's act successfully, and still get
no NPC event. The scene narrator then had no response to render. More prompt
history alone cannot repair a missing response execution path.

## Decision

### 1. Keep presentation memory separate from world truth

Each playable branch has a durable presentation-message log under the
user-level world store. Every message is attached to a branch, actor, and
committed head:

- player text is marked `accepted` or `rejected` and remains untrusted action
  text;
- scene prose is marked `rendered` and remains presentation-only;
- neither form can mutate or override committed state, actor knowledge, event
  history, or active rules.

Reads are filtered by selected embodied actor, commit ancestry, and branch
lineage. Switching characters cannot expose another character's private player
wording through this memory plane. A fork inherits
only messages that existed on its parent lineage at the time of the fork; later
parent conversation does not leak into the child.

Every runtime Pi role that needs conversational continuity receives the latest
ten exact messages: player-action translation, world adjudication, immediate
world-response linking, and scene narration. The current committed projection
always wins a conflict with transcript text.

The full safe archive is not placed wholesale in the prompt. Two read-only
tools form the conversation-recall capability:

- `find_related_messages` performs bounded lexical/relevance search;
- `read_related_message` returns one exact, Unicode-safe paged record.

The tools have a shared call budget and can search only the already selected
branch-safe or actor-safe corpus supplied by the host. They cannot search novel
files, another branch, hidden world state, or another character's private
history.

### 2. Represent directed player interaction explicitly

`PlayerControlledAct` may carry a typed `interaction`:

- exact speech plus direct addressee characters;
- a visible gesture plus direct addressees; or
- a physical interaction plus direct addressees.

Every addressee must be a present, referenceable character and a participant
in the player event. On commit, the host writes a separate exact actor
observation for each addressee. A desired reply remains outside player agency.

This typed edge is the deterministic trigger for NPC response. Natural-language
matching is not used to guess whether a user addressed someone.

### 3. Use a dedicated reactive NPC lane

After the player interaction commits, each directly addressed NPC is evaluated
even when the compiler provided no active goal or character model. The NPC
reasoner receives only:

- its actor-scoped visible state, writable capabilities, and acquired
  knowledge;
- the exact committed trigger as that NPC perceived it;
- its latest ten perceived events and read-only retrieval over its complete
  perceived event history;
- effective disposition, current development, lived experiences, active goals,
  and most recent event-scoped affect when available;
- currently active world rules as private host constraints, explicitly not as
  facts the NPC may claim to know.

The model must submit one typed `NpcReactionCandidate`: speak, gesture, refuse,
ignore, or another concrete perceptible response. Speech includes exact words.
Refusal and silence are valid character choices, but they still produce an
explicit player-visible event. An omitted or failed tool call is never silently
reinterpreted as mysterious in-world silence.

The candidate is a proposal only. Stable IDs are replaced with turn-local
opaque handles at the Pi boundary. Host code restores those handles and applies
actor scope, state grounding, spatial scope, knowledge, active-rule, invariant,
and optimistic-head validation before commitment. A claim communicated by the
NPC must already be in that NPC's actionable knowledge and reaches the player
as sourced hearsay.

### 4. Commit causality and affect in event history

An accepted NPC response becomes an ordinary `source: actor` event whose causal
parent is the triggering player event. Its progress key is unique to the
trigger/NPC pair, making retries idempotent and keeping the response replayable.
The direct response consumes the corresponding automatic actor slot so the old
goal scheduler does not append a second generic reaction.

`actorAffects` records event-scoped emotion with an actor, label, intensity,
and optional outward expression. Affect continuity is derived from the latest
committed actor event; it is not a parallel mutable character timeline. The
player receives only the NPC's perceptible response/expression, while the NPC's
own next reasoning turn may use its prior affect.

If response generation or validation fails after the player's action has
committed, the error is retained in the turn audit and surfaced out of
character. The committed player action remains true, but the system does not
pretend the infrastructure failure was an NPC decision.

## Consequences

- Later turns can resolve pronouns, repeated questions, conversational promises,
  and scene references without treating summaries as full dialogue.
- Transcript continuity is branch-aware but non-authoritative; replayable world
  truth still comes only from committed events.
- NPCs can answer direct interaction without requiring a pre-authored goal.
- Character knowledge, private perception, world constraints, emotional
  continuity, and player-visible expression remain separate projections.
- One direct interaction can require additional model calls, one per addressed
  NPC. The lane therefore remains bounded by the interaction addressee limit and
  per-request retrieval/tool budgets.
- Existing transcripts created before this store was introduced are not
  promoted to world truth. New messages become durable continuity records as
  play proceeds.

## Open compiler research question

No compiler schema is changed by this decision. After the runtime behavior is
evaluated on real conversations, a separate research phase should ask which
source-level structures would materially improve NPC continuity rather than
merely increasing extraction volume:

1. **World:** Which social norms, institutions, physical constraints, and
   metaphysical assumptions behave as versioned rules, and which are only
   narrator interpretation?
2. **Events:** Which dialogue acts, promises, refusals, revelations, causal
   dependencies, and unresolved questions need typed event semantics or
   participant-specific observations?
3. **Characters:** Which beliefs, misconceptions, relationships, voice
   patterns, values, coping strategies, and conversational boundaries are
   evidence-backed and stable enough to compile?
4. **Growth:** Which experiences truly change traits, goals, affect regulation,
   identity, or moral commitments, and what observable activation/completion
   boundaries support those changes?
5. **Philosophy:** Which recurring value conflicts and worldview commitments
   constrain choices without becoming a deterministic personality script or a
   hidden canonical scheduler?

The research should begin from runtime failure traces—unanswered interactions,
unsupported claims, flat affect, incoherent reversals, and causally weak
responses—and compare targeted schema additions against prompt-only baselines.
Any accepted addition must retain source evidence, temporal activation, actor
knowledge isolation, branch divergence, and proposal-before-commit semantics.
