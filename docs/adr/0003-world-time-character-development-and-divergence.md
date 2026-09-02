# ADR 0003: One event history drives world time, character development, scenes, and divergence

- **Status:** Accepted
- **Date:** 2026-08-17
- **Scope:** Compiler, prepared revisions, branch projection, actor policy, scenes, possibility frontier, and play
- **Extends:** [ADR 0001](0001-world-truth-history-and-possibility-space.md)

## Context

A novel does not contain only a sequence of plot summaries. It describes a bounded society in which people age, learn, lose resources, change status, form obligations, damage places, enter institutions, and respond differently after lived experience. Its textual order may also differ from world chronology through narrator frames, memories, flashbacks, summaries, and foreshadowing.

The first compiler/runtime slice could order commits and store sparse state transitions, but that is not enough for a local world engine:

- a commit step cannot stand for a year, a chapter, or a character's age;
- a narrator's discourse order cannot be treated as world chronology;
- one static character model cannot faithfully describe both an early and late self;
- an event title without typed consequences cannot change the later scene;
- a player choice that replaces a cause must retire its canonical descendants, not leave them latent forever;
- independently extracted source batches require a whole-world consistency pass before publication.

The design needs richer temporal behavior without introducing a second mutable timeline for every character or a clock-tick simulation of the whole universe.

## Decision

### 1. Use three world-time representations and keep discourse metadata separate

Every committed branch has:

1. **Logical time (`step`)** — a deterministic total order used by replay and optimistic concurrency.
2. **Story time (`StoryTime`)** — an evidence-backed calendar, interval, ordinal, or relative anchor. It may remain uncertain.
3. **Elapsed world time (`elapsedDays`)** — a deterministic cumulative duration used by ageing, deadlines, decay, recovery, and temporal predicates.

`NarrativeContext` is not a fourth world clock. It records textual layer, discourse order, viewpoint, and whether a passage is a frame, recollection, flashback, flashforward, scene, summary, or hypothetical. Changing narrative order never changes branch truth.

```text
text order:       frame(now) -> memory(then) -> frame(now)
world chronology: memory(then) ----------------> frame(now)
commit order:     0 -> 1 -> 2 ... on the selected playable branch
elapsed time:     0d -> duration accumulated by committed events
```

An accepted event may carry `timeAdvance`. If it moves from one comparable calendar anchor to a later one without an explicit duration, the engine deterministically infers the elapsed calendar gap. Unknown event time preserves the last known story anchor; it never erases it. A proposal with a definitely earlier story time is rejected on an active forward branch.

When a player explicitly waits, the host—not the model—parses and caps the duration. It advances both `elapsedDays` and any safely comparable calendar anchor (including leap days and calendar month/year boundaries). If the anchor is relative or otherwise unorderable, only `elapsedDays` advances; the engine does not manufacture a false date.

Counterfactual exploration of an earlier point uses a branch fork or a different opening checkpoint, not a backwards commit.

### 2. Genesis names one coherent checkpoint

`InitialWorld.checkpoint` identifies whether genesis is:

- the earliest playable chronological scene;
- the textual narrator frame;
- or a deliberately chosen custom checkpoint.

It may name a story-time anchor, narrative layer, and the first canonical event that follows it. State and knowledge from different temporal layers must not be merged into one genesis. In particular, a remembered younger self and an older narrating self are different temporal projections of one stable entity identity.

The checkpoint is optional only for reading legacy artifacts. New compiler prompts and prepared-revision fingerprints require the new temporal pipeline, and novel-scale semantic audit reports a missing checkpoint.

### 3. Time changes the world only through deterministic projection or committed events

The engine does not simulate every second. Time-dependent change has two forms:

- **Deterministic continuous projection:** an already-known living character age advances with `elapsedDays`. Unknown age remains unknown; the engine does not invent it. A dead character's biological age stops advancing.
- **Discrete world change:** illness, recovery, crop failure, building decay, institutional reform, births, deaths, travel, resource use, and social consequences are typed event effects or eligible temporal possibilities. They must be validated and committed before becoming truth.

Temporal world rules can use story-time and elapsed-day predicates. They constrain proposals but do not directly write state. A rule-triggered change therefore appears as an environmental, institutional, causal, or background possibility whose state delta is committed through the normal event path.

This avoids both silent prompt-side mutation and wasteful clock-tick simulation.

### 4. One atomic occurrence may have multiple simultaneous typed effects

An event is split at a genuine causal or sequential boundary, not at an arbitrary “one field per event” boundary. One death, marriage, conscription, sale, flood, or departure may update several participants, a relationship, resources, knowledge, and a location in the same `StateDelta`.

The compiler permits up to 16 typed operations for one atomic event. Large sequences must still be separated. This keeps replay atomic: later possibilities never observe half of one occurrence.

The shared state registry includes explicit fields for age, health, experience, reputation, wealth, artifact custody/quantity/condition, location condition/control, institutions, factions, and relationship entities. A relationship is an entity with stable endpoints and dynamic kind, strength, activation, and obligations. Unsupported semantics remain claims; the compiler must not force them into a nearby but incorrect field.

### 5. Character development is a projection over the same branch history

A character does not own an independent authoritative timeline. `CharacterDevelopmentView(actor, branch, t)` is derived from:

- the branch's committed events involving that actor;
- canonical events actually realized on that branch;
- the actor's private acquired knowledge;
- current typed self and relationship state;
- active/completed/expired goals and achieved milestones;
- an evidence-backed baseline character model plus activated development phases.

A development phase may activate through:

- deterministic state predicates;
- an objective realized canonical event;
- a canonical event personally experienced by this character;
- acquired knowledge;
- or a story-time window.

Every development phase must name at least one such activation boundary; an always-on phase is rejected because the baseline model already represents the opening self. Phase modifiers are cumulative and bounded to `[-1, 1]`. They change effective traits and decision biases used by actor reasoning; they do not rewrite prior history. A canonical future phase cannot activate merely because the compiler knows the character's complete arc.

Character goals use the same distinction: `afterCanonicalEventIds` gates on an
objective transition committed anywhere in the branch, while
`afterExperiencedCanonicalEventIds` gates on that actor's personal participation.
Realizing an event for somebody else never activates a personal aftermath goal.

Actor reasoning also receives a bounded summary of that actor's recent committed lived experiences. This includes divergent player and background events, not only canonical event IDs, so branch-specific experience can influence later choices without exposing uncommitted canon or other actors' private knowledge.

Generic age bands are presentation-only derived hints. Culturally meaningful adulthood, office, kinship, mourning, marriageability, or legal capacity must be explicit world state/rules because societies differ.

### 6. Scenes are projections of persistent social and physical state

A scene is not only the newest prose beat. It is projected from committed location transitions, participants, current location state, and recent meaningful events. Location condition/control and relationship state therefore survive narration and can change what later actors perceive or do.

The actor-facing play frame includes cumulative elapsed time, safe story-time metadata, a character-development projection, and the current location's committed state. It still excludes uncommitted future canon, hidden world state, other characters' private knowledge, and compiler omniscience.

### 7. Butterfly effects propagate through causal invalidation

When a committed player/actor/background event replaces a canonical event, that canonical possibility becomes `superseded`. Any unrealized possibility that requires a superseded, expired, or already invalidated causal parent becomes `invalidated`; invalidation propagates transitively.

```text
player alternative
       │ supersedes
       ▼
canonical cause ──x──> canonical consequence ──x──> later consequence
       │
       └──────── committed alternative state/history
                         │
                         └──> eligible branch-specific consequences
```

Invalidation does not automatically invent an alternative future. Replacement developments come from state-driven actor goals, environmental/institutional possibilities, explicit causal templates, or a validated generated proposal. Canon remains an attractor only while its conditions and causal ancestry survive.

### 8. Local extraction is followed by whole-world reconciliation and semantic gates

`prepare-all` uses two semantic scales:

1. local evidence batches propose grounded identities, claims, events, goals, models, rules, and possibilities;
2. a bounded whole-world reconciliation pass targets missing effects, unknown time anchors, incoherent opening layers, and recurring characters without phase-bounded development.

Reconciliation can only submit typed replacement proposals. It does not edit canonical stores directly, and every replacement passes the same evidence, identity, reference-closure, temporal, and state-schema validation.

For novel-scale compilations (20 or more canonical events), publication is gated on minimum structural semantic coverage:

- at least 65% of events have a typed state or knowledge effect;
- at least 75% have a story-time anchor;
- at least 50% of recurring characters have phase-bounded goals or development phases;
- genesis declares a temporal/narrative checkpoint when it already exists.

These are readiness floors, not claims of full semantic accuracy. Prepared bundles also contain a compiler fingerprint covering the pipeline, prompt policy, engine version, and state registry. A legacy bundle cannot silently remain active after these semantics change; it must be reparsed into a new immutable revision. Existing branches remain pinned to their prior revision.

`prepare-all` detects such an incompatible active revision and routes it through the rollback-safe whole-novel reparse path instead of merely clearing resumable batch counters. After the new revision is published, it selects a fresh branch by default so an existing branch never silently changes its pinned world semantics.

## Validation and replay invariants

- Commit steps and elapsed days are monotonic.
- Definitely comparable story time cannot regress on a forward branch.
- Continuous effects are applied before event preconditions and deltas at the new time.
- State numeric bounds and entity applicability are deterministic.
- Character development is reproducible from history and knowledge.
- Narrative rendering cannot write any of these projections.
- Frontier `realized`, `superseded`, `expired`, and `invalidated` states are derived from branch history/current conditions.
- Canon replay and divergent play use the same clocks, event deltas, reducer, actor model, and frontier.

## Consequences

### Positive

- Long time jumps affect characters without manufacturing daily filler events.
- Flashbacks and narrator frames no longer contaminate opening chronology.
- Character behavior can change after personal experience without granting future knowledge.
- Social, institutional, physical, and relationship consequences persist into later scenes.
- Player choices have transitive causal consequences instead of temporarily hiding canon.
- Old prepared worlds are invalidated when compiler semantics change.

### Costs and limits

- The compiler must extract durations, temporal layers, effects, and phase triggers more carefully.
- Unknown age or duration remains unknown; the engine deliberately refuses to guess.
- A causal invalidation graph does not by itself generate the best alternative consequence.
- Relationship and institution extraction increases identity-resolution pressure.
- Readiness ratios catch broad omissions but cannot prove literary or sociological fidelity.
- Exact sub-segment evidence spans and richer global identity reconciliation remain follow-up compiler work.

These costs are accepted because they preserve a single auditable truth model while enabling the bounded social simulation the product requires.
