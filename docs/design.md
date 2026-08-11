# Design: Executable Narrative World Model

## 1. Problem statement

A novel is a natural-language record of one historical trajectory through a fictional world. A traditional knowledge graph can answer who, where, and what, but cannot reliably continue the world after a user changes a key event.

The research problem is therefore:

> How can a narrative text be compiled into a computational world model that remains internally consistent, can reconstruct its past, and can continue evolving after counterfactual intervention without treating the source's future as a mandatory script?

The product is split into two systems:

1. **Novel Compiler Harness** — understands the complete source and compiles evidence-backed world artifacts.
2. **World Runtime** — advances one branch from committed history, active rules, actor state, and a frontier of possible future developments.

The long-term product is not a novel RAG chatbot. It is closer to an executable world system whose narrative text is one observation and one rendering of world history.

See [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md) for the temporal model and future-direction decision, and [the executable world technical design](technical-design.md) for concrete contracts, storage, validation, scheduling, replay, and implementation milestones.

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
A temporal edge with validity and evidence. Static identity relationships and dynamic relationships must remain distinguishable.

### CanonicalEvent
A source-observed event on the canonical trajectory. It contains evidence, participants, timing, preconditions, observed outcomes, and causal relationships. It is compiler knowledge, not automatically committed future branch truth.

### CommittedEvent
An event that has passed branch validation/adjudication and is authoritative for that branch.

### StateDelta
The deterministic change produced by a committed event.

### WorldSnapshot
A reproducible materialized cache used to avoid replaying the complete branch history. It is not the semantic source of truth.

### KnowledgeFact
Actor-scoped information with confidence, source and validity. Knowledge must have a plausible acquisition/propagation path.

### CharacterGoal / CharacterModel
Goals, values, traits and decision tendencies inferred from repeated source evidence. These are policy/model inputs, not canonical facts unless explicitly stated.

### WorldRule
A temporal in-world rule or constraint. It is distinct from non-negotiable engine invariants implemented in deterministic code.

### Possibility
An uncommitted future candidate with preconditions, blockers, causal provenance, candidate timing, pressure/priority, and optional canonical analogue. A possibility is never world truth until a resulting event is committed.

### Branch
A timeline fork anchored at a committed event/history checkpoint.

### NarrativeObservation
A narrative/meta artifact describing framing, interpretation, theme, motif, foreshadowing, or rendering semantics without directly mutating world truth.

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
Recompute coverage / replay diagnostics
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
- rule builder
- possibility builder
- narrative/meta analyzer
- verifier
- adjudicator
- replay evaluator

Workers may share LLM profiles, but their prompts, tools and output contracts remain separate. Workers produce proposals; they do not directly mutate committed world truth.

## 7. Completion/readiness

A single pass over the text is not sufficient. Corpus evaluation should eventually report metrics with explicit annotated denominators, for example:

- source coverage >= 0.99
- evidence binding >= 0.99
- entity resolution >= 0.99
- major event resolution >= 0.98
- temporal consistency >= 0.99
- state delta coverage >= 0.95
- epistemic coverage >= 0.90
- causal coverage >= 0.90
- rule coverage for runtime-relevant constraints
- replay determinism == 1.0 for committed fixtures

Runtime readiness additionally requires invariant checks and canon replay tests. High extraction coverage alone does not mean the world is executable. The current `audit` command reports `null` for dimensions without a trustworthy denominator rather than fabricating these percentages.

## 8. Canon replay

Before users enter the world, run the runtime using canonical initial conditions, source-supported decisions/policies, and extracted world pressures, then compare resulting checkpoints with canonical checkpoints.

A large mismatch indicates errors in at least one of:

- world state
- event effects
- character goals/models
- character knowledge
- causality
- temporal world rules
- possibility construction
- background scheduler

Canon replay is a system-level evaluation, not scripted playback and not just extraction accuracy. A missing canonical event must not be repaired by forcing it because it appears next in the novel.

## 9. World runtime

Each runtime Move follows:

```text
Current branch head
   ↓
Project WorldState(branch, t)
   ↓
Resolve active rules + actor views
   ↓
Refresh possibility frontier
   ↓
Player / NPC / background proposals
   ↓
Precondition + invariant validation
   ↓
Adjudicate compatible events
   ↓
Commit events + deterministic StateDelta
   ↓
State projection
   ↓
Knowledge propagation / rule changes
   ↓
Refresh future possibilities
   ↓
Narrative renderer
```

### Proposal/commit separation
LLMs may propose events. Only deterministic validation/adjudication code can commit them to branch history.

### Fog of war
Narration and actor reasoning receive the relevant perceived view, not unrestricted compiler truth.

### Canon as attractor
Canonical future events contribute evidence about conditions, intentions, pressures, and causal structure. If those preconditions disappear on an alternate branch, an analogous event is canceled, transformed, delayed, or replaced. The runtime must never recreate an event merely because it exists in the book.

### Divergence
Divergence is a derived metric comparing a branch with canonical checkpoints/conditions. It may tune canon affinity, evaluation, or rendering, but it is not an authority that decides truth.

## 10. Time

The model separates source/story time from deterministic commit order.

Story time may be:

- exact;
- approximate;
- a range;
- relative to another event;
- ordinal/scene-like;
- unknown.

Every branch commit still has a deterministic logical order so replay is unambiguous.

The runtime uses adaptive story-time scale:

- dialogue: seconds/minutes
- scene: minutes/hours
- travel: days
- campaigns: days/months
- politics: months/years

The scheduler advances to meaningful eligible changes rather than simulating every clock tick.

## 11. NPC execution tiers

Running a frontier LLM for every character continuously is infeasible.

- Tier 1 background actors: rules/state machines/latent pressures
- Tier 2 relevant actors: compact policy/model calls
- Tier 3 scene actors: full agent reasoning

Promotion/demotion is based on scene relevance, causal impact, active goals, proximity to the player, and frontier pressure.

## 12. Storage

Phase 0 retains human-readable, workspace-local files under `.novel-harness/` for project metadata, source manifests, deterministic evidence segments, compiler batch checkpoints, typed proposals, and Pi sessions.

Executable world data should live in a separate `.novel-harness/world/` namespace. Branch truth should use immutable content-addressed event/delta/commit objects plus an atomically replaced branch head pointer. This gives local-file storage a Git-like crash-safe commit boundary without requiring a database.

Snapshots, frontier materializations, indexes, and divergence metrics are caches and may be regenerated.

If scale, concurrent writers, or transactional requirements eventually require a database, introduce it behind the world storage interfaces with a migration plan. A graph/vector database is not required for source discovery.

See [technical-design.md](technical-design.md) for the concrete storage protocol.

## 13. LLM/program boundary

Use LLMs for:

- semantic interpretation
- extraction proposals
- ambiguous entity resolution candidates
- candidate preconditions
- character reasoning
- dialogue generation
- candidate causal links
- narrative/meta analysis
- narrative rendering

Use deterministic code and storage constraints for:

- identity/reference integrity
- commit ordering
- state schema/type checking
- location and resource constraints
- alive/dead and other engine invariants
- branch/versioning
- knowledge visibility enforcement
- rule evaluation
- event commit
- state reduction
- snapshot verification

The first model-side mutation capabilities should be narrow typed proposal tools such as `propose_canonical_event`, `propose_state_delta`, `propose_world_rule`, and `propose_possibility`. Do not expose general file writes as the world mutation model.

## 14. Runtime invariants

Examples:

- dead actors cannot act through ordinary mechanisms;
- direct dialogue requires a valid communication channel;
- exclusive artifacts cannot have two simultaneous owners;
- actor knowledge must have a propagation source;
- event effects are applied only after successful resolution;
- one actor cannot occupy incompatible locations at the same logical time;
- stale proposals cannot commit against a moved branch head;
- future canonical information cannot appear in an actor view without a committed information path;
- cache corruption cannot change authoritative branch history.

## 15. MVP sequence

### Phase 0 — local-first harness CLI (implemented)
Claude Code-style terminal interaction backed by Pi, workspace instructions, `rg`-first local read/search tools, bounded `@file` context, and persistent local-file sessions/state. There is no external database or RAG layer. Ordinary sessions are read-only; explicit compiler sessions now add narrow typed proposal tools.

### Phase 1A — executable history core (implemented vertical slice)
Typed world contracts, immutable commit storage, branch heads, predicates, `StateDelta`, deterministic projection, and validation are implemented and tested on constrained fixtures.

### Phase 1B — constrained canonical compiler (mechanism implemented; quality unproven)
Bounded Pi batches can propose evidence-backed entities, claims, canonical events, preconditions, state deltas, rules, actor artifacts, and possibilities. Representative corpus accuracy has not been established.

### Phase 1C — canon replay (implemented vertical slice)
Predicate checkpoints are evaluated against normal possibility-driven moves without directly forcing future canonical event IDs.

### Phase 2 — possibility runtime (implemented vertical slice)
The possibility frontier, deterministic scheduler, branching, conflict adjudication, and durable counterfactual tests exist. Long-horizon policy quality remains unmeasured.

### Phase 3 — actor runtime (partial)
Actor-scoped knowledge, goals, deterministic candidate actions, conflict handling, and information propagation exist. Natural-language player control, Pi-backed actor reasoning, and interactive character embodiment are not connected.

### Phase 4 — compiler breadth and narrative quality (next)
Add annotated corpus evaluation, model-backed narrative rendering, interactive world play, long-horizon testing, and terminal UX after the end-to-end product loop is reliable.

## 16. Primary success criterion

The system succeeds when a high-impact player intervention creates durable downstream differences without breaking world invariants, without leaking future canon into actor knowledge, and without silently steering the branch back to the canonical plot.

Equivalently: the same committed history must replay to the same world; a different valid committed event must be allowed to create a genuinely different future.
