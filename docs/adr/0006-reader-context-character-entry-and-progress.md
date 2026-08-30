# ADR 0006: Reader context, character entry, presence, and material progress

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** Novel onboarding, alternate-role checkpoints, participant presence, scene progression, and open-world pressure

## Context

A player who has not read the source novel cannot understand an opening scene
from actor-visible state alone. Conversely, giving the selected actor a synopsis
would violate knowledge isolation. The former runtime also treated every event
participant as physically present when locations were sparse. A letter author or
named addressee could therefore become an apparent room occupant and trap play in
an invented conversation.

Role selection had a separate temporal error: branches were created before the
role was chosen and every source character was offered immediately. A supporting
character could be inhabited at the protagonist's opening even when the source
did not introduce that character until much later.

Finally, accepted no-op dialogue and observe/stay events carried progress metadata
without necessarily changing state, knowledge, time, or scene. Narrator choice
capture was optional and the host discarded its own preflighted routes, so a valid
world could appear to have no way out of a repeated exchange.

## Decision

### 1. Separate reader onboarding from actor knowledge

For the opening checkpoint, `InitialWorld.readerSetup` supplies a concise,
source-grounded, spoiler-free explanation of where, when, who, the premise needed
to understand the scene, and the immediate unresolved situation. Its separate
`participantPresence` must mark an actionable opening role as physically present;
identity, alive state, mention, memory, or representation is insufficient. For a later
character checkpoint, the host derives an ordered `ReaderEntryContext` from every
canonical event already presented before that entry. Each beat carries
a source-grounded completed-event recap, participant names, narrative mode/story
time, and known causal-parent titles. It is rendered as a display-only
`nwh-play`/CLI preface labelled “故事前情” when prior beats exist; an opening
checkpoint with no prior beats skips the empty recap. The player-facing preface
never explains character-knowledge boundaries or uses engine terminology. A later
role is not offered if any preceding event lacks its recap. Reader context is
never written to `KnowledgeDelta`, world state, scene narration input, NPC input,
or player-action model input. Actor capability and claims continue to come only
from committed state, learned claims, and actor observations.

### 2. Select the role before creating its branch

The prepared revision derives one grounded entry per playable character:

- an opening entry requires meaningful opening dynamic state, not catalog identity
  or a bare alive flag for a multi-character source;
- a later entry requires an embodied canonical scene plus a per-character
  source-backed pre-event checkpoint;
- mention, remote participation, representation, dream, and memory do not establish
  a lived entry.

A later-role genesis uses the accepted initial world plus main-timeline canonical
effects strictly before the entry, followed by the checkpoint's already-true
state and knowledge. The checkpoint must give the selected actor a location,
plan, or momentum, explicit physical presence, and a direct actor-visible opening
observation. Its separate reader setup may orient the human but never enters the
actor frame. Prior canonical IDs are recorded as realized by genesis. The entry
event and its outcome are not realized or copied into the checkpoint, preserving
player agency at that scene. The branch pins its prepared revision. If a step-zero
opening branch already exists—even if it has been viewed or saved—it remains
unchanged and the host creates a sibling entry branch. Existing branch history is
never rewritten.

### 3. Make participation and physical presence distinct

Canonical events, possibilities, proposals, and committed events may carry
`participantPresence` with `physical`, `remote`, `mentioned`, `represented`,
`dream`, or `memory`. Presence entries refer only to character participants.
Scene projection adds only physical characters. Legacy actor/observation events
remain readable; legacy background/canonical flat participant lists fail closed.

The compiler prompt requires explicit presence for character participants, and
novel-scale audit measures its coverage. `序幕`, `序言`, `前言`, `引子`, and their
English counterparts are first-class section headings, so title/front matter no
longer consumes or hides the prologue batch.

### 4. Certify material progress and retain executable exits

`PlayerProgressCertificate` distinguishes a true scene transition from `stay`,
records explicit time advance, and reports whether state, knowledge, time, or
scene materially advanced. The director counts trailing actor events lacking all
four. After repeated stagnation it raises structural moves, stateful actions, and
wait actions above more empty conversation.

The narrator still does not see private host affordances. After narration, the UI
merges model suggestions with a bounded set of host-preflighted current-head
actions. Selecting a host action resolves its opaque ID at the current head and
still passes normal deterministic gates. An explicit wait advances five minutes
and permits at most one currently eligible autonomous obligation, causal
consequence, background pressure, environmental process, or generated world
process to commit. If none is eligible, the clock still advances, so the action
is material progress rather than another conversational no-op. It does not
schedule a forward canon analogue. Other turns retain zero automatic background
scheduling.

Reactive NPC reasoning also receives a repetition depth. At depth two or greater
it must not merely paraphrase the same answer: it may communicate a new known
claim, make a permitted concrete decision, refuse/disengage, or end the exchange,
but may not invent novelty.

### 5. Derive branch motion from causal machinery, not canon replay

Compilation separates five products of the source novel instead of treating its
next paragraph as the runtime scheduler:

1. completed canonical events provide evidence, reader recaps, and a replay/eval
   baseline;
2. world rules constrain which proposals can commit;
3. current character goals provide bounded actor-owned actions with completion or
   expiry conditions;
4. obligations, causal consequences, background pressures, and environmental
   processes encode source-grounded mechanisms that can remain valid after a
   divergence; and
5. future canonical events remain canon-analogue possibilities that require a
   direct causal selection, never mere chronological eligibility.

At runtime, committed event history is primary and projected state is the input
to eligibility. A player act can cause one separately validated immediate world
response; a co-present or active-goal actor can commit its own scoped event; an
explicit wait can admit one eligible autonomous non-canon process. Each accepted
event changes the next projection and therefore the next possibility frontier.
Narrator prose and a compiler's knowledge of later chapters never enter this
feedback loop as truth.

This is deliberately not unrestricted invention. When the compiled source has no
actionable goal or autonomous mechanism, the clock can still move but the host
cannot safely fabricate a substantive development. Novel-scale audit therefore
fails that compilation rather than hiding the missing causal machinery behind
repetitive dialogue or silently replaying canon.

### 6. Audit for an executable world, not only extracted plot

Novel-scale semantic readiness now checks:

- explicit participant-presence coverage;
- explicit physical presence for the actionable opening role;
- a spoiler-free reader setup for the opening checkpoint;
- a reader recap for every canonical event;
- a complete actionable checkpoint for every later embodied character;
- an opening location, plan, or momentum for a lived actionable checkpoint; and
- at least one executable actor goal or non-canonical autonomous possibility.

The compiler is asked to encode source-grounded obligations, causal consequences,
background pressures, environmental changes, deadlines, institutional responses,
and resource processes with typed effects and conditions. Future canon remains a
possibility, never active branch truth merely because it was compiled.

## Consequences

- An unread player receives enough source-grounded orientation without gaining
  illicit character knowledge.
- Supporting roles begin where they actually enter the source, while prior canon
  is checkpoint truth and future canon remains undecided.
- Letters, signatures, reports, and memories no longer create phantom roommates.
- Repeated prose cannot indefinitely masquerade as world progress; at least one
  deterministic executable route remains visible.
- Explicit waiting can let the world act, but ordinary turns do not silently put
  canon back on rails.
- Prepared caches compiled before this decision are incompatible and require
  reparse. Existing branches remain pinned/replayable and are never silently
  upgraded; the UI tells the player to create a fresh instance for corrected
  semantics.
