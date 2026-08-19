# ADR 0004: Model-first player intent and contradiction-grounded world adjudication

- **Status:** Accepted
- **Date:** 2026-08-19
- **Scope:** Player input, scene transitions, world consequences, and immersive failure handling

## Context

The first player loop mixed two incompatible responsibilities. An LLM translated
free-form input, but host code then searched the original utterance for a small
set of Chinese and English movement, waiting, observation, action, and destination
phrases. Those matches selected progress channels, parsed time, invented open-scene
labels, and sometimes decided whether a turn counted as progress.

That makes the executable world depend on surface wording. It fails on another
language, a translation, an unseen paraphrase, or prose whose words happen to
match a host pattern. It also turns an impossible desired result into a validation
message rather than an event that happens inside the fiction.

## Decision

Player execution uses two isolated model proposals followed by one deterministic
commit boundary:

1. The actor-scoped interpreter proposes a typed `PlayerIntent` and only the
   immediate state/knowledge effects the actor is authorized to control. It
   separates the actor's `controlledAct` from any `desiredEffect` that still
   depends on discovery, another entity, or the surrounding world.
2. A world adjudicator receives that intent, the relevant current committed
   world state, applicable active rules, and deterministic preview issues. It
   proposes exactly one `PlayerWorldResolution`:
   - `realize`: the immediate intended event can occur; or
   - `transform`: a direct contradiction prevents the desired result, so a
     different immediate in-world consequence occurs.
3. Host code validates scope, contradiction evidence, knowledge, spatial facts,
   active rules, invariants, time, and optimistic branch head, then commits the
   resulting event. Rendering reads only committed history.

The host does not infer intent, movement, destination, duration, consequence, or
progress by matching natural-language text. Typed safe UI affordances may bypass
the first interpretation model because their intent is already structured; their
display text is never reparsed.

## Contradiction rule

`transform` is deliberately narrower than general dramatic arbitration. It is
valid only for a direct contradiction with current state, an applicable active
rule, a deterministic preview issue, or unavoidable immediate ordinary
causality/capability. Uncertainty, inconvenience, low probability, missing detail,
or divergence from canon is not a contradiction and therefore does not authorize
transformation.

Every transformation includes a contradiction certificate with at least one of:

- an existing current entity state field;
- an applicable active rule name;
- a deterministic issue code from this exact candidate; or
- an explicit ordinary causal/capability principle.

The host verifies state, rule, and issue references and rejects unsupported
certificates. A causal/capability principle remains a model proposal, is retained
for audit, and cannot itself bypass deterministic state and write constraints.

For example, in a world whose committed model supports ordinary causality, has a
committed dead character, and has no applicable supernatural exception, “revive
them now” does not produce a canned `invalid action` result.
The world model may transform it into an attempted resuscitation whose immediate
perceivable failure is committed as a `blocked` consequence, while the dead/alive
state remains unchanged.

## Open scenes

An uncompiled destination is represented as a described intent target. It is not
converted into a fake canonical location ID. On commitment, the host creates a
branch-local `sceneId` from structural turn identity (parent commit, actor, beat,
and transition kind). The model-proposed label remains presentation data and may
be translated or rewritten without changing scene identity.

## Failure boundary

Ordinary world resistance is an immersive committed event. Rejection is reserved
for technical/model-contract failure, security/capability boundary violation,
stale concurrency, or a consequence proposal that still fails deterministic
validation. An auxiliary scene-choice tool failure does not discard otherwise
valid narration or undo a committed turn.

A missing or malformed world-resolution tool call first receives one retry in a
fresh isolated adjudication session. If that retry also fails, the host may still
commit one deliberately narrow fallback: a typed `observe` intent that stays in
the current scene, has no state or knowledge operations, advances no story time,
requires no knowledge, and has no deterministic validation issue. The committed
event uses a host-defined observe/stay primitive, not model-authored copy; the
unrealized `desiredEffect` remains only in the turn audit. This makes the
actor-controlled observation available to replay and later character context
without asserting that the hoped-for discovery occurred.

No other adjudication failure authorizes a synthetic consequence, knowledge
fact, active rule, or world-state change. Those turns leave the head unchanged
and re-establish the scene as technical recovery, never as fictional resistance.
Any unavoidable explanatory message is explicitly marked out of character.

## Consequences

- New languages and paraphrases require no host-code vocabulary changes.
- The model may reason about open-world acts without receiving direct mutation
  authority; every output remains proposal data.
- Impossible actions can advance the lived world without fabricating the desired
  effect or surfacing engine terminology to the player.
- Model latency increases because ordinary free-form turns use interpretation and
  adjudication sessions before narration.
- Semantic quality now depends on model/evaluation quality rather than a hidden
  phrase list, so multilingual and counterfactual evals are required.
