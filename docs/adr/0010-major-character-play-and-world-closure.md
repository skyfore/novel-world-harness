# ADR 0010: Major-character play certification and novel-to-world closure

- **Status:** Proposed
- **Date:** 2026-09-05
- **Implementation baseline:** `b2c010548edc519ea957e0ddc9fffdb47c297a5d`
- **Scope:** Compilation completeness, grounded character entry, prepared publication, shared action adjudication and actor decision views.
- **Related:** ADR 0001, 0003, 0004, 0006, 0008 and 0009 remain governing decisions. This proposal extends their contracts; it does not declare their implementations absent.
- **Detailed design:** [Chinese technical design](../novel-to-play-technical-design.zh-CN.md).
- **Delivery gates:** [Implementation and acceptance plan](../novel-to-play-acceptance-plan.zh-CN.md).

## Context

The current implementation has phase-major source compilation, typed proposals,
evidence verification, immutable prepared revisions, grounded entries for later
characters, five-channel event effects, isolated fresh play, and replayable
branch history. These are substantial executable-world foundations.

The September 5 review reproduced three interface failures on the baseline:
ordinary player conversion omits action invocation; source-scoped actor context
filters out correctly projected branch knowledge; and spatial validation is
enabled by an optional arrive intent rather than every actual location change.
Static review also found incomplete semantic-effect channels in model adapters
and different social-state inputs for direct NPC responses and autonomous actors.

An additional product gap is the denominator. A list of roles with an existing
entry does not establish that every major character in the novel has an entry.
Completed batches and valid evidence anchors do not prove semantic completeness.
Missing characters or mechanisms must not disappear from a success metric.

## Proposed decision

### 1. Certify a declared world, including all major characters

Maintain a versioned major-character roster derived from the whole source and
independently reviewed. Preserve unresolved major candidates through mention
references. Never compute the denominator from already-playable roles or remove
failed roles merely to obtain full coverage.

Each major character needs at least one evidence-grounded entry immediately
before a lived scene, with sufficient state, private knowledge, motivation,
relationships, capabilities and continuation behavior. A late entry must restore
the relevant rules, semantic state, obligations and active processes as well as
physical and knowledge deltas. Story-time occurrence and discourse order remain
separate; the current event's outcome must not be applied before play begins.

Full-novel publication requires all rostered major characters to pass, source
accounting to close, critical semantic issues to be resolved, and required
mechanisms to be executable. Missing critical information blocks certification.
Noncritical unknowns are explicit. Certification does not claim that a novel
uniquely specifies every counterfactual fact of a complete physical reality.

### 2. Centralize action and effect adjudication

All actor-origin proposals carry an ActionInvocation and share the existing
state, knowledge, semantic, process and norm proposal types. Only trusted host
paths may construct non-actor environmental transitions bound to a declared
mechanism. A model cannot obtain that authority by omitting action or changing
an origin field.

The final commit boundary derives obligations from proposed state differences.
A location change always triggers spatial checks, regardless of intent labels.
Action bindings and mechanism witnesses must justify effects; a valid action
name or declared footprint alone cannot authorize arbitrary state patches.
Physical possibility, permissions and in-world norms remain distinct. A
physically possible norm violation may succeed and produce consequences.

All effect channels commit atomically through the existing history model.
Renderers never become writers. A failed or no-op request is not automatically
a material world event.

### 3. Use one role decision view and provenance admission policy

Player translation, reactive NPC responses and autonomous actors share a
branch/head/actor-specific view of visible state, knowledge and beliefs, goals,
appraisals, relationships and obligations. Strategy prompts can differ; domain
facts at the same cut cannot.

Admit source-grounded knowledge through exact source and acquisition checks.
Admit branch-emergent knowledge through reachable committed-event provenance
and the actor's acquisition record. Never fabricate source evidence for branch
facts, accept empty evidence indiscriminately, or trust a model-provided
branchGrounded flag. Fork ancestry and information availability both matter.

### 4. Publish an immutable readiness certificate

A host-derived certificate binds source bytes, the candidate canonical/compiler
snapshot, roster, dependency closure, role results and validator/engine
fingerprints. Hash the subject snapshot without certificates first; let
certificates reference that hash; finally hash the prepared envelope containing
their references. This avoids a self-referential prepared/certificate hash.

Before publication, a host-only candidate evaluation use case runs isolated
branches through the same creation kernel, Pi adapters, projections and commit
validators as product play. It binds the candidate subject instead of requiring
an already-published certificate. No public request or model field can bypass
certification. Freeze the evaluation manifest before certificate generation;
keep final prepared/certificate mappings outside that referenced manifest.
After publication, test public API/CLI admission separately. This avoids both
a certification bootstrap cycle and a second recursive hash through evaluation
results.

Publish, activate, cache restore and fresh-play entry use the same validator.
Interrupted repair or certification cannot replace the active prepared base.
A fresh role selection checks expected prepared revision and entry cut again;
it then creates an isolated sibling branch under ADR 0008. Existing branches
remain pinned to their original base.

### 5. Repair dependencies, not just adjacent source slices

Derive a revision-aware dependency graph from typed artifact references.
Identity, attribution, temporal, causal, state-effect, acquisition and entry
changes invalidate their transitive dependents and certificates. Repair is
source-scoped, staged and resumable. Repeated unchanged diagnostics stop after
the prescribed corrected retry instead of deleting artifacts or expanding tool
authority. Every new model tool follows the existing recovery contract.

### 6. Retain local storage and explicit MVP version boundaries

Keep Pi and local files; introduce no external database, embeddings or general
model write tools. Do not add a product-wide token/request budget. Record model
cost and retain scoped recovery and no-progress protections.

The proposed incompatible integration targets prepared V4, world schema V3,
engine 0.3.0 and storage v3, with matching cache/fingerprint updates. If main has
already allocated those versions, advance them explicitly. Couple the first
incompatible change with version rejection tests. Do not implicitly migrate,
delete or reinterpret old histories; use the matching old engine or recompile
immutable source into a new world. Routine fixes that preserve the stored
contract need not independently bump every version.

## Alternatives considered

- **Declare success when any grounded role can start:** hides missing major
  characters and does not meet the requested whole-novel goal.
- **Add more entity or personality fields first:** does not fix lost action,
  knowledge or semantic-effect channels.
- **Let each model adapter enforce its own checks:** repeats the current
  omissions and makes equal actions behave differently across entry points.
- **Let narration fill world gaps:** breaks the proposal/commit truth boundary
  and makes replay and persistent social state unreliable.
- **Force the canonical future:** invalidates player agency after changed causes.
- **Add a graph/vector database:** changes storage without resolving semantic
  evidence, role completeness or execution coverage.

## Consequences

Publication becomes stricter and may expose more blocked novels initially. This
is an observable limitation rather than an invitation to fabricate missing
facts. Preparing late roles requires richer entry snapshots and explicit time
constraints. Shared views and effects reduce adapter drift but require schema,
cache, replay and public API changes to land together.

Independent semantic review and per-major live-play trials add evaluation work.
Deterministic regression, statistical extraction quality, role behavior and
literary quality remain separate. A readiness certificate is a record of these
checks within a declared capability scope, not a proof of universal narrative
understanding.

## Acceptance

This ADR remains Proposed in the design PR. Implementation acceptance requires
W0–W8 and the linked case matrix, including the three regression fixes, all-major
entry coverage, branch knowledge consumption, free-interaction social effects,
counterfactual/background progression, version isolation and real complete-work
evaluation. Existing tests passing or schema inventory growth is insufficient.
