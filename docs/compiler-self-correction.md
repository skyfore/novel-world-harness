# Compiler failure diagnosis and bounded correction

## Problem and implementation

The observed boundary failure has two independent causes: selectors used distant
or invented adjacent context, and a `new-event` resolution omitted its selected
event/relation and candidate. A subsequent selector correction also excluded the
trigger from the extent. Retrying the same workflow with a larger budget cannot
repair these contracts by itself.

The implementation provides:

1. Typed selector diagnostics with the failing model field path, same-segment
   match count and at most three candidate contexts. Each side contains at most
   80 Unicode code points. Whitespace is preserved. These strings are untrusted
   evidence, never instructions. Missing exact quotes do not produce invented
   fuzzy replacements. Ambiguous matches never select themselves.
2. Aggregated selector failures and an explicit trigger/extent containment check
   before staging. Host-computed ranges help diagnosis but are not model inputs.
3. Event-resolution validation from the existing authoritative domain schema,
   with model-facing snake_case paths and a complete repair SOP. Validation does
   not invent an event ID, reinterpret a resolution or commit a draft.
4. Durable diagnostic context and retry state alongside failed proposal history.
   Pi error transport preserves the structured recovery block, including source
   text that resembles markup. The original error and failure status remain.
   The second distinct failed input immediately reports a host-review stop.

These changes affect failure feedback only. Existing source truth, canonical
identity rules, finish validation, proposal immutability and retry authorization
remain authoritative. No compiled checkpoint is reset to enable a retry.

## SOP for the next LLM

1. Read the entire failure report and `context` (or persisted
   `diagnosticContext`). Identify the source, batch, tool, proposal ID, failed
   paths, current draft lifecycle and remaining correction allowance. If
   `correctedRetryAvailable=false`, stop model submissions for this obligation.
   Scope, consumed receipt, interrupted-write, budget and circuit-breaker stops
   take precedence over any local repair suggestion.
2. Inspect every failed selector. If exact text is unique, retain it and omit
   optional prefix/suffix/occurrence. Otherwise read the complete same-segment
   source and copy immediate verbatim context. An occurrence index counts
   matches after applying optional context; omit context to count every exact
   match. Never count from one page or choose the first example automatically.
   Use `read_source_evidence` only when available and only with the named
   `source-segment:<segment_id>` ref; continue with returned `nextOffset`.
3. For event mentions, independently verify that at least one exact extent
   contains the trigger. Speech content alone may omit the reporting verb.
   Preserve independently valid participant mentions, IDs and source scope.
4. Diagnose the dependency graph before repairing a resolution. Failed calls
   do not create replacements. Read active mentions and participant resolutions.
   Call `find_event_resolution_candidates` for each event mention. For a pending
   event use `find_compiler_artifacts` with `kind=canonical-event`, copy
   `results[].readArguments.ref` to `read_compiler_artifact.ref`, and inspect the
   returned `payload.id` and lifecycle. Read all pages before using the record.
5. A same-finish event uses `new-event`: provide `canonical_event_id`,
   `relation=coreference`, and exactly one candidate with that same event/relation.
   Its `basis_event_mention_ids` must include the whole cluster; complete the
   remaining candidate schema fields. `resolved` requires existing canonical or
   previously checkpointed authority. Preserve exact predecessor resolution IDs
   in `supersedes_resolution_ids`; a draft is not canonical merely because its
   ID exists. Never choose non-referential simply to suppress a failure.
6. Fix all diagnosed fields together and make at most one materially corrected
   submission under the same failed tool/proposal identity. Successful immutable
   drafts require the existing successor/withdrawal protocol, not overwriting.
   Verify staging and finish separately. An unresolved obligation blocks finish;
   accounting completion does not certify executable closure.

## Break boundary

Stop for host review if the correction allowance is exhausted, evidence is
missing, intent remains ambiguous, a write result is uncertain, a lifecycle gate
is closed, or the required repair is outside the supported source semantics.
Do not rotate IDs, discard valid dependencies, clear ledgers, rewrite
checkpoints, or repeatedly restart. A model/schema/source bug normally calls for
source-code repair and verification; changing architectural direction requires
explicit review.

## Existing stopped batch

Improved feedback does not retroactively authorize another model attempt for an
already exhausted identity. The owning host must inspect the complete persisted
inputs, original source, active drafts and current finish receipt. A supported
selector-only correction uses the existing reviewed, hash-bound annotation
correction API: preview first, then apply only that exact verified input.
Repair the separate event-resolution obligation within its actual remaining
allowance, verify all mention/participant dependencies and finish closure, then
resume the existing rebuild loop. Preserve attempt counters and audit history.
Do not declare the novel complete from unit tests or a passing preview.

## Verification

Regression tests cover multiple selector errors in one report, preserved CRLF
and tab context, bounded ambiguous matches, trigger containment, malformed
new-event payloads with no staged output, persisted retry exhaustion across
sessions, and Pi transport of source strings resembling recovery markup.
