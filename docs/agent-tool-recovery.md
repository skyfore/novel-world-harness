# Agent tool failure recovery

Quotation-content trace validation compares exact proposition object assertions
with the cited quotation anchors at finish and committed-artifact validation.
Sharing a segment or speaker does not establish content support. If a source
utterance was truncated by an observation, stop for host review of the full
original utterance. Any justified revision retains the quotation's logical ID,
speaker and addressees, stages a new correction envelope, and passes normal
annotation/finish validation while preserving original revisions and receipts.
Never remove content assertions or change acquisition mode to evade the check.
Legacy artifacts without exact object assertions are not certified by this check.

Host-reviewed knowledge supplements use an immutable `knowledge-repairs` plan
linked to the original completed receipt and deferred target report. Their finish
allows only the target event's knowledge acquisition and new claim/proposition/
attribution dependencies reachable through typed references. Existing dependencies
and all other event fields remain read-only. On a scope diagnostic, preserve all
valid drafts, inspect the named pending artifact using `find_compiler_artifacts`
and copy `readArguments.ref`; correct only the named defect once. If correction
requires a new entity, annotation, changed baseline, or wider authority, stop for
host review. Never rotate the batch/namespace, remove established knowledge, or
reuse retired IDs. A short quotation anchor supports only its exact content, not
adjacent dialogue. Original deferrals still require their source-wide host review
before publication even after a supplement succeeds.

Model-facing tool failures are part of the agent protocol, not terminal exception strings. A failure must remain a real error for audit, circuit-breaker, and checkpoint logic, while also telling the agent how to make bounded progress.

Compiler recovery also consults the persisted proposal journal before session creation, after a batch report, and after a thrown timeout/network error. An interrupted mutation or two distinct failed inputs requires host review even when other proposals succeeded. `host-repair-required` metadata (including the tagged JSON on older Pi error paths) forbids fresh-session recovery. A single failed input remains eligible for one concrete correction under the same exact tool and `proposal_id`; a new ID or an unrelated successful draft never clears that obligation.

Source-accounting discovery persists a protocol receipt for each issued unresolved page: source hash, batch, segment IDs, exact ordered unit IDs and eventual consumer. This is audit metadata, not a source disposition or world mutation. If new evidence or valid accounting covers any submitted unit, `account_source_units` rejects the entire call with `coverage-changed`, listing `representedUnitIds`, `accountedUnits` and `remainingUnitIds`. Preserve the failed `proposal_id`, call same-batch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the returned `pageToken`, review the fresh page and make at most one corrected call. Never reuse indexes without inspecting that page. If no units remain, stop for host coverage review rather than submit an empty array or withdraw valid coverage. Receipts survive fresh sessions; consumed tokens stay single-use.

Host-only coverage adjudication uses `nwh compiler-obligations review-accounting --source <exact-id> --batch <exact-id> --proposal <failed-id> --reason <text> --audit-ref <ref>`. The default is a read-only proof preview; `--apply` verifies again under the compiler lock and records `superseded-by-coverage`. Missing legacy page receipts additionally require `--from-run <original-run-id>`; the host verifies the blob hashes, same-session discovery, identical failed input, failed result, exact source text and unit boundaries. No model tool exposes this adjudication. Every original failed input/unit must be included, with current-batch evidence/annotation anchors or nonblocking successor accounting decisions. Prior-stage coverage alone is deliberately insufficient for this settlement path. The journal retains every failure and binds the proof to source bytes, unit hashes, dependency contents, and audit references. Dependency withdrawal, revision ambiguity or source changes makes the proof invalid and requires host review again. Repeating the same valid host review is idempotent. A settlement never accepts world proposals, writes a checkpoint or certifies executable semantics.

Use `nwh status --json --source <exact-id>` for a read-only recovery snapshot. It verifies immutable source bytes and the deterministic segment layout, intersects effective-version checkpoints with the shared compiler plan, reports each stage and durable obligation, and links the latest audit run. It separately lists hash-verified archived candidates and their stored closure assessments; it does not run a new assessment, activate a revision, initialize traces, migrate storage, or infer readiness from counts. A lock record is shown as a record, without claiming its PID is live. Missing or stale evidence/layout produces unknown plan counts rather than a false completed state.

Scoped `finish_compiler_batch` now freezes a durable intent after validation and before cross-file acceptance. It binds the original finish arguments, pipeline/source/segment identity, proposal content hashes and title/chapter/role-review metadata. A prepared receipt freezes mutations and blocks model retries, including fresh sessions. Stop and preserve it on `Compiler finish requires host review`; inspect `status --json` and resume the same compiler scope through the host. The host holds the compiler lock, revalidates the exact original finish and replays idempotent acceptance/review operations before writing its completed receipt. Production source-batch checkpoints require that receipt. Input changes, withdrawn/revised dependencies or newly failing validation require inspection; never delete the receipt, change IDs, or rewrite the finish summary to bypass it. Receipt recovery does not certify world semantics or playability.

Explicit reparse, `resume=false`, and prepared-revision materialization archive replaced finish receipts with a reason; original receipt history remains on disk. Legacy checkpoints without receipts remain readable, but every new production finish/checkpoint follows the new protocol. Atomic rename supports process-interruption recovery; this is not a filesystem power-loss transaction or a multi-file database commit. Read-only status reports receipt checksums and timestamps; host recovery performs the full dependency and finish validation.

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

For a source-supported selector mistake after model retry exhaustion, the host
may use `withHostSelectorCorrection` under that lock. Review every original
failed input and bind its hashes, a reason, an audit reference, and one exact
corrected input. Only exact/prefix/suffix/occurrence may change; tool, proposal
ID, payload, segment scope, assertion targets and strengths stay fixed. The
permit exists only within that host call, retains the unresolved obligation,
and executes normal tool/schema/evidence validation. Only a successful tool
result resolves the obligation. A failed host correction or interrupted result
must stop for review; it grants no fresh-session or second host retry. Never
classify a supported proposal as unsupported to reset the retry guard.


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

### Persistent independent scene requirements (host CLI)

`nwh review-scenes --spec FILE --register SET_ID` registers source-verified
mandatory checks under the compiler lock and evaluates canonical artifacts only.
The default command without `--register` remains read-only and its pending overlay
cannot settle these obligations. For a definition predecessor miss, run
`nwh requirements inspect --source SOURCE_ID`, copy the matching
`definitions[].revisionHash` into `--predecessor`, and retry at most once with the
reviewed corrected specification. Never guess hashes or rotate set IDs to escape
an existing requirement. Changed scope needs its own source-review audit reference.

Corrupt/missing published journal records, a missing head, source mismatch or a
restore that would discard current requirements require host inspection. Stop;
do not retry unchanged, delete the ledger or alter canonical data to bypass the
failure. A completed compiler receipt and a model `proposed` report never settle
an independent requirement. Reevaluate the actual active artifact revisions.

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

## Opening input preflight

`preview_initial_world` is available only in host-scoped opening/reconciliation
passes. It reads the intended proposal envelope without staging a draft,
settling a proposal obligation, or committing truth. It aggregates payload shape,
exact-selector and field-evidence errors where independently checkable. A
successful preview explicitly leaves graph closure, commit and playability
unchecked; submission and finish still revalidate. Use at most an original and
one changed preview per batch session. Repeating unchanged input or exhausting
that allowance requires host review, never automatic fresh-session recovery.
Existing durable proposal and finish guards apply before preview work.

Initial-world input schemas expose defaultable arrays as optional and publish
the required reader fact kinds and stance-holder conditions. The full Zod
validator still runs before staging. Correct every reported path together. A
mention whose surface differs from selector.exact must be corrected using exact
text from the supplied segment under its original failed proposal_id. Fresh
IDs are only for replacing previously successful drafts, not settling failures.

Opening failures with unresolved obligations or a saved finish preserve drafts
and propagate their original error instead of entering fallback. Standalone
scoped compiler prompts record their own trace, including failures before model
creation. Read-only compiler status includes opening/supplemental journals while
keeping completed ordinary-source batch counts separate.

Preview exposes the same input schema as submission, including enums and nested
fields. Its second failed check immediately returns host-repair-required while
retaining the complete validation diagnostic; it does not wait for a third call
to stop automatic session recovery.

Opening preview attempts are reserved in `prepareArguments`, before Pi's schema
validation. Domain diagnostics at this boundary enumerate allowed enum values
and unexpected keys; remaining envelope validation failures use the same attempt
budget. Execution consumes the prepared attempt after Pi clones/validates it,
without counting it a second time. Direct host execution uses the same budget.
A parameter failure followed by an evidence failure therefore exhausts the same
one-correction allowance. Failed preview traces remain visible in compiler status
as `latestRun.lastToolFailure`, even when there are no proposal obligations.
Regression tests must call preparation, Pi validation, and execution in order.

## Resuming converged world-only finishes

A completed finish for world proposals precedes their convergence into canonical
artifacts. For completed world-only receipts with no metadata side effects,
recovery first verifies source bytes and the original dependency envelopes. If
all dependencies are accepted, it verifies their exact payloads are still current
canonical artifacts and rejects new pending work in the same frozen batch. It
then confirms completion without replaying a finish that requires pending drafts.
Missing, rejected or changed dependencies still require host review. Prepared
receipts, un-converged proposals and annotation/resolution/accounting/metadata
side effects retain their existing recovery checks; this path never reactivates
superseded identity resolutions or changes a receipt.

Use the standard CLI to continue through graph adjudication, semantic
reconciliation, role review and candidate archival without publishing Play:

```sh
node --import tsx src/cli.ts prepare-all --source SOURCE_ID --yes --candidate-only --model openai-codex/gpt-5.6-terra
```

No stage-specific dependency overrides are needed. Completed graph shard IDs are
verified without model calls when the loop encounters them again.

New semantic reconciliation plans require `finish_compiler_batch.target_reviews`
for every exact `repairPlan.reviewTargets` entry. The host associates active
proposals with targets; models never enumerate proposal IDs to choose the finish
set. Missing/duplicate/foreign target reports, unbacked `proposed` reports, and
foreign evidence handles reject finish. Read each listed artifact and source;
copy `read_source_evidence.evidence_segment_id` (discover with
`find_source_evidence`, then copy its returned `ref`). Correct the complete report
once while preserving every valid draft; an unchanged diagnostic stops for host
review. `unsupported` and `capability-gap` reports preserve unresolved work and
are not assertions that the novel lacks evidence.

Version 3 reconciliation plans also freeze `repairPlan.requirements`. Every
target report must carry `requirement_reviews` with one record per listed
capability, copying `requirementId` from the isolated prompt's
`repairPlan.requirements[].id`. A goal cannot substitute for ontology migration;
an empty action is not driver proposal work. Partial proposals may coexist with
an unresolved requirement report. Preserve these reports even when global ratios
improve. Never move a remaining capability gap into free-text summary alone.
For an ID miss, reread this exact active plan, copy its offered ID, and make at
most one corrected retry; do not search outside the plan or guess.

Version 2 finish identities freeze these capability requirements and the entire
plan hash. A changed/missing plan stops receipt recovery; preserve original
receipts and drafts, do not rewrite a plan or switch namespaces. Host deferral
reviews for these receipts name each deferred requirement ID in `reviews[].target`,
not just its containing character/event. Historical target-only receipts retain
their original version and review identity. None of these progress reports is a
semantic capability certificate.

Source deferral checks include retained `finish-receipts/<source>/history/`
records. Archiving for reparse/restore never clears an obligation. A host may
review an explicitly retired attempt by its exact original fingerprint after
checking the immutable source; this records accountability only and cannot
replay the retired writes. Active prepared finishes still require the normal
completion/recovery protocol. Candidate snapshots retain these records and
their reviewed requirement IDs. Restoration that would forget local obligations
or replace an existing review stops before world materialization; use an isolated
workspace, never delete history or retry unchanged. Corrupt archive identity,
source or filename requires host inspection, not a fresh model session.

Finish receipts freeze these reports. Post-convergence target audits are stored
in `compiler/reconciliation-reviews/`; a completed batch or accepted proposal is
not semantic resolution. Publication scans durable receipts across repair
namespaces, including on a restart with a clean audit. Deferred reports require
host source review through `reviewReconciliationDeferrals` under the compiler
lock, naming the exact completed finish fingerprint, every deferred target,
reason and audit reference. This does not certify world truth or bypass the full
publication audit. Original plans and receipts remain immutable. A new reviewed
repair round is allowed only after reviewing its predecessor's blockers; never
rotate a namespace to escape proposal obligations or deferred reviews.

Deterministic canonical commit-preview failures are finish-graph repair reports,
not requests to change finish arguments. Inspect the exact current pending draft
(using `find_compiler_artifacts` and its returned `ref`). Correct only the named
successful draft via a validated new envelope and withdrawal of its superseded
predecessor, preserving stable artifact identity and all unaffected fields.
After withdrawal, subsequent repairs must follow the active successor, never the
retired ID. A never-staged failed call still requires its original ID; these are
different lifecycle states. An attempted overwrite/revival that has itself
failed creates a durable obligation: stop for host review before any replacement.
The storage error's old generic suggestion to use a new ID is not authorization
to bypass that obligation. New reconciliation prompts include the exact-batch
pending/accepted/rejected identity inventory. Existing source and publication
validation remains unchanged.

### Quotation retrieval and knowledge-repair deferrals

`find_source_annotations` searches quotation content only after verifying its exact source anchor. Returned `readArguments.ref` is the read handle; `annotationId` remains the logical ID for attribution references. A failed annotation read must discover the exact failed ID in the same source, omitting status, copy the returned ref and retry once. Neighboring dialogue returning no matches is not proof that the designated quotation is missing. Invalid source anchors stop for host review; no unverified text fallback is allowed.

Knowledge-repair prompts provide designated quotation read arguments and verified source text as untrusted evidence. After a no-progress finish, the compile-loop host independently checks those dependencies and preserves the original model report and finish receipt. Failure identity includes the target, deterministic failure category and dependency IDs; a target-only coverage gap is not a root-cause fingerprint. This does not authorize automatic reopening of completed receipts or a stopped loop.


Independent role reviews now capture version 2 development expectations from
original source pages. Every candidate needs `developmentExpectation`: `stable`,
`changes` with dimensional before/after unit references, or `unknown` with an
explanation. These are requirement definitions, never satisfaction claims.
For unknown evidence-unit errors, call same-scope `read_roster_source_page` and
copy its exact `unitIds` into `basisUnitIds`, `beforeUnitIds`, or `afterUnitIds`.
For candidate/subject errors, call `read_role_roster` and copy `candidates[].id`
and `subjectHash`. Make at most one corrected retry; never guess or repeat
unchanged arguments. Single-use capture still requires finish, not resubmission.
Legacy reviews remain readable, but missing development data, insufficient
source evidence, or disagreement between reviewers remains an unknown
requirement at certification. Stop unchanged model retries; do not delete
reviews or recast unknown as stable to bypass the gate. Completing the semantic
requirement or migrating historical reviews needs a host-controlled review
revision with preserved history; the current role-review tool does not grant
that mutation capability.


### Core-role requirement registration and finish recovery

After the second independent role review commits, the host registers its complete
definition in the source requirement ledger. If publication fails after the
review was saved, preserve the finish receipt and use host finish recovery; do
not resubmit the single-use model proposal. Recovery rechecks the saved review
and idempotently completes registration. A corrupt ledger or missing head stops
for host repair; never delete history or switch namespaces to bypass it.

If a revision removes existing role requirements, stop model retries. The host
can register the already reviewed scope with
`nwh requirements register-core-roles --source <id> --predecessor <hash> --scope-decision <ref> --reason <text>`.
For a stale predecessor, run `nwh requirements inspect --source <id>`, copy
`revisionHash` from the last `coreRoleDefinitions` entry, and make at most one
corrected host retry. This records an explicit scope decision and removed IDs;
it neither erases prior requirements nor marks them satisfied. Rewriting a
retained review run is forbidden. New independent reviews require new run IDs;
this command does not itself grant a model permission to replace reviews.

Candidate evaluation is deterministic and tied to its frozen definition, source
bytes and subject hash. Missing or stale inputs require host re-evaluation, not
replaying model writes. Restoring a candidate that would discard current
definitions stops before world materialization; preserve the current ledger.


### Independent requirement attempts in reconciliation finish

New reconciliation plans (v4) freeze the registered core-role definition revision
and per-requirement hashes, or explicitly record that no such scope existed.
Older plans and receipts keep their original identities. A later registration
does not retroactively bind old reports to new requirements. If the frozen
independent revision changes, stop model retries and preserve the old plan,
receipt and drafts for host replanning; changing namespace does not remove the
old obligations or authorize replaying writes.

The host creates `requirementAttempts` inside finish v2 from validated reports
and matching typed proposal dependencies. Models still report only
`proposed`, `unsupported`, or `capability-gap`; `satisfied` is not accepted.
If the completed receipt was saved but the requirement-ledger append failed,
preserve it and use host finish recovery. The checkpoint assertion and
post-convergence requirement service can also idempotently retain the original
attempt without rerunning model writes. A bad plan, source, dependency or
definition must stop for host review, never be replaced with a guessed ID.
Historical snapshot import validates the original scope and preserves attempts;
it does not require old dependencies to be current and does not settle them.


### Post-convergence role settlement

`prepare-all` now completes the two independent role reviews before opening
semantic repair plans. The internal opening-only rollback path still stops
before this stage. A source review that does not commit stops unchanged model
retries; it cannot be bypassed by generating a repair under an empty scope.

After a repair shard converges, the host evaluates its canonical candidate and
retains per-attempt settlements keyed by receipt fingerprint, requirement ID,
definition hash and subject hash. A crash after the main evaluation was appended
requires only host settlement recovery; no model writes are replayed. Pending
proposals and unfinished source batches prevent candidate evaluation. A changed
subject invalidates the previous evaluation even when the new role roster cannot
yet be certified; preserve the reviews and stop for host source-review repair.

Superseded definition or proposal revisions yield `stale` for that historical
attempt, never a rewritten old success. If the same settlement key produces
different dependency evidence, stop for host storage/dependency review; do not
retry unchanged, delete the old result or replay the original proposal. These
records observe current postconditions; they do not claim that a particular
model attempt caused a capability to become satisfied.


### Frozen requirement journals

New prepared candidates carry the complete `compilerSnapshot.requirementJournal`
chain, including definitions, attempts, evaluations, invalidations and attempt
settlements. Restore validates original source bytes, the source-scoped sequence,
record hashes, predecessor links and referenced definitions/evaluations before
world materialization. Current local history must be a prefix of the incoming
chain. A missing, divergent or truncated chain stops for host review; preserve
the journal and candidate, never reset the head, discard later records or replay
model writes. An interrupted import can resume from its verified prefix.

The journal is audit evidence, not an evaluator input. Its addition changes the
immutable bundle hash but not the semantic subject hash. Current certification
still recomputes capability results from frozen world inputs; a historical
`satisfied` entry never grants current satisfaction. Historical bundles without
a journal remain readable. If they have independent requirement definitions,
current certification requires a fresh candidate with retained history; missing
historical evaluations must not be fabricated. Such a legacy bundle cannot
restore over an existing local journal by silently dropping its audit history.


### Host-controlled migration of historical role reviews

A completed legacy review with missing development fields is still unknown; it
is never relabeled stable automatically. The host can explicitly open a new
review while preserving both complete and partial prior reviews:

```sh
nwh requirements inspect --source SOURCE
nwh requirements begin-core-role-review --source SOURCE --revision REVISION_ID --roster-hash SAVED_ROSTER_HASH --predecessor DEFINITION_HASH --scope-decision AUDIT_REF --reason "Why a new source review is needed"
nwh prepare-all --source SOURCE
```

Copy `savedRosterHash` and the last `coreRoleDefinitions[].revisionHash` from the
same-source inspection. Omit `--predecessor` only if no definition is registered.
A stale predecessor permits at most one corrected host retry; never guess IDs.
The revision command publishes its immutable decision and prior roster before
switching the current roster. If switching fails, resume the exact original
command: copy the original `id`, `priorRosterHash`,
`predecessorDefinitionRevision`, `scopeDecisionRef` and `reason` from
`reviewRevisions`, not a newer current hash. Recovery preserves already completed
new reviews and does not start another epoch. An unchanged-scope partial review
must be resumed rather than reset. A changed source identity needs another
explicit host decision; saved reviews are never silently replaced.

The host attaches `reviewRevisionId` to each captured review and its finish
metadata. Models cannot select or change it. An old in-flight or prepared review
cannot commit into the new epoch: stop retries and preserve that original
receipt. A pending finish blocks beginning a revision until host recovery or
explicit retirement through the existing retained-receipt protocol. A source
unit inventory that cannot be verified against immutable bytes also stops for
host review; do not invent old anchors.

Opening a revision does not approve shrinking the major-role denominator. If
new completed reviews omit a retained major role, inspect those concrete reviews
and use the separate `requirements register-core-roles` command with an exact
predecessor, scope-decision and reason. Then resume preparation: the host repairs
the original prepared finish before considering another model session. Prior
reviews and removed requirements remain in the journal; finish receipts remain
in retained receipt storage. Pending
review revisions block certification even if the old roster was once complete.

Each saved role-review snapshot, including the first review of a new epoch, is
also retained in the journal. Restore must preserve those snapshots; an older
candidate cannot overwrite a newer partial review. A roster carrying a new
review epoch without its journal authorization is invalid even for checkpoint
materialization. This does not upgrade the saved snapshot into a completed
finish or a capability certificate.

### Role-review finish recovery from a checkpoint

Candidates retain model role-review receipts even without reconciliation target
reports. Only a pure, dedicated role-review finish that was active and prepared
when captured receives `resumeRoleReview: true`. It must have no proposal
dependencies, requirement attempts or unrelated metadata. Checkpoint restoration
validates the immutable source, frozen roster subject, review epoch and exact
saved review before restoring that active intent. Preparation then recovers the
original finish before opening another model session. This narrow path does not
reactivate ordinary world-proposal finishes or unmarked archived role receipts.

A saved model review with a missing, mismatched or incomplete finish blocks
certification. Retired incomplete receipts remain historical; do not replay them
or continue model review to conceal the missing completion. Stop model retries,
preserve the roster and receipts, and use `nwh requirements inspect --source
<exact-id>` for host review. If the original finish cannot be resumed, an explicit
`requirements begin-core-role-review` decision may preserve and supersede that
partial review. Copy `savedRosterHash` and the last
`coreRoleDefinitions[].revisionHash` (when present), with at most one corrected
host retry. An active prepared finish must still be recovered first. Never reset
the roster, downgrade a completed receipt, guess references or retry unchanged.

### Requirement validity after host proposal acceptance

Single-proposal acceptance and general convergence observe retained requirement
validity under their host compiler operation. Scene requirements use the current
canonical evaluator. Previously evaluated role requirements compare the complete
current candidate subject; a changed subject appends invalidation and never
grants a new role success. Sources without prior role evaluations do not acquire
invented evaluations. Observation conservatively checks all retained sources
because canonical inputs can be shared.

If pending work or invalid canonical inputs prevent freezing the current role
subject, append invalidation with `nextSubjectSnapshotHash: null` and the actual
failure reason. This means the current subject is unavailable, not an empty or
guessed hash. Convergence reports the issue and can still quarantine invalid
drafts. Current certification must evaluate a valid frozen subject independently.
After host repair, re-evaluation appends a new result even if its subject has
returned to a previously evaluated value; the intervening invalidation remains.

If the validity journal append fails after acceptance, accepted artifacts remain
committed. Stop model retries and preserve receipts and history. Repair the
reported storage error, then run `nwh requirements refresh --source <exact-id>`
or resume the original convergence. An empty convergence retry also observes
validity; it does not replay accepted proposals. `requirements inspect` remains
read-only. `refresh` acquires the compiler lock, reports the journal and exits 2
when the current role subject remains unavailable. It is not a role evaluator or
a publication command. Do not reset history or retry the model unchanged.

Role-review revision commands and saved role-review registration also observe
the retained requirements, including a saved first review. Replaying the exact
host revision decision repairs an interrupted observation without clearing the
new roster. A changed roster or definition cannot inherit its predecessor's
evaluation.

`finish_compiler_batch` observes validity after marking the original receipt
completed. Its result retains unavailable-subject diagnostics in text and in
`requirementValidityIssues`; completion still means only the finish protocol.
If the journal write fails at this point, preserve the already completed receipt
and saved metadata. Stop model retries and use original verified host finish
recovery or `requirements refresh` after repairing the reported state. Do not
submit another review or a new batch to conceal the failure. Recovery observes
again even for an already-converged world-only finish, without replaying its
accepted proposals. The existing single-use and changed-dependency checks remain
in force.

### Upstream repair plan validation (not an execution capability)

`upstream-repair-plan.ts` defines a strict frozen host policy input for existing
annotation and identity/event-resolution types. Freezing the plan does not
persist authorization, consume a retry budget, open model tools or permit
finish. The executor must add those gates before using it for mutation.

The pure pre-stage validator checks source/requirement identity and all supplied
active baseline revisions, exact logical IDs, host provenance, citable segment
IDs, registered field differences and frozen typed references. It does not
replace original-byte evidence validation. Readable references do not grant
citation authority. Array element/index pointers are unregistered; the host
must explicitly authorize replacement of the complete named array field.
New objects require exact host-allocated dependency slots; references to other
planned creations must follow declared acyclic dependency edges.

`UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW` is terminal for that repair task: preserve
the plan, budget and drafts; do not guess references, rotate namespaces or retry
unchanged. A changed dependency requires host re-planning linked to the retained
predecessor. No agent tool is exposed by this module. When the executor is wired,
its narrow tools must still use `withNwhToolRecovery`, exact same-source discovery
instructions and the existing evidence, proposal-obligation and finish checks.

### Persisted upstream repair authorization and failure budget

`UpstreamRepairLedger` is a compiler-lock-owned host API. Registration verifies
actual immutable source bytes, deterministic segment layout, active independent
requirement definitions, readable artifacts, baseline revisions and retained
completed predecessor receipt identities. Authorization and every attempt
reservation repeat this preflight. A changed dependency stops the retained plan;
restoring the old artifact does not reopen it. Role definitions whose source
review scope is currently being revised are not active repair authority.

Inspect retained records with `nwh requirements inspect-upstream --source
<exact-id>`. Copy `plans[].plan.planHash` and `attempts[].attemptRef` exactly for
host recovery. A reserved attempt with no recorded outcome must be recovered
before any new model call. Failure recovery records the real diagnostic against
that original attempt, including after a host stop; it cannot rewrite the first
diagnostic. Permit at most one materially corrected retry with the same proposal
ID. Two failures exhaust the shared budget for each stable requirement ID and
derive `needs-host-review`. Plan, batch and retryBudgetRef changes do not reset
that count. There is no budget-reset API.

Overlapping successor plans must name the latest retained predecessor, preserve
all earlier stops and prove a changed shared dependency revision or independent
requirement revision. Reordering references is not a dependency change. A new
plan retains the previous requirement failure counts. Missing/corrupt journal
records or a missing head with retained records stop for host storage repair;
never initialize a new budget or delete the retained directory.

This stage does not expose model execution. Successful staging, typed proposal
integration, finish authorization/recovery and candidate snapshot preservation
must be implemented before these host records can authorize an executing model
session. Existing tool recovery and evidence checks must remain in that path.

### Host-guarded upstream staging and draft recovery

`stageUpstreamRepair` reserves the exact original tool input before preparation,
then invokes an existing narrow annotation/resolution tool through
`withNwhToolRecovery`. The common staging boundary rechecks actual dependencies,
source anchors, citable ranges, host provenance and authorized field differences.
It appends `attempt-validated` with the normalized payload hash before writing
the pending proposal. `attempt-staged` binds the exact resulting envelope hash;
it grants neither world truth nor requirement satisfaction.

Argument/selector failures retain their original bounded correction SOP and
charge the persistent failure budget. Unauthorized mutations stop the plan.
After a validated intent exists, a write may already have happened: do not count
an uncertain storage failure as a model-correction opportunity. Preserve the
reserved attempt and inspect `requirements inspect-upstream`; copy the exact
`attempts[].attemptRef` for `recoverUpstreamRepairStage`. Host recovery verifies
the original pending payload, source anchors, dependencies and provenance without
executing the tool. A missing or changed draft requires host review, never model
replay. Once successful, the same logical repair cannot be resubmitted with a new
proposal ID to replace its draft.

Managed upstream batch IDs reject ordinary toolset initialization without their
exact active authorization. Failed initialization leaves that toolset unusable
until the host establishes a valid batch; catching the error cannot permit later
tool execution. Even the host staging path currently rejects ordinary finish,
world proposals, retrieval and unrelated metadata tools. There is no autonomous
repair-session entrypoint yet. Authorization-aware finish, staged dependency
consumption and snapshot recovery remain prerequisites for the full executor.
