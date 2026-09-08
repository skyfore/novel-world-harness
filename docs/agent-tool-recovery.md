# Agent tool failure recovery

Model-facing tool failures are part of the agent protocol, not terminal exception strings. A failure must remain a real error for audit, circuit-breaker, and checkpoint logic, while also telling the agent how to make bounded progress.

Compiler recovery also consults the persisted proposal journal before session creation, after a batch report, and after a thrown timeout/network error. An interrupted mutation or two distinct failed inputs requires host review even when other proposals succeeded. `host-repair-required` metadata (including the tagged JSON on older Pi error paths) forbids fresh-session recovery. A single failed input remains eligible for one concrete correction under the same exact tool and `proposal_id`; a new ID or an unrelated successful draft never clears that obligation.

Source-accounting discovery persists a protocol receipt for each issued unresolved page: source hash, batch, segment IDs, exact ordered unit IDs and eventual consumer. This is audit metadata, not a source disposition or world mutation. If new evidence or valid accounting covers any submitted unit, `account_source_units` rejects the entire call with `coverage-changed`, listing `representedUnitIds`, `accountedUnits` and `remainingUnitIds`. Preserve the failed `proposal_id`, call same-batch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the returned `pageToken`, review the fresh page and make at most one corrected call. Never reuse indexes without inspecting that page. If no units remain, stop for host coverage review rather than submit an empty array or withdraw valid coverage. Receipts survive fresh sessions; consumed tokens stay single-use.

## Contract

Every NWH tool exposed to a model is registered through `withNwhToolRecovery`. The wrapper preflights the tool schema and intercepts argument-preparation and execution failures. It preserves Pi's thrown-error behavior, so the resulting tool message still has `isError=true`, and appends a host-generated `<nwh-tool-recovery>` block with:

- the failure category and whether a retry is allowed;
- the condition that must change before retrying;
- ordered, concrete recovery steps;
- a paired read-only discovery call when one is safe and available.

The recovery block controls only tool invocation. It is not source evidence, world truth, character knowledge, or permission to widen the active source/actor/time scope.

## Required SOP by failure class

| Failure | Required next step | Retry policy |
| --- | --- | --- |
| Unknown/stale opaque `ref`, ID, or path | Name the paired `find_*`/`list_*` tool, refresh within the same active scope, and copy the exact returned field | One corrected retry; never guess an ID |
| Unknown compiler dependency | Find the source-scoped artifact, read it when exact payload matters, and distinguish `ref` from logical/domain/proposal IDs | Submit a genuinely new dependency first or retry once; preserve unresolved semantics when absent |
| Unknown actor/player opaque handle | Re-read only the current isolated prompt/options and copy an offered handle | One corrected retry; never search outside actor scope |
| Invalid JSON/schema/path/enum | Point to the first failing field and correct the smallest invalid part | One corrected retry |
| Invalid event-execution envelope/action | Keep evidence_segment_ids/evidence_selectors beside payload, not inside it. Find an action-schema in the active source, read its returned ref and copy payload.id into action.schemaId; an ad-hoc occurrence cannot be copied or relabeled as a mechanism | One corrected retry; if no supported mechanism exists, preserve the occurrence without inventing an execution binding |
| Incomplete compiler finish graph/trace | Treat the full finish diagnostic as one report; repair every listed dependency while preserving valid drafts | One retry after concrete proposal progress; an unchanged full diagnostic stops |
| Accounting review conflicts with no-artifacts | Correct the named reviewed_segments.disposition to proposed; preserve existing semantic coverage and all valid accounting pages. No new mechanism does not mean no source artifacts | One corrected finish retry; never withdraw whole pages to satisfy the mistaken review label |
| Canonical entity name lacks a resolved mention | Search both committed and pending entity mentions with `find_source_annotations`; read the returned `ref`, copy `annotationId`, verify `surface === canonicalName` and compatible kind, then use `find_entity_resolution_candidates` and `propose_entity_resolution` to establish the source-supported identity. A substring match or an unparsed mention alone is insufficient | One finish retry after concrete repair of all reported sections; preserve error status and stop on an unchanged full diagnostic |
| Source-annotation dangling reference | Read the finish inventory or call `find_source_annotations`; copy the exact returned `annotationId`, repair/withdraw only named proposals, and preserve every unlisted draft | One finish retry after concrete repair; never substitute `ref`/`proposalId`, mass-withdraw, or escape through `no-artifacts` |
| Cross-batch logical supersession in an ordinary source batch | Withdraw only the named current-batch replacement, repair one-sided current dependencies, then peek/defer a confirmed adjacent artifact to the existing two-segment calibration pass; never withdraw the checkpointed prior proposal | One finish retry after concrete withdrawal and deferral; only the calibration batch may replace the prior proposal |
| Invalid page offset | Reuse the exact returned `nextOffset`, or restart at `0` | One corrected retry; never estimate offsets |
| Unknown/stale source-accounting page token or index | Refetch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the exact `pageToken`/`unitIndex`, and review the complete page | One corrected retry; never guess, copy long unit IDs, or reuse a consumed page token |
| Duplicate proposal | Keep the accepted draft, or use the supported withdraw/replace workflow for a genuinely defective draft | Never create duplicate IDs just to bypass the guard |
| Single-use capture, finished batch, tool scope block | Stop calling that tool and use the accepted result/current active tools | No retry in the same turn |
| Budget/circuit breaker | Stop the tool loop and resume only through a fresh host-started turn | No retry in the same turn |
| Stale/corrupt/unsafe host state | Surface the exact diagnostic and perform the named host repair, re-ingest, or reparse | Rediscover IDs only after repair |
| Unexpected failure | Verify scope and inputs with read-only tools; change something concrete | At most one corrected retry, then stop and report |

If the same diagnostic repeats after the prescribed correction, the agent must stop. Rewording or resubmitting the same call is not recovery.

For a stale workspace compiler lock, model tools cannot repair host ownership.
Stop model retries. On the owning Linux host run `nwh compiler-lock inspect`,
copy the exact `owner.token`, and use `nwh compiler-lock recover --owner-token`.
The host command rejects live owners and foreign host/PID namespaces. A legacy
owner requires a real original-host PID check before the explicit
`--legacy-owner-host-verified` attestation; absence in a sandbox is insufficient.
Preserve the archived lock, checkpoints, and drafts. After recovery, start a fresh
host compiler turn and rediscover accounting pages; never reuse old page tokens.

Source accounting includes exact same-slice evidence from checkpointed earlier
observation/semantic stages. Inherited coverage supersedes overlapping old
accounting decisions in projection while preserving proposal history. This is
source coverage only, not executable certification. A `represented` unit must
not receive another accounting disposition; any supported executable mechanism
still requires its own typed world proposal and validation.
Every scoped compiler proposal attempt now has a durable, per-proposal journal
under `world/v3/compiler/proposal-obligations/`. Argument-preflight failures and
interrupted execution are retained along with their exact proposed input. A
fresh session hydrates unresolved attempts. Neither accounting nor unrelated
world proposals clear a failed identity. Finish checks this journal before any
accept/review writes or successful termination; the outer handshake also rejects
unresolved proposal failures independently of artifact counts.

Copy the diagnostic's exact tool and proposal_id and make one corrected retry
after checking all reported selectors against the supplied citable evidence.
After original and corrected inputs both fail, or an execution lacks a verified
result, stop for host review; restarting does not reset the guard. Missing
evidence cannot be repaired by changing the source scope. The host-only
`CompilerProposalObligations.reviewUnsupported` API requires a reason and audit
reference, preserves failed history, and does not certify executable coverage.
For older runs predating the journal, the host must import the exact failed tool
input and diagnosis from the audit using `record` before resuming that batch.
These host operations require the workspace compiler lock.

Exact selector validation reports all missing/ambiguous quotes in one diagnostic.
Copy verbatim punctuation and do not substitute quotes from another segment.
Artifact discovery includes `readArguments.ref`; copy that ref unchanged.
`logicalId` identifies the domain object and must never be used to construct a ref.
Classify accounting finish diagnostics before generic offset errors: pagination
instructions inside an accounting diagnostic do not give finish_compiler_batch
an offset parameter. If an earlier faulty host SOP caused a withdrawal, the
host-only SourceAccountingStore.reproposeRejected API can stage an exact copy
under a fresh ID with restoredFrom provenance after an audited same-source/batch
check. It preserves rejected history and still requires the normal finish gate.

## Development pattern

Domain and storage code may throw precise errors. The model-facing registration boundary must add recovery guidance; do not convert failures into successful tool content because that breaks failure accounting.

When adding a new tool or a future `SKILL.md` workflow:

1. Register the tool through `withNwhToolRecovery`.
2. Make opaque lookup failures precise enough to identify the failed kind (`ref`, segment ID, entity ID, proposal ID, and so on).
3. Add/update the safe finder mapping in `src/agent/tool-recovery.ts`. Suggest only tools actually available in that scope.
4. State which returned field must be copied. A retrieval `ref` must never be described as a domain entity/event ID.
5. Bound the retry: one retry after a concrete correction; repeated failure stops.
6. Preserve trust and authority boundaries. Recovery cannot broaden evidence, reveal hidden actor context, activate future canon, or bypass validation/commit gates.
7. Test the failure as an agent sees it: original diagnosis, `isError` semantics, recovery category, exact next action, and repeated-failure stop rule.

Bad:

```ts
throw new Error(`Artifact ref '${ref}' was not found.`);
```

Expected agent-visible result (the domain error may remain unchanged internally):

```text
Artifact ref '…' was not found.

<nwh-tool-recovery>
{ "category": "lookup-miss", "suggestedCall": { "tool": "find_compiler_artifacts", … } }
</nwh-tool-recovery>
```

Pi skills are currently disabled by the NWH embedding. If skills are enabled later, every model-callable tool introduced by a skill follows this same contract.
