# Design: Executable Narrative World Model

## 1. Problem statement

A novel is a natural-language record of one historical trajectory through a fictional world. A traditional knowledge graph can answer who, where, and what, but cannot reliably continue the world after a user changes a key event.

The research problem is therefore:

> How can a narrative text be compiled into a computational world model that remains internally consistent, can reconstruct its past, and can continue evolving after counterfactual intervention without treating the source's future as a mandatory script?

The product is split into two systems:

1. **Novel Compiler Harness** — understands the complete source and compiles evidence-backed world artifacts.
2. **World Runtime** — advances one branch from committed history, active rules, actor state, and a frontier of possible future developments.

The long-term product is not a novel RAG chatbot. It is closer to an executable world system whose narrative text is one observation and one rendering of world history.

See [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md) for the temporal model and future-direction decision.

## 2. Core world-model thesis

The architecture follows four separations.

### World truth vs narrative

World truth records what has been committed to a branch. Narrative is a rendered or source-observed view of that truth. Changing prose must not silently change the world.

### Committed history vs future possibility

The compiler may know the complete canonical story, but a runtime branch only treats events at or before its current head as committed truth. Later canonical events become references, causal evidence, replay expectations, or future possibilities.

### Events vs state

Events and their validated state deltas are authoritative. `WorldState(branch, t)` is a projection of committed history, with snapshots used only as reproducible caches.

### Engine invariants vs in-world rules

Engine invariants protect data and simulation integrity. In-world rules are temporal world data and may change because of committed events.

## 3. Compiler/runtime and temporal separation

```text
Source Novel
    │ complete evidence, including future canon
    ▼
Compiler Harness
    │ proposals -> validate -> commit
    ▼
NWIR / Local world files
    │
    ├── Canonical Record
    ├── Entities / claims / evidence
    ├── Temporal world rules
    ├── Character knowledge / goals / models
    ├── Causal constraints
    └── Narrative/meta semantics
    │
    ▼
World Runtime
    │
    ├── Branch committed history
    ├── WorldState(branch, t) projection
    ├── Active rules
    ├── Possibility frontier
    └── Actor/background proposals
    │
    ▼
Validated committed events
    │
    ▼
Narrative renderer
```

The compiler may inspect the complete source. Runtime characters may not. Future canonical knowledge must never leak automatically into actor knowledge or active branch truth.

## 4. NWIR

NWIR (Novel World Intermediate Representation) is the stable semantic boundary between source understanding and simulation.

### L1 Evidence
Every structured claim points back to a source span.

### L2 Canonical record
Orders source-observed events with absolute, relative, approximate, and uncertain time. This is the complete canonical trajectory known to the compiler, not the automatically committed future of every runtime branch.

### L3 Semantic graph
Stable identities and typed relationships: characters, locations, factions, artifacts, concepts, institutions, etc.

### L4 Event graph
Events are first-class transitions with participants, preconditions, outcomes, evidence, and causal dependencies.

### L5 Dynamic world history and state
Committed events plus deterministic `StateDelta`s are authoritative for a branch. `WorldState(branch, t)` is reconstructed from history, active rules, and optional snapshots.

### L6 Epistemic model
Tracks what each actor knows, believes, suspects, or has heard. Actor knowledge is branch/time-scoped and distinct from compiler omniscience.

### L7 Causal and possibility model
Separates temporal adjacency from dependency, precondition, pressure, blocking condition, and candidate future developments.

### L8 Rule model
Represents temporal in-world constraints separately from engine invariants.

### L9 Narrative semantics
Themes, motifs, arcs, foreshadowing, dramatic irony, framing, genre expectations, and literary interpretation. This layer informs analysis and rendering but is never treated as world truth.

## 5. Core primitives

### SourceSpan
Immutable evidence location inside the original source.

### Entity
Stable identity only. Dynamic attributes such as current title, faction, inventory, location, health, allegiance, or permission live in temporal state or relations.

### Claim
A normalized proposition with provenance and epistemic type:

- explicit fact
- narrator claim
- character claim
- rumor
- inference
- interpretation

### Relation
A typed relationship with temporal validity where required.

### CanonicalEvent
An evidence-backed event observed on the source novel's canonical trajectory.

A canonical event after a runtime branch head is not automatically true on that branch.

### CommittedEvent
An event accepted by validation/adjudication into one branch's authoritative history.

### StateDelta
The deterministic change produced by a committed event.

### WorldSnapshot
A materialized checkpoint used to avoid replaying the entire event log. It is a cache and must be reproducible from history plus the applicable model/rule versions.

### KnowledgeFact
Actor-scoped information or belief with confidence, source, branch, and validity interval.

### CharacterGoal / CharacterModel
Goals, values, traits, plans, and decision tendencies inferred from repeated source evidence. These are policy/model inputs, not canonical facts unless separately supported.

### WorldRule
An in-world temporal constraint or mechanism with activation/validity conditions. Examples include institutional procedures, active laws, faction policies, communication constraints, treaties, magical restrictions, or other world-specific mechanisms.

### Possibility
An uncommitted future candidate. A possibility may contain a time window, preconditions, blocking conditions, actors/resources, causal parents, provenance, optional canonical reference, priority/pressure, expiry conditions, and proposed effects.

Probability may inform scheduling policy but does not turn a possibility into truth.

### Branch
A timeline fork with parent/fork metadata and its own committed history. The branch head determines what is historical truth for that runtime.

### NarrativeObservation
A source or generated interpretation/rendering of world events that remains separate from committed truth.

## 6. Compiler harness loop

The harness is gap-driven rather than chapter-driven.

```text
Audit world model
      │
      ▼
Find highest-value gap
      │
      ▼
Plan build task
      │
      ▼
Load evidence
      │
      ▼
Typed worker proposal
      │
      ▼
Schema + deterministic validation
      │
      ▼
Cross-model consistency checks
      │
      ▼
Commit or reject
      │
      ▼
Recompute coverage / replay confidence
      └──────────── loop
```

Task priority should approximate:

```text
importance × uncertainty × downstream_dependencies × runtime_relevance
```

The project should prefer model-first experiments on a constrained slice of one novel over maximizing parser coverage before the world abstractions stabilize.

### Worker roles

- controller
- segmenter
- entity extractor
- entity resolver
- event extractor
- timeline builder
- dialogue/information-transfer analyzer
- state-delta builder
- rule extractor/modeler
- epistemic builder
- character modeler
- causality builder
- possibility builder
- narrative/meta analyzer
- verifier
- adjudicator
- replay evaluator

Workers may share LLM profiles, but their prompts, tools and output contracts remain separate.

## 7. Completion/readiness

A single pass over the text is not sufficient. The compiler reports explicit readiness metrics, for example:

- source coverage >= 0.99
- evidence binding >= 0.99
- entity resolution >= 0.99
- major event resolution >= 0.98
- temporal consistency >= 0.99
- state-delta coverage >= 0.95
- epistemic coverage >= 0.90
- causal coverage >= 0.90
- rule coverage appropriate to the constrained runtime slice

Runtime readiness additionally requires invariant checks, deterministic state replay, and canon replay tests.

Coverage is not enough by itself. A model that parses every chapter but cannot replay or survive one important divergence is not runtime-ready.

## 8. Canon replay

Canon replay is a system-level evaluation, not scripted playback.

Start from canonical initial conditions and run the runtime with canonical decisions/policies and source-derived pressures. Compare resulting checkpoints with canonical checkpoints.

A large mismatch indicates errors in at least one of:

- world state
- event effects
- character goals/models
- epistemic propagation
- active rules
- causality
- possibility generation
- background scheduling

A mismatch is evidence that the world model is incomplete. It is not a reason to inject the missing event because it appears later in the book.

Canonical future events may be used as evaluation targets and sources of causal structure, but they do not become committed runtime truth until the runtime reaches and validates an appropriate event.

## 9. World runtime: Move pipeline

Each meaningful world advance is a **Move** rather than a chapter step.

```text
Current branch head
   ↓
Project WorldState(branch, t)
   ↓
Resolve active temporal rules
   ↓
Refresh actor knowledge, goals, obligations, and possibility frontier
   ↓
Player / NPC / background proposals
   ↓
Precondition + rule + resource + knowledge validation
   ↓
Conflict adjudication
   ↓
Committed events
   ↓
Deterministic StateDelta reduction
   ↓
Knowledge propagation / rule activation or retirement
   ↓
Refresh possibility frontier
   ↓
Branch/divergence update
   ↓
Narrative renderer
```

### Proposal/commit separation

LLMs may propose events, interpretations, plans, or candidate causal links. Only validated/adjudicated code can commit world-changing events.

The first model-side write capabilities should therefore be narrow typed proposal tools such as `propose_event`, `propose_rule`, or `propose_state_delta`, not a general file-write tool.

### Fog of war

Narration receives the player character's perceived view when appropriate, not unrestricted compiler truth. Actor reasoning cannot use future canon unless that actor has an evidence-backed reason to know it.

## 10. Possibility frontier and scheduling

The runtime does not store one fixed future timeline. It maintains a frontier of candidate developments.

Possibilities may come from:

- source-observed future canonical events decomposed into conditions/pressures;
- actor goals, plans, promises, threats, obligations, or queued actions;
- causal consequences of committed events;
- institutions and active world rules;
- environmental/background processes;
- grounded model proposals.

The scheduler evaluates candidates against the current branch state and active rules.

A candidate can be:

- latent — not yet eligible;
- eligible — preconditions currently hold;
- blocked — an explicit blocker exists;
- expired/canceled — its window or causal basis is gone;
- transformed — branch divergence changes its form;
- committed — validation/adjudication accepted an event derived from it.

The scheduler should advance to meaningful changes rather than simulate every clock tick. Priority can consider urgency, causal pressure, actor intent, downstream impact, and runtime relevance.

### Canon as attractor, not scheduler

Canon events are not fired because their canonical timestamp arrives. The compiler should instead extract why they occurred: intentions, dependencies, opportunities, pressures, rules, and background conditions.

If those conditions survive on a divergent branch, an analogous event may remain likely or structurally attractive. If they disappear, canon should not reassert itself by fiat.

## 11. Dynamic rules

Rules require two layers.

### Engine invariants

Integrity constraints enforced by deterministic code. Examples:

- an event applies effects only after successful validation;
- branch history has deterministic ordering;
- references must resolve;
- one exclusive artifact cannot have two simultaneous owners unless the world model explicitly represents duplication;
- an actor cannot occupy incompatible locations simultaneously unless the fiction explicitly allows it.

### In-world rules

Temporal world constraints represented as data. Examples:

- a faction's chain of command;
- a law or decree active during a period;
- a treaty;
- communication availability;
- an institutional procedure;
- a magical restriction;
- permissions or prohibitions that change after a political event.

Committed events may activate, amend, suspend, or retire in-world rules. Rule validity must therefore be branch/time-aware.

## 12. Time

Time is a first-class coordinate rather than an incidental chapter field.

The runtime uses adaptive scale:

- dialogue: seconds/minutes
- scene: minutes/hours
- travel: days
- campaigns: days/months
- politics: months/years

Events may have absolute, relative, approximate, uncertain, or interval-based time. Possibilities may specify earliest/latest windows rather than one fixed timestamp.

Historical queries are always branch/time scoped: "Where is this character now?" is shorthand for `WorldState(activeBranch, headTime)`.

## 13. NPC execution tiers

Running a frontier LLM for every character continuously is infeasible.

- Tier 1 background actors: deterministic rules/state machines/background pressures
- Tier 2 relevant actors: compact policies or smaller model calls
- Tier 3 scene actors: full agent reasoning

Promotion/demotion is based on scene relevance, causal impact, open goals, and interaction with the active possibility frontier.

Character decisions are proposals conditioned on the actor's own knowledge and goals, not compiler omniscience.

## 14. Storage

Phase 0 uses human-readable, workspace-local files under `.novel-harness/` for project metadata, source manifests, compiler jobs, readiness metrics, and Pi sessions. Writes use atomic rename, and source documents remain ordinary local files.

The executable NWIR format remains a later implementation decision. Early formats should optimize for inspectability, evidence provenance, replayability, and migration rather than premature scale.

If scale, concurrent workers, or transactional branch execution eventually require a database, introduce it behind the storage boundary with a migration plan. A graph or vector database is not required for source discovery; lexical file search remains the default retrieval path.

## 15. LLM/program boundary

Use LLMs for:

- semantic interpretation
- typed extraction proposals
- ambiguous entity resolution candidates
- character reasoning
- candidate goals and plans
- candidate causal links
- candidate future possibilities
- dialogue generation
- narrative/meta analysis
- narrative rendering

Use deterministic code and storage constraints for:

- stable identity
- branch/versioning
- event ordering and commitment
- state-delta application
- location/resource/accounting constraints
- active-rule resolution
- knowledge visibility boundaries
- schema/reference integrity
- replay checks
- runtime invariants

An LLM verifier can criticize or add evidence, but it does not replace deterministic validation for committed world truth.

## 16. Runtime invariants

Examples:

- dead actors cannot act unless the world model explicitly represents a mechanism that changes that condition;
- direct dialogue requires a valid communication channel;
- exclusive artifacts cannot have simultaneous owners unless explicitly duplicated;
- actor knowledge must have a propagation source;
- event effects are applied only after successful resolution;
- one actor cannot occupy incompatible locations at the same time;
- future canonical events are never automatically committed to a divergent branch;
- narrative/meta artifacts never mutate world truth directly.

## 17. Rewrite and continuation semantics

The architecture must distinguish two operations that are often both called "rewrite."

### Narrative rewrite / retelling

Keep the same committed branch history and change the narrative rendering: voice, viewpoint, pacing, emphasis, genre, scene selection, or prose style.

World truth does not change.

### Counterfactual rewrite / continuation

Fork from an event/time, commit a different action or outcome, and continue from the new branch history. State, actor knowledge, active rules, causal pressures, and future possibilities must evolve from that divergence.

The system must not quietly reconstruct the canonical future unless its conditions genuinely re-emerge.

## 18. MVP sequence

### Phase 0 — local-first harness CLI

Claude Code-style terminal interaction backed by Pi, workspace instructions, `rg`-first local read/search tools, bounded `@file` context, persistent local-file sessions/state, configuration, and the harness task-loop skeleton. No external database, RAG layer, or write-capable model tools.

### Phase 1 — executable canonical slice

For a constrained slice of one novel, define typed `CanonicalEvent`, `CommittedEvent`, `StateDelta`, `WorldRule`, and `Branch` contracts; compile evidence-backed events/rules; implement deterministic validation and `WorldState(branch, t)` reduction; verify deterministic history replay.

### Phase 2 — possibility scheduler and canon replay

Implement the minimal possibility frontier, causal/precondition handling, adaptive scheduling, and canon replay. Reproduce canonical checkpoints without directly forcing future canonical events.

### Phase 3 — actor and counterfactual runtime

Implement epistemic state, goals, character policy, player control, branch divergence, background pressures, and one high-impact intervention that produces durable downstream differences.

### Phase 4 — narrative quality and broader compilation

Expand extraction breadth across full novels, improve long-horizon narrative rendering and retelling, add dynamic arcs/meta-aware rendering, and build a polished TUI/UI.

## 19. Primary success criterion

The system succeeds when it can:

1. compile a source-backed canonical world model;
2. reconstruct historical state deterministically;
3. replay an important canonical slice from modeled causes rather than scripted future events; and
4. accept a high-impact player intervention that creates durable downstream differences without breaking world invariants or silently steering back to canon.

That behavior, rather than parser coverage alone, is the defining test of Novel World Harness.
