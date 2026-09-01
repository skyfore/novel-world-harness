# ADR 0008: Frozen world bases, isolated play instances, and third-person narration

- **Status:** Accepted
- **Date:** 2026-08-31
- **Scope:** Source/prepared identity, new-play lifecycle, Web orchestration, reader orientation, and player-facing prose
- **Supersedes:** ADR 0006 only where it excluded reader context from the final opening renderer; ADR 0007 only where play-continuity pronouns could override the host narrative voice

## Context

The harness already stored source bytes and prepared revisions by content hash,
and branch truth was already an event history. Two product-level ambiguities
remained:

1. “Play” in the Web UI could create another conversation on an existing
   branch, so a new session looked like a new playthrough even though it shared
   world truth.
2. The source document, prepared revision, and canonical snapshot were pinned in
   different records but were not exposed as one checked base identity.
3. Reader setup and prior-event recaps were printed as technical prefaces while
   the final narrator received only actor knowledge. The visible opening was
   therefore split between UI copy and novel prose.
4. The literary narrator was explicitly instructed to use second person, while
   the desired product voice is focalized third person. Raw player requests also
   looked like dialogue addressed directly to “you”.

The fix must preserve the existing truth boundary: source evidence and reader
orientation cannot become character knowledge, narration cannot commit events,
and the Web UI cannot grow a parallel runtime.

## Decision

### 1. Treat the compiled novel as an explicit frozen base

A modern source-backed branch resolves a `FrozenWorldBase` value:

```text
sourceContentSha256
preparedRevisionHash
canonicalSnapshotHash
```

`sourceId` addresses immutable source bytes, the prepared hash addresses an
immutable compiler bundle, and the canonical snapshot hash addresses the exact
world-model artifacts captured at genesis. The branch persists its source and
prepared hashes; every commit retains the same canonical snapshot. Resolution
checks all three records agree and fails on a source-prefix, source-scope, or
prepared-revision mismatch.

Publishing another prepared revision creates another possible base for future
instances. It never upgrades an existing branch. Player events append only to a
branch history and cannot write any member of the frozen-base identity.

### 2. Make “new play” mean a new world instance

The harness owns one atomic `startFreshPlay` use case:

```text
source + grounded role
  -> read the active fresh frozen base
  -> derive that role's evidence-backed entry checkpoint
  -> create a new sibling genesis branch
  -> pin the base and entry actor
  -> create a private play session/conversation
```

This path always uses `instanceMode: create`; it never reuses a source-owned
branch. Repeating the same role creates a different branch and conversation.
Different roles do the same. A client request ID makes a retried HTTP mutation
idempotent without turning a later intentional play into reuse.

A session is presentation and resume state attached to one branch; it is not a
world instance. Continuing a saved session resumes that branch's history.
Forking creates a child history from an explicit committed ancestor. Neither
operation mutates the base or any sibling branch.

### 3. Keep Web as an adapter over harness use cases

The browser reads grounded roles with
`GET /api/v1/novels/:sourceId/play-roles` and starts a play with
`POST /api/v1/play-instances`. The POST invokes the single application service
above and returns the instance, session, and checked frozen-base identity. The
React client does not compose branch creation, role checkpointing, or session
creation itself.

The novel page labels this action “new independent play” and lists saved
playthroughs separately under “continue”. The instance page labels opening an
existing branch as such. Commit hashes remain available in diagnostics and
trace views, but they are removed from the main prose transcript.

### 4. Render reader orientation inside the novel opening

At logical step zero, and only when the selected actor equals the branch's
persisted entry actor, the host may derive `readerPrelude` from the branch's
exact pinned prepared revision. It contains only the source-grounded entry setup
and completed prior discourse beats.

`readerPrelude` has `reader-orientation-only` authority. It is admitted only to
the final opening narrator so that the narrator can weave it into continuous
prose before settling into the immediate sensory scene. It is excluded from:

- world state and `KnowledgeDelta`;
- player-intent translation and world adjudication;
- next-action choice generation;
- NPC reasoning and background progression; and
- orientation, turn, blocked, and recovery narration after the opening.

The old standalone markdown recap is removed. If pinned orientation cannot be
loaded, opening rendering fails closed to the actor-safe frame rather than
substituting an active or newer revision.

### 5. Enforce focalized third-person visible prose

Every final narrator frame carries a host invariant:

```json
{
  "person": "third",
  "focalCharacter": "<selected character name>",
  "narratorAddressesPlayer": false,
  "dialogueMayUseFirstOrSecondPerson": true
}
```

The final narrator must name the focal character early in an opening and use
natural third-person narration. First- and second-person pronouns remain valid
inside verbatim dialogue or clearly quoted thought. The host rejects prose that
uses an “I/we” narrator, addresses the player as “you”, omits the opening focal
character, or changes committed locked dialogue. One clean final-render retry
receives the same immutable packet and the same contract.

Player input remains an untrusted action request. The existing harness pipeline
continues to parse intent, adjudicate desired effects against the current
actor-safe state, validate and commit typed events, and only then narrate actual
outcomes. The Web transcript labels raw input as “Action request” and rendered
output as “Story”; it does not pretend the request itself is novel truth.

## Consequences

### Positive

- The frozen compiled novel has one inspectable, integrity-checked identity.
- Starting the same or another role repeatedly produces independent histories.
- The CLI and Web UI share the same branch/session/action/narration machinery.
- An unread player receives necessary context as story rather than an engine
  report, without granting that context to the character.
- Player intent and committed consequences remain distinct, while all settled
  player-facing scene output follows a consistent third-person voice.

### Costs

- Modern fresh-entry branches persist one additional `entryActorId` field.
- The final opening renderer has one presentation-only input unavailable to all
  semantic and action-producing model calls, so its authority must remain
  explicit in traces and tests.
- Older second-person model fixtures and stored presentation prose do not define
  the new voice. Continuity analysis may retain imagery and cadence but must
  yield to the host narrative contract.
- Legacy unpinned branches remain playable but cannot claim a complete
  `FrozenWorldBase` identity.

## Verification

Tests must prove that two fresh starts for the same role have different branch
and conversation IDs, that committing on one changes neither the other nor the
original branch, and that all retain the same frozen-base hashes. Opening tests
must prove reader prelude reaches only the final opening prompt, never the choice
prompt, and that third-person prose with natural dialogue passes while
second-person narration fails.
