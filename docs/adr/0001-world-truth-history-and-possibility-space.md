# ADR 0001: World truth is committed history; the future is a possibility space

- **Status:** Accepted
- **Date:** 2026-08-11
- **Scope:** Novel compiler, NWIR, world runtime, replay, branching, scheduling, and rewrite semantics

## Context

Novel World Harness is intended to compile a novel into an executable world that can be replayed, continued, rewritten, and safely diverged without silently forcing the story back onto the canonical plot.

The source novel gives the compiler an unusual advantage: it can inspect the complete canonical trajectory, including events that are "future" relative to an earlier point in the story. That information is useful for evidence, causality analysis, character modeling, and replay evaluation, but it creates a dangerous modeling ambiguity.

If future canonical events are represented as ordinary world truth, a branch runtime can accidentally treat events that have not happened yet as facts that must happen. If state is represented as a single mutable object, replay and branching become difficult to audit. If rules are treated as static configuration, the model cannot represent worlds in which laws, institutions, social constraints, magical systems, permissions, or other effective rules change over time. If narrative/meta information is mixed with world truth, a rewrite can accidentally mutate the world merely by changing how it is described.

The current design already establishes several important boundaries:

- source evidence is the ground-truth boundary for compilation;
- entities have stable identity while dynamic facts belong to temporal state;
- events are state transitions rather than summaries;
- LLM output is a proposal until validated and committed;
- character knowledge is distinct from omniscient world truth;
- narrative rendering does not write world truth;
- canon is a baseline/structural attractor rather than a mandatory script.

This ADR makes the temporal and dynamic parts of that model explicit.

## Decision

### 1. Separate the complete canonical record from runtime world truth

The compiler may build an evidence-backed **Canonical Record** for the entire source novel. This record describes what the source says happened on the canonical trajectory.

A running world, however, has a branch-scoped **Committed History**. Only events committed on that branch at or before its current head are runtime world truth.

Therefore a canonical event that occurs after the current branch head is not an already-true runtime fact. It is a canonical reference that may inform a future possibility, replay expectation, causal hypothesis, or character policy. After divergence, it may occur, transform, be delayed, or never happen.

This distinction is fundamental:

```text
Canonical Record
  complete source-observed trajectory
  useful to compiler and evaluator

Active Branch History
  only committed events up to branch head
  authoritative runtime truth

Future / Possibility Frontier
  eligible or latent candidate developments
  never authoritative until committed
```

### 2. Events are authoritative; state is a projection

The authoritative dynamic history of a branch is an append-only sequence of committed events and deterministic state deltas.

`WorldState` is not a general mutable bag of "current facts". It is a derived view:

```text
WorldState(branch, t)
  = reduce(initial world, committed events <= t, active temporal rules)
```

Snapshots may be materialized for performance, but they are caches/checkpoints rather than the semantic source of truth. A snapshot must be reproducible from committed history plus the applicable world model version.

This gives replay, auditability, branching, and counterfactual comparison a common foundation.

### 3. The future is represented as a possibility frontier

The runtime maintains a **Possibility Frontier** rather than a fixed future timeline.

A possibility is a candidate development that could become eligible for commitment. It may originate from:

- a future event observed in the canonical source;
- an actor goal, plan, obligation, promise, threat, or scheduled action;
- a causal consequence of previously committed events;
- an environmental or institutional pressure;
- a background process;
- an LLM-generated proposal grounded in current evidence and actor knowledge.

A possibility should be able to express at least:

- identity and kind;
- candidate time or time window;
- preconditions;
- blocking conditions;
- participating actors/resources;
- causal parents or pressures;
- provenance/evidence;
- optional link to a canonical source event;
- priority or pressure used by the scheduler;
- expiry/cancellation conditions;
- proposed effects, which remain uncommitted.

Probability may be used by a policy or scheduler, but probability is not world truth. A possibility with high probability is still not a fact.

### 4. Distinguish engine invariants from in-world rules

Not all "rules" belong to one layer.

**Engine invariants** are integrity constraints enforced by deterministic runtime code. Examples include referential integrity, branch/event ordering, resource conservation when the domain requires it, or the rule that an event cannot apply its effects before successful validation.

**In-world rules** are temporal world facts and constraints. Examples include laws, faction policies, titles and permissions, institutional procedures, active treaties, magical constraints, communication availability, or a social rule that applies only during a particular era.

In-world rules are versioned/temporal data. They may become active, change, or cease to apply because of committed events. The runtime must resolve which rules are active for `(branch, t)` before validating a candidate event.

A fictional world may also contain apparently fundamental laws that later change. When the source actually supports that behavior, the world model must represent the change explicitly instead of hiding it in application configuration.

### 5. Define runtime advancement as a Move pipeline

A runtime **Move** advances the world through proposals and commitments rather than through chapter index progression.

The conceptual pipeline is:

```text
Current branch head
      │
      ▼
Project WorldState(branch, t)
      │
      ├── active temporal rules
      ├── actor knowledge / beliefs
      └── open goals / obligations / pressures
      │
      ▼
Refresh eligible possibility frontier
      │
      ▼
Player / actor / background proposals
      │
      ▼
Validate preconditions, rules, knowledge, resources, causality
      │
      ▼
Adjudicate conflicts
      │
      ▼
Commit event(s) + deterministic StateDelta(s)
      │
      ▼
Propagate knowledge / activate or retire rules / update frontier
      │
      ▼
Render narrative view
```

Time may advance by seconds, days, or years, but the scheduler advances to meaningful candidate changes rather than simulating every clock tick.

### 6. Canon influences the future through conditions, not imperative scheduling

Canonical future events are useful because they reveal structures that existed on the source trajectory: actor intentions, causal dependencies, latent plans, environmental pressures, and narrative checkpoints.

They must not be scheduled simply because "the book says this happens next."

Instead the compiler should decompose important canonical events into the conditions and pressures that made them possible. During runtime, if those conditions remain valid, an analogous event may remain on the frontier. If the branch destroys a precondition, the event should disappear, transform, or be replaced by downstream consequences appropriate to the new state.

Canon is therefore an evaluator and structural attractor, not an imperative script.

### 7. Replay and prediction are different operations

**History replay** reconstructs a branch from committed events and verifies deterministic state projection.

**Canon replay** is a system-level evaluation. It starts from canonical initial conditions and tests whether the runtime can reproduce important canonical checkpoints when supplied with canonical decisions/policies and the relevant world pressures.

**Future simulation** operates on possibilities, actor policies, rules, and current state. It must not read uncommitted future canon as actor knowledge or branch truth.

A canon-replay mismatch is evidence of a missing or incorrect world model: state, causality, actor goals, rules, scheduling, or event effects. It is not a reason to hard-code the missing canonical event.

### 8. Narrative and meta semantics remain separate from world truth

The system must preserve a distinction between:

- what happened in the world;
- what a character knows or believes;
- what the source narrator claims;
- how the text frames an event;
- themes, motifs, foreshadowing, dramatic irony, arcs, genre expectations, and other meta/narrative semantics.

Meta information is valuable. It can guide extraction priority, interpretation, character modeling, evaluation, and narrative rendering. It must not directly mutate committed world state.

This distinction enables two different kinds of rewrite:

1. **Narrative rewrite / retelling:** keep the same committed world history and render it differently.
2. **Counterfactual rewrite:** fork a branch, commit different events, and let downstream state and possibilities evolve from the new history.

These operations must not be conflated.

### 9. Compilation is proposal -> validate -> commit

Broad novel parsing is not itself the source of truth. Extraction workers produce typed proposals backed by source evidence.

The intended compiler flow is:

```text
source evidence
   ↓
typed proposal
   ↓
deterministic/schema validation
   ↓
cross-model consistency checks
   ↓
commit canonical artifact
```

LLM-based verification may provide additional evidence or criticism, but it does not replace deterministic contracts for identity, temporal ordering, references, state deltas, rule activation, knowledge visibility, and event commitment.

The project should prefer model-first experiments on a constrained slice of one novel over maximizing parser coverage before the world model stabilizes.

## Model implications

The NWIR should evolve toward explicit primitives such as:

- `SourceSpan` — immutable source evidence location;
- `Entity` — stable identity, not current mutable state;
- `Claim` — evidence-backed proposition with epistemic type;
- `CanonicalEvent` — source-observed event on the canonical trajectory;
- `CommittedEvent` — branch-authoritative event;
- `StateDelta` — deterministic effects of a committed event;
- `WorldSnapshot` — reproducible cache/checkpoint;
- `KnowledgeFact` — actor-scoped information/belief;
- `CharacterGoal` / `CharacterModel` — policy inputs, not automatically facts;
- `WorldRule` — temporal in-world constraint with activation/validity;
- `Possibility` — uncommitted future candidate with conditions and provenance;
- `Branch` — fork metadata plus committed event history;
- `NarrativeObservation` / narrative-semantic artifacts — interpretation separated from truth.

Exact serialization remains a later implementation decision. The semantic separation is the architectural commitment.

## Consequences

### Positive

- Replay, branching, continuation, and counterfactual rewrite share one event-sourced model.
- The runtime cannot accidentally treat future canon as already-true state.
- State at any historical point can be reconstructed and compared.
- Dynamic rules become representable without turning the engine into an unstructured prompt.
- Canon can guide fidelity without railroading divergent branches.
- Narrative rewriting can change prose without corrupting world truth.
- Compiler artifacts become auditable because every committed structure has evidence and a validation boundary.

### Costs

- The model is more explicit than a simple entity graph plus current-state JSON.
- Scheduling requires first-class possibility lifecycle and causal/precondition modeling.
- Branch execution needs deterministic event ordering and conflict resolution.
- Rule versioning and temporal validity add complexity to validation.
- Canon replay becomes a genuine system evaluation rather than a scripted playback.

These costs are accepted because they correspond directly to the product's differentiating behavior.

## Implementation direction

The next architectural work should prioritize the smallest executable vertical slice rather than full-book extraction breadth:

1. define typed `CanonicalEvent`, `CommittedEvent`, `StateDelta`, `WorldRule`, `Possibility`, and `Branch` contracts;
2. compile a constrained source slice into evidence-backed canonical events and temporal rules;
3. implement deterministic event validation and state reduction;
4. reconstruct `WorldState(branch, t)` from history and verify replay determinism;
5. implement a minimal possibility frontier and scheduler;
6. run canon replay for the constrained slice without directly forcing future canonical events;
7. fork one high-impact event and verify durable downstream divergence;
8. only then expand extraction breadth, actor models, epistemics, and narrative quality.

The Phase 0 local-file/Pi CLI remains the development harness around this model. It should not grow general write access. The first model-side mutations should be narrow typed proposal capabilities whose outputs pass through validation before any commit.

## Rejected alternatives

### Treat the entire canonical timeline as runtime truth

Rejected because future events would become implicit obligations and contaminate branch simulation.

### Store one mutable current-state object as the authority

Rejected because it weakens replay, provenance, branching, auditability, and historical queries.

### Let the LLM directly rewrite world files

Rejected because generated prose and inferred facts would bypass invariant enforcement and evidence validation.

### Encode all rules as static application configuration

Rejected because many meaningful fictional-world rules are historical, institutional, social, political, or otherwise time-dependent.

### Treat canon as a fixed scheduler

Rejected because a counterfactual world must be able to invalidate the causes of future canonical events and remain diverged.

## Guiding principles

The project should use the following shorthand when evaluating future design decisions:

- **World before narrative.** Narrative is a view of world history, not its authority.
- **Events before state.** Dynamic truth is committed history; state is a projection.
- **Possibility is not fact.** Future candidates become truth only through validated commitment.
- **Rules are temporal when the fiction makes them temporal.** Keep engine invariants separate.
- **Knowledge is actor-scoped.** Compiler omniscience never leaks automatically into runtime actors.
- **Canon is evidence and an attractor, not a script.**
- **Models before parser breadth.** Use extraction to pressure-test the abstraction, not to define it accidentally.
- **Proposal -> validate -> commit -> render.** This remains the core mutation boundary.

