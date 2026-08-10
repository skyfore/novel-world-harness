# Design: Executable Narrative World Model

## 1. Problem statement

A novel is a natural-language description of one historical trajectory through a fictional world. A traditional knowledge graph can answer who, where, and what, but cannot reliably continue the world after a user changes a key event.

The research problem is therefore:

> How can a narrative text be compiled into a computational world model that remains internally consistent and can continue evolving after counterfactual intervention?

The product is split into two systems:

1. **Novel Compiler Harness** — understands and compiles the source.
2. **World Runtime** — runs the compiled world after a player enters it.

## 2. Compiler/runtime separation

```text
Source Novel
    │
    ▼
Compiler Harness
    │
    ▼
NWIR / Local world files
    │
    ├── Canon timeline
    ├── World snapshots
    ├── Character knowledge
    ├── Character goals/models
    └── Causal constraints
    │
    ▼
World Runtime
    │
    ▼
Alternate timeline
```

The compiler may inspect the complete source. Runtime characters may not.

## 3. NWIR

NWIR (Novel World Intermediate Representation) is the stable boundary between source understanding and simulation.

### L1 Evidence
Every structured claim points back to a source span.

### L2 Canon timeline
Orders events with absolute, relative, approximate, and uncertain time.

### L3 Semantic graph
Stable identities and typed relationships: characters, locations, factions, artifacts, concepts, institutions, etc.

### L4 Event graph
Events are first-class state transitions, not summaries.

### L5 Dynamic world state
`WorldState(t)` is reconstructed from snapshots plus committed event deltas.

### L6 Epistemic model
Tracks what each actor knows, believes, suspects, or has heard.

### L7 Causal model
Separates temporal adjacency from actual dependency, precondition, and effect.

### L8 Narrative semantics
Themes, motifs, arcs, foreshadowing, dramatic irony and literary interpretation. This layer is never treated as world truth.

## 4. Core primitives

### SourceSpan
Immutable evidence location inside the original source.

### Entity
Stable identity only. Dynamic attributes such as current title, faction, inventory, location, and health live in temporal state.

### Claim
A normalized proposition with provenance and epistemic type:

- explicit fact
- narrator claim
- character claim
- rumor
- inference
- interpretation

### Relation
A temporal edge with `valid_from` and `valid_until`.

### Event
Contains participants, timing, location, preconditions, observed actions, outcomes, and evidence.

### StateDelta
The deterministic change produced by a committed event.

### WorldSnapshot
Materialized state used to avoid replaying the entire event log.

### KnowledgeFact
Actor-scoped information with confidence, source and validity interval.

### CharacterGoal / CharacterModel
Goals, values, traits and decision tendencies inferred from repeated source evidence. These are probabilistic model inputs, not canonical facts unless explicitly stated.

### Branch
A timeline fork from canon or another branch.

## 5. Compiler harness loop

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
Worker proposal
      │
      ▼
Verifier
      │
      ▼
Commit or reject
      │
      ▼
Recompute coverage
      └──────────── loop
```

Task priority should approximate:

```text
importance × uncertainty × downstream_dependencies × runtime_relevance
```

### Worker roles

- controller
- segmenter
- entity extractor
- entity resolver
- event extractor
- timeline builder
- dialogue/information-transfer analyzer
- state-delta builder
- epistemic builder
- character modeler
- causality builder
- narrative/meta analyzer
- verifier
- adjudicator
- replay evaluator

Workers may share LLM profiles, but their prompts, tools and output contracts remain separate.

## 6. Completion/readiness

A single pass over the text is not sufficient. The compiler reports explicit readiness metrics, for example:

- source coverage >= 0.99
- evidence binding >= 0.99
- entity resolution >= 0.99
- major event resolution >= 0.98
- temporal consistency >= 0.99
- state delta coverage >= 0.95
- epistemic coverage >= 0.90
- causal coverage >= 0.90

Runtime readiness additionally requires invariant checks and canon replay tests.

## 7. Canon replay

Before users enter the world, run the runtime using canon decisions/policies and compare resulting checkpoints with canonical checkpoints.

A large mismatch indicates errors in at least one of:

- world state
- event effects
- character goals/models
- causality
- background scheduler

Canon replay is a system-level evaluation, not just extraction accuracy.

## 8. World runtime

Each runtime step follows:

```text
Player input
   ↓
Intent/action proposal
   ↓
Precondition validation
   ↓
NPC proposals + background pressures
   ↓
Adjudicator
   ↓
Committed events
   ↓
State reducer
   ↓
Knowledge propagation
   ↓
Branch/divergence update
   ↓
Narrative renderer
```

### Proposal/commit separation
LLMs may propose events. Only deterministic validation/adjudication code can commit them to the event store.

### Fog of war
Narration receives the player character's perceived view, not unrestricted world truth.

### Canon as attractor
Canon events are represented with causal preconditions. If those preconditions disappear on an alternate branch, the event is canceled or transformed. The runtime must never recreate an event merely because it exists in the book.

### Divergence
Each branch tracks how far it has departed from canonical state. As divergence rises, future canon guidance decays. At a configured threshold, future canon is ignored except for invariant world rules and independent background pressures.

## 9. Time

The runtime uses adaptive time scale:

- dialogue: seconds/minutes
- scene: minutes/hours
- travel: days
- campaigns: days/months
- politics: months/years

The scheduler advances to meaningful changes rather than simulating every clock tick.

## 10. NPC execution tiers

Running a frontier LLM for every character continuously is infeasible.

- Tier 1 background actors: rules/state machines
- Tier 2 relevant actors: small policy/model calls
- Tier 3 scene actors: full agent reasoning

Promotion/demotion is based on scene relevance and causal impact.

## 11. Storage

Phase 0 uses human-readable, workspace-local files under `.novel-harness/` for project metadata, source manifests, compiler jobs, readiness metrics, and Pi sessions. Writes use atomic rename, and source documents remain ordinary local files. This keeps the first CLI inspectable and removes operational dependence on PostgreSQL or another attached database.

The executable NWIR format is still a later design decision. If scale, concurrent workers, or transactional branch execution eventually require a database, it should be introduced behind the storage boundary with a migration plan. A graph or vector database is not required for source discovery; file search remains the default retrieval path.

## 12. LLM/program boundary

Use LLMs for:

- semantic interpretation
- extraction proposals
- ambiguous entity resolution candidates
- character reasoning
- dialogue generation
- candidate causal links
- narrative rendering

Use deterministic code and storage constraints for:

- identity
- time
- location
- alive/dead
- inventory/resource accounting
- branch/versioning
- knowledge visibility
- event commit
- invariants

## 13. Runtime invariants

Examples:

- dead actors cannot act
- direct dialogue requires a valid communication channel
- exclusive artifacts cannot have two simultaneous owners
- actor knowledge must have a propagation source
- event effects are applied only after successful resolution
- one actor cannot occupy incompatible locations at the same time

## 14. MVP sequence

### Phase 0 — local-first harness CLI
Claude Code-style terminal interaction backed by Pi, workspace instructions, `rg`-first local read/search tools, bounded `@file` context, persistent local-file sessions/state, configuration, and the harness task-loop skeleton. No external database, RAG layer, or write-capable model tools.

### Phase 1 — executable canon
Implement `Event -> StateDelta -> WorldState -> Canon Replay` for a constrained slice of one novel.

### Phase 2 — actor runtime
Knowledge state, goals, character policy and player control.

### Phase 3 — counterfactual world
Branches, background simulation, structural attractors, divergence.

### Phase 4 — narrative quality
Long-horizon literary rendering, dynamic arcs and polished TUI/UI.

## 15. Primary success criterion

The system succeeds when a high-impact player intervention creates durable downstream differences without breaking world invariants and without silently steering back to the canonical plot.
