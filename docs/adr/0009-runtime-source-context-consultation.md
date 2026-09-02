# ADR 0009: Runtime source-context consultation and authority-projected retry

- **Status:** Accepted
- **Date:** 2026-09-02
- **Scope:** Player-action translation, world adjudication, literary narration, frozen-source access, traces, and compiler feedback
- **Extends:** ADR 0004's player-intent/world-adjudication protocol and ADR 0008's frozen-base and presentation-authority rules

## Context

An executable world is intentionally smaller than its source novel. Stable
entities, current state, rules, event history, knowledge, and possibilities are
the right authority for simulation, but they are not a lossless literary
representation. A compiler can therefore be valid enough to run while still
omitting a relationship explanation, a document's provenance, a first-use
identity gloss, or the causal sentence that makes a scene intelligible to a
reader who has never read the book.

This creates three cases that must not be conflated:

1. the requested result contradicts current truth or capability;
2. relevant actor-safe data exists but was omitted from the bounded initial
   prompt and can be recovered with the existing actor/message retrieval tools;
3. the active compiled projection genuinely lacks enough evidence to interpret
   or adjudicate the immediate intent.

Treating case 3 as case 1 produces sterile refusals. Giving every runtime model
unrestricted access to the novel is worse: it can activate future canon, leak
narrator knowledge into the character, read a newer prepared revision than the
branch was created from, or let prose bypass deterministic commitment.

The runtime needs a narrow evidence escalation path, not a general novel RAG
chatbot and not a second mutable world model.

## Decision

### 1. Represent missing context as a typed outcome

The player-action translator and world adjudicator may return a strict
`needs-context` request containing a domain, one bounded question, an audience,
and literal search terms. It is a third protocol result, not an exception string
and not an in-fiction refusal.

Host validation failures can also trigger consultation, but only when every
issue in the failure set belongs to a small deterministic data-gap allowlist.
A mixed set containing a capability, knowledge, write-scope, stale-head, active
rule, or known-state contradiction is never relabelled as missing data.

Prompt-size omission remains a separate first-line recovery path. Models must
exhaust actor-context and conversation retrieval before requesting source
consultation.

### 2. Permit one isolated consultation and one consumer retry

At most one consultation is allowed for a player move. A successful admitted
supplement permits at most one fresh retry at the consumer that requested it:
translation or adjudication. A narration-only consultation never retries or
reopens world commitment. A second request, a repeated unresolved result, or a
consultation without usable authority fails closed.

The control flow is:

```text
actor-safe translation
        |
        +-- candidate --------------------+
        |                                  |
        +-- needs-context                  v
              |                     current-world adjudication
              v                            |
      isolated frozen-source turn          +-- realize/transform --> validate --> commit
              |                            |
              v                            +-- needs-context --+
      host authority admission                                 |
              |                                                |
              +-- usable projection --> one fresh retry <------+
              |
              +-- future / ambiguous / unavailable --> no retry, no commit
              |
              +-- structural compiler gap --> repair-hint inbox
```

The consultation is a fresh, non-persisted Pi session. It receives no project
instructions, local file tools, NWH extension, compiler mutation tools, branch
mutation tools, or previous model transcript. It can only search/read the source
corpus bound by the branch's `FrozenWorldBase` and submit one capture-only
proposal.

### 3. Bind evidence access to the branch's frozen base

The host loads exactly the branch-pinned source SHA-256, prepared revision hash,
and canonical snapshot relationship. It rejects a missing or non-V2 evidence
snapshot, a source mismatch, changed source bytes, malformed source structure,
or an exact-anchor hash mismatch. Historical compiler-layout drift is allowed
only so an existing branch can read its own immutable revision; the lookup never
falls forward to the active/latest prepared revision.

Retrieval is deterministic lexical search over immutable base source units; no
embedding index or cross-source RAG is introduced. Search results carry
host-issued `source-unit:*` refs and only artifact kind/ID pairs already linked
through frozen evidence bindings or overlapping verified `EvidenceRef`s. A
proposal may cite a source unit only after the complete unit was read in that
same isolated attempt. Reads are paged, tool calls are bounded, and lookup
failures use the repository's one-corrected-retry recovery protocol.

Novel prose, artifact labels, the player utterance, and tool result strings are
all untrusted model input.

### 4. Separate interpretation proposal from host admission

The source consultant proposes cited findings, temporal class, intended
audiences, and a summary. It does not decide what becomes actor knowledge,
current truth, narration context, or a compiler change.

After capture, the host rechecks the branch head and independently validates:

- the need ID and frozen source/revision scope;
- that every cited source unit was completely read in the same attempt;
- that every cited artifact is present in the frozen prepared bundle and is
  actually linked to a cited unit;
- current committed history, realized canonical events, effective active rules,
  and the actor-safe projection;
- ambiguity and temporal safety.

Future protection is passage-wide. The host examines every artifact linked to a
cited passage, not only the subset selected by the model. If the passage touches
an unrealized canonical event or an uncommitted possibility, the entire finding
is withheld even when the model labels it current or omits the future-bearing
artifact ref. Explicitly future findings are also withheld. Findings whose
temporal class remains unknown and ambiguous proposals produce no consumer
supplement and no retry.

A model-authored literary statement may enter presentation context only when its
cited units overlap evidence already attached to the frozen initial world,
committed branch history, or a realized canonical event. That restriction is
deliberately conservative: useful but temporally unprovable prose becomes a
compiler repair hint rather than runtime fact.

### 5. Project separate authority channels

One admitted result is split before reaching any downstream model:

| Projection | Permitted content | Explicitly forbidden |
| --- | --- | --- |
| Translation | actor-visible facts; a one-turn referent mapping | hidden world facts, new capability, new character knowledge |
| Adjudication | facts independently confirmed against current committed entities, known claims, realized events, or effective rules | future canon, source-only claims, one-turn player-language mappings |
| Choice | actor-visible facts only | reader-only prose and hidden/current-world-only facts |
| Narrative | current/prior presentation context with no artifact/evidence handles | state changes, actor knowledge, presence, possession, NPC response, future outcomes |
| Compiler repair | source/revision/need/evidence/artifact references outside branch truth | automatic canonical publication or branch mutation |

The one-turn referent mapping handles a common sparse-world failure without
pretending to teach the character a name. If the player names a compiled entity
that is already physically/referenceably in the actor projection but appears as
unidentified, exact source-linked identity may map the player's wording to that
existing entity for translation only. The mapping is exposed through the same
turn-local opaque handle as the actor projection. It does not enter choice
authority, `KnowledgeDelta`, persistent memory, or world truth.

Supplement schemas enforce these channel rules even for custom resolver
callbacks. Stable artifact and source refs are removed at presentation model
boundaries. The final narrator receives narrative projection only; the private
choice expert receives choice projection only. Narration remains downstream of
the commit result and cannot write truth.

### 6. Treat recurring source-only findings as compiler input, not runtime truth

When exact evidence appears relevant but cannot be admitted through an existing
current artifact, the runtime writes an immutable, content-addressed
`RuntimeCompilerRepairHint` under the workspace compiler state. It records the
frozen source and prepared revision, branch head, typed need, and evidence/artifact
refs, but not a world mutation.

The inbox is idempotent and non-authoritative. A later explicit compiler repair
workflow may inspect, reparse, propose, validate, and publish a new prepared
revision. Existing branches remain pinned to their old base; no runtime hint
silently upgrades them.

### 7. Keep consultation observable and non-fatal where appropriate

Turn audits retain typed consultation records and persisted repair-hint IDs.
Application traces record the detected gap and admission result, while the
isolated Pi/tool trace retains detailed evidence access. Raw source text is not
copied into the ordinary turn audit or presentation frame.

Failure to consult cannot loosen validation. For an explicit semantic gap it
leaves the turn unresolved at the original head. A conditional narration-only
lookup failure is a non-fatal warning because the already-valid event can still
commit and be rendered from committed actor context.

The host conditionally requests literary context for structured direct
interactions and described referents; it does not add a source-model call to
every turn.

## Rejected alternatives

### Give the translator or narrator direct novel access

Rejected because it merges evidence, actor knowledge, current truth, and future
canon inside one model context and cannot be audited as a separate escalation.

### Always include large source windows in every runtime prompt

Rejected because it adds latency and distraction on turns that have no gap,
weakens frozen temporal boundaries, and still does not provide typed admission.

### Automatically write a discovered fact into branch state or knowledge

Rejected because source interpretation is a proposal and narration is not a
mutation authority. Persistent truth still requires normal compiler/runtime
validation and an explicit commit path.

### Automatically activate a repaired prepared revision on the current branch

Rejected because a branch's base is immutable. Repairs create a future base for
new instances or an explicit migration decision, never a silent history rewrite.

### Consult after every validation failure

Rejected because known contradictions and forbidden writes are not information
shortages. Consultation cannot become a bypass around deterministic gates.

## Consequences

### Positive

- Genuine data absence is preserved and investigated instead of rendered as a
  generic refusal.
- Sparse compiled worlds can recover bounded identity, provenance, relationship,
  and causal context for an unread player without becoming RAG chatbots.
- Source/revision isolation, branch CAS, character knowledge, and future-canon
  boundaries remain explicit and testable.
- Recurring runtime gaps form concrete compiler feedback rather than disappearing
  in prose logs.
- Choice and narration receive purpose-specific context rather than one mixed
  packet with accidental authority.

### Costs and limits

- A triggered semantic turn can add one source-model call and one consumer retry.
- Conservative temporal admission means some genuinely prior literary detail is
  withheld until the compiler represents it more precisely.
- Exact citation and artifact linkage validate provenance and scope, not perfect
  natural-language interpretation; presentation-only statements therefore
  remain lower authority than committed facts.
- The repair-hint inbox does not itself implement automated recompilation or
  branch migration.

## Verification

Tests must prove explicit and deterministic data-gap triggers consult at most
once, retry at most once, and commit at most one event. Mixed/definitive failures
must not consult. Source tests must prove frozen scoping, exact-anchor checks,
complete paged reads, artifact linkage, bounded tool recovery, and branch-head
stability. Adversarial tests must prove an unrealized future event is withheld
even when its artifact ref is omitted or its temporal class is falsified, and
ambiguous findings cannot trigger a retry. Boundary tests must prove one-turn
identity mappings use opaque handles, choice and narrator projections are
separated, stable evidence IDs do not cross presentation boundaries, and repair
hints are immutable and idempotent.
