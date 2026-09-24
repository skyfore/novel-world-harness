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
repair-session entrypoint yet. The host finish executor described below is
separate from staging; live draft snapshot recovery remains outstanding.

### Consuming staged upstream dependencies

The host staging service now follows only declared same-plan write/creation
dependency edges. Every dependency must already have a validated intent and an
`attempt-staged` result. Its pending envelope, payload and provenance must still
match those records. Transitive dependencies undergo the same checks; no general
pending overlay is treated as active world truth.

If a declared dependency is not staged, stop the consumer before argument
preparation or budget reservation and stage that original host slot first. Do
not retry the consumer unchanged, invent a substitute ID or search another
namespace. Missing or altered dependency envelopes require host review with
the original plan and drafts preserved.

`attempt-validated.dependencies` freezes the complete declared staged dependency
closure as exact `attemptRef` and `proposalHash` pairs. The journal requires each
reference to name an earlier same-plan staged result and rejects omitted or
extraneous dependency slots. Consumer recovery checks the same closure without
executing tools. These references provide staged compiler inputs only; ordinary
finish remains unavailable to staging tools. Only the host's frozen finish
executor may commit this exact authorized batch; publication is a later gate.

### Upstream history in prepared candidates

Candidate snapshots retain the complete upstream repair journal. Frozen plans
must match a retained original requirement definition and the exact completed
predecessor receipt identities; ordinary annotation-only predecessor receipts
are retained too. Pending, stopped or otherwise unevaluated plans block current
certification. An authorized or staged record never counts as capability success.

Checkpoint materialization validates source bytes and the entire incoming chain
before writing canonical artifacts. The local journal must be an exact prefix;
an old candidate cannot erase later failures, attempts or authorizations. Import
reuses the original record payloads/hashes and is idempotent. Missing or divergent
history requires an isolated workspace or host storage review; never delete the
head to make restoration pass. Failure counts remain effective after restoration
into a new workspace.

Journal import alone does not execute proposals, invent missing pending envelopes
or reactivate historical predecessor finishes. Portable recovery requires the
explicit upstream checkpoint described below, including its original envelopes.

### Frozen upstream finish intent

`prepareUpstreamRepairFinish` is a host-only preparation operation. It verifies
all original baselines, every planned staged slot and its dependency closure,
and the exact batch inventory before appending `finish-frozen`. The intent binds
the original finish input, authorization head, source and requirement revisions,
proposal envelope/payload hashes and read-only original baseline payloads.
It does not create a completed compiler receipt, commit artifacts or satisfy a
requirement. Ordinary finish remains unavailable to managed repair tools.

After freezing, do not authorize or stage the plan again. Host preparation may
resume only with the identical original input and matching retained drafts and
baselines; this returns the same intent without another event or tool execution.
Use `requirements inspect-upstream --source <sourceId>` and copy the exact
`plans[].plan.planHash` to identify the retained plan. Missing/changed drafts,
baselines, unrelated batch artifacts or a conflicting ordinary receipt require
host review. Preserve all records and drafts; do not retry unchanged, invent a
new batch, or reset the budget. Journal restoration retains this intent but does
not recreate pending drafts. Actual execution uses the separate host gate below.

### Executing and recovering an authorized upstream finish

`executeUpstreamRepairFinish` takes the original source ID and exact retained
`plans[].plan.planHash`; it takes no replacement model input. It runs the existing
compiler finish graph/source/lifecycle validators, then writes a v3 receipt
binding the complete frozen upstream intent before committing annotations or
resolutions. Unrelated metadata, world proposals and source-accounting writes
remain outside this authorization. A failed graph validation stops the plan for
host review before any commit; do not retry it unchanged or restart the model.

After a storage interruption, preserve the original receipt, journal and draft
envelopes. `recoverCompilerFinish` routes v3 receipts to this same host executor.
Recovery verifies pending or accepted envelope hashes, source bytes, independent
requirements and every original baseline. An active repair slot may contain its
original baseline or the exact validated output only when the matching original
receipt is already durable. An unrelated revision, missing envelope or changed
input requires host review, never an overwrite or a new proposal namespace.
The mutation guard still compares against the frozen original baseline payload.

Completion verifies every output is active, then records the exact completed
receipt fingerprint as `finished`. Recovery after receipt completion resumes
journal recording without rerunning mutation tools. Finished records and their
original receipts are retained in candidate history and still block certification
until convergence and current independent requirement evaluation have succeeded.

### Portable upstream draft and finish checkpoints

Candidates may retain `upstreamRepairCheckpoint` for live staging, frozen,
finished, converged or evaluated plans. It contains every original staged envelope, pending/accepted
status and explicitly active v3 receipt. Other pending compiler or world work
still prevents capture. An unresolved reserved attempt must first use local
draft recovery; do not rerun the model to manufacture a replacement envelope.
The full original journal, requirement history and retained receipts remain
mandatory. This is a compiler checkpoint, not a publishable Play revision.

Before materialization, verify all draft/attempt hashes, complete membership,
source bytes and layout, original baselines, allowed field mutations, accepted
active outputs and receipt lifecycle. Local pending proposals absent from the
checkpoint, changed envelopes, rejected identities or accepted-to-pending
regressions require host review or an isolated workspace. Preserve the local
history; do not delete drafts or rotate proposal IDs to make import pass.

Restore original envelope bytes without tool execution. Pending envelopes do
not commit artifacts; accepted envelopes reproduce only the already verified
snapshot outputs. Reactivate only receipts explicitly marked active in the
checkpoint after their exact envelopes and retained authorization are present.
Historical predecessor receipts remain historical. Restoring the same checkpoint
is idempotent; later attempts or finish completion prevent rollback to an older
checkpoint. The host then resumes staging or the original finish through the
existing bounded services. No provider call or new budget is created by import.

### Post-convergence upstream revision observation

After deterministic world convergence, the host inspects finished and converged
repairs across retained sources because canonical dependencies may be shared.
It rereads the completed original receipt, exact output revisions and unchanged
baselines. Only a source with no pending world, annotation, resolution or
accounting work can append `converged`. That record binds the original finish
fingerprint and actual complete dependency/output revision set; it is not a
requirement evaluation and does not clear certification gates.

`UPSTREAM_REPAIR_CONVERGENCE_PENDING` preserves the finished plan. Complete,
repair or quarantine the existing downstream work through its original host
workflow, then run convergence again; do not restart upstream model attempts.
An interrupted observation can resume through an empty convergence retry.
Receipt/authority mismatches stop the plan as `needs-host-review`, preserving
the original reason and current artifacts. The compiler commands report these
issues separately from committed world results. A later revision change is
detected even for an already converged plan; repeated unchanged observation
does not append another convergence record.

Current checkpoints also retain finished/converged envelopes and active receipts
so observation can continue after workspace migration. Older history-only
checkpoints remain readable but cannot invent missing envelopes or reactivate
historical receipts to claim convergence; preserve them for host review.

### Independent upstream requirement evaluation and invalidation

`nwh requirements evaluate-upstream --source <id>` runs under the compiler lock
after an observed convergence. It reads the actual candidate and uses the existing
scene and core-role evaluators; it accepts no model-provided result or replacement
requirement list. `prepare-all` also settles eligible repairs at its candidate
stage. Each `evaluated` record binds the original plan/definition, completed
receipt, convergence record, subject hash and every selected requirement result.
Blocked, unknown and unmapped results remain unresolved; the CLI exits 2 for
remaining upstream issues. Other world, role and quality gates stay independent.

Certification recomputes current results from the frozen definitions. A matching
hash plus a claimed `satisfied` state is insufficient. Only currently satisfied
obligations clear this gate. Legally linked successor plans take over their
selected obligations; predecessor attempts and failure budgets remain retained,
and an unevaluated successor does not clear the predecessor's unresolved work.

The subject hash retains all upstream authorization, proposal, budget and
convergence inputs, but excludes derived evaluation/invalidation events and
their chain metadata. The complete original journal is still stored and checked.
Adding an evaluation therefore cannot invalidate itself. Host validity observation
appends an invalidation when canonical/definition/other subject inputs change,
or records an unavailable subject when pending work prevents a candidate freeze.
Certification also detects stale input hashes before any explicit refresh.

On an unavailable candidate, preserve the original plan, envelopes, result and
budget. Inspect the existing source workflow and resolve its host blocker, then
run `requirements evaluate-upstream` again; do not replay repair tools, guess new
IDs or restart a model namespace. Use `requirements inspect-upstream` and its exact
`plans[].plan.planHash` to locate retained evaluation history. Repeated identical
evaluation is idempotent, and portable checkpoints preserve evaluated state.

### Isolated upstream model slot

`runUpstreamRepairModelSlot` is a host API called under the compiler lock for
one previously authorized slot. It reserves a durable model session before Pi
construction. The fresh session has no project instructions, local file tools,
NWH extensions or resumed transcript. Its only tools are
`read_upstream_repair_context` and the selected original narrow proposal tool.
The latter transports `proposal_json`; the host reserves the attempt before
parsing and validating the original domain schema and exact authorized slot.

For an ID or evidence miss, read `read_upstream_repair_context`, copy exactly
`readable[].id`, `stagedDependencies[].payload.id` or `evidence[].segmentId`, and
make at most one materially corrected retry using the same host proposal ID.
Never guess IDs, rotate proposal identities or retry unchanged. Host authority,
source drift, consumed slot and budget failures stop immediately. A successful
proposal only stages a draft; the host retains finish and commitment authority.

No-proposal sessions consume a failure and stop the plan for host review. Typed
proposal failures are not counted twice when the session closes. Failures remain
shared across revised plans for the same independent requirements, and exhausted
budgets reject before another provider invocation. A stopped completed predecessor
may be followed by an explicitly linked plan with a changed dependency revision;
its accepted draft remains immutable. Pending successful drafts cannot be retired
by this API to obtain another model attempt.

An unresolved invocation blocks another model session and checkpoint capture.
Inspect `requirements inspect-upstream` and copy `modelSessions[].sessionRef`.
`recoverUpstreamRepairModelSession` verifies an existing validated original draft
and closes its reservation without executing a tool or restarting Pi. If no such
draft exists, preserve the reservation for host review; do not replay the model.
This API does not yet provide automatic plan generation or a full DAG scheduler.

Host CLI entry points:

- `nwh requirements run-upstream-slot --source <id> --plan <hash> --kind <kind> --artifact <id>`
  consumes existing host authorization. Copy `plans[].plan.planHash` and the
  matching `allowedWrites[]` / `allowedCreations[]` kind and id from
  `requirements inspect-upstream`. It does not register, authorize, finish or
  publish a plan. `--config` explicitly selects the extractor profile;
  `--model` optionally overrides the model and `--timeout-ms` bounds the turn.
- `nwh requirements recover-upstream-session --source <id> --session-ref <hash>`
  copies the exact `modelSessions[].sessionRef` from that inspection and invokes
  only original-draft recovery. Both operations hold the compiler lock.

After process termination, first inspect the original compiler lock and follow
its owning-host recovery protocol if needed. Never delete the lock or start a
new model invocation to work around the original unresolved session.

`nwh requirements stage-upstream-plan --source <id> --plan <hash>` schedules all
slots of an already authorized plan under the compiler lock. Copy the plan hash
from `inspect-upstream plans[].plan.planHash`. Dependency edges point from the
consumer to its prerequisite; the host uses a stable topological order and
sequential isolated slot sessions. It verifies retained successful drafts before
any new model invocation and again when consuming them. A returned model message
or runner result without a durable validated envelope is never success.

Repeating this command after interruption reuses original verified drafts. Open
sessions are recoverable only from their original validated result; empty or
uncertain reservations stop the scheduler without another invocation. Baseline
or source preflight failure stops the plan with its original diagnostic. Failed
model calls retain the existing per-requirement budget and stop this invocation;
the scheduler contains no outer retry loop. It returns `phase: staged`, not a
completed repair or certification result. Finish, convergence, evaluation and
publication retain their existing separate host checks.

### Host plan lifecycle commands

All mutating lifecycle commands hold the workspace compiler lock. They are host
commands, never tools exposed to an isolated repair model:

1. `requirements register-upstream-plan --source <id> --file <plan.json>` reads
   an exact frozen plan including its validated `planHash`. It retains policy
   without authorizing mutation. A successor additionally supplies `--predecessor`
   copied from `inspect-upstream plans[].plan.planHash`; all existing source,
   revision, receipt, overlap and shared-budget checks still apply.
2. `requirements authorize-upstream-plan --source <id> --plan <hash>` rechecks
   the actual source and dependencies before persisting authorization. It cannot
   reopen a stopped plan or grant a new namespace to reset attempts.
3. `requirements stage-upstream-plan --source <id> --plan <hash>` stages the
   authorized dependency graph as described above.
4. `requirements finish-upstream-plan --source <id> --plan <hash> --input <review.json>`
   validates the existing compiler finish schema, exact reviewed segments,
   authorized inventory and all original evidence/identity validators, then
   freezes input before committing. The first invocation requires the host review;
   the command does not invent segment review from model success. After freezing,
   omit `--input` to recover the original receipt. Supplying a different input is
   rejected even after a partial authorized commit. Never rerun model slots to
   recover finish. Completion is not requirement satisfaction or publication.
5. `requirements observe-upstream-convergence --source <id>` verifies actual
   committed revisions and absence of pending source work without accepting
   unrelated proposals. It exits 2 on issues. Resolve pending downstream work
   through its original workflow, then observe again without upstream model replay.
6. `requirements evaluate-upstream --source <id>` evaluates actual independent
   obligations; unresolved results still exit 2 and retain certification gates.

`requirements stop-upstream-plan --source <id> --plan <hash> --reason <text>`
preserves the original diagnostic, drafts, receipt and budgets while stopping
execution. A repeat stop does not replace its original reason. Stopping is not
permission to reopen: a successor still requires the existing verified dependency
or definition change. For a missing plan, inspect this source and copy exactly
`plans[].plan.planHash` for one corrected host selection; never guess IDs or edit
frozen JSON hashes to bypass a mismatch. Storage and scope failures require host
repair, not repeated model calls.

### Typed upstream planning

`requirements plan-upstream-repair --review <json>` reads a strict, versioned host
review under the compiler lock. `upstreamRepairReviewSchema` defines the input:
source and requirement revisions, stable plan/batch/budget identities, explicit
read/citation segment scope, audit reference and typed diagnostics. The result
remains `authority: diagnostic-only`. Save its `plan` member as the exact JSON
input for `register-upstream-plan`; planning does not register or authorize it.

Currently supported diagnostic policies are:

- `QUOTATION_ANCHOR_INCOMPLETE`: an exact current quotation revision plus a
  host-reviewed `expectedAnchor` that strictly extends its original-byte range.
  The expected range must fit the explicit citable evidence. The generated policy
  permits only `/anchor`; it grants no speaker, mode or confidence edits.
- `QUOTATION_SPEAKER_MENTION_MISSING`: the current quotation must actually name
  an absent speaker mention. Its existing typed reference fixes the creation ID;
  one entity-mention slot and explicit dependency edges are generated. No absent
  speaker ID is invented from prose, and collisions with any annotation kind fail.
- `SEMANTIC_MODULE_REQUIRED`: returns `needs-host-review`, no plan and exit 2.
  A mixed review containing unsupported semantics grants no partial authority.

The host derives baseline hashes and readable refs from current typed objects,
then runs the original plan/source/definition/receipt preflight. The review hash
is bound into its authorization reference. It never parses error strings into
write pointers or infers satisfaction from a successful plan. On missing/stale
quotation data, use same-source `find_source_annotations`, copy `annotationId`
and obtain a new exact host review; never guess IDs or change a revision hash to
silence the conflict. An unchanged failed review must stop.

This is a typed review-to-plan converter, not yet automatic discovery of all
compiler diagnostic classes. Resolution revision, expression/perception and executable
repair policies remain unsupported by this converter; missing-resolution creation
is supported below. Independent requirement
evaluation and downstream closure checks still determine repair success.

### Missing resolution discovery and negative dependencies

`requirements discover-upstream-repairs --source <id>` takes the compiler lock
for a consistent read, checks original source bytes/segment layout, then examines
active typed annotations and resolution refs. It reports missing quotation
speaker mentions, `ENTITY_RESOLUTION_MISSING` and `EVENT_RESOLUTION_MISSING`.
An existing unresolved, ambiguous or non-referential resolution is not absent.
It does not infer quotation boundaries or equate matching names with identity.

Copy `findings[].diagnostic` into the host review and bind the independent
`requirementId` and explicit evidence scope. For missing resolutions, provide
`candidates: [{id, revisionHash}]` using the matching kind from
`candidateRefs[].id` and `candidateRefs[].revisionHash`; `readArguments.ref`
permits exact artifact inspection. This catalog is not a list of asserted matches.
An empty candidate list permits a source-grounded unresolved result, not a guessed
entity/event. Candidate source/revision mismatches require one new corrected host
review after discovery; unchanged retries and namespace rotation are forbidden.

The planner verifies actual absence and freezes the original mention and every
explicit candidate revision. The resolution creation ID derives from source,
kind and mention, so changing a plan, batch or budget cannot rotate the slot.
It grants no new entity or canonical-event creation. The created resolution must
name exactly its original mention; it cannot consume a different readable mention.

`resolutionAbsences` is an optional versioned plan constraint for backward reading
of older plans; new missing-resolution plans always emit it. Preflight and
checkpoint state validation reject any other active resolution for that mention,
even if the newly allocated ID remains free. Only the original exact output backed
by its durable receipt is allowed during partial commit/recovery. An absence
change preserves the old plan and stops model retries; do not recreate the old
missing dependency or overwrite the new resolution. A successful unresolved
resolution removes a structural absence finding but does not satisfy independent
requirements or clear certification gates.

### Scene requirement dependency binding

`requirements bind-upstream-repairs --source <id>` regenerates structural findings
and source-verified scene assessments under the compiler lock, freezes the current
candidate, then traces declared closure dependencies from each unresolved event,
norm or action requirement to the finding's exact annotation revision. It returns
`subjectSnapshotHash`, `closureHash`, original definition revision/requirement ID
and the directed path of node revisions. No claimed links or success states are
accepted as command input; the result remains diagnostic-only.

Only typed dependency paths qualify. Sharing a source, source unit, roster,
entry, requirement set or overlapping text does not establish a repair binding.
Missing/stale target revisions have no path; duplicate closure identities and
stale edges stop for host review. The host indexes the closure once and reuses one
search per target, so repeated capability checks do not repeatedly parse the
whole graph. Quotation `speakerMentionId` and discourse `viewpointMentionId` now
participate in closure validation alongside their plural forms. Existing stored
closure assessments are still compared with a freshly rebuilt graph, so an old
assessment that omitted these dependencies cannot silently remain valid.

Copy the exact binding's `requirementSetHash` and `requirementId` into a host
review only after inspecting its diagnostic and path. Regenerate after subject
changes; a path proves dependency, not that this repair will satisfy a capability.
`unboundFindingIds` and `coreRoleBlockers` must remain explicit.
Do not assign them by matching names or shared text, and do not treat a structural
repair as a new requirement evaluation. An unfreezable candidate requires resolving
its original pending host work; preserve diagnostics and do not replay models.

### Planning from current scene bindings

`requirements plan-bound-upstream-repair --request <json>` consumes a strict
`boundUpstreamRepairRequestSchema`: source, current subject/closure hashes,
original requirement-set hash, selected finding hashes, stable plan/batch/budget
identities, host audit ref, citation scope and optional resolution candidate IDs.
Copy these selectors from `bind-upstream-repairs`; do not construct finding IDs.
The command recomputes the binding report under the compiler lock before use.

Every selected finding must have a current typed path to an unresolved requirement
in that original definition. The host retains **all** those matching requirement
IDs; there is no caller-provided replacement requirement list. Candidate revisions
are copied from the current discovery catalog for the exact entity/event kind.
Quotation mention creation does not accept resolution candidate selections. The
underlying diagnostic policy still decides the narrow mutation slots.

The generated plan freezes all supported path nodes as exact baseline revisions,
including readonly attribution, claim and other canonical dependencies. They add
no new mutation kinds. This prevents a changed event/attribution path from keeping
an old generated plan authorizable merely because the target annotation is unchanged.
The binding and review hashes are retained in its authorization reference.

Stale subject/closure hashes require one regenerated host request. Unbound
findings, unknown candidates and nodes without a registered baseline representation
stop for host review; never drop path guards or substitute guessed requirements.
Evidence-binding nodes and structural discourse objects without matching readable
artifacts are not silently flattened to their source text. Existing direct host
review planning remains necessary for independently reviewed quotation extensions;
discovery does not infer those expected anchors. Core-role bindings now use the frozen independently reviewed definition: ontology/development start from the exact character model, and opening-driver starts from the verified physical entry or a non-focal physically present actor goal. Entry guards and every typed path node are frozen; shared source text grants no binding. Unknown entry time retains its original diagnostic in coreRoleBlockers and grants no driver binding. The output remains diagnostic-only: register and
authorize the exact `plan` through the normal lifecycle, then independently evaluate
actual capability results after finish/convergence.

### Authorized upstream phase in normal preparation

`prepare-all --source <id> --upstream-plan <hash> --upstream-finish <review.json>`
continues an existing authorized plan before ordinary compilation, cache restore
or broad reconciliation. Copy the exact hash from `requirements inspect-upstream`.
The first run checks a complete host review and exact source segment inventory
before any model call; it does not invent source review or implicitly authorize a
planned/stopped task. With an existing frozen intent, omit `--upstream-finish` to
recover it; a replacement input is rejected.

This phase reuses the slot DAG scheduler, original finish executor and actual
convergence observer under the existing compiler lock. Prepared/partly committed
finish resumes without staging or invoking a model again. Deterministic authority
failures stop normal preparation. Pending downstream work retains its original
issues for the existing workflow. Successful upstream execution disables cache
restore for this preparation invocation, so an old published snapshot cannot be
restored over the repair. It does not modify that immutable publication. The
normal requirement settlement, candidate and certification gates still run.

The CLI now forwards SIGINT/SIGTERM cooperatively through preparation. Isolated
Pi turns receive abort, dispose and retain their original journal outcome before
the lock unwinds. A pre-aborted call creates no new reservation. An invoked turn
with no typed result follows the existing persisted failed-session policy; do not
reopen it or reset its budget. An unresolved write retains the original reservation
and must use exact-draft recovery. Process loss/SIGKILL still uses the original
owning-host lock recovery protocol, never automatic lock deletion.


### Retained upstream finish reviews in default preparation

`prepare-all --source <id>` now resumes existing active authorized/staging,
finish-frozen and finished repair plans before ordinary compilation or cache
restoration. It does not register or authorize new plans. An active stopped plan
halts this path with its retained diagnostic; no replacement namespace or model
retry is permitted. Superseded requirements retain their original history.

The first explicit `--upstream-plan <hash> --upstream-finish <review.json>` call
records the exact complete host review in the append-only repair journal before
staging invokes a model. After that record is durable, default preparation and
`requirements finish-upstream-plan` can use it without the external file. The
latter still requires already staged results. Neither path fabricates review
completion or replaces its segments, dispositions or summary. Frozen intents
from older journals remain recoverable without a separate review record.

If an authorized plan lacks both retained review and frozen intent, stop before
model invocation. Use same-source `requirements inspect-upstream`, copy
`plans[].plan.planHash`, and supply the original host review through the explicit
prepare-all flags once. Do not retry unchanged, infer review from model output,
or reset the authorization/session budget.

### Structural discourse dependency guards

Bound upstream plans retain structural discourse as `structural-discourse`, a
read-only kind distinct from writable `discourse-segment` annotations. When a
closure path includes both representations of one discourse ID, retain both
revision guards. The original source structure manifest supplies the structural
payload; annotations cannot stand in for it. This adds no model mutation tool.

Missing, changed or wrong-source structural state stops preflight before a new
model attempt. Preserve the original plan, budget and pending proposals. Resolve
the host dependency and regenerate `bind-upstream-repairs`; copy its current
`subjectSnapshotHash`, `closureHash` and `discovery.findings[].findingId` for one
corrected host request. Do not remove the structural baseline, substitute the
annotation revision, or retry the old plan unchanged. Portable checkpoints retain
and validate the same structural payload before restoring repair authority.

### Semantic effect proposals and execution boundaries

`propose_semantic_effect` is a semantic-stage narrow compiler proposal tool.
Normal Pi session/extension registration wraps it with `withNwhToolRecovery`.
Use source-scoped evidence handles and an exact support selector for each of
`/canonicalEventId`, `/subjectEntityId`, `/kind`, `/validTime` and the typed args
(`/args/field` plus `/args/value`, or `/args/capacity` plus `/args/duration`).
`validTime` currently records the occurrence onset, preserving unknown time;
incapacity duration is separate and is never inferred as a number.

A state-change can be mapped only to an existing action-bearing event-execution
of the same occurrence, validated against its schema, semantic agency and exact
state outcome. Temporary incapacity remains unmapped in this initial registry.
Staging and finish do not imply lowering success or capability certification.
Convergence retains the source meaning without writing a second state delta.

For SEMANTIC_EFFECT_EVENT_MISSING, SUBJECT_MISSING or EXECUTION_MISSING, call
same-source `find_compiler_artifacts` with the matching kind. Copy
`results[].readArguments.ref` into `read_compiler_artifact.ref`, then copy its
`payload.id` into the indicated dependency field. Permit at most one materially
corrected retry; preserve the original failed proposal ID, or use the normal
successor path for an already successful draft. If no supported dependency
exists, stop for host repair. Never guess an ID or fabricate an execution.

SEMANTIC_EFFECT_UNMAPPED, LOWERING_MISMATCH and TIME_MISMATCH require host review
of the original meaning/mechanism. Do not retry unchanged, invent a duration,
change the occurrence outcome, delete the effect or reset a namespace to bypass
validation. Runtime realization and replay reject unmapped canonical effects;
independent branch actions do not activate future canonical meaning.

Pipeline 36 retains only compatible structure/observation checkpoints from the
supported legacy versions and reopens semantic/executable work. Engine 0.5.0
explicitly rejects old-engine branch history. Old canonical snapshots without
semantic-effect refs remain readable as having no such records; no meanings or
knowledge are fabricated during migration. New candidates and snapshots retain
new effect revisions; old publications are not rewritten.

### Nested quotation content validation

Attribution content diagnostics derive required object pointers from the actual
proposition schema and name the defective nested proposition. Discover that
proposition with same-source `find_compiler_artifacts` (`kind: proposition`);
copy `results[].readArguments.ref` into `read_compiler_artifact.ref`, and use
`payload.id` only for logical references. Discover quotations with same-source
`find_source_annotations` (`annotation_type: quotation`), copying
`results[].readArguments.ref` into `read_source_annotation.ref`. Correct the identified content selector at most
once when the cited source supports it. A parent reference or evidence from a
different utterance cannot replace child content. Preserve drafts and stop for
host source review if quotation revision or wider authority is needed. Missing
exact legacy evidence remains unverified; removing assertions is not a repair.
Cycles and expansion limits require host graph review: do not retry, raise the
limit, delete references, or guess substitute IDs.

### Committed utterance rendering

For accepted turns carrying host-derived utterance IDs, narration must return
`narration-blocks-v1`. Copy `resolvedAct.lockedUtterances[].utteranceId` directly
into `committed-utterance` blocks, exactly once each in supplied order. IDs are
already in the immutable frame: do not discover unrelated events or construct
replacement IDs. Correct invalid blocks once in a fresh rendering session with
the same frame. A prose block that copies dialogue (including an ambiguous
short substring) must be rewritten; never delete a legitimate repeated speech
block. Adjacent prose blocks cannot split a copied utterance to evade checking.
Missing or duplicate host IDs require host frame review before any model call;
do not retry that frame. Provider failure or invalid rendering leaves committed
actions intact. Use the existing narration-retry operation at that same head;
never resubmit the player action to repair presentation. Raw provider text and
native assistant events are drafts, and only complete validated prose is
published to terminal/Web consumers. Legacy frames without IDs remain readable
via their prior text checks; they do not prove block-contract compliance.

### Scheduling policy migration

`world-pressure-v2` does not use canonical extraction confidence as world
pressure. `sourceConfidence` is a diagnostic; `pressureBasis: unspecified`
means no world-pressure evidence was supplied. It is not an instruction to
invent a goal or deadline. Legality gates still apply before presentation
preference, and higher confidence/affinity cannot repair a failed prerequisite.
A cached frontier without the current policy version is recomputed by the host.
An unsupported engine version stops the branch operation: do not retry, relabel
commits, change confidence to force selection, or overwrite snapshots. Preserve
history and use its matching engine or an explicit host migration to a new
branch. A new session is not a migration.

### Actor legality before arbitration

`legality-first-v3` runs the normal read-only engine preview before actor
priority/conflict arbitration. `COMMIT_NOT_ATTEMPTED` means validation rejected
the candidate before any commit; preserve its validation errors. Raising its
priority, deleting preconditions, or changing actor IDs is not a repair. Correct
only an evidence-supported proposal once under the existing actor tool protocol;
unknown prerequisites remain blocked until world evidence changes. Legal selected
proposals are validated again at the actual commit head. Preview acceptance is
not a commit receipt and grants no world-state or character-knowledge change.

### Compiled actor alternatives

`legal-alternatives-v4` enumerates compiled `candidateAction` and
`actionPatterns`, then checks actual engine legality before selecting one action
per actor. The action index participates in the proposal identity; never reuse
a different pattern's ID. No-effect, unknown, or illegal patterns do not prove
that another pattern is unavailable. The deterministic source permits at most
64 read-only engine previews for one selection. `ACTOR_ALTERNATIVE_BUDGET_EXHAUSTED`
retains rejected proposal IDs/error codes and stops that search; do not retry
unchanged, raise the bound, or infer absence of a driver. Host scope review is
required. Entry probes exclude the focal actor before this budget is consumed.
The independent background lane may still establish a real witness; if neither
lane establishes one and actor search was incomplete, report
`ENTRY_DRIVER_SEARCH_INCOMPLETE` rather than a completed negative search. These
are host search bounds, not model token-usage measurements or new write authority.

### Opening driver discovery and frozen reconciliation scope

Reconciliation plan v5 never selects an opening driver by whole-book character
frequency. If no actionable physical opening actor is established,
`driverDiscovery: "opening-context-unresolved"` freezes separate
`initial-world:singleton:initial-world` and
`initial-world:singleton:opening-driver` requirements. Source-backed initial-world
proposals may repair opening facts, but cannot account for the driver requirement
as `proposed`. Report that requirement as `capability-gap` or `unsupported`;
normal finish retains it in the receipt and host review ledger. Convergence is
still required before proposed world facts become canonical. Coverage changes,
resume, and a newly planned scope do not clear the old obligation. Do not invent
a goal to make the audit green; actual independent entry-driver execution remains
necessary.

`RECONCILIATION_DRIVER_SCOPE_STALE` means a frozen actor scope lacks current
physical opening support (including old frequency-selected plans). Stop model
retries and preserve the original plan, receipts, and requirements for host source
review/replanning. Do not guess another actor ID, repeat unchanged, rotate the
namespace, or delete the old obligation. This host scope failure grants no new
mutation authority.

### Current goal pressure

`active-goal-pressure-v5` derives goal pressure at the exact frontier commit from
pinned actor goals, source-scoped history, actionable actor knowledge, activation,
completion, expiry, personal experience, and phase support. The derived goal map
is host input, not a model-writable proposal field. Unknown required knowledge or
activation contributes no goal pressure. A fulfilled historical `motivates` edge
alone contributes none: its explicit goal and motivated actor must match a current
goal and candidate participant. Repeated edges do not multiply pressure. Traces
record the accepted goal revision and priority; do not interpret those host traces
as an actor-visible knowledge grant. Mutable actor-store edits cannot change the
ranking of a frozen branch. No model retry or synthetic goal is authorized when a
current goal is absent; preserve the neutral result and use normal legal candidate
selection. Engine 0.9.0 histories freeze this policy; preserve incompatible history
and follow the existing engine-version stop/migration protocol.

### Host-derived due pressure

`host-world-pressure-v6` ignores every possibility's legacy `pressure` declaration
for ranking. Keep old artifacts readable; do not rewrite their bytes or raise the
number to force selection. Current pinned goals and host-derived due norm/process
instances are the available pressure sources. Unsupported pressure remains zero.
The current head's projection and frozen mechanism templates produce due candidates;
the evaluator requires an exact candidate hash match with that host-only set.
`kind: due-process` or `dueAtElapsedDays` alone grants neither due pressure nor the
due tier/date ordering. A changed payload or a different branch/head fails the
match. Do not retry unchanged, forge a due label, or create a synthetic mechanism
to obtain urgency; use the ordinary typed mechanism/goal evidence path and normal
commit gates. Source confidence and presentation preferences cannot supply missing
pressure. Traces retain the matched candidate hash, whose frontier entry includes
the instance references. This host proof is not a new model-write field or an
actor knowledge grant. Engine 0.10.0 freezes the policy; incompatible histories
retain the existing stop/migration protocol.

### Effective norm scope at settlement

`effective-norm-scope-v7` separates an unresolved norm instance (`status: active`)
from a template that is effective at the current cut. Scope predicates and each
exception use three-valued conjunction. An unknown exception is not proven absent;
an unknown higher-priority overrider prevents enforcing the lower norm. Known
inactive scope remains inactive even when another condition is unknown. The shared
resolver feeds automatic outcomes, due candidates, and norm settlement validation.
Instances are preserved while inactive/unknown/overridden; absence of a due
candidate never means the obligation was satisfied or deleted.

`NORM_SCOPE_NOT_ACTIVE` rejects satisfaction/violation outside proven effective
scope. Preserve the instance and branch head. Stop unchanged retries; do not
substitute IDs, erase exceptions, or invent enabling facts. Reevaluate after a
source-supported scope change is committed normally; unknown scope requires host
review. Settlement uses action-time state before the action's effects, in both
commit validation and replay. Changing scope in the same proposal does not
retroactively enable or exempt that action. Reparation remains validation of a
historical violation and is not an assertion that its original scope still holds.

`NORM_DEADLINE_NOT_DUE` rejects `deadline-expired` without a due elapsed obligation
at the action cut. Do not change the reason/ID to bypass it or repeat unchanged;
establish time through normal committed events before reevaluation. Engine 0.11.0
freezes the reducer change, including full replay and initial projection validation;
keep incompatible histories intact and follow the existing version stop protocol.

### Unknown world-rule conditions

`unknown-world-rule-v8` retains rules with unknown applicability, supported
exceptions, or higher-priority overrides in `resolution.uncertain`, with explicit
`unknown-applicability`, `unknown-exception`, or `unknown-override` diagnostics.
They are not exposed as effective actor rules or treated as proven absent. Known
false applicability and known true exceptions still establish non-applicability;
contested semantics keep the existing non-execution policy.

`STATE_RULE_SCOPE_UNKNOWN` means a possibly applicable hard rule prevents proving
this action legal. Stop unchanged retries. Establish scope facts through authorized
evidence/committed events; do not guess an exception, substitute rule IDs, or erase
the rule. An outcome proven safe under the possible rule remains permitted, so a
safe fact-establishing event can resolve the uncertainty. `STATE_RULE_CONDITION_UNKNOWN`
rejects a hard rule's unknown forbidden postcondition, including attempts to erase
the field. Resolve required facts before reevaluation; do not convert unknown to
false or repeat unchanged. These messages do not disclose hidden rule references.

For normative world rules, an unknown required fact no longer proves violation.
Only known false requirements or known true forbidden conditions can generate a
violation event. Absence of a violation is not a compliance certificate. Engine
0.12.0 and the policy fingerprint freeze this interpretation; preserve incompatible
history and use the existing version stop/migration protocol.

### Bounded world-rule time

`bounded-rule-time-v9` uses the same comparable calendar/ordinal interval model as
world time, but requires the complete current cut to lie inside a rule's validity
window before declaring it active. Disjoint comparable intervals are inactive;
partial overlap, missing/unordered cuts, or incompatible time scales remain
`unknown-time` in the rule resolver and use the existing uncertain-rule gate.
Equal unnumbered labels do not prove a shared period. Do not guess a date, year,
ordinal order, or offset to bypass the gate. Establish the cut through the normal
source-supported compilation/committed-event path and reevaluate; stop unchanged
retries. A missing rule bound still means unbounded applicability.

World-rule schemas continue to reject `relative` and `unknown` validity bounds.
Event-driven activation must use committed `activate-rule`/`deactivate-rule`
operations; do not weaken the schema or attach future canonical anchors as active
rule truth. The rule-time helper treats malformed/legacy relative or unknown bounds
as unresolved defensively, never as a new authorization. Engine 0.13.0 freezes the
change; preserve incompatible histories under the existing version protocol.

### Shared policy scope and unresolved offsets

`bounded-policy-time-v10` applies the bounded-cut truth check to character
dispositions, relationship stances/activation windows, and spatial validity.
Only `policyStoryScopeTruth === true` enables the policy. Partial overlap,
incomparable/missing cuts, and explicit unknown validity stay unresolved. Missing
validity is still unbounded; explicit unknown is not the same as omission.

A relative `after` with no offset can be proven by the committed anchor. A missing
anchor does not prove `before`; it remains unknown. `during` and free-text offsets
remain unknown until represented by supported temporal mechanisms. Development
and relationship-change start/end offsets likewise block application rather than
being silently treated as zero. This does not remove the caller's separate
committed/experienced trigger and retirement checks. Do not replace an unresolved
bound with an omitted bound, guess an ordinal/date, or erase an offset to recover
an action/route. Preserve the model and refs; stop unchanged retries for host
source/time review, then reevaluate after authorized refinement. An inactive
projection does not certify the policy false or retire the underlying artifact.
Engine 0.14.0 freezes the change; preserve incompatible histories and follow the
existing version protocol.

### UtteranceExpression v1 的表达与获知恢复

`propose_utterance_expression` 只接收逻辑 quotation/proposition IDs、有序原文 fragment selectors 和字段 evidence selectors。宿主读取当前或本批草案的实际修订，冻结 quotation anchor、proposition snapshots/hash 与 UTF-8 bytes；模型不能填写这些权威字段。内容证据路径使用宿主展开后的 `/propositions/i/snapshot/...`，不能只给 `/object/kind`。writing 另需 `/documentId`，文档和作者分别引用。

- `EXPRESSION_QUOTATION_MISSING`：在同 source 调用 `find_source_annotations(annotation_type=quotation)`，把 `results[].readArguments.ref` 原样交给 `read_source_annotation.ref`，仅将返回的 `payload.id` 用作 `quotation.quotationId`。其他实体/事件/命题/表达缺失用同 source `find_compiler_artifacts` 的对应 kind；同样复制 readArguments.ref，逻辑字段仅复制 payload.id。最多一次有实质修正的重试；找不到则保留草案并停止，不能猜 ID/hash。
- 表达内容缺证据、引用/内容不符：读取这次引文和实际命题对象，补齐 schema 要求的每个语义字段。多 anchor 为合取，多条独立支持为替代；断开的片段不能拼接成连续 exact quote。不得借用别处同一 proposition 的证据。未成功 staging 的失败沿用 proposal_id；已成功草案走既有 successor 协议。
- `EXPRESSION_QUOTATION_REVISION_MISMATCH`、场景图阻断：冻结依据已变或上游未闭合，保留草案和旧 prepared archive，停止模型重试，交宿主按受限源修复/重新编译路径处理。新候选不可覆盖旧快照。身份、annotation 或 source authority 不足同样停止。
- `ACQUISITION_EXPRESSION_REQUIRED/MISMATCH`：保留 attribution/proposition/mode，查同域表达后最多修正一次；已绑定表达的 attribution 不能删 expressionId 降级为 legacy 路径。
- `ACQUISITION_EXPRESSION_NOT_REALIZED`：表达尚未在分支历史发生，保留 head 并停止，不能把未来 canon 当获知证据、改 observed 或无变化重试。Genesis、正常提交和无 checkpoint 重放使用相同约束。

旧无 expression 的记录保持可读且不补造证明。新的表达证明须有独立精确证据、修订一致性和身份 trace；完整模式判别 Acquisition/PerceptionObservation 迁移尚未由本段实现。

### PerceptionObservation and bounded acquisition recovery

`propose_perception_observation` accepts logical observer/event mention IDs and exact field selectors. The host freezes the annotation/resolution hashes and occurrence anchors. Discover same-source annotations with `find_source_annotations`, copy `results[].readArguments.ref` into `read_source_annotation.ref`, then use `payload.id`. Discover identity/event resolutions with `find_identity_resolutions` / `find_event_resolutions`; copy `results[].ref` into the corresponding reader's `ref`. Canonical IDs come from `find_compiler_artifacts` → `results[].readArguments.ref` → `read_compiler_artifact` → `payload.id`. Permit at most one corrected retry inside existing authority; never invent hashes or logical IDs.

`PERCEPTION_TRACE_REVISION_MISMATCH`, `PERCEPTION_QUOTED_REPORT`, `PERCEPTION_UNMAPPED`, `PERCEPTION_CUT_NOT_CURRENT` and `PERCEPTION_ACCESS_NOT_PROVEN` stop model retries. Preserve drafts, immutable evidence and branch head for host review. A later report, equal state outcome or previous occurrence does not prove direct observation at the current event cut. Never remove `perceptionId`, delete a report source, or change acquisition mode to bypass proof. Runtime actor tools must not discover compiler-only evidence. Unsupported channels/phenomena remain represented-unmapped and cannot grant knowledge.

New model-side observed acquisitions require `perceptionId`. Unchanged legacy operations remain readable without acquiring verified status. A v1 knowledge repair plan cannot authorize new expression/perception dependencies; a host-reviewed v2 successor must explicitly enumerate `dependencyKinds`, preserve predecessor receipt and event baseline, and include only dependencies reachable from its target knowledge effects. Missing authority, frozen revisions and exhausted budgets require stopping, not plan mutation or namespace reset.

### Typed Acquisition recovery

`propose_acquisition` accepts an acquiring event, recipient/content, mode-specific basis and separate `received/understood/belief` evidence. The host loads the event's original evidence and freezes event/content/basis revisions; models never supply authority hashes. For `ACQUISITION_DEPENDENCY_MISSING` or `ACQUISITION_OCCURRENCE_MISSING`, use same-source `find_compiler_artifacts` with the named kind (`canonical-event` for the occurrence), copy `results[].readArguments.ref` into `read_compiler_artifact.ref`, and copy `payload.id` into the logical field. Permit one corrected retry within current authority, then stop if evidence is unavailable.

Revision mismatch, dependency cycle/depth or expansion limit, absent prior experience, unavailable premise and wrong acquiring cut stop retries. Keep drafts, branch head and frozen revisions. Never delete acquisitionId, change mode, borrow another actor's experience or treat future canon as history. Runtime actor tools cannot discover compiler-only proof. New repair dependencies require explicit v2 `dependencyKinds` authorization; typed acquisition dependencies must remain reachable from a reviewed target and preserve existing canonical artifacts and event baseline.

Receiving content is not understanding, accepting it is not world truth, and a source-grounded inference is an evidenced character belief rather than a general logical theorem. Forgetting current knowledge retains committed experience for a separately grounded recollection; it does not leave the forgotten premise available for inference. Deception retains actual and believed sources separately; actor views expose only the latter.

New model-side compiler learn operations require `acquisitionId`, including newly introduced told/read/inferred/remembered operations. Existing byte-identical operations in the current event, initial world or event-execution checkpoint may be retained for legacy repair; this never verifies their missing acquisition proof. A model cannot create a new legacy occurrence or change its knowledge status/confidence under that exception. Stage the acquiring event with its intended typed acquisition ID before freezing that event revision in the Acquisition proposal, then finish the connected dependency group together.

### Incapacity process recovery

`CHARACTER_ACTION_INCAPACITATED`, `CHARACTER_SPEECH_INCAPACITATED` and
`CHARACTER_PERCEPTION_INCAPACITATED` preserve the committed restriction. Stop
this attempted use; only a separately validated recovery event can change the
phase. Removing actorId, changing acquisition mode or rendering recovery is not
permitted. `INCAPACITY_RECOVERY_UNAUTHORIZED`, `INCAPACITY_DURATION_MISMATCH`,
`INCAPACITY_ONSET_DUPLICATE` and `INCAPACITY_ONSET_MISSING` require host review of
the actual onset/recovery/entry seed. Preserve drafts and branch head; no unchanged
retry, guessed deadline, duplicate local ID or background-source bypass.

`INCAPACITY_EVIDENCE_MISSING`, `INCAPACITY_CONTROL_OWNER_MISMATCH` and
`SEMANTIC_EFFECT_PROCESS_MISMATCH` require source-supported mechanism correction.
Within the authorized source and repair scope, call `find_compiler_artifacts`
for kind `process-template` (or `action-schema` for its recovery control), copy
`results[].readArguments.ref` verbatim into `read_compiler_artifact.ref`, and copy
its `payload.id` into the relevant template/schema reference. Read the original
occurrence before correcting exact incapacity field evidence. Permit at most
one corrected retry when the returned artifact and original source support it;
otherwise stop for host review. Never guess IDs, manufacture duration or widen
repair scope. An unknown duration is valid with no deadline or due transition;
it does not authorize immediate recovery.

`PROCESS_ONSET_TIME_INVALID` means a process start attempts to backdate an ordinary
event or lies after its entry cut. Preserve head and stop for host entry review;
never alter elapsed time, remove the timestamp from a historical seed, or retry
unchanged. `startedAtElapsedDays` belongs to host-materialized process operations,
not model process proposals. Reviewed entry seeds may restore historical starts;
an overdue restriction still needs a separately committed recovery event.

### Occurrence-bound process recovery

`PROCESS_RECOVERY_MECHANISM_MISSING`: within the authorized source and repair
scope, use `find_compiler_artifacts` with kind `process-template`; copy
`results[].readArguments.ref` verbatim into `read_compiler_artifact.ref`, then copy
`payload.id` into `processTemplateId`. At most one corrected retry is allowed if
the exact returned template and original occurrence support the recovery.
Otherwise preserve the draft and stop; no ID guessing or scope expansion.

`PROCESS_RECOVERY_EVIDENCE_MISSING` requires original occurrence evidence for
canonicalEventId, actorId, action when present and each recovery's template,
subject and outcome. Use the same proposal ID for a supported corrected attempt;
changing IDs or restarting does not discharge the failed obligation. Missing
source support requires host review, not a retry loop.

`PROCESS_RECOVERY_DUPLICATED`, `SUBJECT_UNPROVEN`, `CONTROL_MISMATCH`,
`DURATION_UNKNOWN`, `ACTION_REQUIRED` and `PRECONDITION_UNPROVEN` preserve the
actual failure and stop for source/mechanism review. Unknown duration is not a
timer. `PROCESS_RECOVERY_TARGET_UNRESOLVED` means the active branch has zero or
multiple eligible instances (or an unsupported intermediate phase/progress);
stop for host branch review, do not guess an instance. `PROCESS_RECOVERY_UNRESOLVED`
retains that underlying cause in runtime validation. `PROCESS_RECOVERY_EFFECT_MISSING`
is a history or entry-seed integrity failure: preserve head and stop, never
rewrite committed history or let rendering supply the missing recovery.

### Historical entry knowledge

`ENTRY_KNOWLEDGE_HISTORY_INVALID` preserves the real cause (missing frozen opening,
unproved embodied checkpoint, recursive baseline, stale cut, future/unrealized
occurrence or changed historical operations). Preserve branch head and drafts;
stop for host source/entry review. Do not guess cutHash, delete acquisitionId,
relabel an old observation, change actorId or retry unchanged. The host derives
knowledgeHistory from the frozen opening and ordered pre-entry events. Models
never supply receipt objects. A history reference is permitted only in Genesis;
a non-Genesis occurrence carrying one is rejected during replay.

A missing or ambiguous chronological baseline keeps the existing ENTRY_* error;
it is not permission to substitute source order or elapsed zero. Exact opening
`beforeCanonicalEventId` establishes the referenced occurrence as after that
pre-event seed even when its absolute story time is unknown. A later source
checkpoint can use a reviewed history reference, but an opening that recursively
requires itself cannot be reconstructed and must stop.

### Versioned resolution repair (2026-09-22)

The host planner accepts `ENTITY_RESOLUTION_REVISION` and
`EVENT_RESOLUTION_REVISION` for one existing decision over one exact mention.
Same-source `requirements discover-upstream-repairs` returns unresolved/ambiguous
revision findings. Copy `findings[].diagnostic` unchanged, including `mentionId`,
`revisionHash`, `resolutionId`, and `resolutionHash`; select candidates only from
`candidateRefs[].id` and `candidateRefs[].revisionHash` of the matching kind.
Resolved decisions may be revised only through an explicit host diagnostic review;
discovery does not infer that a resolved identity is wrong.

The plan allocates one deterministic successor ID and freezes its predecessor and
mention scope in `resolutionRevisions`. Use the returned `allowedCreations[].id`
as `resolution_id`; set `supersedes_resolution_id` (entity) or the one-element
`supersedes_resolution_ids` (event) to the frozen predecessor. Do not overwrite
an old ID or omit the predecessor. Unknown and ambiguous decisions remain in the
original baseline and immutable resolution history; a revision is not proof that
an identity became known. Event split/merge and unsupported semantic modules have
no registered policy: preserve the diagnostic and stop for host review, without
model retry or namespace rotation.

Changed hashes require one regenerated host review after copying the exact
same-source fields. Scope/authorization/budget/finish failures require stopping,
not a corrected model retry. Existing predecessor-plan authorization, durable
budgets, narrow tools, finish validation and independent postcondition evaluation
remain mandatory. Recovery may use the frozen predecessor payload only from the
original durable finish intent and only alongside its exact active successor;
competing decisions or missing baseline evidence stop recovery. Readonly recovered
predecessor revisions are audit evidence, never active identity decisions.

Quotation anchor-extension plans also freeze unchanged existing speaker and
addressee mentions. Missing mention dependencies still require their separately
allocated creation slots; an anchor extension does not authorize identity edits.

## Branch acquisition and legacy migration

A branch `record-acquisition` pairs with one learn at the same committed event. For an opaque prior-experience handle miss, re-read the current isolated prompt and copy `decision.experiences[].acquisitionId` (and its proposition/claim handles); permit one corrected retry only. An absent personal experience, wrong event cut, inaccessible document/observation, cross-actor/branch scope, or receipt mismatch requires stopping and preserving the head and proposal. Never delete acquisition provenance or invent a canonical occurrence.

`nwh migrate-acquisitions` is a host CLI, not a general model write tool. It preserves the real underlying compiler error and the isolated review workspace. A stale event hash, missing original proof, or conflicting legacy provenance requires evidence review before one corrected manifest run. Parent revisions, active publication and branch history remain unchanged; failures do not authorize fabricating source selectors, widening scope, or retry loops.

Decision dependencies are bound to the current host branch/head/actor and, during adjudication, candidate revision. A missing required actor knowledge record or undisclosed action contract stops inference; rebuild the same isolated view rather than searching compiler/global scope. `DECISION_CANDIDATE_CHANGED` requires host reconstruction of the current candidate/context pair before retrying; do not reuse the old manifest or retry unchanged. Dependency-budget failure is not permission to discard prerequisites. Host scope IDs stay in audit metadata, never in actor prompts.

Literary source references require exact actor-admitted text inside verified immutable source evidence. A keyword, a visible participant, or an event-level evidence span alone does not grant access to neighboring prose. Missing/ambiguous visibility proof omits that optional sample; do not widen the source span, use future canon, or guess an occurrence. `LITERARY_REFERENCE_STALE_HEAD` requires rebuilding the intended actor/head lookup; stop unchanged retries and never reuse another branch's index.

Conditional source speech is a frozen character-goal action candidate, not narrator authority. For `GOAL_EXPRESSION_MISSING`, use same-source `find_compiler_artifacts` with kind `utterance-expression`, copy `results[].readArguments.ref` into `read_compiler_artifact.ref`, then its `payload.id` into `expressionCandidates[].expressionId`. Claim misses use kind `claim` and copy `payload.id` into `requiredKnowledgeClaimIds[]`. Inspect the original source selectors for participant, relationship and knowledge requirements; make at most one corrected proposal under the existing successor protocol. Missing source support stops the task; do not erase conditions, invent references, widen source scope or retry unchanged.

`CONDITIONAL_EXPRESSION_*` failures during runtime are host reconstruction failures: preserve the current head, frozen goal and expression revisions. Stop the candidate, rebuild from current branch knowledge and conditions, and do not look up future canon through actor tools. Removing `expressionBinding`, promoting current-event learning to pre-event knowledge, changing the words or forcing canonical realization is not recovery. Replaying invalid committed bindings stops history loading; narration retries never regenerate the action.

### Agency and channel authority

`AGENCY_PROCESS_MISSING` / `AGENCY_ACTION_MISSING` use same-source
`find_compiler_artifacts` (`process-template` / `action-schema`), copy
`results[].readArguments.ref` to `read_compiler_artifact.ref`, then the returned
`payload.id` to the diagnosed `agencyProfile.channels[]` reference. Review the
source and exact field selectors before one corrected proposal; absent support
or unavailable discovery means stop, never invent a mechanism or widen scope.
Preserve an unstaged proposal ID; staged drafts follow the successor protocol.

`AGENCY_NOT_LIVE`, `AGENCY_UNAVAILABLE`, `AGENCY_BODY_REQUIRED` and
`AGENCY_CHANNEL_UNAVAILABLE` require host reconstruction at the unchanged head.
Do not retry unchanged, relabel a representation as a body, guess a session,
start one in the same event to authorize itself, or substitute an audio channel
for a physical-control mechanism. A narration retry does not repeat the action.

Remote interaction candidates copy only `decision.agency.channels[].id` and
`processId` handles from their current actor/head into
`interaction.channelBinding.channelId` and `processId` (or the corresponding
`action.channelBinding` for physical control). A sender's incoming binding is
not a recipient capability. Missing candidate dependencies stop inference;
paused sessions or a trigger that does not match committed speech require host
reconstruction at the unchanged head, never a guessed session or unchanged
model retry. Scoped tools cannot discover compiler-only channels.

For compiled conditional speech the host resolves exactly one eligible current
session after the frozen goal's original gates. Missing or ambiguous sessions
block the candidate; do not insert a guessed runtime process ID in source goals,
strip an expression/channel binding, or erase a location/knowledge prerequisite.
A stale candidate after pause and a replay binding mismatch preserve the head
and require host reconstruction. A model-authored speech candidate may select
an explicitly exposed channel handle, but all domain gates still revalidate it.


Remote opening entry failures distinguish source repair from host state repair.
`ENTRY_AGENCY_EVIDENCE_REQUIRED` permits at most one corrected compiler proposal:
copy the supplied source segment's exact `id` into `evidence_segment_ids` and
`selector.segment_id`, and support each named remote presence mode and historical
process operation at the same entry cut. Preserve the failed proposal ID or follow
the staged successor protocol; never erase the seed, relabel presence, import a
future session, or retry unchanged. Without original support, stop.
`ENTRY_AGENCY_UNPROVEN` is host repair only: preserve the head and reconstruct the
source-backed pre-entry process and knowledge state. Do not retry until that
state is repaired. A representation or remote mention is not an active channel.


Later remote entry uses the same protocol with checkpoint-prefixed selectors.
For `ENTRY_AGENCY_EVIDENCE_REQUIRED`, also support the named checkpoint actor and
execution binding's `/actorId` and `/canonicalEventId` links. An inactive proposal
tool, exhausted budget, circuit breaker or already-consumed sink forbids a retry,
even when the diagnostic also names a missing entry selector.
`EVENT_ENTRY_PRESENCE_UNPROVEN` stops for host source/checkpoint review: the
occurrence and entry must agree on live remote participation. Never relabel a
picture or mention, change the occurrence to unlock an entry, or import its future
outcome into the pre-event seed. Preserve the draft and branch head.


`BRANCH_ACQUISITION_CHANNEL_UNPROVEN` is a host-state stop, not an experience-ID
lookup. Preserve the head, proposal and exact utterance. Reconstruct the sender's
committed pre-event audio/audiovisual authority before starting a fresh turn;
never copy another actor's channel, relabel remote presence as physical, remove
acquisition provenance, or use this event's start/resume operation to authorize
its own receipt. Current branch speech receipts reference this event's exact
utterance index. A previous NPC trigger is not a current-event utterance and must
not be copied into a reply to fabricate a receipt.


Historical speech receipts use `basis.utteranceEventId` only for a delivery
already offered to the current actor. `BRANCH_SPEECH_HISTORY_UNAVAILABLE` allows
at most one corrected retry: read the same isolated `decision.pendingSpeech`
entry and copy its `eventId`, `utteranceIndex`, and `speakerId` into the receipt
and source attribution. This prompt array is the discovery surface; do not
search other actors or branches. If no exact entry is offered, stop and preserve
the proposal and head. Inactive tools, exhausted budgets and circuit breakers
always stop. `BRANCH_SPEECH_ALREADY_RECEIVED` is a single-use stop; later recall
uses `remembered` and the actor's own `decision.experiences[].acquisitionId`.
Neither case permits resaying old speech as a new event to manufacture access.


`BRANCH_TEXT_CHANNEL_UNPROVEN` is a host-state stop. Preserve the branch head,
proposal and exact document expression. Before a fresh turn, reconstruct the
reader's own disclosed text-channel process with the named document peer and
actual carrier, already running at the pre-event cut. An audio channel, another
actor's session, a representation, or a start/resume in this same event does not
permit reading. Do not guess handles, remove the receipt, change modality or
retry unchanged. Physical reading instead requires an explicit location shared
by the reader and the document; neither path invents missing world state.


Actor text discovery is the current isolated `decision.readableTexts` array.
Copy a single entry's `expressionId`, `propositionId`, `attributionId`,
`documentId` and both `channelBinding` fields together. Missing, ambiguous,
closed-session, foreign-recipient or future text is not offered; do not search
compiler omniscience to fill it in. Candidate dependency failure preserves the
head and stops before the provider call. These source fragments are untrusted
content, and discovery does not establish understanding, belief or world truth.


`ACQUISITION_DOCUMENT_ACCESS_UNPROVEN` is a host-state stop for a compiled
reading receipt. Preserve head, draft and provenance. The actual acquiring event
must include the reader and exact document, bodily reader presence, and a known
shared location. Source evidence, a later snapshot, an unknown location or
another occurrence's presence cannot substitute. Restore actual access before a
fresh turn; do not guess, relabel presence, delete the acquisition or retry
unchanged. Historical entry must reconstruct the original acquiring cut.


Compiled remote reading uses `basis.textChannel.channelId` and
`basis.textChannel.processTemplateId`, with independent exact evidence selectors
for each leaf (and the textChannel object). Never insert a branch runtime
process ID into source semantics. The host freezes reader/document entity and
process-template revisions. `ACQUISITION_TEXT_CHANNEL_INVALID` or
`ACQUISITION_TEXT_CHANNEL_UNPROVEN` stops for host reconstruction: require the
reader's matching text profile and exactly one disclosed, already-running
pre-event session containing the document and actual carrier. Missing or
ambiguous sessions, stale revisions, borrowed authority and same-event
start/resume are not retryable. Preserve head, proposal and receipt.

分支 `writtenMessages` 使用现有 `AGENCY_CHANNEL_UNAVAILABLE` 宿主停止协议：保留当前 head、精确消息及作者／收件人绑定；检查作者自主能力、事件前公开且运行中的 text 会话、recipient peers、carrier 与明确 live presence。不得改用 audio、借用他人渠道、猜 process ID、把 represented 改为 physical，或在发送事件内启动／恢复会话后自授权。投递记录不是理解或相信收据；模型接收适配器尚未开放时不得改塞入 audible utterance 或伪造源文档表达。

### Branch text interactions and message receipts

`interaction.kind=text` uses exact `content`, `addresseeIds`, `channel=text` and
mandatory `channelBinding`. Copy only the current actor's offered
`decision.agency.channels[].id` and `.processId` into `.channelId` and
`.processId`. The sender's incoming binding is not a receiver capability and is
removed from the NPC model input. `AGENCY_CHANNEL_UNAVAILABLE` is a host-state
stop: preserve the committed head and proposal; never borrow a channel, start a
session in the same event to authorize itself, relabel text as speech, or retry
unchanged. A successful send creates delivery, not recipient knowledge.

For `BRANCH_TEXT_HISTORY_UNAVAILABLE` at a model receipt boundary, re-read only
this actor's current `decision.pendingMessages` (or its same-snapshot
`find_actor_context` / `read_actor_context` record). Copy one returned entry's
`eventId`, `messageIndex`, and `authorId` into the read/branch-message receipt and
source attribution. Make at most one corrected retry; if no exact entry exists,
stop. Do not guess an event, use another branch, invent a document or re-send the
old message. `BRANCH_TEXT_ALREADY_RECEIVED`, inactive tools, exhausted budgets
and a repeated diagnostic prohibit retry. Recall uses the actor's existing
`decision.experiences[].acquisitionId` through remembered acquisition instead.

A host NPC trigger mismatch is not a model ID correction opportunity: stop for
host reconstruction without invoking the reasoner. A paused channel does not
revoke old delivery; the recipient can record its own reception and independent
understanding/belief, but sending a reply still requires its own active channel.
Text narration uses the same ordered committed-content blocks as dialogue, with
`channel=text` on the locked record. Copy each offered `utteranceId` exactly
once; never speak written content, replace its whitespace, invent IDs, or repeat
the player action after a rendering failure. One corrected rendering uses the
same committed head and content identities; a second failure stops.
