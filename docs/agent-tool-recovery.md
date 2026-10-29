# Agent tool failure recovery

## Entry capability contract recovery

`entry-capability/v2` separates grounded final entry state, a real actor action,
and an independent autonomous driver. `preview_initial_world.entryDiagnostics`
is read-only: `valid` covers shape and evidence checks, never graph closure,
commit or playability. Its canonical catalog can omit current pending proposals.
The report includes registered field definitions and the exact retained write
pointers for a managed repair. Inspect source evidence and dependencies before
submitting one corrected proposal under existing authority; never infer a missing
entity or permission from an incomplete catalog.

`BODILY_STATE_EVIDENCE_REQUIRED` needs an exact `supports` selector of explicit
or strong-inference strength on the named operation, such as
`/delta/operations/1`. Read the same-source evidence with
`find_source_evidence`/`read_source_evidence`; correct the selector once only if
it supports the subject, field and qualitative value. Omitted state remains
unknown. Never substitute a plan, location, numeric health or identity claim.

`ENTRY_ACTION_UNPROVEN` and `ENTRY_ACTION_SEARCH_INCOMPLETE` retain a missing
witness; neither proves source impossibility. A compiled goal may omit its
explicit action invocation: the probe and origin check use the engine's ad-hoc
normalization of its existing title, predicates and effects. This does not create
a new goal, effect or permission. Use same-source
`find_compiler_artifacts` for `character-goal` and `action-schema`, copy
`results[].readArguments.ref` into `read_compiler_artifact.ref`, and inspect the
exact preconditions, disclosure and frozen revisions. An ID/ref miss allows at
most one corrected discovery-based retry. The probe does not authorize module
installation, fabricated goals, future canon replay or budget expansion. A
changed head, mismatched effect hash, stale dependency or stale contract requires
host review/re-evaluation of the original candidate, never an unchanged retry.

`scope-conflict` and `consumed-stage` diagnostics stop dispatch. For an identity
consumer, use the source/task/ref discovery protocol below and inspect
`finishRevisionProgress.entryContractReview`. Preserve the original stop,
consumed grant, draft and acceptance status. New field support or passing code
tests grants no new semantic attempt, ledger write, certificate or activation.

An explicitly authorized entry-contract upgrade can recover a settled,
no-proposal opening revision through the original `execute-identity-repair`.
In the same source/task/ref, copy
`finishRevisionProgress.contractRecoveryCandidate.previousContextHash` from
`inspect-identity-repairs` into `--recover-entry-contract`, and supply the explicit
`--contract-recovery-authorization-ref`. Retain the original authorization and
revalidation ID; use `--inspect` first. Discovery and inspection confer no authority.
An ID miss allows one correction from that exact discovery field, never guessing.

The host verifies the complete old Pi session, requests, failure and source read;
the entry schema must have changed while source bytes, dependencies, original
revision intent and writable fields remain identical. It freezes that transition
and retains every old artifact. `finish-revision-contract-recovery.*` records one
new read/submission session with at most two model calls, using only the original
draft's remaining call and byte allowance. The cumulative budget includes both
sessions. A prior submission, unsettled request, changed scope, insufficient
allowance, failed recovery or another invocation stops without retry, renamed
authority or budget renewal. Passing tests alone never authorizes this transition.

Recovery searches the complete retained trace index for the exact source and
operation, independent of the recent-run listing limit. Older failures remain
discoverable; missing or duplicate matching traces still require host review.
Inspect the original source/task records without replaying or renaming the stage.

Only a verified new Pi submission can enter the existing finish-revision protocol.
The changed graph still needs deterministic commit preview and fresh independent
`finish-revision-acceptance` under its original remaining allowance. A sealed
draft may resume host persistence without replaying Pi. Old judgments and the
parent BREAK remain until the original consumer and source-audit revalidations
pass; this local recovery never grants certification or activation.

Acceptance receives `stagedEvidence` with the original envelope's hash-bound
field evidence assertions as well as its payload. If a completed negative review
under this explicit contract recovery omitted that metadata, inspect
`finishRevisionProgress.acceptanceEvidenceRecoveryCandidate.rejectedInputHash`.
Copy it into `--recover-acceptance-evidence`, retaining both contract-recovery
arguments and the original finding parameters, and preflight with `--inspect`.
The host verifies the entire negative session, unchanged proposal graph and
material omitted evidence. One separate `finish-revision-evidence-acceptance`
session uses the original review's remaining calls/bytes after both earlier
reviews; old verdicts, sessions and charges remain immutable. A changed proposal,
already supplied metadata, unsettled session or failed evidence recovery stops.
This restores transport context, never converts a negative verdict into support;
fresh independent acceptance remains mandatory and cannot be replayed.

Receipt recovery keeps the repair slot `initial-world:singleton` distinct from
the evidence target `initial-world:initial-world`. The host maps only this
canonical singleton identity when restoring original evidence; foreign targets
and missing or modified committed assertions still stop. After an identity-mapping
implementation fix, resume the original verified finish and receipt without
another Pi draft or acceptance invocation.

Checkpoint validation also keeps a consumer repair's retained identity decisions
separate from active resolutions. It recovers them only from the exact completed
parent plan and finish intent, with unchanged successor hashes and predecessor
links. Missing or modified evidence, another receipt, or a reactivated predecessor
stops. After fixing this host projection, rerun the original
`requirements evaluate-upstream --source <id>`; do not rewrite resolutions or
replay their model stages.

## Opening compiler failure recovery

`ENTRY_CONTEXT_REQUIRES_SOURCE_REVIEW` is a typed `phase:opening` semantic stop
for a settled pass that leaves no usable opening, not for an invocation exception.
CLI and Web preserve thrown errors, their cause chains and pending drafts; TUI
retains the actual run/finish diagnostic and stops. Unknown engineering or
provider failures do not acquire semantic recovery merely because no opening
was produced. Inspect the original trace/session before resolving the owning
failure; do not reject its drafts, retry unchanged or synthesize state.
Use `nwh compile-novel status --source <source-id>` to inspect the retained phase
and repair conditions; do not synthesize an alive-only opening or route this
condition into an engineering retry loop.

## Player move transport recovery

A `playerMoveId` identifies one exact request on one branch. The host validates
preconditions before publishing an exclusive immutable intent under
`world/play/moves/<branch>/<move-hash>/`. A completed receipt can return the
original outcome without another model request, world commit or conversation
append. `PLAY_MOVE_ID_CONFLICT` means the same ID was supplied with different
input: inspect the original request, never relabel it to force another action.

Session persistence is derived metadata. Its failure is returned as `sessionError`
alongside the actual committed result. Repeating the exact completed move may
repair that session pointer only while the branch remains at the recorded final
head; replay never rewinds a newer session or branch. Receipts do not authorize
world truth, which remains the committed branch history.

`PLAY_MOVE_RECOVERY_REQUIRED` means execution may still be running, stopped after
admission without a completed receipt, or retained data is inconsistent. Preserve
the named receipt directory, original trace and branch history, and inspect their
actual state. Do not automatically repeat the action, change its ID, delete the
intent or infer rollback from a transport error. A missing completion requires
host reconciliation; it is not permission to rerun Pi or world mutations.

## Full-command engineering supervisor

`requirements inspect-identity-repairs` is read-only recovery discovery for a
retained identity consumer stop. First use the same `--source` without a task,
copy `tasks[].taskId` into `--task`, then copy `items[].ref` or `availableRefs[]`
into `--ref`. Copy the exact `nextOffset` (or `downstream.nextOffset` for detail)
under the same source/task/ref; page size is 1..48. An ID/ref/cursor miss permits
one corrected discovery-based retry, never guessing or unchanged loops. For an
unknown source use `nwh status --json` and copy `sources[].sourceId` once.
Downstream discovery carries dependency counts/hashes; copy
`downstream.items[].dependencies.readRef` into the same source/task's `--ref`
to read its complete payload and pointer uses. A compact discovery page is not
evidence that those dependencies have been read or validated.

An altered graph, payload, ledger prefix or current baseline is a host-state
stop: preserve both versions and inspect the owning task; do not repin evidence,
dispatch a repair or automatically retry. `unsupported-kind` and
`unsupported-revision` require implementation and independent acceptance of the
missing typed operation. A completed recorded shard or a supported disposition
cannot renew a consumed phase, grant consumer writes, resume the parent or
certify the world. The command reconstructs current inputs but does not rerun
model/host acceptance; failed host receipts retain their original meaning.

Retired incident recovery records retain their original `contextRecoveryAttempt`
field and hashes for read-only ledger inspection. Execution and public authority
verification stop on that marker or an unsupported proof format. Preserve the
original receipts and charges; use `inspect-identity-repairs` for the same
source/task, never remove the marker, rewrite a proof version or redispatch.
The runtime does not import temporary producer scripts by hash, extend the
original recovery deadline, or open another incident-specific execution window.

Compiler hooks must not queue their originating user conversation. The dedicated
engineering registry uses `purpose: nwh-rebuild-review`, exact workspace/source,
model/effort, UUID, creation time and last-use time. Resume that exact UUID until
its creation age is strictly greater than 72 hours; retain the old registry on
rotation. A failed resume is never a reason to create another session.
`COMPILE_LOOP_DEDICATED_SESSION_REQUIRED` means preserve the passive observation
and hand the settled incident to its owning supervisor. Do not retry the queue,
use a current-chat monitor, or launch while the worker/lock is still active.

An authorized prerequisite attached to a stopped compiler can use
`runPrerequisiteLoop` without reopening the parent's exhausted incident. Its
single-use handoff binds the original task, stop, immutable files and inherited
counters. The registered Codex engineer fixes source, a distinct read-only Codex
session reviews the patch, and fixed host tests run before the exact domain
recovery preflight. Only a successful preflight can launch the Pi worker. A
consumed worker recovery is never repeated automatically; all new and old failure
files and cumulative domain charges remain binding. Engineering limits do not
grant extra model calls, bytes, semantic attempts or writes. Prerequisite DONE
still requires receipt verification and never means global certification.

Both the full command and prerequisite supervisor resolve the same registry for
their exact workspace/source. New registries live at
`$NWH_HOME/workspaces/v1/<workspace>/compile-loops/<source>/engineering-session/reviewer-session.json`
with exclusive owner locks. A matching historical
`run-records/<legacy-directory>/reviewer-session.json` remains authoritative in
place, with its original UUID and creation time; it cannot own another source.
Legacy directories are discovered locally; the exact workspace/source fields
determine ownership. Two matching legacy registries also stop as a conflict.
Resolution is read-only and never migrates or rotates a session. Two registries
claiming the same source stop with `DEDICATED_REGISTRY_CONFLICT`: inspect both
original records and their ownership before dispatch; do not choose, delete or
replace one to obtain another attempt. Invalid registry data also requires host
inspection, never a guessed source or replacement session.
Codex agent tools use an explicit native permission profile with entire task trees,
registry and owner locks read-only. Do not wrap the trusted Codex exec transport
in an additional mount sandbox: its command service fails under that nesting.
Host tests and workers use read-only mounts with mount-administration capabilities
dropped. Type checks and tests additionally receive a read-only root filesystem
with only a per-command scratch directory writable; they cannot add new task
records. Worker writes remain subject to the separately reviewed domain authority.
Real `command/exec` regressions must verify source edits plus rejected history
overwrites, deletions and additions; a standalone shell probe is insufficient. Checks after exit remain
a second guard. A newer private session field cannot replace the canonical registry
or renew its creation timestamp. Original consumer proofs and the ordered budget
inventory are verified, including each stage's scope and cumulative charges.
The fixed incident's observed provider requests and payload bytes independently
anchor the failed stage charge; repinning its budget/request cannot lower usage.
Prerequisite handoffs use paths derived from the original source/task; changing a
directory or lock cannot create another attempt. The parent BREAK, authorization,
stopped stage and cumulative budget must agree with all frozen original files.
Inspect/verify execute under a network-disabled, read-only `bwrap` mount, with
only their output directory writable. Missing sandbox/implementation, a nonexact
JSON result, altered history or consumed start keeps BREAK; do not retry under
another directory, session or budget.

The full `compile-novel` CLI starts an outer supervisor by default. Hooks only
record observations; a settled worker failure is handed to a dedicated engineering
session after the compiler releases its lock. An independent read-only review and
fixed host tests must approve the cumulative patch before a fresh worker can load
it. The supervisor can change implementation code, never novel truth or stored
budgets. Domain recovery still needs its original typed, source-bound authority.

Use `compile-novel status --source <id>` and copy
`compilation[].supervision.directory` or `.incident` for exact diagnostics.
Correct an unknown source once by copying `sources[].sourceId`; do not guess.
The same incident has at most two engineering rounds, including failed checks.
An unchanged invocation cannot clear BREAK, reset counts, renew a grant or change
the engineer model. Lock/in-flight, uncertain writes, failed independent review,
scope violations, cancellation, exhausted repair and unavailable model stops
require their concrete host condition to be resolved before dispatch. All original
receipts, task identities and failures remain authoritative.
After resolving that condition, copy `compilation[].supervision.stateHash` into
`--loop-resume` and record the concrete resolution with `--loop-resolution`.
This host-only, exact-state-bound resume preserves every consumed allowance;
exhausted incidents remain exhausted. Never guess a hash or retry unchanged.
Rejected admission (wrong policy/source/request, in-flight child, absent resolution
or wrong state hash) never rewrites the saved phase, reason, timestamp or counters.
Use `compile-novel status` again and copy `compilation[].supervision.stateHash`
only after resolving the actual condition; the rejected invocation is not a new
failure of the retained worker.

A successful worker receipt enters a durable verification-only state. Reopening
DONE rechecks that exact receipt, current certificate, active revision and branch
binding without launching another compiler or engineer. Verification results must
match the strict boolean/result schema; truthy values do not establish acceptance.
Each verification writes a new audit result and preserves earlier results. A
missing/changed receipt or stale certification keeps BREAK and the successful
worker binding. An exact host resume may reverify after the concrete condition is
resolved, but cannot reopen compilation, replace the receipt, or spend another
worker. Older DONE records are adopted into this same verification-only path,
including when their receipt is missing. Inspect the original result identified
by `compilation[].supervision.directory`; never guess a replacement or retry
unchanged. `COMPILE_LOOP_REQUEST_CHANGED` requires inspecting the original saved
request/policy; repinning altered authority is not a recovery.

For an explicitly requested rebuild after DONE, copy the completed
`compilation[].supervision.stateHash` into `--rebuild --loop-new-run <hash>`.
The hash identifies one new generation. Reusing it resumes or reverifies that
same generation; it never resets attempts. The supervisor saves the new READY
state before atomically switching its current-generation pointer and before any
child dispatch. A failed pointer publication can resume that exact staged
generation. All predecessor states, policies and receipts remain retained;
`supervision.directory` identifies the current one. A BREAK, active child, stale
hash or changed predecessor is not eligible for new-run admission. Resolve the
original stop instead; do not combine new-run with resume, migration or host-patch
authority. Source-bound domain budgets and certification gates remain in force.

If the host has implemented a concrete source fix after those engineering rounds
are spent, bind the actual cumulative delta against `pending.baseline` using
`digest(changes.map(file => [file, currentHash]))` and supply `--loop-host-patch`
together with the exact `--loop-resume` state hash and resolution. This is a
verification-only handoff: a fresh independent review and the unchanged fixed
tests must pass before dispatch. Engineering counts are retained. Only explicitly
submitted CLI/supervisor routing edits may cross the engineering control boundary;
domain budgets, certification gates and fixed tests remain protected. Changed
hashes, review rejection or failed checks stop without another worker. Never
submit a guessed hash, an unchanged patch or merely a promise of a fix.

## Ordinary compile source-audit recovery

An explicit later user request to resume compilation after an external provider
outage may authorize `host-provider-resumption-v1`. This is a separate host
decision, never automatic renewal of a failed grant. The host previews with
`inspectRoleProviderResumption`, copies its exact `authorityHash`, and authorizes
under the compiler lock with `authorizeRoleProviderResumption`. It requires the
last automatic quota context to have failed on its **first** request with zero
provider usage, zero tools, no retries, no proposals, no pending writes, unchanged
original task/dependencies and an unexhausted original progress window. A newer
successful availability check must use the same Pi provider and model. Record the
actual user authorization reference and bind the availability evidence.

Resuming the full pipeline may add a completed `compiler-host` /
`compiler-checkpoints` trace for batches it only skipped. That exact four-event,
zero-request, zero-tool, zero-usage trace does not supersede the retained model
refusal. Later model/work/write traces, incomplete inspections, or an original
refusal outside the bounded discovery window still stop for host review.

The new host lineage permits exactly one context and spends only the calls left
under the original cumulative ceiling. It retains the old grant, all context and
invocation claims, original budget, failure trace and uncommitted draft unchanged.
Its separate usage begins with every prior charge. Only original evidence reads,
inventory reads, read-only audit preview and the original typed audit proposal are
exposed; ordinary evidence and semantic validation remain mandatory. Any failure,
missing receipt, uncertain publication or scope drift consumes this host grant
and stops without renewal. Status/source IDs come from `compile-novel status`;
copy the exact returned source/plan/work IDs, correcting an ID miss once. Never
guess IDs, renew the grant, reset counters or treat the retained draft as committed.
Successful audit delivery still leaves blocked questions for independent repair,
global closure and executable certification.

Before dispatch, copy the exact availability evidence into the grant's immutable
workspace sidecar; its original hash remains part of the authorization. Removal
of the temporary input cannot remove that proof. Recovery reads use a separate
access checkpoint, leaving every predecessor file unchanged. Every later history
check revalidates the parent grant/context/attempt files, both refused traces and
their blobs, durable availability evidence, and the successful recovery trace,
receipt and checkpoint. Missing or changed retained evidence is a host stop, not
a reason to renew the grant, replay work or rebuild the missing proof from memory.

`compile-novel` and its `roles` phase enable bounded orchestration in the current
role plan. A trace-proven, settled Codex quota refusal may continue an unfinished
source audit only when its original prompt can be reconstructed exactly, tool
results are complete and read-only, dependency hashes still match, and the original
session and progress allowances remain. The compiler-lock owner claims one grant
for the stopped run; it reuses the original invocation and charges the original
budget. Restore all `read_role_session_context` pages using `nextOffset`, then
reread decisive evidence before proposing. A changed scope, pending write, tool
failure, missing trace, consumed grant or exhausted allowance stops continuation.
Do not retry these stops, clear counters, change work IDs or substitute a new plan.

The failed provider response must be the sole failed response, match the final
request, report zero usage and follow otherwise exactly paired model requests and
responses; retries and world commits disqualify this recovery. The authority binds
the cumulative starting usage and permits exactly one remaining ordinary context,
with a hard additional-call ceiling equal to the retained progress window at the
stop. Context rebuild and evidence-supplement requests are unavailable. A retained
preview remains untrusted and uncommitted; the model must restore originals and
submit through the unchanged typed validator. A failure after claim consumes this
grant and cannot be converted into another quota continuation.

If that claimed final quota context later reaches the no-progress breaker, ordinary
compilation may continue only for the narrower, trace-proven transport-loss shape:
all tools settled successfully and were read-only except one valid, uncommitted
audit preview; the last provider request failed with zero usage as `WebSocket
closed 1006`; its one adapter retry was rejected before transport by the retained
no-progress budget; and no audit proposal history exists. The compiler binds a
new `compile-audit-no-progress-v1` authority to both traces, the consumed quota
grant, final ordinary context, blocked budget, current atlas/entries/claim hashes,
original task, and retained draft. It never clears or overwrites the old budget.
One host session starts from the cumulative call count with exactly three further
calls and exposes only exact source reads, exact candidate-inventory reads, and
the original typed audit proposal. Preview, supplement and context-rebuild tools
are absent. Required IDs are supplied so the model can reread them together and
submit through unchanged semantic validators; the preview is never auto-promoted.
Blocked questions and unresolved findings remain obligations. Claim or usage
publication uncertainty, dependency drift, any tool error/mutation, a different
provider failure, missing receipt, or failure of this grant is terminal: inspect
the saved authority/result and do not issue another grant or retry unchanged.

When both ordinary audit invocations are claimed but the latest settled run ends
without a receipt immediately after its first typed audit input fails, the host
may use `compile-audit-correction-v1` only if the durable proposal journal still
allows its one ordinary correction. The trace must have no provider failure,
retry, compaction, pending call or other failed/mutating tool; its failed result
must carry the exact retryable `invalid-arguments` diagnostic, and the model must
then have stopped without another tool call. The current policy is intentionally
limited to a `missingMajorCharacters` diagnostic that says which assigned
discovery names were not retained. It binds the failed input and diagnostic,
complete trace, immutable task restored from all context pages, two invocation
claims, first two context claims, checkpoint, source/atlas/entries/claim hashes,
and unchanged cumulative progress budget. Missing or ambiguous evidence, changed
dependencies, a running proposal, a second distinct failed input, or any other
diagnostic remains stopped for host review.

Claiming this authority consumes the final ordinary context without creating an
invocation attempt. A separate cumulative budget permits exactly three calls:
read every mapped candidate named by the retained draft, submit a materially
changed draft to the unchanged read-only preview, then send that exact valid
preview through the original typed proposal. Exact retained source-unit reads
remain available if the supplied complete core is insufficient. The preview is
never promoted. Only `missingMajorCharacters` may change, and it must include
every diagnostic name plus every prior evidence basis. Blocked questions,
unresolved facts, discovery dispositions, identities, evidence and
the original failed attempt remain intact. The ordinary budget is never reset or
overwritten. The authority, context, usage and result are single-use; a missing
receipt, invalid correction, publication uncertainty or any failure consumes the
grant and forbids another correction continuation.

One host implementation-fault restoration is available for the exact rejected
`read_role_audit_inventory({candidateId, mode: "detail"})` shape. Every rejected
ID must belong to the retained required set, the entire set must have been read
once, all calls must have settled with that exact host-guard error, and the model
must then have stopped. There must be no preview, proposal, provider failure,
retry, unknown write, changed dependency or exhausted usage. The original grant
and its failed result remain immutable. `compile-audit-host-tool-repair-v1` binds
that trace, failure, checkpoint and unchanged cumulative ceiling, and spends
only its **one remaining call**, adding zero calls and zero ordinary context or
proposal attempts. The host restores the exact scoped reads before model dispatch;
the model can request only the original typed audit proposal. That request first
passes the unchanged preview and then the original submission validators. A saved
preview is never promoted. All fields except `missingMajorCharacters` remain
unchanged. That array keeps its entire old prefix unchanged (each name, rationale,
evidence list and order), and may append only the exact missing diagnostic names.
Preserving the aggregate evidence set alone is insufficient: a prior character
finding cannot be removed or merged into another. Ambiguity and overlapping
findings remain obligations for later independently checked semantic repair.
The restored call ends after submission; any failure, missing receipt or uncertain
publication remains terminal. Inspect `compile-novel status`, the same work's
correction authority and `.host-repair.json` lineage; never renew either record or
replay a claimed restoration. Successful restoration still leaves negative source
findings for independent semantic repair and certification.

A separate host schema restoration applies only when that three-call correction
used all of its own calls, every candidate/evidence read settled successfully,
and its sole failed tool was the read-only audit preview rejecting changes outside
`missingMajorCharacters`. The rejected draft must still contain every exact
diagnostic target and all prior evidence basis, with no foreign missing-character
name; it is failure evidence, not a saved preview to promote. The trace must then
end cleanly without a proposal, provider failure, retry, compaction or another
tool. `compile-audit-narrow-schema-repair-v1` binds that complete trace, rejected
input, failed correction/result, unchanged dependencies, journal and checkpoint.
It is available only when the original progress window retained at least one call
that was never allocated to the failed three-call grant.

The policy spends exactly one such retained original call, starting from cumulative
usage and raising the cumulative ceiling by one without changing either older
record. Its only model tool accepts new `missingMajorCharacters` entries for the
exact missing diagnostic names. The host prepends every frozen prior entry and
retains the prior rationale, atlas revision, questions, discovery dispositions and
unresolved facts byte-for-byte, then runs the unchanged preview and original typed
proposal only on that fresh explicit tool request. The rejected preview is never
auto-promoted. Exact scoped reads are restored by the host before dispatch. A
missing/ambiguous trace, changed evidence, unrelated read failure, unavailable
retained call, invalid append, missing receipt, uncertain publication or any
failure consumes this schema restoration and remains terminal. Never replay it,
renew the failed correction grant, or use other nominally unspent progress calls
for another recovery.

A successful negative source audit is a retained finding. After collecting all
source diagnostics, the host may bind one `compile-source-audit-repair-v1`
revision to that exact receipt and frozen atlas, entries and claim verifications.
`propose_role_source_audit_repair` submits a revised audit; a separate session uses
`propose_role_source_audit_repair_check` to check every original question, discovery
and unresolved issue. Their previews validate structure and evidence access, not
semantic support. Both tasks inherit cumulative usage and share one budget; each
has one invocation and one context session. No source, candidate or world writes
are exposed. A valid negative proposal or check consumes its task and cannot be
replayed. Only a supported complete check can supersede the active audit, and its
full proof must be in the requirement journal before assembly or archival.

These tools use Pi's `withNwhToolRecovery` registration. Copy `revisionId`,
`proposalHash`, `expectedQuestions[].questionId`, `discoveries[].findingId` and
the indexes of `predecessor.unresolved` from the task. For unknown evidence call
`read_role_work_evidence` with a same-source query, copy `units[].unitId` and follow
`nextOffset`; for candidates call `read_role_audit_inventory` and copy
`candidates[].id`, then read the complete relevant entry. Preserve the original
failure; allow at most one materially corrected proposal, never a guessed or
unchanged retry. Host, scope, single-use and circuit-breaker stops forbid retries.
Schema failures also consume the original proposal correction allowance.

## Migrated source audit revalidation

A host-authorized subject revision may retain completed old source audits as
history while requiring new audits of the changed subject. Diagnostic selection
must distinguish inherited consumption from a task already started in the current
plan. It must not silently discard inherited consumption or reuse the old verdict.

Discover the active plan with `activeRoleWorkPlans`, copy its `batchId`, and copy
the exact audit ID returned by `store.workId("audit", page)`. Call the read-only
`inspectMigratedSourceAudit(store, workId)` and copy its complete proof into
`sourceAuditScope.migratedAudits`, alongside the ordinary frozen scope hashes.
Correct an ID selection once using these same-scope fields; never guess IDs or
retry unchanged. The existing subject-revision authority and every retained file
must still verify. A verified terminal predecessor receipt and remaining original
invocation/context/progress allowances are required. Any current-plan attempt,
checkpoint, budget, audit proposal, exhausted allowance, native fallback, missing
usage or blocked budget stops selection without another dispatch.

The compiler-lock owner rechecks the proof before using the ordinary audit
workflow. Invocation and context ordinals continue from the inherited values;
all old calls, progress milestones, limits and receipts remain intact. The new
auditor rereads original evidence and current judgments through the existing
tools and validators. Failed revalidation stops with its original records. A
negative diagnostic remains a critical finding; it does not complete the roster,
resolve an existing audit, certify a world or activate a candidate. A settled
current-plan audit is never overwritten through this path.

One narrower host policy covers an exhausted predecessor only when the complete
retained lineage proves that context 0 failed terminally, context 1 subsequently
succeeded through `propose_role_review_audit`, and the authorized subject
migration made that receipt stale without starting the current audit. The
read-only `inspectExhaustedMigratedSourceAudit` must bind both attempt/context
claims, both terminal `TraceStore.peek*` traces, the successful predecessor
receipt, changed current atlas/entries, retained cumulative budget and the exact
settled `roles` scheduling stop `work invocation allowance exhausted`. Any
current trace, attempt, context, budget/proposal write, uncertain tool call,
changed retained file, missing schedule receipt, blocked budget or nonterminal
predecessor remains stopped with its original records.

The next ordinary compiler may claim that preview once under its compiler lock.
The claim is keyed to the blocked scheduling receipt, so it cannot reopen a
second work item from the same incident. It creates no ordinary attempt 3 and
does not import the old audit. It permits exactly the final inherited context
ordinal and applies a hard additional-call ceiling equal to the still-retained
progress window, starting from cumulative usage. Evidence supplements and
session rebuilds are unavailable. The current packet goes through the unchanged
audit preview/submission validators; blocked questions, discoveries, unresolved
facts and negative findings remain obligations. A crash, pressure stop, missing
receipt, invalid proposal or exhausted ceiling consumes the grant. Never renew
it, reset counters, promote a preview, or treat predecessor success as current
semantic acceptance.

## Explicit quota-refusal dispatch recovery

An explicit user request to resume may use `inspectRoleQuotaContinuation` after
one original claim request was refused by `openai-codex` with zero provider
output/usage and no tool calls. This narrow host protocol applies only when an
ordinary restart already reserved invocation 2 and then stopped at
`context loop round already claimed`, before a second physical session began.
It is not automatic quota polling and does not establish that provider quota
has reset. Other provider, validation, no-progress or uncertain-write failures
remain stops under their own protocols.

Discover the original plan with `RoleReviewWorkStore.plans`, copying `batchId`;
copy `candidateId` from `stagedEntries()` and `runId` from the same source's
failed `TraceStore.peekRuns` result. Supply the explicit user authorization and
verified implementation references. Inspect the preview's source, task, trace,
budget, reserved attempt, scheduling receipt and retained-file hashes; copy its
exact `authorityHash` into `grantRoleQuotaContinuation` under the compiler lock.
Correct a lookup once using those same-scope returned fields; never guess IDs
or retry unchanged. A later model run, changed evidence, prior audit, exhausted
budget, other recovery, unknown context or missing receipt blocks dispatch.

Use that grant as `claimQuotaResume` for `runBoundedRoleReview`, with its exact
original model and no other scope or runner override. The original immutable
task must still match. Dispatch consumes a durable single-use claim, reuses the
already reserved invocation 2, and claims physical session ordinal 1. Neither
attempt record is replaced; the first request stays charged in the original
budget with unchanged limits. No third invocation, evidence-supplement session
or session-rebuild tool is granted. The model must restore the original task and
read decisive originals before ordinary audit validation accepts a submission.
Negative judgments remain findings and never become certification. Another quota
refusal or any failed recovery retains all records and stops; do not redispatch,
rename the authority or clear counts. This local claim result does not finish
source auditing, the roster, global closure, certification or activation.

## Audit contract revisions

An already consumed, unversioned claim audit is never replayed or relabelled
after a contract correction. The host may authorize one independent audit under
the versioned evidence-faithfulness contract. This is a new contract task on the
unchanged entry, source, atlas and evidence packet; it is not another semantic
correction. A host diagnosis and explicit authorization are mandatory. Negative
results under the current contract cannot use this channel again.

Preview `nwh requirements authorize-role-audit-contract --source ID --batch BATCH
--plan-hash HASH --candidate ID --receipt-hash HASH --authorization-ref REF
--diagnosis-ref REF`. Discover the plan using `requirements inspect`, copying
`roleReviewPlans[].batchId` and `planHash`. Discover the exact negative receipt
using `compile-novel status`, copying `roleReviewWork[].claimFindings[].candidateId`
and `receiptHash`. Correct a lookup once; never guess or repeat unchanged. Copy
the preview's `authorityHash` into `--apply --authority-hash HASH`. The owning
compiler lock and unchanged preview are required. Reusing the exact authority
is idempotent; renaming it grants nothing. Missing usage, blocked budgets,
unresolved proposals, changed history, source audits or finish receipts stop
this operation without retry or implicit dependency invalidation.

The authority retains all predecessor receipts and allowance files. Its new
budget inherits cumulative usage, progress and unchanged limits; old budget
files stay immutable. Invocation and context ordinals continue from their prior
values. One explicitly authorized session is appended even if a completed old
contract used all its sessions; no old retry/context counter is reset. Budget
stops, native fallback stops and exhausted handoffs cannot be cleared. This new
task has no session-rebuild tool. A missing receipt or a negative result consumes
the authority and stops. A durable supported result can finish ledger publication
on restart without another model call. All historic findings remain recorded.

The isolated auditor can read evidence and propose an audit only. Copy the exact
candidate, claim, atlas and packet hashes from its task. Evidence lookup uses
`read_role_work_evidence query`, then exact `units[].unitId` and `nextOffset`.
Invalid submissions permit at most one corrected proposal, never an unchanged
retry. Host, scope, single-use and budget failures forbid retry. `supported`
means the classification follows the evidence, including an honest `unknown`
boundary. Major-role development with `unknown` still fails the independent
certification gate; this authority never changes importance or world truth.

## Versioned role judgment repair

A successful `propose_role_claim_audit` with `insufficient` or `contradicted`
records a semantic finding. It is not a transport error, failed proposal, or
permission to retry that audit. Normal compilation records the exact finding in
the requirement journal and stops unless the host has authorized this review's
bounded repair policy. Diagnostic audit scopes remain observational.

The host previews `nwh requirements authorize-role-judgment-repairs --source ID
--batch BATCH --plan-hash HASH --authorization-ref REF`. Discover `BATCH` and
`HASH` with `requirements inspect`, copying `roleReviewPlans[].batchId` and
`roleReviewPlans[].planHash`; correct a lookup once without guessing. Inspect
the returned policy and copy `authorityHash` into `--apply --authority-hash HASH`.
Apply requires the compiler lock. The same policy/reference is idempotent;
renaming the reference cannot replenish an allowance. This policy authorizes
work for the existing candidate denominator, never any literary conclusion.

This first repair scope requires completed source work and no source audit,
roster submission or finish receipt. Existing downstream receipts require an
explicit dependency revision; stop and preserve them. The host records one
authority per unsupported candidate in the existing proposal journal, retaining
the predecessor entry, exact negative audit/receipt, original attempts, context
consumption and budget-file hashes. Migrated drafts use the same mechanism.

The assigned model receives only `preview_role_judgment_revision` and
`propose_role_judgment_revision` as judgment tools. Copy `revisionId` and
`candidateId` from its packet. For evidence discovery use
`read_role_work_evidence query`, copy `units[].unitId`, then follow `nextOffset`
until complete. Read original support and counterevidence; review notes and old
claims are untrusted proposals. Correct invalid arguments once under the same
revision identity; never guess, retry unchanged, or overwrite an old entry.
Host, scope, single-use, unresolved-proposal and budget failures forbid retry.

The successor must change the same candidate's judgment. Independently supported
importance cannot be lowered or otherwise changed in this repair scope. A valid
preview establishes structure/access only. An isolated new session must audit
the successor's exact claim, atlas and evidence-packet hashes, with no judgment
write tools. The audit verdict measures whether the entry's classification is
faithful to the evidence; it is not a certification result. An evidence-supported
`unknown` boundary therefore receives a supported claim audit while the separate
deterministic development-certification gate remains blocked. `insufficient`
means the asserted boundary itself was not established or source coverage prevents
judgment, not merely that `unknown` cannot certify development. Only a supported
successor audit resolves the historical finding.
Another negative verdict is retained and stops compilation: this scope permits
one successor and one invocation per new task, not repeated repairs until pass.

The proposal and successor audit share a cumulative budget initialized from the
predecessor audit's retained usage and progress, with unchanged limits. Original
budget files remain immutable. Candidate/audit attempts and context consumption
are carried separately; stopped or exhausted work is not renewed. Restart after
a durable proposal/audit skips that model invocation and completes the pending
ledger publication. Assembly and archive verification require the revision,
its independent audit, and matching authority/finding/resolution journal.
`unknown` remains a valid evidence boundary, but cannot certify a required major
role's development. Full-source review, questions, discovery coverage, two
independent roster reviews, closure, certification and activation stay separate.

Role-review source pages now return `units[]` records pairing `unitId` with its
exact source `text`. A null ID marks an uncitable gap; `continued=true` identifies
a unit crossing a page boundary. `read_roster_evidence` performs same-source
lexical discovery (`query`, then exact `nextOffset`) or exact reads (`unitIds`,
up to ten). Copy `units[].unitId`; never reconstruct or shorten IDs. A truncated
exact read lists every `sourcePages` page needed for the remaining text. Search
and preview do not satisfy full-source page visits.

After full-source reading, use `preview_role_roster_review` with one entry and
`partial=true` to check its structure, then `propose_role_roster_entry` to stage
that candidate. The existing proposal-obligation journal retains the input under
a host-derived candidate identity, bound to `subjectHash` and any
`reviewRevisionId`; evidence changes do not reset its correction allowance.
Preview with entries omitted reports staged and missing candidate IDs, unread
pages and retained failures. It performs no proposal or world writes and consumes
no submission attempt. A successful preview verifies structure only:
`semanticSupport=not-verified` requires independent assessment of whether the
actual text supports this character and claim. Never replace an invalid reference
with an arbitrary valid ID.

Bounded roster previews report current/stale audit counts in `auditStatus`.
New source receipts can invalidate old audit revisions without invalidating a
missing candidate's local draft. `partial=true` checks that draft without calling
the strict global audit/ledger gate. A full preview with stale audits returns
`needs_global_audit`, never `complete=true`; submission and finish retain their
strict checks. The host inspects `reviewFreshness()` under the original plan and
arranges revalidation through a supported scope, preserving old receipts. Do not
retry assembly unchanged or overwrite settled audits. Corrupt receipts still
stop for host review; freshness inspection does not suppress integrity failures.
The first structurally valid roster preview, with all source receipts present
and no unresolved proposal/host-review block, earns the same one draft milestone
as other role preflights. It cannot certify semantics, credit repeated drafts,
retroactively renew a stopped budget, or restore an invocation allowance.

For a retained candidate draft blocked solely by the former stale-audit preview
exception, the host may use `inspectRoleCandidateDraftRecovery`. Discover exact
`batchId` from `RoleReviewWorkStore.plans`, `candidateId` from the current roster's
`candidates[].id`, and `runId` from the original trace. The preview binds the last
one-candidate partial draft, immutable original text delivered before it, the
settled trace, plan, journal and retained budget. Inspect its complete `evidence`
and exact `input`; copy `authorityHash` as `expectedAuthorityHash` into one
`recoverRoleCandidateDraft` call. Apply claims once under the compiler lock and
uses ordinary candidate proposal validation. It only stages that exact draft.
No model request, progress credit, counter reset, proposal retry, full-review
finish or certification is granted; even a subsequent no-progress stop remains
in its original budget. Unread/truncated evidence, another tool/proposal failure,
changed source/scope, missing context, an existing candidate proposal or a
consumed claim stops. Do not repeat, alter the draft or guess IDs. Recover an
uncertain publication by inspecting its original claim and journal, never by
starting this operation again. Independent claim audits remain mandatory.
The one already-completed schema correction that only adds the required empty
`missingMajorCharacters=[]` before this host defect is also eligible when both
inputs prove every other field unchanged. This does not grant another correction.

For a settled candidate that only performed successful reads before a local
no-progress stop or an explicitly diagnosed host abort, the host can preview
`inspectRoleCandidateContinuation`. Discover `batchId` with
`RoleReviewWorkStore.plans`, copy the roster's `candidates[].id` and the original
trace's `runId`, then record the diagnosis, audit and implementation references.
Inspect the bound original task, navigation, budget, trace, unresolved evidence
need and unused second invocation/session. Copy `authorityHash` into one
`continueRoleCandidate` call under the compiler lock. This explicit host budget
revision allows at most 12 additional calls once, charges from the retained total,
and keeps the old blocked budget and failure immutable in its original location.
Search references and old navigation never satisfy evidence access: the resumed
model re-reads decisive original units through the ordinary tools and submits the
same original candidate proposal. It cannot renew proposal corrections or certify
the claim. Any tool/proposal failure, changed scope, uncertain result, existing
second invocation/context or consumed continuation requires separate host review;
do not redispatch or grant another window. Byte limits remain observational.
This single-use runner exposes neither fresh-session requests nor an evidence
supplement that would open another session. Native compaction still invalidates
read gates: restore the original task and re-read decisive originals before
submitting. A stopped continuation retains its claim and charged usage.

A claim audit with no proposal history can independently hit the same navigation
stall. Ordinary claim audits expose `preview_role_claim_audit` with the submission
schema and complete-original-evidence gates. Only the first valid draft advances
the existing progress window; reads and repeated previews do not. A valid preview
is structural feedback, never semantic support, a receipt, or certification.

For an already blocked audit, the owning host may preview
`inspectRoleClaimContinuation`. Discover the original `batchId` with
`RoleReviewWorkStore.plans`, copy `candidates[].id` from the same roster and `runId`
from its failed trace, and supply the authorization, diagnosis, verified repair
reference and at most 12 additional calls. Copy the returned `authorityHash` into
one `continueRoleClaim` call under the compiler lock. This requires an original
claim's first invocation, one intact physical session, complete source work,
only successful reads, an exact local no-progress stop, and no proposal history,
inherited consumption, context recovery or downstream review. The failed trace's
full claim/evidence packet must still match. A local pre-transport budget refusal
with zero provider usage is distinct from a provider failure; the latter blocks.

The grant binds source, plan, entry, atlas, evidence packet, failed trace, original
prompt/checkpoint and budget. It consumes the unused second invocation and uses
session ordinal 1, retaining the old task and creating a versioned checkpoint.
The new finite counter starts at all previously charged calls/bytes; previews
cannot increase it. Retained navigation is untrusted and does not deliver source
evidence. The unchanged independent audit validator and exact original proposal
identity still apply, including the existing one-correction rule. The runner
offers no session rebuild or evidence-supplement restart. Negative findings stay
negative; evidence-faithful `unknown` still cannot pass required major-character
development certification. Later allowance capture includes all new charges and
retains the old blocked state, so this grant cannot become a fresh rolling window
for a semantic successor. Ordinary compilation and finish check the retained
history and final receipt. Changed scope, used attempts, failed/pending tools,
quota/provider errors, drafts, negative receipts, uncertain publication or an
already claimed grant require separate host diagnosis; never retry unchanged,
rename the work, clear the budget or invoke the grant again.

Validate the host configuration before claiming this grant. If an older host
invocation failed before dispatch, `inspectRoleClaimStartRecovery` can inspect the
same grant with its original input/authority hash, exact failed result hash and
verified repair reference. It requires unchanged initial cumulative usage,
no second invocation, no new physical session/checkpoint, no proposal and intact
predecessor history. Copy its returned `authorityHash` into the optional
`startRecovery` argument of one `continueRoleClaim` call. This claims dispatch of
the existing grant once; it adds no calls, attempts, session allowance or proposal
corrections. Both the first failure and the recovery outcome remain immutable
records. Any charge, started invocation/session, unknown publication or consumed
start recovery forbids this path; preserve the original result and stop.

When the complete preview passes, `propose_role_roster_review` with `staged=true`
assembles the durable entries; ordinary finish still validates the complete
candidate denominator and commits the review. Complete-input host/legacy calls
remain available but cannot replace or omit staged entries or escape their failed
obligations. Successful drafts without a final capture resume under their original
batch; they do not mix with the other independent review. Source/revision changes,
ambiguous scopes, interrupted calls, exhausted failures and captured reviews
without finish remain host-review stops. No new session or UUID clears them.
The structured host-recovery stop overrides correction advice; do not attempt a
`no-artifacts` finish to escape it.


Independent role review checks retained source-scoped `role-roster-*` obligations before creating another model batch. A failed, exhausted, or interrupted review blocks fresh UUID creation. On `ROLE_REVIEW_REQUIRES_HOST_REVIEW`, use `compiler-obligations inspect` with the exact reported source and batch IDs, preserve the inputs and attempt history, and recover the original scope through a supported host protocol. Do not retry `prepare-all` unchanged, rotate review IDs, or classify a missing review as unsupported to clear this barrier. This guard does not itself authorize an additional model attempt or certify a roster.

Quotation-content trace validation compares exact proposition object assertions
with the cited quotation anchors at finish and committed-artifact validation.
Sharing a segment or speaker does not establish content support. If a source
utterance was truncated by an observation, stop for host review of the full
original utterance. Any justified revision retains the quotation's logical ID,
speaker and addressees, stages a new correction envelope, and passes normal
annotation/finish validation while preserving original revisions and receipts.
Never remove content assertions or change acquisition mode to evade the check.
Legacy artifacts without exact object assertions are not certified by this check.

A queued two-segment boundary calibration is already an explicit source-repair
scope for those two immutable segments. If finish proves that a committed source
annotation is incomplete only across their shared split, and the matching
`propose_*` source-record tool is exposed, stage the corrected annotation under
a new `proposal_id` while preserving its `annotation_id`. Accepted prior
revisions and their receipts remain immutable history; do not withdraw or rebind
them, and do not call `replace_boundary_proposal`, which applies only to pending
world proposals. Any current-batch world draft that froze the old annotation
revision must receive a normal same-logical-ID successor before only that
defective draft is withdrawn. Retry finish once after this material correction.
Evidence outside the two segments, unavailable proposal authority, or an
unresolved identity decision still stops for host source review with all drafts
intact.

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

Model-facing tool failures are part of the agent protocol, not terminal exception strings. A failure must remain a real error for audit, circuit-breaker, and checkpoint logic, while also telling the agent how to make bounded progress. A typed `ProposalIdentityCollisionError` is still a model-facing error and durable proposal obligation even when the proposal store rejected it before writing. Exact-batch lifecycle discovery should prevent the retired ID from being submitted; the tool must never translate the collision into proposal success.

Compiler recovery also consults the persisted proposal journal before session creation, after a batch report, and after a thrown timeout/network error. An interrupted mutation or two distinct failed inputs requires host review even when other proposals succeeded. `host-repair-required` metadata (including the tagged JSON on older Pi error paths) forbids fresh-session recovery. A single failed input remains eligible for one concrete correction under the same exact tool and `proposal_id`; a new ID or an unrelated successful draft never clears that obligation.

Ordinary hydrated batches include the exact batch's accepted/rejected world-proposal envelope inventory and rejection diagnostics. Retired IDs are immutable and never active truth. Inspect one with same-source `find_compiler_artifacts`, passing its exact `proposalId` as `query` and exact `proposalStatus` as `status`, then copy `results[].readArguments.ref` into `read_compiler_artifact.ref`. A same-batch immutable-ID collision is refused before any proposal-store write, remains a failed tool call, and must not be retried. Diagnostic prose never settles a durable obligation. This applies equally to legacy no-write collisions and current failures: inspect retained state and use an explicit, audited host disposition when the original proposal is unsupported. An earlier successful invocation is not authority to erase a later failure.

The active retry inventory also includes exact-batch pending/accepted source annotations and recoverable entity/event resolutions, with envelope `proposalId`, payload `logicalId`, and lifecycle status kept distinct. Recovery must use the owning store: `find_source_annotations`/`read_source_annotation` for observations, `find_identity_resolutions`/`read_identity_resolution` for identity decisions, `find_event_resolutions`/`read_event_resolution` for event decisions, and `find_compiler_artifacts`/`read_compiler_artifact` only for world proposals. Copy each finder's exact read `ref` into its paired reader; copy `annotationId`, `resolutionId`, or another payload ID only into the matching logical field. A failed mention-candidate lookup should search a distinctive fragment of the exact failed mention ID rather than a truncated wildcard page. Event-resolution supersession uses only exact `status=current` resolution IDs; `(none)` means an empty supersession list, never a rejected ID or pending envelope ID.

Source-accounting discovery persists a protocol receipt for each issued unresolved page: source hash, batch, segment IDs, exact ordered unit IDs and eventual consumer. This is audit metadata, not a source disposition or world mutation. `status=unresolved` includes active `unresolved` and `intentionally-deferred` decisions because both remain preparation blockers. After later review supports a nonblocking disposition, submit the fresh page under a **new** `proposal_id`; the compiler preserves the blocking proposal and records a hash-bound refinement edge. A refinement may replace only a blocking decision with `background-only`, `paratext`, or `duplicate-description`; it cannot overwrite valid nonblocking accounting or replace one blocker with another. If new evidence or nonblocking accounting covers a submitted unit, `account_source_units` rejects the entire call with `coverage-changed`, listing `representedUnitIds`, `accountedUnits` and `remainingUnitIds`. Preserve the failed `proposal_id`, call same-batch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the returned `pageToken`, review the fresh page and make at most one corrected call. Never reuse indexes without inspecting that page. If no units remain, stop for host coverage review rather than submit an empty array or withdraw valid coverage. Receipts survive fresh sessions; consumed tokens stay single-use.

An exhausted accounting identity with a proven blocking-predecessor refinement requires the host-only `reviewAccountingRefinementObligation` API. Eligibility is verified from exact inputs, page receipts, predecessor decisions and absence of output, not error-message wording. First call it read-only with the exact source, batch, failed proposal, predecessor settlement IDs, a genuinely changed `correctedInput` retaining the latest failed page token, any accepted semantic proposal IDs supporting `duplicate-description` decisions, reason, and audit reference. Inspect its source text, proposed dispositions, and bound support dependencies, then pass the returned `authorityHash` as `expectedAuthorityHash` to one apply call. The operation rechecks immutable source/structure, exact batch segments, all failed input/page hashes, active accounting and semantic baselines, checkpoints, finish receipts, predecessor histories, and every current accepted support revision plus exact overlapping evidence under the compiler lock. It submits the reviewed correction through normal `account_source_units` validation, preserves every old attempt/proposal, settles only the explicitly bound predecessor obligations after the successor is durable, and refuses unchanged, unsupported, changed, repeated, accepted, checkpointed, or receipt-frozen state. An interruption may complete the same retained reviewed intent only when its exact pending output, dependency graph and page-consumption markers remain unambiguous.

The workflow is implemented in `src/compiler/accounting-refinement-review.ts`
and remains re-exported from `accounting-review.ts`. The host CLI
`nwh compiler-obligations review-accounting-refinement --review FILE` previews
the same typed review; `--apply` requires its exact `expectedAuthorityHash`.
Preview first; do not apply until the returned source excerpts, dispositions and dependencies have been reviewed:

```ts
import { reviewAccountingRefinementObligation } from "./src/compiler/accounting-review.js";

const options = {
  sourceId,
  batchId,
  proposalId,
  settleProposalIds: [blockingProposalId],
  duplicateSupportProposalIds: [acceptedSupportProposalId],
  correctedInput: {
    proposal_id: proposalId,
    page_token: latestFailedPageToken,
    page_default: { status: "background-only", reason: "Reviewed attribution or context." },
    page_overrides: [{ unit_index: 1, status: "duplicate-description", reason: "Exact accepted evidence already represents this unit." }],
  },
  reason: "Host reviewed the exhausted same-page refinement.",
  auditRef,
};
const preview = await reviewAccountingRefinementObligation(workspaceRoot, options);
const result = await reviewAccountingRefinementObligation(
  workspaceRoot,
  { ...options, expectedAuthorityHash: preview.authorityHash },
  true,
);
```

Host-only coverage adjudication uses `nwh compiler-obligations review-accounting --source <exact-id> --batch <exact-id> --proposal <failed-id> --reason <text> --audit-ref <ref>`. The default is a read-only proof preview; `--apply` verifies again under the compiler lock and records `superseded-by-coverage`. Missing legacy page receipts additionally require `--from-run <original-run-id>`; the host verifies the blob hashes, same-session discovery, identical failed input, failed result, exact source text and unit boundaries. No model tool exposes this adjudication. Every original failed input/unit must be included, with current-batch evidence/annotation anchors or nonblocking successor accounting decisions. Prior-stage coverage alone is deliberately insufficient for this settlement path. The journal retains every failure and binds the proof to source bytes, unit hashes, dependency contents, and audit references. Dependency withdrawal, revision ambiguity or source changes makes the proof invalid and requires host review again. Repeating the same valid host review is idempotent. A settlement never accepts world proposals, writes a checkpoint or certifies executable semantics.

Novel compiler schemas expose only `source-pattern` induction for action schemas,
action constraints, norm templates and process templates. `domain-module` remains
a canonical/runtime contract for host-managed mechanics and must not appear in a
model-facing proposal schema. An exhausted source-pattern proposal is not reopened
for another model retry merely because a later source review finds a missing
supporting occurrence.

When that missing occurrence is outside the failed batch and no independent scene
or core-role requirement set exists, use the read-only same-scope discovery command
`nwh compiler-obligations inspect-upstream-authority --source <exact-id> --batch
<exact-id> --tool <exact-tool> --proposal <exact-id>`. Copy its complete
`proposalObligation`, `requirementSetHash`, and sole `requirementIds[]` value into
one typed `requirements plan-upstream-repair` review. The authority is derived from
the immutable unreviewed failure prefix, including every distinct failed input,
the original source-pattern support and original citation segments. It permits
only `CANONICAL_EVENT_MISSING` creations in a different upstream batch. Changed,
truncated, ambiguous, already reviewed or singly failed histories stop; never
invent a requirement ID or register an unrelated requirement merely to obtain a
repair denominator.

After a `CANONICAL_EVENT_MISSING` upstream repair has completed and converged, an
independent host may use `nwh compiler-obligations review-source-pattern --review
FILE`. The typed file contains `version`, exact `sourceId`, `batchId`, `tool`,
`proposalId`, every distinct `failedInputHashes` value, exact
`upstreamPlanHash`, exact `upstreamReceiptFingerprint`, `reason`, `auditRef`, and
the complete corrected `input`. The default is read-only. It verifies immutable
current canonical event revisions, the plan's semantic-event creation, completed
finish receipt, convergence record, all original failures, the unchanged original
batch citation scope, source-pattern support retention, payload schema and exact
selectors. Inspect the preview's `binding`, `evidencePreview`, and
`upstreamEvidence`; then add `--apply` only for that unchanged review. Apply
rechecks under the compiler lock and submits the same failed identity once through
its normal proposal tool. It preserves every failed attempt and records the plan,
receipt, convergence and added event revisions in `hostReview`. A failed apply
cannot be repeated, and this operation never finishes or checkpoints the batch,
accepts the proposal, or certifies executable closure.

Use `nwh status --json --source <exact-id>` for a read-only recovery snapshot. It verifies immutable source bytes and the deterministic segment layout, intersects effective-version checkpoints with the shared compiler plan, reports each stage and durable obligation, and links the latest audit run. It separately lists hash-verified archived candidates and their stored closure assessments; it does not run a new assessment, activate a revision, initialize traces, migrate storage, or infer readiness from counts. A lock record is shown as a record, without claiming its PID is live. Missing or stale evidence/layout produces unknown plan counts rather than a false completed state.

Legacy role source work stopped solely by retired host byte watermarks has a
separate host-only `inspectRoleSourceContextContinuation` preview. It requires
the exact original source/batch/work, settled trace IDs accounting for every
charged call, two retained invocation markers and the original context
checkpoint. Copy IDs from `RoleReviewWorkStore.plans` / `workId("source", page)`
and the original trace index; never guess or rename them. Inspect the preview's
`authority.remainingCalls`, sealed history and dependent audit receipts, then
pass the exact `authorityHash` with the same input as `sourceContextResume` to
one `runBoundedRoleReview` under the owning host's compiler lock.

The continuation consumes one durable host claim before transport and uses only
the original fixed remaining call allowance. It preserves the legacy budget,
context, invocation markers, proposal correction history and cumulative usage.
It does not reopen quota, no-progress, proposal/citation failures, uncertain tool
results or exhausted call allowances. Every historical tool call must have a
matching start and successful result with intact trace blobs. A tool failure,
error result or orphaned result requires separate host review; a later size
failure cannot hide it. A consumed claim or failed invocation is
a stop: do not redispatch, reset, rotate IDs, or substitute a different recovery
authority. Scope/authority changes require a fresh read-only host review, never
an unchanged retry. New source receipts use normal validation and settle the
matching missing-receipt need using the accepted proposal input hash; newly
discovered questions stay in the requirement ledger. New receipts invalidate
dependent audits at the new atlas revision. `reviewFreshness()` and compiler
status report these as stale while preserving the old receipts. They cannot
count as current verification or authorize global finish, certification or
activation. Revalidation of stale audits needs its own supported repair scope.

For a host-selected candidate queue, `runBoundedRoleReview` accepts
`candidateWorkScope` with the exact current `planHash`, `atlasRevision` and
`candidateIds` copied from `RoleReviewWorkStore.plans`, `atlasRevision()` and the
current roster's `candidates[].id`. All source receipts must already exist. A
candidate scope cannot mix source, diagnostic or recovery scopes and stops on a
changed plan/atlas; inspect the current same-source inventory once instead of
retrying unchanged. It stages only the selected judgments, settles their
receipt-backed evidence needs, and returns before independent audits or finish.

An explicit user instruction to reset limiting counters is a host policy
amendment, not a model-side recovery tool. Record the exact instruction and
source/work scope, seal and archive the affected counters/context claims under
the compiler lock before opening a zero-based window, and preserve accepted
receipts, proposal failures, requirement history and lifetime usage separately.
Uncertain writes still need reconciliation. A reset of counts never validates a
citation or renews a stale audit; it does not permit automatic repeated resets.

Scoped `finish_compiler_batch` now freezes a durable intent after validation and before cross-file acceptance. It binds the original finish arguments, pipeline/source/segment identity, proposal content hashes and title/chapter/role-review metadata. Automatic pipeline-upgrade retirement is limited to completed older ordinary receipts whose source bytes and dependencies still verify. Prepared, newer-pipeline and specialized receipts are preserved for compatible recovery; no new model session may replace an unfinished commit. A prepared receipt freezes mutations and blocks model retries, including fresh sessions. Stop and preserve it on `Compiler finish requires host review`; inspect `status --json` and resume the same compiler scope through the host. The host holds the compiler lock, revalidates the exact original finish and replays idempotent acceptance/review operations before writing its completed receipt. Production source-batch checkpoints require that receipt. Input changes, withdrawn/revised dependencies or newly failing validation require inspection; never delete the receipt, change IDs, or rewrite the finish summary to bypass it. Receipt recovery does not certify world semantics or playability.

The provider-facing finish schema is also batch-scoped. Ordinary source-review,
boundary, and structure batches omit `target_reviews`; the field is exposed only
after batch initialization verifies a versioned reconciliation or knowledge-repair
scope with exact targets. If argument preflight rejects `target_reviews` as an
unknown field in an ordinary batch, remove only that field and retry the finish at
most once. If execution instead reports that `target_reviews` is outside scope,
stop for host review because the advertised schema and verified scope disagree.

An accepted, still-current `new-entity` or `new-event` resolution remains the
immutable creation decision when its same-finish dependency has since become
canonical. A recovery finish replays that accepted decision without withdrawing
or rewriting it. Candidate discovery may now report `resolved` for a hypothetical
new revision because the dependency is canonical; that does not retroactively
invalidate the accepted creation history. This exception never applies to a new
pending `new-*` proposal, a superseded resolution, or a missing dependency; those
retain the normal same-finish and graph-closure checks.

Explicit reparse, `resume=false`, and prepared-revision materialization archive replaced finish receipts with a reason; original receipt history remains on disk. Legacy checkpoints without receipts remain readable, but every new production finish/checkpoint follows the new protocol. Atomic rename supports process-interruption recovery; this is not a filesystem power-loss transaction or a multi-file database commit. Read-only status reports receipt checksums and timestamps; host recovery performs the full dependency and finish validation.

A current-plan checkpoint marker without an active verifiable finish receipt is
not a completed production batch. If no original receipt exists, the source loop
must not reconstruct one from checkpoint counts, accepted outputs, summaries, or
retained trace prose. It reopens only that exact current-plan batch in memory,
hydrates its retained pending proposals and only those accepted source records
whose exact immutable payload is still the current revision, redelivers the
immutable source slice, and requires an ordinary validated
`finish_compiler_batch` before the existing marker can be trusted again.
Superseded accepted annotations and resolutions remain immutable history; they
are never rebound over a later current revision merely to recreate an old batch
finish. The marker and proposal history stay intact. A prepared receipt uses
original host finish recovery instead; a corrupt, dependency-invalid,
specialized, or ambiguous receipt stops for host review. This evidence-based
re-review is batch recovery only and does not certify semantic closure,
executable readiness, or Play activation.

When effective pipeline migration reopens a batch from the current deterministic
source plan, its older active finish receipt cannot authorize the new checkpoint.
The lock-owning source loop archives that receipt with the exact old/new pipeline
versions, retains it in finish history, and opens the plan-selected batch for a
new current-pipeline finish. It never replays the legacy finish or treats its
checksum as dependency validation. Direct receipt recovery and versioned
reconciliation, upstream-repair, and role-review scopes still stop on a pipeline
mismatch; they cannot use this bounded source-plan retirement authority.

## Contract

The `compile-novel` lifecycle preserves the same failure/finish/requirement authorities across stage commands and full runs. Its scheduling journal is not a semantic certificate and cannot reset an obligation, role review or repair budget. `compile-novel status` reports the stopped stage, original diagnostic and retained evaluation review/report without executing recovery. Follow a host-review stop before invoking the suggested stage command again; `--rebuild` is not an error-reset mechanism.

Independent evaluation review exposes only source retrieval, `read_evaluation_input`, `propose_evaluation_item` and the single-use `finish_evaluation_plan`. For unknown input sections, read `read_evaluation_input` with `section=index` and copy `sections[]` or `itemSections[]` exactly. Read `section=schema` and `section=draft` before correcting the same stable item key. Binding fields come from `section=roles` (`candidateId`, `entityId`, `entryCutHash`) and `section=assertions` (`assertion.id`, `assertionHash`); never guess. Page using the exact returned `nextOffset`. Original text uses `find_source_evidence` and the exact `results[].ref` in `read_source_evidence`; finish requires complete source-page coverage. An invalid item/finish permits at most one corrected retry. `EVALUATION_REVIEW_HOST_REQUIRED`, `EVALUATION_REVIEW_NO_PROGRESS`, scope/index changes and `EVALUATION_PLAN_ALREADY_FROZEN` stop model retries; preserve draft identity, offsets, counters and trace IDs. A frozen result cannot be submitted again.

Live evaluation with resume enabled reuses completed experiments only for the exact frozen plan and current validator. It records a run before its first model call. `EVALUATION_RUN_HOST_REQUIRED` preserves failed/uncertain experiment IDs, original evaluation branches and traces; inspect those receipts before host recovery. Do not generate a new run or rotate gold to erase a failed or possibly committed experiment. Preflight semantic/entry/support failures report compiler/spec gaps without running live experiments. Certification and activation remain separate operations.

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
| Invalid JSON/schema/path/enum | Point to the first failing field and correct the smallest invalid part. Evidence-selector `target_path` is relative to the proposal payload (`/canonicalEventId`, never `/payload/canonicalEventId`) | One corrected retry |
| Invalid event-execution envelope/action | Keep evidence_segment_ids/evidence_selectors beside payload, not inside it. Find an action-schema in the active source, read its returned ref and copy payload.id into action.schemaId; an ad-hoc occurrence cannot be copied or relabeled as a mechanism | One corrected retry; if no supported mechanism exists, preserve the occurrence without inventing an execution binding |
| Incomplete compiler finish graph/trace | Treat the full finish diagnostic as one report; repair every listed dependency while preserving valid drafts | One retry after concrete proposal progress; an unchanged full diagnostic stops |
| Accounting review conflicts with no-artifacts | Correct the named reviewed_segments.disposition to proposed; preserve existing semantic coverage and all valid accounting pages. No new mechanism does not mean no source artifacts | One corrected finish retry; never withdraw whole pages to satisfy the mistaken review label |
| Canonical entity name lacks a resolved mention | Search both committed and pending entity mentions with `find_source_annotations`; read the returned `ref`, copy `annotationId`, verify `surface === canonicalName` and compatible kind, then use `find_entity_resolution_candidates` and `propose_entity_resolution` to establish the source-supported identity. A substring match or an unparsed mention alone is insufficient | One finish retry after concrete repair of all reported sections; preserve error status and stop on an unchanged full diagnostic |
| Source-annotation dangling reference | Read the finish inventory or call `find_source_annotations`; copy the exact returned `annotationId`, repair/withdraw only named proposals, and preserve every unlisted draft | One finish retry after concrete repair; never substitute `ref`/`proposalId`, mass-withdraw, or escape through `no-artifacts` |
| Cross-batch logical supersession in an ordinary source batch | Withdraw only the named current-batch replacement, repair one-sided current dependencies, then peek/defer a confirmed adjacent artifact to the existing two-segment calibration pass; never withdraw the checkpointed prior proposal | One finish retry after concrete withdrawal and deferral; only the calibration batch may replace the prior proposal |
| Invalid page offset | Reuse the exact returned `nextOffset`, or restart at `0` | One corrected retry; never estimate offsets |
| Unknown/stale source-accounting page token or index | Refetch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the exact `pageToken`/`unitIndex`, and review the complete page | One corrected retry; never guess, copy long unit IDs, or reuse a consumed page token. Use a fresh proposal ID only when refining an already-successful blocking disposition |
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

Argument-preflight errors retain their failed input and diagnostic like other
proposal failures. No diagnostic text, payload shape, or absence of a pending
file automatically settles them. Correct the exact proposal once when evidence
supports it; otherwise stop for an explicit host disposition. `reviewUnsupported`
retains the failure and records the host's reason and audit reference without
certifying executable coverage. It applies to the selected identity only and
never disables valid execution bindings elsewhere in the batch.

The event-execution provider schema requires at least one of `action`, non-empty
`processRecoveries`, or `entryCheckpoint`, and selectors use payload-relative
paths. A canonical ad-hoc action is not an execution binding. Discover a supported
schema before proposing a binding; never fabricate an entry checkpoint or
mechanism to satisfy a failed proposal.

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

Source annotations use the narrower
`reviewSourceAnnotationObligation` API from
`src/compiler/source-annotation-obligation-review.ts`. Call it first without
`apply` and retain its `previewHash`; then call it under the same host review
with `expectedPreviewHash` and `apply=true`. The preview binds the current
compiler pipeline, immutable source hash, exact batch segment plan, complete
failed-input history and every selector path. A correction may select an
`exact` value only from that path's exhausted model inputs; it may repair or
remove optional immediate `prefix`/`suffix`/`occurrence` context, but cannot
change non-selector semantics, logical IDs, selector slots or segment scope.
Apply rechecks that no finish receipt or proposal output exists, acquires the
compiler lock, and invokes the normal typed proposal tool. Original failures
and the reviewed binding remain in the obligation journal. A failed/replayed
review, changed preview, existing output, missing batch plan or prepared finish
stops without another permit.

```ts
const preview = await reviewSourceAnnotationObligation(root, review);
await reviewSourceAnnotationObligation(root, {
  ...review,
  expectedPreviewHash: preview.previewHash,
}, true);
```


Exact selector validation reports all missing/ambiguous quotes in one diagnostic.
Each source-annotation diagnostic names `trigger_selector`, `extent_selectors[i]`,
`selector`, `cue_selector`, or `selectors[i]`. When `exact` exists but optional
context is not immediately adjacent, keep `exact` unchanged and remove context
for a unique occurrence; otherwise copy immediate verbatim context or the
one-based occurrence from the complete segment. Copy verbatim punctuation and
do not substitute quotes from another segment.
Artifact discovery includes `readArguments.ref`; copy that ref unchanged.
`logicalId` identifies the domain object and must never be used to construct a ref.
Classify accounting finish diagnostics before generic offset errors: pagination
instructions inside an accounting diagnostic do not give finish_compiler_batch
an offset parameter. If an earlier faulty host SOP caused a withdrawal, the
host-only SourceAccountingStore.reproposeRejected API can stage an exact copy
under a fresh ID with restoredFrom provenance after an audited same-source/batch
check. It preserves rejected history and still requires the normal finish gate.

Source-accounting batch reviews retain the exact assertion and annotation spans
seen when each finish was accepted; those spans are audit history, not permanent
coverage authority. Prepared candidate capture reprojects only the materialized
accounting `records` against the current active exact-evidence bindings and
committed source annotations while preserving every historical review, decision,
timestamp and receipt. When artifact replacement removes an assertion, its old
immutable revision cannot keep a unit `represented`. A still-current overlapping
assertion/annotation supplies its current ID; otherwise the unit keeps an explicit
reviewed disposition when one exists, or returns to `unresolved`. It is never
silently relabeled as background. Frozen prepared snapshots that claim
`represented` through a missing or non-overlapping current binding are rejected
before materialization. Reprojection writes no workspace state and certifies no
semantic or executable completeness; newly uncovered units must pass the normal
accounting review/repair flow.

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
different lifecycle states. A typed, same-batch immutable-envelope collision is
a deterministic no-write storage refusal but remains a failed model tool call:
inspect the exact retained history and do not retry that ID. A legacy post-success collision also requires explicit host adjudication;
reading its diagnostic cannot exclude it from obligation recovery. Any untyped, cross-source, cross-batch, missing-state, or
interrupted overwrite/revival remains a durable obligation and requires host
review before replacement. The storage error's generic suggestion to use a
new ID is never authorization by itself. Ordinary and reconciliation prompts
include the applicable exact-batch pending/accepted/rejected identity inventory.
Existing source and publication validation remains unchanged.

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

An exhausted `propose_role_roster_review` identity can be recovered only through
the host API `reviewRoleRosterObligation`. Its input names the exact original
source, role batch, tool and fixed `role-roster-review` proposal identity, every
distinct failed-input hash, a complete replacement review, and a separate reason
and audit reference. Call it read-only first. The preview validates every
candidate and evidence-unit ID, reconstructs the versioned review against the
unchanged roster subject/review revision, and visits every `read_role_roster` and
`read_roster_source_page` page through the ordinary tools. It returns page-content
hashes, the normalized complete review and an `authorityHash`; this is material
for host review, not a generated judgment or certification.

Apply requires that exact `authorityHash`. Under the compiler lock it repeats all
page reads, rechecks source bytes, roster/revision, full failure history, absence
of a saved review or finish receipt, then invokes the ordinary
`propose_role_roster_review` and `finish_compiler_batch` tools in the original
batch. The journal preserves failed attempts and records the reviewed binding on
the normal running/succeeded proposal attempts. An unchanged input, omitted
failure, incomplete denominator, unknown candidate/unit, stale page/roster hash,
running attempt, prior failed host correction, saved output or finish receipt
stops without another grant. If proposal capture succeeded but finish preparation
was interrupted before any durable receipt or roster write, the same retained
authority may recapture that in-memory-only proposal once and finish it; a second
interruption stops. A prepared receipt uses ordinary finish recovery. Fresh role
UUIDs remain blocked while a captured original batch lacks its completed receipt.
This API grants no blanket model retry, invents no role judgment, and does not
certify the executable world.


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

When an unfinished bounded plan belongs to the prior subject, inspection also
returns `roleReviewPlans[].planHash`. Copy that exact same-source field into
`--work-plan HASH` on the host revision command; a stale selection permits at most
one corrected invocation. The narrow migration requires unchanged source bytes,
structure and candidate inventory. It freezes the original plan, proposal history,
attempts, context handoffs and budget files, and records one authorized successor
in the existing review-revision journal. Original source notes and staged entries
remain proposals; completed independent reviews, claim audits and source audits
do not count toward the successor. Every current claim and question must pass
fresh verification. Used calls, progress counters, invocation limits, context
allowances and blocked budgets carry forward without a reset. A retained hard
stop still stops; do not rename work, clear counters or reopen the predecessor.
Changed inventories, unresolved proposals or missing usage records require host
dependency review and must not be retried unchanged. For an interrupted migration,
replay the exact original revision decision including its `--work-plan` value;
do not select a new batch or use the successor hash as the predecessor.

A host interruption between claiming a migrated claim-audit invocation and
publishing its first session claim does not authorize a fresh invocation. The
host may inspect `inspectRoleStartInterruption`, bind `expectedAttemptHash` to
the canonical hash of the exact existing attempt record, and grant the returned
`authorityHash` under the compiler lock. This requires the original recovered
lock archive, unchanged inherited usage, and no session/context claim or uncertain
budget write. It consumes one continuation of the same attempt record; calls,
attempt count, context allowances and prior failures are unchanged. A published
session claim, advanced budget, changed identity, missing recovery proof or used
grant stops this path. Preserve those records for their original host recovery
protocol; never delete the attempt, infer zero usage, change work IDs, or retry
the grant unchanged. This is host-only and is not a model-side recovery tool.

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

`upstream-repair-plan.ts` defines a strict frozen host policy input for source
annotations, identity/event resolutions and the bounded missing-event semantic
chain described below. Freezing the plan does not
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

The ledger itself exposes no model execution. The staging, isolated-slot, finish,
checkpoint and convergence services below must consume its exact retained records;
none may infer authorization from a plan object or reset its failure budget.
Existing tool recovery and evidence checks remain in that path.

### Host-guarded upstream staging and draft recovery

`stageUpstreamRepair` reserves the exact original tool input before preparation,
then invokes an existing narrow annotation/resolution or authorized semantic
event tool through
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
tool execution. The host staging path rejects ordinary finish, retrieval,
unrelated metadata and every world proposal except an exact planned
`canonical-event` or `event-participation` creation in a reviewed missing-event
contract. Those world records remain pending proposals. The host finish executor
described below is separate from staging.

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

### Host-reviewed pre-receipt finish graph revision

When normal finish validation stops an otherwise settled upstream plan before
any finish receipt or accepted output exists, the compiler-lock owner may inspect
the exact retained graph with `inspectUpstreamRepairFinishRevisionAuthority`.
Copy its `failedFinishRef`, `originalIntentHash`, `originalGraphHash`, and each
corrected slot's `originalAttemptRef`, `originalProposalId`, and
`originalInputHash` into one `authorizeUpstreamRepairFinishRevision` call. The
review must provide a new proposal ID and complete typed tool input for every
materially changed slot and every transitive consumer of a changed dependency.
It must not include unrelated slots or widen the frozen source scope.

Authorization appends one durable host-only revision intent. It does not accept
an old draft, erase a failed finish, open a model session, or grant another model
retry. `continueUpstreamRepairFinishRevision` rejects only the superseded pending
drafts into retained history, runs every replacement through the normal typed
proposal, evidence, cross-record, and dependency validators, and freezes a new
effective finish graph while preserving the original finish intent, tool inputs,
baselines, review text, and logical artifact IDs. Unchanged slots are reused only
when their dependency hashes remain valid. A changed dependency requires a fresh
validated descendant draft even when that descendant's semantic fields do not
otherwise change.

If continuation is interrupted after its revision intent or validated write is
durable, call `continueUpstreamRepairFinishRevision` again with the same returned
`revisionHash`; never authorize another revision or rotate proposal IDs. Any
receipt, accepted or ambiguous output, open model session, changed source/plan/
baseline/dependency graph, unchanged correction, wrong slot, extra slot, failed
replacement, consumed revision, or mismatched hash stops for host review. After
continuation returns its revised finish intent, use the ordinary
`executeUpstreamRepairFinish` and convergence path; the revision API itself never
commits canonical truth.

Managed semantic staging also checks presence before writing a pending draft. A
canonical event must explicitly project one evidence-supported presence mode for
every character participant and none for artifacts or other non-characters. Each
character participation must copy the staged event's mode exactly; a
non-character participation must omit presence. These mismatches are corrected
explicitly and are never silently normalized.

### Upstream history in prepared candidates

Candidate snapshots bind source-representation and independent-identity plans to
their original requirement journal, independently checked definitions, exact
source scope and receipt identities. A frozen definition is distinct from its
current postconditions: snapshot loading must not require a later evaluation or
silently promote it. Missing or changed authority stops candidate loading; inspect
`requirements inspect-upstream` for the same source and copy
`plans[].plan.planHash` once. Do not recreate the definition, restage a consumed
plan or retry unchanged.

Derived upstream evaluation/invalidation appends retain the original frozen
prefix of a role dependency or identity review. They neither change that intent
nor authorize new work. A rewritten prefix or appended execution/authority event
still stops reconstruction and requires same-source/task host inspection; never
repin the prefix to the current head.

Role dependency reconstruction compares the complete retained path/hash inventory
before preserving its original serialized ordering. Filesystem traversal order
alone is not a changed task. Missing, additional, duplicated or changed files
still stop reconstruction; original records and their hashes are never rewritten.
Existing records may use the earlier producer's whole role-work tree plus original
plan journal. Compatibility requires an exact match of that complete historical
inventory, including archived failures and budgets. New records retain the current
source-local capture. Unknown layouts cannot be repinned or treated as permission
to drop files, change a budget, or reopen a phase.

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
resolutions. Exact planned semantic-event world proposals are included in that
receipt but stay pending for ordinary deterministic world convergence. All other
world proposals, unrelated metadata and source-accounting writes remain outside
this authorization. A failed graph validation stops the plan for host review
before any commit; do not retry it unchanged or restart the model.

After a storage interruption, preserve the original receipt, journal and draft
envelopes. `recoverCompilerFinish` routes v3 receipts to this same host executor.
Recovery verifies pending or accepted envelope hashes, source bytes, independent
requirements and every original baseline. An active repair slot may contain its
original baseline or the exact validated output only when the matching original
receipt is already durable. An unrelated revision, missing envelope or changed
input requires host review, never an overwrite or a new proposal namespace.
The mutation guard still compares against the frozen original baseline payload.

Completion verifies every source annotation/resolution output is active and every
semantic world envelope still matches its original validated pending or accepted
draft, then records the exact completed receipt fingerprint as `finished`.
Recovery after receipt completion resumes journal recording without rerunning
mutation tools. Finished records and their original receipts are retained in
candidate history and still block certification until deterministic convergence
has made every semantic output active and current independent requirement
evaluation has succeeded.

### Portable upstream draft and finish checkpoints

Candidates may retain `upstreamRepairCheckpoint` for live staging, frozen,
finished, converged or evaluated plans. It contains every original staged source
or semantic world envelope, its pending/accepted status and the explicitly active
v3 receipt. Unrelated pending compiler or world work still prevents capture. An
unresolved reserved attempt must first use local
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
scene and core-role evaluators. For proposal-obligation plans it instead requires
the original compiler batch, the exact accepted source-pattern mechanism, every
original supporting event, and every newly compiled semantic event in the current
candidate. It accepts no model-provided result or replacement requirement list.
`prepare-all` also settles eligible repairs at its candidate stage. Each
`evaluated` record binds the original plan/definition or durable obligation,
completed receipt, convergence record, subject hash and every selected requirement
result.
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
one previously authorized typed dependency slot. It reserves a durable model session before Pi
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
For a compiler proposal obligation, the optional `proposalObligation` replaces an
otherwise absent independent scene/core definition without weakening source
review: its hash-derived requirement identity is single-purpose, its original
supporting events are frozen as baselines, and every authorized write is part of
the reviewed missing-event creation DAG.

Currently supported diagnostic policies are:

- `QUOTATION_ANCHOR_INCOMPLETE`: an exact current quotation revision plus a
  host-reviewed `expectedAnchor` that strictly extends its original-byte range.
  The expected range must fit the explicit citable evidence. The generated policy
  permits only `/anchor`; it grants no speaker, mode or confidence edits.
- `QUOTATION_SPEAKER_MENTION_MISSING`: the current quotation must actually name
  an absent speaker mention. Its existing typed reference fixes the creation ID;
  one entity-mention slot and explicit dependency edges are generated. No absent
  speaker ID is invented from prose, and collisions with any annotation kind fail.
- `CANONICAL_EVENT_MISSING`: a host review supplies exact immutable-byte trigger
  and extent anchors plus current entity-mention IDs for one genuinely omitted
  source occurrence. The planner resolves and freezes each mention's current
  identity and canonical entity, then deterministically allocates one event
  mention, one `new-event` resolution, one canonical event and a complete typed
  event-participation inventory. Every semantic draft must cite exact evidence
  inside the reviewed occurrence; broad segment evidence cannot widen that scope.
  The model cannot change the occurrence anchors, participant identities, event
  identity, resolution relation or participation event/entity bindings.
- `SEMANTIC_MODULE_REQUIRED`: returns `needs-host-review`, no plan and exit 2.
  A mixed review containing unsupported semantics grants no partial authority.

The host derives baseline hashes and readable refs from current typed objects,
then runs the original plan/source/definition/receipt preflight. The review hash
is bound into its authorization reference. It never parses error strings into
write pointers or infers satisfaction from a successful plan. On missing/stale
quotation data, use same-source `find_source_annotations`, copy `annotationId`
and obtain a new exact host review; never guess IDs or change a revision hash to
silence the conflict. An unchanged failed review must stop.

This is a typed review-to-plan converter, not automatic discovery of all compiler
diagnostic classes. `CANONICAL_EVENT_MISSING` requires an explicit host-reviewed
source occurrence; the planner does not infer it from an event-catalog miss or a
flat coverage metric. Generic semantic modules, resolution revision,
expression/perception and executable repair policies remain unsupported by this
converter; missing-resolution creation is supported below. Independent requirement
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

Upstream semantic-slot contexts expose `reviewedOccurrences.triggerExact` and
`extentExact` extracted from frozen source byte anchors. Copy these strings and
all frozen participant IDs literally; do not paraphrase or normalize whitespace.
An exhausted slot remains stopped until owning-host review. The host-only
`authorizeHostCorrection` operation binds one failed attempt and exact new input
hash, with an audit and reason, preserving all prior failures. It grants one
additional failure allowance (maximum five grants per plan), permits only that
same-slot/same-proposal host submission first, and cannot start a model session.
Normal tool validation, proposal obligations, staging, finish and convergence
still apply. A failed host-reviewed identity is not eligible for another domain
correction. Do not expose this authorization operation as a model tool.

A missing/mismatched character presence projection or presence on an artifact is
an argument error before staging. Preserve the real failure and allow at most one
materially corrected input under the same proposal ID. It is not by itself a
host-state stop. Missing dependency authority, changed scope, consumed budgets,
receipts and ambiguous writes still require the explicit host recovery protocol.

### Structured compiler failure context

Compiler selector and event-resolution failures attach typed `context` to the
recovery envelope and persist `diagnosticContext` with the failed obligation.
Inspect every field path and the full dependency graph before one corrected
retry. Candidate adjacent text is bounded, verbatim, same-segment untrusted
source data; it never chooses an occurrence or becomes an instruction. Event
extents must contain their trigger. A new-event resolution must name its
same-finish event, coreference relation and complete matching candidate rather
than only changing status. See [the compiler correction SOP](compiler-self-correction.md).

`context.retry.correctedRetryAvailable=false` requires immediate host review;
source-specific hints do not authorize a third attempt, fresh identity or session
reset. The structured diagnostic survives Pi's text-only error transport and
batch hydration. Original errors, failure status, staged drafts and all prior
attempts remain intact. Host/scope/receipt/budget failures retain precedence.

### Bounded role-review work

Role source work and global audit now use host-assigned work identities inside
one original role-review batch. `propose_role_source_review` and
`propose_role_review_audit` store validated proposals in the existing obligation
journal. Their local completion never authorizes `finish_compiler_batch`.

For an evidence miss, use same-source `read_role_work_evidence` with a literal
`query`, copy `units[].unitId` to `unitId`, and follow `nextOffset` until the
complete decisive passage has been read. Search snippets and review notes are
not a replacement for original text. Source-work citations must be copied from
the assigned packet's `fragments[].unitId`; null gap IDs are uncitable. Neighbor
context uses `read_role_work_neighbor` direction `previous` or `next`; a boundary
result is normal and must not be retried. For a notes/inventory offset miss,
call the same reader with `offset=0` and copy `nextOffset` once. Correct all
reported proposal fields under the original work identity; never guess IDs,
repeat unchanged inputs or change work IDs to clear a failed attempt.

`ROLE_REVIEW_WORK_HOST_REQUIRED` stops model calls: retain the plan, source and
review hashes, local receipts, successful drafts and complete failure history.
Stale scope, single-use receipt, changed post-audit entries, invocation allowance
exhaustion and unresolved global audit findings are host stops. Budget/circuit
errors and exhausted proposal allowances take precedence over lookup advice.
The workflow does not automatically retry provider quota failures or reset
allowances in a fresh session. A partial work result never certifies an
independent review, complete world or active candidate.

For a host process that exited without a terminal report, first inspect the
compiler lock on its owning host and recover it with the exact returned
`owner.token` only after proving the process is dead. Preserve the archived
owner and recovery record. Under the compiler lock, reconcile the old trace as
`HOST_RESTART_INTERRUPTED_RUN`; do not relabel it as a provider quota failure.
Host-only `inspectRoleHostInterruption` and `grantRoleHostInterruption` bind the
archived lock proof, interrupted trace, original source/plan/task, unchanged
budget and validated receipts. Copy the preview's exact `authorityHash` into
`sourceInterruptionResume`. This consumes the existing second invocation and
next context round, retaining every earlier charge and progress milestone.
The new context must restore original evidence before proposing. This path
rejects unresolved proposals, in-flight tool results, stale scope, exhausted
budgets, already consumed context rounds and quota/validation stops. Do not
retry these failures, replace IDs, delete claims or recreate an authority.
An unfinished report with a dead owner requires a host handoff, never silent
polling or an automatic model retry.

### Role review verification v2

New reviews are version 4 with version 2 work evidence. Version 3 remains a
readable legacy artifact; it must not be relabeled as verified. Existing draft
entries retain their identities and receive `propose_role_claim_audit` work.
Copy `candidateId`, `claimRevision`, `packetHash` and `atlasRevision` from its assigned packet.
Assess importance, identity and development separately. Required original units
must be fully delivered in the packet or read with `read_role_work_evidence`
and every `nextOffset`. Counterevidence citations also require original text.
A contradicted/insufficient verdict is a durable finding, not a schema error;
stop for semantic repair, never retry it unchanged or turn it into supported.

`read_role_review_atlas` exposes only the current independent review. Start at
`offset=0`; copy `pages[].page` to expand notes and questions, or copy
`nextOffset`. For a bad page/cursor, make at most one corrected lookup. It is
an unfiltered navigation index, not authoritative source evidence.

Source audits must dispose of every supplied `expectedQuestions[].questionId`
and `discoveries[].findingId` exactly once, with the packet `atlasRevision`.
Read mapped judgments using `read_role_audit_inventory` and copy
`candidates[].id`; names alone do not satisfy the judgment read gate. Read all
cited original units. Empty dispositions, foreign IDs and stale revisions are
errors; correct the original work once. Blocked dispositions/unresolved issues
stop assembly and remain visible in the existing requirement ledger.

`request_role_work_evidence` accepts a concrete question, missing evidence,
decision impact, searched units and requested units. Discover exact IDs through
`read_role_work_evidence`, copying `units[].unitId`. One fresh-context supplement
is allowed per original work, with the same cumulative request budget. It does
not grant new model calls. A repeated need, wholly already-read request, missing
terminal receipt, exhausted budget or uncertain publication is a host stop;
never rotate work IDs, discard the question, silently truncate decisive evidence,
or retry in a new batch. Supplemental units are required before the terminal
proposal. An unsuccessful supplement does not authorize another child work.

### Context pressure and same-work repacking

Role notes now default to a compact directory. `nextOffset` means more entries
are discoverable, not that every entry must enter this work's context. Copy
`records[].noteId` into `read_role_review_notes.noteId` to expand a relevant
record. On a lookup miss, discover in the same review, copy the exact returned
ID and correct once. Directory previews are incomplete navigation, never evidence.

Novel role review uses Pi's native auto-compaction. Serialized context and
provider-payload bytes are telemetry, not a tokenizer estimate or model capacity.
The historical 36,000-byte watermark never stops a request. Persisted
`maxRequestBytes` remains historical budget metadata and is reported with
`requestBytesMode: observe` for role-review budgets, including retained parent
windows. Production role review uses a persisted window of 12 model calls without a
new host-validated milestone; cumulative call counts remain intact. Per-request
and cumulative bytes are observations (`requestBytesMode: observe`, `totalBytesMode: observe`). Actor and
other explicitly enforced request budgets retain their own policy. Existing
blocked budget records do not become usable merely because policy changed.

Pi owns threshold compaction and its native overflow compact-and-retry attempt.
Compaction model calls and payloads consume the same budgets as normal calls.
A successful compaction invalidates current-context evidence/read deduplication
state. Before proposing, use `read_role_session_context` with offset=0 and copy
`nextOffset` until the immutable task/evidence pages are restored; then use the
ordinary same-source tools for additional decisive originals. A summary cannot
satisfy evidence gates or change world truth. Unknown page offsets permit one
corrected discovery-based read, never guessed IDs or unchanged retry loops.

Role work first uses same-session self-review: call `refactor_role_work` with
an explicit diagnosis, revision plan and unresolved questions, then inspect the
draft using a read-only preview or original-evidence tool. A rebuild request
before that step returns an actionable correction; it does not commit anything.
If the work still needs a fresh session, `request_role_session_rebuild` carries
the self-review and diagnostics forward. A real provider overflow remaining
after Pi's native recovery may also enter this fallback. Authentication, rate
limit, cancellation, unknown transport errors and uncertain writes do not.

Every context-loop round is claimed durably before dispatch, under the same
parent work and immutable task hash. There are at most THREE sessions, including
the initial session. Each replacement receives recovery diagnostics plus
paginated access to the original task. Native compaction, self-review, previews
and replacement sessions all charge the SAME retained model-call budget. A
spent round cannot be restarted by process restart or renamed task. Existing
legacy single-use fallback claims remain stopped for explicit host review.

Draft previews are not commits and may be revised within the loop/call limits.
Original committed proposal identities, real validation failures, evidence
requirements and questions persist. A failed committed proposal does not acquire
extra retries from a fresh session; unresolved proposal/host/scope gates still
require exact host disposition. Failed or exhausted loops preserve all records.

Every actual model request, including Pi summarization, records context and
transformed provider-payload observations in the existing run trace BEFORE
transport. `validation.completed` events with `phase: role-request-observation`
include work/plan/task identity, session and request ordinal, recovery reason,
request kind (task/compaction), evidence epoch, last tool, model context-token
capacity, exact total JSON UTF-8 bytes, per-top-level-section sizes, and per-message
role/tool/size. Each event links a redacted full snapshot blob for later analysis.
Byte counts are measured before redaction; token estimates are explicitly unknown
when unavailable. Actual provider usage remains in response records. Observation
persistence failure blocks dispatch rather than silently losing a round's data.

Historical host handoff checkpoints remain readable, with their original
allowances and navigation entries intact. `read_role_context_history` paginates
same-work access metadata; copy `accesses[].args` to its named discovery/read
tool. Historical reads do not prove current evidence delivery. Legacy handoff
paths are for diagnosed recovery, never triggered by a byte observation.

An already blocked legacy work is not automatically reset. Host-only
`recoverRoleContextBudget`, under the compiler lock, accepts only an unfinished
source work with a verified original budget hash and a matching failed trace
proving a request-size stop. It records the implementation reference and a single
immutable grant. The original blocked budget remains intact; a separate continuation
inherits every charged call and byte under unchanged limits. Call/total-byte
exhaustion, quota/unknown errors, unresolved proposals, stale evidence and repeated
grants are rejected. Recovery restores navigation from that exact trace, never a
semantic verdict, and does not reset invocation attempts.

On handoff, the host rebuilds original evidence from immutable source ranges and
merges overlaps before delivery. The assigned source core remains explicit;
neighbor text does not enlarge review coverage. Only complete originals actually
delivered in the new packet satisfy read gates. An exact read already fully
present in this context returns `alreadyDeliveredInCurrentContext`; use that
original text, do not retry the read. This pointer does not earn handoff progress.
Partial ranges and discovery excerpts never become complete-read proofs. For a diagnostic evidence-packet preview with an explicit byte allowance,
an oversized merged packet requires host task decomposition;
never silently drop evidence, reset attempts or replace originals with a summary.

Source-review notes have an observational 8000-byte reference point, not a total
JSON-size validity constraint. Preserve exact references, all findings and open
questions even when notes exceed it. Prefer concise observations and use draft
preview/refactor tools for schema, scope and evidence feedback. Ordinary source,
part and integration previews share their corresponding submission validators.
An invalid draft never commits truth or consumes a proposal correction attempt;
its actual model call and tool feedback are retained in the trace. Citation,
identity, responsibility, structural schema and committed proposal gates remain.

The following sourceNotesRecovery path concerns retained historical size failures;
it never implies that the old size validator remains active.

A host may select `sourceNotesRecovery` only for the exact sole unresolved source
proposal whose only schema defect is total JSON byte size. Bind the original work
ID and failed input hash within an existing sourceWorkScope; this work must run
first. Deliver the failed proposal and immutable core/cited originals to Pi in a
bounded correction packet. Preserve each finding's order, name and evidence IDs,
and every open-question slot. The ordinary proposal validator and journal commit
remain authoritative. Recovery consumes an existing work invocation and retained
model budget, does not alter the old context checkpoint, and grants no additional
handoff or correction attempts. Foreign scope, a second failed correction, missing
budget, oversized required packet or exhausted invocation allowance stops. A
successful correction resolves the original journal identity; other blocked works
remain in the denominator. Only Pi rewrites the semantic prose.

A completed host-selected sourceWorkScope returns normally at the source-stage
boundary, with progress explicitly stating that global review remains unfinished.
It never calls global finish. Reassembled packets carry each evidence ID on its
fragment; the complete-read ID set stays host-side to avoid duplicate metadata.
Recovery rechecks the authorized trace hash before restoring access navigation.

### Current-session delivery and partitioned source inspection

Exact evidence reads return only missing Unicode-code-point ranges, with
startOffset/endOffset and a current-session location. If already delivered, use
locations instead of retrying. nextOffset always identifies an outstanding gap;
reading a suffix cannot prove the unseen prefix. New sessions clear delivery
proofs; immutable original ranges actually redelivered in the new packet reseed
them. Search excerpts do not count. Repeated identical read-tool responses return
a pointer to their first current-session tool call and do not earn new progress.

Host-selected partitionedSourceWorkIds must belong to the original source scope.
The host derives up to four bounded original-evidence packets from the same core
and retained read ranges, with UTF-8-safe boundary overlap. Each session uses the
parent work ID and its retained budget. The single remaining parent invocation
covers all parts and final integration: child proposal IDs do not own budgets or
new retries. Exhausted parent invocations still stop.

propose_role_source_part writes only narrow unvalidated notes into the existing
proposal journal, bound to the plan, parent, packet and partition-bundle hashes.
Copy IDs from part.packet.fragments[].unitId. Correct invalid arguments once;
unchanged submissions, interrupted/stale parts and a second failure stop. Each
part uses the shared source-note schema and provides a read-only
preview_role_source_part for exact byte measurement before committing. Actual
serialized request gates govern the combined originals and drafts; no per-part
model budget is granted. If required responsibilities cannot fit, stop rather
than omit them. Partial notes never satisfy source coverage. Their
questions are registered in the existing requirement ledger even if later work
fails. Pi must finally inspect the complete original core, integrate every
core-related finding, and retain all part questions verbatim in order. Only the
ordinary validated parent source proposal creates a source receipt. Integration
failure preserves partial proposals and all question obligations.

### Host revalidation of legacy source-part size failures

`reviewLegacySourcePart` is host-only and previews before apply. It accepts only
an unchanged retained part whose complete failed history reports solely the
retired 1800-byte validator. It reconstructs the original immutable packets,
checks every cited unit, current roster/structure, both parent invocation markers,
and retained budget. The shared structural source-note validator remains binding; note bytes
are observational. Apply requires the exact preview `authorityHash` and appends a host
revalidation to the original proposal journal; it never changes prose, clears
history, grants model calls, creates source coverage, or certifies semantics.

The host may resume that original partition invocation once with
`sourcePartContinuation`, the exact single `sourceWorkScope`, and the original
`partitionedSourceWorkIds`. A durable claim prevents a second continuation even
if integration fails. Pi must inspect the originals and integrate all retained
findings/questions through the ordinary parent validator. Stale packets,
non-size failures, unknown or exhausted budgets, pending publication, changed
parent scope and repeated claims stop without model retries. Discover exact IDs
in the retained same-source role-work plan and obligation journal; never guess
or rotate IDs. Revalidation is not an automatic retry of a rejected proposal.

### Original parent integration correction after context pressure

`inspectIntegrationCorrection` provides a read-only host preview for the sole
original parent binding failure after all original evidence parts succeeded.
It verifies source/roster/structure, part packets, the consumed continuation,
original invocation markers, exact failed tool input in the stopped trace, and
unchanged retained usage. Only a trace-proven context stop with one unused
proposal correction and remaining model calls is eligible. This is a distinct
parent-proposal correction, not another part continuation or a budget grant.

An explicitly selected `sourceIntegrationCorrection` must match that preview's
`authorityHash` in an exact single-work `sourceWorkScope`. Under the compiler
lock it claims the original correction once before transport. Failure, interruption
or zero output consumes that claim; never repeat it, rotate IDs, reset attempts,
clear a budget, or accept a draft manually.

The packet contains all assigned core bytes and complete originals for every
cited unit, merging overlaps and indexing identifiers losslessly. The host keeps
the exact ID dictionary and immutable name/reference bindings. Copy every
`bindings[].bindingIndex` once into `findings[].bindingIndex`; provide an
original-evidence-supported observation for each. The host restores exact names,
core references and all part questions verbatim, then measures expanded size and preflights
binding completeness through the ordinary source validator before commitment.
The failed proposal remains in the packet and journal. This creates only a source
review receipt, never world truth, a global review, or certification. Unsupported
bindings, missing indexes, unchanged correction, stale scope, a second failure,
context pressure and budget stops preserve the failure and forbid further retries.

For host-selected partitioned source work, `compactSourceIntegration` uses the
same immutable binding representation without a prior failed parent proposal.
It delivers the whole core plus complete originals for every part citation,
merges overlapping text and keeps the ID dictionary host-side. The optional
`preview_role_source_integration` checks expanded bindings and bytes without
recording a proposal; it still uses the parent's model-call budget. All actual
submissions pass the ordinary source validator. Missing/duplicate indexes,
unsupported observations remain failures; expansion bytes are observational. Unchanged
inputs, consumed invocation allowances and context/budget stops cannot be retried.
This mode consumes the existing partition invocation and creates no new allowance.

Source-part preview and commit share the same structural schema and citation-scope
validator. A foreign `findings[].unitIds` makes preview invalid without creating
a proposal failure. Its diagnostic names the invalid IDs and directs the model
to copy exact `part.packet.fragments[].unitId` values. Preview success is only
structural/scope validation, not semantic support. A real failed submission
retains its original identity and correction bound; context stops still require
host recovery rather than another unchanged call.

### Original source-part citation correction after context pressure

`inspectPartCitationCorrection` is a read-only host inspection for the sole
failed `propose_role_source_part` citation submission. It requires one unused
correction, unchanged source/plan/part packets, valid preceding receipts, both
original invocation markers, unchanged retained budget, and the exact trace
proving context pressure after that failed input. Sufficient original calls must
remain for the unfinished parts and parent integration. No budget or invocation
allowance is added.

An explicitly scoped `sourcePartCitationCorrection` binds the preview authority
and claims the interrupted partition once before model dispatch. The failed
proposal and complete assigned part are delivered again. Copy exact
`part.packet.fragments[].unitId` values from that same-scope packet; do not guess
IDs or use another part. Preserve findings in name/order, existing valid refs and
all open questions verbatim. Stop if the original evidence cannot support a
finding. One corrected submission is allowed; failure, transport uncertainty,
context pressure, stale scope or consumed claim forbids another launch. The
remaining partition runs under the same parent budget and ordinary validators.
No source coverage is recorded until parent integration succeeds; no global
closure or certification follows from this local recovery.

### Retired byte-watermark integration continuation

`inspectIntegrationResume` is a read-only host preview for an unfinished parent
with every original part receipt validated, no parent submission, no unresolved
proposals, unchanged source/plan/context/budget, and a matching failed trace with
zero model requests/tool submissions proving the retired byte-watermark stop.
`sourceIntegrationResume` must bind that authority to one selected partitioned
work and claims continuation once before dispatch. It does not repeat the parts,
reset invocation markers, grant calls, or pardon a failed model proposal.
Changed authority, incomplete evidence, spent budget, uncertain state, or a
consumed claim stops. Native Pi context recovery then applies under the same
remaining budget; the parent receipt and all later audits are still required.

### Retained integration rejected only by obsolete total note size

`reviewIntegrationSize` previews/revalidates only the exact sole failed parent
integration whose entire failed history reports the retired total-byte validator.
The host reconstructs original part packets and immutable bindings, validates
all citations and questions, and expands the LAST retained model input without
rewriting its text. The authority binds history, original source/context/parts,
budget hash and expanded proposal hash. Apply under the compiler lock with that
exact authority. Append a host-reviewed success through the ordinary source
submission lifecycle; preserve every failed entry and invocation marker and do
not charge a new model call or grant budget. Other defects, stale authority,
already-reviewed state or missing parts stop. This produces only a local review
receipt, not semantic certification or activation.

### Host continuation after an aggregate call limit

`inspectParentCallContinuation` previews one explicit revision of the original
`continuation-window`, capped at 120 additional calls. It binds the exhausted
budget, unchanged stopped child usage, failed run, source/batch, implementation
and user-authorized host audit reference. `grantParentCallContinuation` requires
that exact preview hash under the compiler lock. It preserves the blocked record
and writes an immutable grant; `openParentCallContinuation` persists cumulative
usage separately, starting from all previously charged calls and bytes. Pending
publication, changed hashes, unknown failures and exhausted child budgets stop.
The grant cannot be repeated, silently enlarged or used to reset a work budget.

For the exact stopped source work, `sourceParentBudgetResume` must match this
grant and an exact single-work scope. It verifies the retained trace, task hash,
first context claim, unchanged child budget and absence of unresolved proposals.
The replacement consumes the next original context round and invocation; the
persisted work budget, three-session limit and proposal correction limits remain.
Restore the immutable task with `read_role_session_context` and copy `nextOffset`
until complete before proposing; summaries do not satisfy evidence gates.
Changed scope, a previously consumed continuation or another stop forbids an
unchanged retry. Discover identities in the original role plan and failed trace,
never guess them or create replacement work IDs. Completion remains subject to
all original source, claim and audit denominators.


### Progress-controlled role compilation

A host may select `claimAuditScope` to independently inspect already staged
claims while historical source work remains blocked. Copy `planHash`,
`atlasRevision`, `entriesHash` and candidate IDs from the original role-work
store; supply the exact full set of missing source work IDs. Every missing work
must retain an unresolved need in the existing requirement ledger under its
original ID. Inspect its original failure before recording that need; doing so
does not grant a retry, restore a correction or create a source receipt.

This scope runs only the selected original claim-audit identities. It freezes
the atlas and entries, exposes missing coverage to the reviewer, and uses the
ordinary evidence, proposal, context and progress gates. Missing atlas notes
are never evidence of absence. Record an insufficient or contradicted judgment
when warranted; these durable findings block global completion while other
independent claims may be inspected. The scope always returns before source
audits and global assembly, even when every selected claim is supported.
Changed hashes, omitted gaps, unresolved proposals, mixed recovery scopes and
spent work/context claims stop before another model call. Inspect the original
plan and journal for exact returned identities; never rotate IDs, guess hashes,
retry unchanged, or overwrite a stale audit after its atlas revision changes.

For unstarted scoped claims the host may opt into `claimAuditDraftPreview`.
The unfiltered atlas directory returns up to 25 core summaries per page so
global orientation does not itself require more calls than the local stall
window for this source. Copy `nextOffset` until the directory ends; every core
retains its original page ID, span and detail access, including late questions.
This batches navigation only: directory reads earn no progress and never prove
original-evidence access or complete an audit. For an invalid cursor, call
`read_role_review_atlas` with `offset=0`, copy its `nextOffset`, and correct once;
never guess offsets or retry unchanged. Existing stopped budgets remain stopped.
`preview_role_claim_audit` shares the submission schema, exact claim/atlas/packet
bindings and complete-original-read checks. It returns `valid` without writing
a proposal or consuming a correction. Semantic support remains unverified;
preserve explicit insufficient judgments and evidence boundaries. Copy revision
fields from the assigned packet. Discover original evidence with
`read_role_work_evidence` query, copy `units[].unitId` and follow `nextOffset`;
correct reference errors once, never guess or repeat unchanged failures. Only
the first valid draft of that immutable task can advance the existing progress
window. Reads, repeated previews and self-assessments cannot. This opt-in leaves
old task prompts unchanged and does not revive a stopped claim, reset budgets
or grant context/proposal attempts. A diagnosed stalled claim stays in the
original audit denominator and ledger while untouched independent claims may
continue under their original identities.

The host may also select `sourceAuditScope` for independent diagnostics of
already reviewed cores. It binds the original `planHash`, `atlasRevision`,
`entriesHash`, `claimAuditsHash` and selected original audit work IDs. Supply
the full `missingSourceWorkIds`, `missingCandidateIds` and
`unresolvedClaimWorkIds` from the current store; every gap must retain an
unresolved need in the existing requirement ledger. Candidate inventory size
and staged-claim audit size are separate denominators. This scope does not
relax candidate submission's full-source-review gate.

Only untouched audit work may start with this diagnostic prompt. Previously
settled audit receipts are reused without replacement; a started but unfinished
audit, stale hash, omitted gap, mixed recovery scope or unreviewed source core
stops before model dispatch. Inspect the original plan and journal, copy exact
returned IDs and hashes, and perform the appropriate host diagnosis; never
retry unchanged, rotate IDs, clear budgets or revise settled receipts.

The reviewer receives the incomplete coverage explicitly. In
`read_role_audit_inventory`, copy `candidates[].id`, read the full `entry`, and
inspect its `claimAudit` status. A name without an entry cannot satisfy the
mapped-judgment read gate; use an evidenced blocked or missing-major finding.
Mapping a candidate with absent/insufficient/contradicted claim audit must also
name its exact candidate ID in `unresolved`. Correct this once from the same
inventory; mapping is not a semantic repair. All original-evidence, question,
discovery, preview and bounded proposal gates remain in force. Blocked
dispositions and missing-major findings remain durable diagnostics in the
original work receipts and requirement ledger; other selected untouched cores
may proceed. The scope always returns before global assembly. Neither these
diagnostics nor resolved individual questions certify source coverage, a claim,
the roster, an executable world or activation.

Complete original units supplied in the current source-core task satisfy the
evidence delivery gate without redundant tool calls. A core-boundary fragment
does not satisfy that gate until its missing original ranges are delivered.
On `Unread role work evidence`, copy the exact `unreadUnitIds` from the
diagnostic into `read_role_work_evidence.unitId` and follow `nextOffset`; do not
reread every already-delivered citation. For an unknown ID, use that same
tool's `query`, copy `units[].unitId`, and correct once. Compaction or rebuilding
invalidates this access until the original task is fully restored; notes and
search snippets never qualify. This fixes delivery bookkeeping, not semantic
support, and does not revalidate old failed previews, grant progress credits,
restore attempts or reopen a stopped work.

Production role work uses `modelCallsMode: progress`. Its `maxModelCalls: 12`
is a stall window, not a lifetime allowance: stop before a thirteenth call without
a new host-validated milestone. The host records the first valid draft, a
validated terminal subtask receipt, or complete restoration of the exact original
task after actual context recovery. Keys bind the immutable logical task. Every
milestone counts once across tool names, reworded drafts and replacement sessions.
Generic reads, new output hashes, model self-assessments, heartbeats, invalid
previews and failed proposals do not advance this window. A draft milestone is
structural/scope progress only; it is never certification or committed truth.
The model-facing role protocol states this 12-call window explicitly: every model
response consumes a call even when it only requests reads, reads do not renew the
window, and the model must reserve a response for the exposed proposal tool.
Atlas-directory pagination is optional navigation, not evidence or a completeness
gate; follow another directory page only when it is relevant to the assigned
claim, then verify decisive support and counterevidence in original source units.

Cumulative calls, payload bytes, validated milestones and the last-progress call
are persisted together before further dispatch. A fresh process cannot clear
stalled calls or replay an old milestone. A `no-progress` stop, prior blocked
state, failed publication, exhausted correction or stale scope remains a host
stop; never retry unchanged, rename work, delete counters or pardon a failure.
An original task already present in a fresh context need not be read again using
`read_role_session_context`. After recovery, use offset=0 and copy `nextOffset`
until the immutable task is completely restored; additional decisive originals
must still be delivered through ordinary same-source reads.

Whole-plan aggregate calls are observational under the explicitly selected
`validated-role-progress/v1` policy. The scheduler visits the finite original
source-work plan, verifies each receipt, preserves blocked entries in that
denominator and never rotates IDs to manufacture progress. Stop on host/state
errors or unresolved proposals; a stalled work cannot be repeatedly rescheduled.
There is no automatic global stop at 120 or 240 calls while validated work is
advancing. An explicitly requested spending/time limit remains a separate bound.

`inspectRoleProgressContinuation` previews migration of a retained aggregate
call-limit stop. It binds both historical budgets, unchanged child usage, the
failed trace, source/roster/structure, original role plan and validated receipts.
`grantRoleProgressContinuation` applies that exact preview under the compiler
lock using the existing user authorization; no model tool can grant it. Both
blocked historical records remain immutable. A separate continuation starts at
all charged calls/bytes with `modelCallsMode: observe`; the original per-work
stall windows, session claims and proposal histories still govern execution.
Pending writes, changed scope, stale proof or exhausted child progress windows
stop migration. For its exact interrupted source work, use the existing
`sourceParentBudgetResume` with `policy: progress`; this consumes the next
original context round and invocation once, rather than creating another task.

### Aggregate audit preflight and evidence-triggered draft validation

New audit tool schemas expose the disposition constraint: only `mapped` may
have candidate IDs, and it must have at least one. `blocked`, `missing-major`
and `nonmajor` use `candidateIds=[]`; related identities and dependencies remain
in rationale/unresolved. Preview and submission use the same aggregate validator.
An invalid preview returns all independently checkable `issues[]`, including
exact field paths and candidate/unit IDs. Correct these together once. Unknown
or unread candidate IDs use `read_role_audit_inventory.candidateId`, copied from
the diagnostic or `candidates[].id`. Query discovery still follows `nextOffset`.
A known candidate without an `entry` is a missing judgment, never an unread
entry: preserve an evidenced blocked/missing-major finding and its unresolved
dependency; do not retry reads, invent a judgment, or change semantic status
just to satisfy the validator. Non-mapped candidate IDs are a field-shape error,
not an instruction to read a missing judgment.

Untouched scoped source audits receive complete boundary units when they fit
the existing bounded evidence packet. `boundaryContext.contextOnly` never changes
core ownership, source receipts, or neighboring work. Oversized originals stay
explicit in `manifest.requiredButMissing`; read those exact unit IDs and every
`nextOffset`. No bytes are trimmed, including whitespace. Compaction invalidates
access until the original task and any additional decisive text are restored.

Within a live work, the host retains the latest schema-valid preview input and
rechecks it after evidence/inventory reads with the SAME preflight validator.
Only a newly valid draft earns the existing `draft:<logicalTaskHash>` milestone,
shared with explicit previews. The host returns `hostDraftPreview` with its input
hash, `committed=false`, and unverified semantic support. Submit through the
original proposal tool. A read by itself earns nothing; repeated reads, changed
draft hashes, repeated valid previews and self-assessments cannot renew the
window. An invalid replacement draft cannot fall back to an older draft.
This mechanism does not consume another model call to confirm the last required
read, but it grants no proposal, context, or retry allowance. Retained blocked
budgets and previously stopped source/claim/audit work remain blocked, with no
retroactive progress credit or renamed replacement work.

Untouched diagnostic source audits now default unfiltered
`read_role_audit_inventory` calls to a compact directory: up to 25 complete
identity/status records per page, further bounded by 16000 UTF-8 bytes without
truncating an item. Copy `nextOffset` for the full denominator and
`candidates[].id` into `candidateId` for the relevant full judgment. `mode=detail`
and literal queries retain the full single-entry read. `mode=directory` can
filter the directory with a query; it cannot combine with `candidateId`.
Directory responses never satisfy judgment-read gates or earn progress. Missing
entries remain visible. A cursor miss uses the same tool with `offset=0`, then
the returned `nextOffset`; correct once, never guess or repeat unchanged.
Oversized single items stop for host review, with no truncated evidence or retry.

An `unverified-dependency` preview issue identifies a field correction, not
missing access. Copy each unique reported candidate ID into `unresolved`, retain
its evidence boundary, and correct the draft before optional navigation. The
validator reports each such candidate once even when multiple findings map it.
This does not certify that claim or reopen stopped work. A no-progress task
retains its original budget, context and attempt records; the directory change
applies only to untouched diagnostic work, whose start guard remains mandatory.

### Durable compiler handoff delivery

The local supervisor uses `tools/compiler-wakeup/` to connect to the existing
Codex daemon over its protected Unix socket. It uses `thread/queue/add`, exact
queue/history discovery and `thread/queue/start` for its own acknowledged queued
submission when idle. It never launches a second `codex exec resume`, steals a
writer, changes the model/account, or treats `task_complete` as writer release.
An unavailable owning thread remains pending for host review/availability.

`delivery.json` binds the thread, source/plan, trace, report hash, prompt and
predecessor wake evidence to one stable message identity. Each transport attempt
has its own exclusive record. Explicit busy/overloaded RPC refusals remain
pending; a lost acknowledgment is uncertain and may only be reconciled against
the exact queued/history input or receiver acknowledgment, never blindly resent.
Acceptance is distinct from compiler success. The receiving host verifies the
latest user instructions and evidence, then records `handoff-ack.json` with the
exact `deliveryId`, `clientUserMessageId` and bound `reportHash`. Only then is the
delivery completed and its monitor retired. Binding conflicts, foreign acks or
uncertain writes require host review. Old single-use wake claims stay unchanged.
Quota scheduling still requires a new provider reset timestamp; transport
refusals and no-progress stops are not quota failures. Run `pnpm test:wakeup`
for refusal, uncertain delivery, crash, acknowledgment and Unix transport tests.

### Source prerequisites for blocked role questions

`role-source-prerequisites/v1` uses new user-authorized prerequisite work, never
a renewed audit or routing grant. `read_prerequisite_source` discovers exact
`segments[].id`; copy it into `segmentId` and read the complete segment before
citing it. The full read must reach a subsequent model request before submission;
read and submit calls in the same assistant response are not evidence delivery.
Follow `nextOffset`, never guessed offsets. For one ID/selector miss,
rediscover in this same source and make at most one changed correction.

Only after a fresh independent specification check may
`discover_prerequisite_dependencies` expose current findings, candidates,
annotations and resolutions. Copy `findingId`, `id` or `annotationId` from its
directory into the corresponding full-read selector. Read every selected typed
finding/candidate. Missing representations or evidence stay explicit; source
overlap is not a dependency proof. The independent mapping reviewer repeats
the evidence and dependency reads in a fresh session. Dependency discovery and
full payloads also must reach a subsequent request before a binding is submitted.

`submit_source_prerequisite` retains one typed output per original phase. Copy
the task's exact scope, question and predecessor hashes. Preserve every critical
question. A second invalid input, unchanged retry, consumed stage, stale parent,
uncertain publication or budget failure stops the task. Never rename a task,
reuse a review session, renew grants or reset old budgets. The host checks Pi
trace provenance and immutable source anchors before appending review evidence
to the existing requirement ledger. No question disposition changes.

The compiler lock, immutable source and provider admission are checked before
consuming the first phase. A preflight refusal permits retry only after its
actual host condition is resolved. If a completed phase has its original record
and successful trace but ledger publication failed, the host verifies the exact
input, scope, output, fresh-read boundary and predecessor, then publishes only
that missing ledger entry. Already published entries are not appended again.
This replay does not call Pi or renew a session; only originally unconsumed later
phases may dispatch. Missing or inconsistent completion after an invocation was
consumed requires host review, never redispatch or a replacement task. A failed
ledger write does not rewrite a successful model trace as a model failure.

`DONE` means host authorization review is possible, not that any upstream write
is allowed. The existing upstream plan preflight remains mandatory. An accepted
missing-condition report cannot satisfy it. See
[the source prerequisite protocol](role-source-prerequisites.zh-CN.md).
# 来源表示范围提案与复核

`read_representation_source` 的 ID/游标错误：使用同工具 `query/offset=0`，复制 `segments[].id` 到 `segmentIds`；完整读取后，通过 `selectors` 取得宿主锚点并原样复制，禁止猜 byte offsets。`read_representation_annotations` 的 ref 错误：同源 `query/offset=0`，复制 `items[].id` 到 `annotationIds`；不得把标题、proposal ID 或相邻文本当成逻辑 ID。分页只使用返回的 `nextOffset`。每个工具至多一次更正，禁止不变重试。

`submit_source_representation` 只留存来源表示提案／独立复核。保留全部原 critical/blocked 问题和每个验收条件；缺类型或证据时记录 gap，不能强制确定身份、声音或历史。来源／目录漂移、未知权限、依赖循环、单次调用已消耗、host-review 错误或预算耗尽时停止；保留 start、invocation、input、proposal、record、trace、预算与旧账本。不得更换 taskId、另建目录、重跑前置阶段或续发旧 grant。DONE 只允许宿主检查精确计划并进入既有上游登记／授权，不允许把原主 loop 改成 READY。

### 来源表示的 typed proposal 与独立验收

来源表示槽位的 `propose_*` 参数必须忠实保留 `reviewedSourceAnnotation.payload`；复制其 `selectors[].selector` 与宿主 proposal ID，不重新推断语义。ID/ref 错误时只调用 `read_upstream_repair_context`，复制 `readable[].id`、`stagedDependencies[].payload.id`、`evidence[].segmentId`，同一槽位至多一次更正。成功 staging、host-review、scope、消费过的 invocation 或预算失败都停止，不重新开会话。宿主保留原 invocation、input、modelSessionRef、attemptRef、提案、trace 和预算，异常写入只能依据原 intent 恢复，不能重发模型任务。

独立验收使用 `read_source_upstream_acceptance`。传 `segmentIds=[]` 发现本计划的 `segments[].id`，原样复制到 `segmentIds` 并完整读取全部段落。ID/selector 错误至多一次更正；只能引用已经读完的段落，不猜 ID、不重复原错误。`submit_source_upstream_acceptance` 必须使用输入中的 planHash、graphHash 和完整 questionId 分母，只评价实际 pending 来源表示。负面结果、图或来源漂移、重复提交和预算耗尽均停止，保留原 pending 与审查记录，不降级原 blocked 问题。缺少实际独立验收证据时 finish 拒绝提交；不得用旧 supported、预览或重写预算绕过。

### 候选分母修订后的精确语义范围

`read_semantic_source`：同工具 `query/offset=0` 发现并复制 `segments[].id` 到 `segmentIds`，读完整段后通过 `selectors` 获取锚点；不猜 byte offsets。`read_semantic_dependencies`：复制发现结果的 `items[].ref` 到 `refs` 完整读取；复制其 `kind/id/revisionHash`，需要类型定义时传 `schemaKind`。分页只使用 `nextOffset`。ID、selector、schema 或游标错误每工具最多一次改变输入的更正，不变重试禁止。

`submit_role_semantic_scope` 只留存单次范围提案／复核，不写世界或授予修复权限。复制冻结的 revisionHash、原 question ID、候选清单及 host slot，覆盖每个条件和 boundary index；payloadJson 必须匹配所查类型及精确字段范围。格式错误可检查工具 schema、原文与类型目录后更正一次；host-review、来源／依赖漂移、已消耗 invocation、预算失败或重复提交立即停。保留原 start/input/proposal/record/trace/budget，不能另建 taskId、改目录、续发旧 grant 或把主 loop 改为 READY。DONE 也必须经过当前有效类型和原角色计划的宿主授权审查。

部分 `typed-repair` 可以同时保留 `operationSlots` 和非空 `missingCondition`；这表示仍有缺项，即使独立复核 supported 也不能使范围就绪。宿主不得删除缺项或改写失败提交来通过校验。`create` 必须使用分配的 ID、`baseline=null`、`pointers=[]`；新增替代决议的旧版本放在 `readableRefs` 及 payload 的 supersedes 字段，不能充当创建操作的写基线。`revise` 必须使用当前目标的精确 baseline 和已登记字段指针；`/` 从不授权整对象写入。

宿主可用 `inspectSemanticScopePlan` 对保留的原始提交作只读检查，一次列出所有结构范围错误；它不规范化 payload、不登记提案、不授权，也不把失败 trace 改为成功。修正宿主校验器不自动使旧提交有效。若仍有非法指针／基线、缺失独立复核或证据缺项，应继续保留 BREAK、原计费及失败，不能重开已消费阶段来取得修正后的提案。

`ROLE_PREREQUISITE_HOST_REVIEW` 和 `UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW` 的结构化恢复信息必须是 `host-repair-required / retryable=false`，即使消息同时含有 missing、schema 或 requires。禁止通用参数恢复建议覆盖这两个明确停止信号；旧 trace 中的原始错误信息仍保留，不回写更正。

### 独立身份要求的只读工具

- `read_identity_source`：ID/ref 错误时同作用域 `offset=0` 或 `query` 发现，复制 `segments[].id` 到 `segmentIds`；分页复制 `nextOffset`。精确引用先完整读取，再提交 `selectors`，最多一次改变后的纠正，禁止猜 byte offset 或原样重试。
- `read_identity_dependencies`：在原 `collection` 内以 `offset=0` 发现，复制 `items[].ref` 到 `refs`，分页复制 `nextOffset`。`dependencies` 与 `consumers` 不能混淆；定义阶段没有消费者读取权限。一次实质纠正后仍失败即保留现场，禁止换会话或扩大权限。
- `submit_identity_requirements`：一次性只读提案。必须覆盖固定 requirement IDs 和当前分片全部消费者、候选、来源页与问题。缺读可完整读取后纠正一次；类型／来源／单次调用／旧预算／宿主状态错误必须立即停止。已留存负面结果不可再提交或续发 grant。范围和支持判断不能替代现有上游 register/authorize 及实际 pending 图的独立验收。

身份定义若已成功完成 Pi 调用、提交并留存原 record，却因宿主错误地将预算 `largestRequestBytes` 等同于发送载荷最大值而在入账处停止，可在源码修复及测试后使用 `inspectIdentityDefinitionRecovery` 只读核验。预算最大值包含逻辑上下文与发送载荷两者；总字节仍只累计真实载荷，调用数、载荷数、逐次总和及全部上限必须继续匹配。该入口仅接受原首阶段的精确宿主停止、完整文件哈希、成功 trace、已退出的原宿主进程及未消费的后续固定阶段；宿主/PID 命名空间不同、任何文件漂移、未结算调用、已入账或已调用的后续阶段均禁止恢复。

恢复只登记同一个原 record，继承其全部计费，再运行原 intent 中未消费的独立检查与固定消费者分片。原 `start/state/hooks/input/proposal/record/trace/budget` 不变；单次宿主恢复 intent、入账收据与后续状态写入原目录下的 `host-recovery`。该目录不是新语义 task、重试、预算或 grant。负面语义结果仍按原门禁停止；恢复失败不得再次启动或借此恢复主编译器。

### 身份缺口的消费者分流

定义的 `missingCondition` 不得由宿主清空或解释为修复许可。独立复核支持有限的不确定性表示，只允许后续只读审查；真正写入仍须通过全部消费者分片、精确上游计划、register/authorize 与实际 pending 图独立验收。

`submit_identity_requirements` 的消费者阶段从当前输入 `definitionGaps[]` 复制 `requirementId` 与 `conditionHash`，分别写入对应 binding／judgment 的 `definitionGap`。每个缺项须有来源证据和明确分类：`retained-boundary` 保留原问题未定状态，`repair-prerequisite` 阻塞当前修复，`unknown` 表示尚不能分类。独立复核必须检查同一条件与分类。缺少分类不会按空值默认通过；绑定自己的 `missingCondition` 仍表示本次修复缺少前提，必须保留。ID/hash 错误只可按同一输入精确字段纠正一次；不得猜测、按文本相似度匹配或原样重试。来源查找仍用 `read_identity_source`，依赖发现仍用原 collection 的 `read_identity_dependencies`。

旧定义缺口门禁的宿主续行须调用 `inspectIdentityConsumerContinuation`，绑定已退出的原宿主进程、精确 BREAK、两份已登记成功记录、全部旧文件及当前 inventory。新 `consumer-review` 目录仅记录一次原未消费阶段的续行，不是新 task、预算或 grant；旧记录和字节保持不变。未通过独立定义、目录/来源漂移、进程仍存活、未结算 trace、任何消费者阶段已有 invocation 或 trace、预算不一致均停止，不允许再次恢复或重跑。分片复核为前提不足、未知、负面或额外修复时保留提案和独立结果，立即停止放权；不能靠删缺口、换 ID、换分片或续发 grant 继续。

历史范围更正的只读校验允许精确绑定原语义前缀的同 task 身份记录追加；实际更正 dispatch 仍要求原空后缀，不会重新打开已消费更正。

### 身份消费者会话持久化与显式有界重建

身份阶段使用独立的 Pi 持久化目录。新阶段采用提示协议 v3，在台账登记前结束并封存完整会话、实时消息日志、原始请求日志和上下文准入收据，record 绑定 v2 检查点哈希。实时日志在 Pi 的 `message_end` 回调中、Pi 写会话文件之前逐条落盘，包含最终响应的 opaque provider 状态和终止工具回执。封存及公共 `verifyIdentityRecord` 均逐条比较实时消息与持久化消息，再把每次实际原始请求与对应响应之前的完整消息前缀比较；系统头只允许可信策略更新时间戳。提交必须发生在读取结果已进入后续请求之后。缺文件、截断、改写、封存前丢失、消息／请求／预算／trace 不一致均停止，不重新请求模型，不补造缺失日志。失败阶段仍封存现有原始文件和失败检查点，但不能取得成功封存或台账权限。完整 provider 会话与脱敏观测 trace 分开保存；不得从 trace 的占位符补造 provider 状态，也不得将重建称为原会话的无损恢复。

`identity-context-reconstruction/v1` 仅在后续用户明确授权恢复后使用。仓库入口为 `node --import tsx src/workflow/identity-consumer-context-recovery.ts prepare|inspect|run|verify REQUEST_JSON OUTPUT_JSON`。`prepare` 接收 `sourceId/taskId/authorizationRef/engineeringHistory`，生成单独的 v2 proof；其余模式接收该 proof。旧 supervisor request 必须原样保留，不能覆盖或当作 proof 使用。`engineeringHistory` 必须列出原工程停止之后的全部尝试，逐项绑定目录完整文件哈希及 stateFile；显式空数组表示没有后续尝试。`local`／`cumulative` 只是与归档生产者核对的声明，不能决定计费。导入状态必须是无 worker 的已结算 BREAK，并保有生产者写入的 `budgetLineage`：固定 source/task/originalSpecHash、整个已保留前缀的 predecessorHash、继承计数和本地增量。宿主总是累加经过核验的本地增量，并核对归档计数是否符合其局部或累计格式；缺项、乱序、跨作用域、重复、改标签、修改累计数均拒绝。宿主每次计费时同步保存该链路；公共验收重新读取全部导入文件，不能仅信任 gate 中的历史快照。没有可验证链路的旧格式保留为未知计费停止，须检查原生产者及原收据；禁止改写旧文件补造链路、猜计数或省略尝试。原 task、实际全部分片、定义／独立检查、父 BREAK、工程历史、原 request-size 失败、逐次已结算的只读调用与全部累计计费保持。任何提交、未知写入、工具失败、未结算调用、来源漂移或仍存活的原进程均拒绝重建，不重试。

`run` 在原 `consumer-review/engineering/host-recovery/host` 下创建唯一宿主声明，取得原 canonical locks，强制独立源码复核、类型检查和固定回归，并封存源码指纹、审查结果及全部命令收据。完成后才发出进程内单次执行凭证；直接调用 worker、伪造对象或传空回调不能绕过。`WORKER` 期间仅该有效凭证可以登记和核验中间记录，每次都检查原所有权、期限及门禁；公共验收和不持凭证的重复登记必须等待宿主最终完成。worker 返回后，宿主自行检查全部阶段、真实台账、会话和当前门禁，写入绑定 gate、全部记录哈希及 worker 状态的 `completion.json`，再以该收据哈希发布 DONE。回调返回成功、仅有 worker DONE、宿主 WORKER／BREAK、缺失或损坏的最终收据均没有公共权限；异常保留现场，不重发凭证。期限内完成的历史收据可在期限后验证，未完成的宿主不能用旧时间戳冒充完成。保留原截止时间以及工程最多 2 轮、24 命令的限制；过期、预算不足、审查／测试失败、源码／收据／所有权变化均停，不延长期限、不重新生成宿主声明。每次模型请求前再次检查门禁，截止信号中断在途请求。恢复重新读取同一阶段的完整证据，继承其原调用／载荷字节，上限不变；原阶段已支付 5/24 次时最多剩 19 次。后续只执行原来未消费的独立检查和分片；负面或耗尽时保留新会话和原失败，不换目录、分片、ID、预算或会话再次启动。

每个阶段在首次付费调用前计算完整必读证据、实际待验收提案、系统提示和工具 schema 的准入下界；无法容纳则保存拒绝收据，零模型调用停止。实际每次请求仍按原 512000 字节、24 次、12288000 总载荷字节门禁计费。v3 在整个请求的 JSON 数据通道使用 `lossless-json-context/v1`：仅共享完全相同的值，字典与所有引用在同一请求内，保留全部分片 refs、原读取契约的消费者字段、来源及判定；不依赖摘要或外部缓存。既有 roster 机械来源清单的 hash/count 视图沿用原契约，原始完整清单仍在冻结 inventory 中，未新增字段省略。保留标签数组会转义并做逐值往返验证，assistant/tool-call/provider continuation 原样保留，原会话不改写。公共验收从封存的原始请求重新编码并逐条核对真实载荷及预算；脱敏 trace 的字节长度不是实际计费字节。任意额外推理或读取仍受实际请求门禁约束，不能把准入下界当成必定成功的承诺。

提交定义／消费者提案前，宿主还计算该实际输出连同全部必读证据的独立复核准入。超过原限额时保存原提交和 `next-context-plan` 拒绝收据，不登记部分结果、不启动已知无法容纳的复核；明确 host-stop 后代码阻止下一次模型请求。成功检查点同时绑定这份后续准入收据。

消费者工具仅发现当前冻结分片的 `items[].ref`。ID/ref 错误在相同 collection 下 `offset=0` 发现并复制精确字段，只允许一次更正。其余分片保持原清单和单独验收。定义及独立审查的负面门禁不变，恢复成功不授权上游写入、原审查 grant 续期、父编译恢复或认证。真实链路回归使用合成 provider 和既有历史 fixture，运行真实 Pi 工具、源文锚点、预算、trace、恢复检查、会话封存和台账验收；不替换核心验收器。包括 48 项超字节案例、536 项／12 原分片完整检查、5 次原计费继承和剩余额度耗尽、过期或失败的宿主门禁，以及会话／检查点篡改拒绝。

`test/prerequisite-supervisor.test.ts` 中四项 OS 隔离测试由 `NWH_TEST_READONLY_SANDBOX=1` 显式开启，需要 Linux namespace、bubblewrap 和本地 Codex 可执行文件；它们只运行本地进程及 `command/exec`，不创建模型会话。补跑命令为 `NWH_TEST_READONLY_SANDBOX=1 pnpm exec vitest run test/prerequisite-supervisor.test.ts`。宿主外的真实 OS 测试与恢复宿主内部固定回归须分别报告：恢复宿主的全盘只读、能力移除策略会限制嵌套 namespace，并禁止 Codex 初始化其状态目录；不能将这些环境失败算作通过、关闭开关掩盖失败，或为嵌套测试放宽原证据写保护。外部补跑不替代恢复宿主的审查、预算和执行凭证门禁。

### 身份消费者的固定 payloadHash 发现

消费者审查的 `bindings[].payloadHash` 由宿主对完整 `JSON.parse(frozenScope.operations[].payloadJson)` 做 canonical hash；模型不能自行猜算，也不能用 `revisionHash` 或 operation ID 替代。`read_identity_dependencies` 在消费者阶段、`collection=dependencies` 的发现及完整读取结果中提供 `operationPayloadHashes[].slot` 和 `.payloadHash`。缺少值时用同一工具、同一 collection、`offset=0` 发现，按 slot 复制精确字段，最多一次实质更正；host/consumed 错误仍停止。独立定义阶段不暴露这些哈希或冻结操作，消费者读取仍限于原分片。

这些字段是只读派生元数据，不改原 input、intent、冻结 payload 或历史哈希。完整证据预检与实际工具返回计入相同字段和字节。若会话已因未提交而封存失败，补齐字段不授权重新派发、复用旧源码审查 PASS 或刷新预算；保留实际失败和全部已付调用，按新的停止状态处理宿主审查。

## 编译收尾交接：plan 与 closure

已收敛上游计划的交接使用现有 `requirements evaluate-upstream --source <id>`。
这个入口只重验既有独立要求，不重开 Pi staging，也不必先通过全书 `repair`
阶段。完整 `compile-novel requirements` 仍保留其全局门禁；局部评估成功不代表
角色问题已解决或父监督器可以恢复。

Web 在修复／交付阶段的“继续编译”使用同一 `compileNovelWithLoop` 入口，沿用
原 source、监督策略、Pi 预算、回执和失败历史，继续到原有评估／认证／激活
阶段。Web 的单批操作也不能越过已保留的 `BREAK`。遇到该状态先读取同来源的
`compile-novel plan/status`，解决原 `resumeCondition` 后由宿主按既有精确状态哈希
恢复协议处理；按钮和新请求 ID 均不续 grant，不原样重试。发布审计已为
`not-ready` 时显示阻塞，不能因尚无闭合评估而显示未知。
监督编译保留自己的 Pi trace 与预算；Web operation 不额外创建一个持续 running
的 `prepare` trace，以免恢复检查把界面操作误判为尚未结算的模型调用。

`nwh compile-novel plan --source <id>` 是只读发现入口；不启动模型、工程监督器、迁移、认证或激活。未知 source 时运行 `nwh status --json`，复制 `sources[].sourceId`，最多纠正一次；不要猜 ID 或原样循环。输出 `sources[].handoff.tasks` 的 `command` 与 `resumeCondition` 必须一起读取；命令可发现不代表其写权限已获批准。

`COMPILATION_PREREQUISITES_BLOCKED` 保留原始角色／身份停止条件。身份任务仍使用 `requirements inspect-identity-repairs` 的同 source/task：复制 `items[].ref`（或 `availableRefs[]`）到 `--ref`，至多一次实质纠正。只读检查不能重开已消费阶段。额外消费者修复需要原有窄类型、独立要求、准确计划与验收；证据不足、类型不支持或原授权耗尽时停止对应工作，不续 grant、不轮换任务 ID、不恢复父编译。

`COMPILATION_CLOSURE_BLOCKED` 的完整检查保存在原运行 `closure.gates`，计划入口也返回这份历史快照。按每项 `owner`、`refs` 与诊断处理原 requirement／repair scope，然后重新执行 `compile-novel closure`。旧快照、检查点计数、零 proposal obligations 或归档成功都不能替代新检查。闭合阶段本身不调用模型；不得把这个阶段的重新检查解释为重试原模型失败的许可。锁不归当前进程时使用正式阶段入口并先检查 `compiler-lock inspect`；不得并发执行或删锁绕过。

交接命令中的绝对 `--root` 与 `--source` 必须一起保留，不能因当前目录不同而切换原任务范围。已评估上游计划的负面结果仍需检查同 source 的 `requirements inspect-upstream`，读取 `plans[].evaluation.result.result.requirements`；`UPSTREAM_REPAIR_EVALUATION_STALE` 或 `UPSTREAM_REPAIR_EVALUATION_UNVERIFIED` 要求先解决具体输入／存储条件，再通过原 `requirements` 阶段重验。发现结果不能授权重新 staging 已消费计划，闭合检查也不会刷新其评估或预算。


### 原身份消费者 finding 的修复方案与独立复核

`nwh requirements review-identity-repair --source <id> --task <hash> --ref <ref> --authorization-ref <ref>` 用于用户已授权的原 `additional-repair-required` finding。它复用原独立要求，运行两个独立的 Pi 只读会话，追加 `identity-consumer-repair` 记录；不创建要求定义、验收标准、上游写入许可或父编译恢复许可。`supported` 的能力缺口表示实现仍缺失，不能据此激活世界。

任务或引用不匹配时，先在同一 source 调用 `requirements inspect-identity-repairs`，复制 `tasks[].taskId` 到 `--task`，再复制原任务 `items[].ref` 到 `--ref`，最多纠正一次；不得猜 ID、换 task/finding、重开旧消费者阶段或更改原失败文件。该入口不执行已退役的 context-recovery adapter，也不移除 `contextRecoveryAttempt`。

两个阶段继承原预算文件的完整 lineage；同一阶段只按实际增量累计失败与恢复调用，保留原预算哈希和逐阶段上限。缺祖先、分叉、计数下降、来源/基线/要求前缀漂移、未结算 trace 或已消费 invocation 都必须停止，不能重置预算、缩小消费者分母或更换阶段名重试。

模型工具仍为 `read_identity_source`、`read_identity_dependencies`、`submit_identity_requirements`。此入口的依赖读取没有 collection 参数：在同一任务以 `offset=0` 发现，复制 `items[].ref` 到 `refs` 获取完整基线与精确引用指针；源码读取复制 `segments[].id` 到 `segmentIds`。必须先取得完整读取结果，再单独提交。格式/发现错误最多一次实质纠正；来源、宿主、预算、消费状态或混合读取/提交错误禁止重试。

实体已有修订只支持注册字段的精确差异；`id`、`kind`、能力配置、创建、合并、删除、重绑均不在该写入范围。`identityConsumption` 的 `unresolved/quarantined` 标记绑定当前未决身份决议的完整修订哈希、原提及及完整继任链。它保留历史实体，不授予确定身份；实体直接引用、状态读写、事件/知识/机制间接引用、角色入口、目标和名册消费必须检查该标记。名称或别名修订不能替代隔离语义。

`requirements execute-identity-repair` 复用同 source/task/ref/authorization-ref 的原 finding 与两个独立 Pi 修复能力记录。宿主冻结窄类型计划：原身份决议槽位及唯一实体 `/identityConsumption` 修订。按依赖顺序由 Pi 提交；实体保留宿主验证的历史证据和原精确绑定，决议哈希复制 `read_upstream_repair_context` 的 `stagedDependencies[].payloadHash`，提及和链路复制其完整 `payload`。ID 失配先用同作用域 `read_upstream_repair_context`，复制 `readable[].id` 或 `stagedDependencies[].payload.id`，证据复制 `evidence[].segmentId`，最多一次实质纠正；宿主、已消费、预算、来源或作用域失败必须停止，不原样重试。

实际暂存图由另一独立 Pi 会话按原要求验收。`read_identity_upstream_acceptance` 的 `segmentIds=[]` 返回 `segments[].id`；复制到 `segmentIds` 读取完整原文，之后单独调用 `submit_identity_upstream_acceptance`。此验收只允许原要求 ID，不授权下游消费、原关键问题结算或父编译恢复。负面验收保留，不补造支持结论。

逐阶段调用和实际载荷计费继承原失败及方案复核预算；完整 Pi 会话、实时消息、实际请求日志和检查点分别保存并核对。恢复读取原单次 invocation、已封存检查点、暂存尝试和回执，不能重新请求已完成的模型阶段。缺少完整检查点或存在未结算 trace 时保留原状态并检查原拥有者，禁止自动重开。宿主失败状态写入历史，累计计费不归零。上游暂存仍经过原字段与证据校验、原尝试预算、冻结完成回执和确定性收敛；世界提案在完成回执后仍须收敛，不能把检查点当作实体提交或编译完成。

修订后 `inspect-identity-repairs` 分别显示原 finding 基线与当前实体/修复状态，不用新目录覆盖旧上下文。全部原消费者分片、来源页、候选名单、关键问题及其失败记录仍需按原验收重验；本地隔离修复收敛不能代替全局闭合、可执行认证或激活。

已完成原 finish 回执之后的宿主收敛检查失败，通过同一执行入口恢复：宿主必须持有编译锁，核对原已完成回执、全部已结算 Pi 会话、原精确提案及独立验收，再重验当前修订和证据绑定。仅同一回执中接受的证据断言可作为修复输出；其他目录漂移仍阻塞。成功时追加带 `recoveredStopRef` 的收敛记录，旧 `needs-host-review` 与 BREAK 文件原样保留。没有完成回执、调用未结算、提案/证据变更或复核不支持时禁止恢复；此路径不开放暂存、不续模型额度，也不恢复父编译。

`requirements evaluate-upstream` 对身份、来源表示和 proposal obligation 的局部后置条件保留完整当前快照；下游初始世界因隔离身份而不可执行时，局部要求可单独记录结果，原无效消费者仍以 `SOURCE_ISOLATED_BASELINE_INVALID` 阻塞。它不删除该消费者、不把隔离实体改成可玩角色，也不绕过候选归档、可执行场景／角色验收、认证或激活的有效基线门禁。先读取同 source/task 的 `inspect-identity-repairs --ref` 中原消费者及其精确引用，满足其既有修复条件后再重验；不能原样重复已完成的实体修复或用局部 `satisfied` 恢复父编译。快照的来源、证据、暂存或账本无法验证时仍停止，不记成功结果。

### 完成实体修复后的原消费者重验

`requirements revalidate-identity-consumer --source <id> --task <hash> --ref <ref> --authorization-ref <ref>`
仅用于已有用户授权、原任务的实体修复已独立验收并完成收敛之后。先用同来源的
`inspect-identity-repairs` 复制 `tasks[].taskId`，再从同任务复制 `availableRefs[]` 到
`--ref`；ID/ref 失配只允许一次发现后的更正。它追加原消费者重验及独立复核记录，
原 536 项等清单分母由保存的任务决定，不能从成功的对象反推。旧分片、关键问题、
负面审计和已消费阶段保持不变；局部通过不授予父流程恢复或认证。

新阶段必须绑定实际已完成的上游回执、原要求定义和原消费者修订，并继承原预算
与失败调用的累计消耗。每阶段沿用身份审查的请求/总载荷/调用门禁。旧 invocation
不能重放；完整 Pi 会话、实际请求、消息观察及封存检查点可验证时，仅恢复其原
提交的宿主登记，零新增模型调用。不存在完整检查点、依赖漂移、未结算 trace、
预算耗尽或负面复核时停止，不更名、不缩小分母、不清失败。

`entry/<actorId>/<eventId>` 是当前 canonical event 与有效 event-execution 的
只读投影，不是独立存储工件。重验按同一事件执行投影规则定位入口，核对事件及
执行绑定的活动修订哈希；已退休绑定不参与投影。缺失当前事件／入口、修订不符、
角色错配或重复绑定均保留停止，不能退回冻结的旧入口。先在同 source/task 的
`inspect-identity-repairs --ref` 检查原对象及其拥有者，解决实际版本条件后才续行。
定位修复不重新派发已消费阶段，不放宽独立复核、完整消费者分母或父编译门禁。

Pi 的 `read_consumer_revalidation` 在同一 scope 内通过 `collection=source`
或 `artifacts`、`offset=0` 发现：分别复制 `items[].id` 到 `segmentIds`、
`items[].ref` 到 `refs`，分页只复制 `nextOffset`。`collection=consumer` 复制
`scope.ref` 到 `refs` 读取原对象和当前版本。发现不是完整证据读取。
`source` 发现支持 `query` 按原文字面搜索，`artifacts` 按准确 ID/kind 搜索；
分页保持同一 collection/query。`query` 不与 `segmentIds` 或 `refs` 混用，
也不用于 `consumer`。搜索结果只提供导航 ID，须另行完整读取后才能提交。
新增发现能力不重开已耗尽纠错次数的原会话，也不使历史失败成为成功。
`submit_consumer_revalidation` 必须在完整读取后作为单独一次调用提交；格式或
发现错误最多一次实质纠正，host/scope/consumed/budget 错误禁止重试。

初始世界上游修复使用既有 `initial-world` 单例的 `singleton` 修复引用。只允许
计划中批准的完整字段修订；不允许创建另一个初始世界、改版本或写数组子索引。
状态、知识、开场事实、观察、时间切面和投影种子的外部引用须冻结精确依赖，
仍经过原提案校验、完成回执和确定性收敛。独立审查提出的字段范围不是提交许可；
实际世界修改仍需其类型化计划、原验收及 Pi 提案，不能由会话手工填写小说内容。

`inspect-identity-repairs` 和编译状态的 `consumerRevalidation` 单独展示回执绑定的
重验进度，原分片和原消费者审查计数保持不变。`independentVerdict=supported`
只支持所记载的 disposition；若 disposition 为 `blocked`，来源审计仍依赖这项
阻塞，不能转换成通过票或重开原单次审计。`reviews[].rationale`、
`blockedRequirements`、`receiptFingerprint` 保留原条件与回执定位信息。

世界消费者必须存在精确的当前有效修订；被继任的旧决议仅作为历史证据读取，
不得以冻结的旧载荷替代缺失的当前对象。`artifacts` 返回的 `current=false`
表示历史证据，不能作为新修复的当前依赖。来源页、候选和待审清单仍由原来源
审计负责；对此类 ref 不调度世界消费者重验，回到同任务的 `sourceReviewCoverage`
检查原阻塞，不能缩小分母、另起审计或原样重试。

### 身份不确定与局部主体能力的源码纠正

`identityConsumption.mode=quarantined` 继续禁止世界消费。`source-local` 表示经原文
及独立复核支持的局部人物指称，`status` 仍为 `unresolved`，`referentScope` 必须
保留 `crossIdentity=unresolved` 与 `distinctness=unasserted`。稳定 ID 不证明其与
具名人物相同，也不证明其与全部其他人物不同。局部提及必须锚定同一来源位置；
梦境、画像、传闻不能仅靠此模式获得现实身体。原身体／通道、知识、时间和证据
检查全部保留；模式及作用域仍通过既有精确证据断言和类型化提案验收。

对原消费者重验因旧代码只能表达“全隔离”而阻塞的情况，同一命令可带
`--compiler-correction source-local-referent/v1`。宿主绑定原两份负面记录、源码
契约哈希和原任务，不修改旧 invocation 或结论。此纠正键固定，只能继续一次，
不能靠修改代码哈希、更换授权文字或重命名生成新机会。两阶段分别扣除原阶段
已用调用和载荷后使用剩余额度，累计费用继承全部旧调用；无余量时停止。

Pi 必须重读原证据、原条件和原负面结论，判断缺的是来源证据还是表达能力。
只有独立支持的具体修复范围才能进入后续类型化执行；该纠正本身不清关键问题、
不改变完整消费者分母、不恢复原来源审计或父编译。未知策略、缺前驱、源码契约
漂移、预算变动或已消费调用均停止，检查同 source/task/ref 的原记录，不自动重试。

`read_consumer_revalidation` 的工件读取兼容同一精确 `kind:id` 与 `kind/id`，不猜测
别名。优先复制输入的 `artifactReadRefs[].ref`；缺失时使用同 scope 的
`collection=artifacts, query=<精确已知 ID 或 kind>, offset=0`，复制返回的
`items[].ref` 后只纠正一次。空结果应停止，不能遍历整个目录猜身份。

没有终结提交的失败不会产生语义审查记录。只读状态在 `consumerRevalidation.attempts`
保留其 `BREAK`、失败原因、原调用是否已消费、检查点、累计用量和各原阶段余量；
`reviews` 中旧负面结论及原审查计数不变。纠正未完成不能被解读为新的“原文不足”
结论；剩余额度本身也不能重开已消费且没有封存提交的调用。

### 消费者重验未提交失败的受控续接

宿主明确获准恢复后，在原 `requirements revalidate-identity-consumer` 命令、相同
source/task/ref、授权引用及编译纠正策略下，先使用 `--resume-unsubmitted inspect`。
该入口只读，不创建锁、不改状态、不调用模型。它验证原 Pi 完整会话、逐次实际
请求与消息观察、失败 trace、来源和要求输入，以及真实调用／载荷累计。
只有已结束、从未尝试终结提交的只读失败可进入此协议；已有提交须恢复原登记，
会话缺失、预算硬停、作用域漂移、未结束 trace 或已用完纠错机会均停止。

`--resume-unsubmitted run` 为同一原阶段保留唯一的 `.continuation` 目录及不可变
`continuation.json`。原 invocation、会话、请求、错误、预算不改写。新 Pi 会话须
重新读取原必读来源／消费者，并补读原失败请求中尚未完成的精确工件；历史发现
和读取不冒充新会话读取。原工具错误次数继续计入有界纠错，不续发纠错次数。
原要求、分母、来源边界、独立检查与验收规则不变，两个阶段不得互借额度。

新段只能使用该阶段减去原失败实际用量后的剩余额度。读取之后的单独提交至少
需要两次模型调用；这是启动下限，不是完成保证。余量不足时记录 `budget-blocked`
预检，父状态保持 `BREAK`，不创建模型 invocation、不消耗最后额度、不重置预算。
状态的 `consumerRevalidation.attempts[].stages[].continuation` 分开展示旧失败、
续接预检、续接检查点和用量；累计计算两段的全部实际消耗。

续接段自身也只有一次 invocation；其失败且无检查点时不得再开第二段。完整提交
之后若宿主登记中断，只恢复同一封存结果，零新增模型调用。续接记录必须绑定
原失败证明，独立检查仍使用另一 Pi 会话；任何阶段通过均不直接恢复来源审计或
父编译，也不自动认证或激活小说世界。

若该预检因调用余量不足而阻塞，且用户后来明确授权追加预算，宿主可在同一命令
增加 `--continuation-budget <JSON 文件>`；先配合 `--resume-unsubmitted inspect`
只读预检，随后 `run`。JSON 仅含从预检复制的 `continuationHash`、`stage`、
`additionalCalls`（1–12）以及这次后续授权的 `authorizationRef`。原命令的授权
引用保持不变，不得用旧授权冒充追加许可。追加记录不是新的需求或验收标准。

单一不可变 `budget-amendment.json` 绑定原续接证明，只增加本阶段调用上限，
不增加字节额度、不挪用独立检查额度，不改旧 `continuation.json`、`preflight.json`
或预算。新调用、模型输入、预算和审查记录均绑定追加记录哈希。状态同时显示原
余量、追加额度与两段累计用量。仅在续接尚未启动时允许追加；已经启动、授权或
哈希不符、已有另一追加记录时停止，检查原续接目录，不换 ID、不追补许可、不重试。
完整提交后的登记恢复仍不调用模型，也不获得第二段执行机会。

`entityRepair.ref` 同样接受发现结果中的精确 `entity:id` 与旧 `entity/id`，二者须
匹配原完成回执中的同一实体 ID 和修订哈希；不猜别名、不改写 Pi 原始提案。
若唯一续接的终结提交只因宿主旧版斜杠校验被拒，使用同一命令的
`--resume-unsubmitted inspect --recover-submitted-ref` 只读检查。仅允许原诊断、
唯一独立提交、全部成功的完整读取、相同来源／要求、实际会话三方证据和旧用量
均吻合，且完整原提交通过当前全部校验的情况。其他失败停止，不适用此恢复。

通过预检后 `--resume-unsubmitted run --recover-submitted-ref` 以零新增提案模型调用
保留单一 `consumer-revalidation.ref-recovery.json`，登记未经改写的原 Pi 提案。
它不伪造成功工具回执：原失败 trace、消息、预算、错误均保留，记录显式绑定
`refRecoveryHash` 而非成功会话检查点。随后仍由原独立 Pi 检查阶段判断该提案。
恢复证明、原提案或任何读取证据漂移时停止；不得借此重开失败会话或跳过独立验收。

已获独立 `supported` 的 `repair-required` 联合范围，可通过原
`requirements execute-identity-repair --revalidation-id <id> --inspect` 查看类型化
计划与继承预算；复制同 source/task 的 `consumerRevalidation.reviews[].id` 和
原 `ref`，授权引用仍须一致。去掉 `--inspect` 后才进入 Pi 执行。计划由原审查
记录确定，只修订既有实体的 `/identityConsumption` 和原初始世界单例的精确字段，
不创建实体或身份决议。先暂存实体，再在其精确暂存依赖下修订单例，最后用另一
Pi 会话对联合图按原要求独立验收，并经过原 finish／convergence。

已退休的决议仅由原完成回执恢复为只读证据，不标作当前有效决议。完整目录基线
由原冻结目录及前次完成回执重建，不能把无关变动重新冻结为合法基线。新的执行
段继承所有旧阶段、续接、格式误拒及检查用量，沿用现有槽位和独立验收上限；
任何范围、来源、精确回执、目录、预算、暂存图或独立验收不符都停止，保留原
错误，不猜 ID、不重开调用、不改写已消费授权。局部修复完成仍不替代消费者和
原来源审计重验，也不直接恢复父编译或认证世界。

联合修复沿用修复账本的前驱协议：在完整预检通过后，以原独立重验和完成回执
记录旧计划被后续修复接替的原因，显式关联同一前驱计划；原完成及评估记录
保持不变。若中断只发生在前驱停记与新计划登记之间，仅允许相同原因和相同
计划继续登记。其他宿主停止原因不得绕过。退休决议仍保留为审计依赖，收敛
结果只列当前有效决议，不能把历史决议重新标作有效。

隔离类型化槽位须传递原工具的完整 `promptGuidelines`。初始世界的事实、即时情境
和角色观察要求精确到 `summary` 的证据绑定；引用其父对象不能替代字段绑定。
该规则是现有校验的说明，不降低证据要求，也不自动改写模型的选择器。内层工具
已返回 `retryable=false` 或修复账本已停止时，外层不得重新包装成可重试错误；
保留原诊断并阻止后续模型请求。检查入口返回最近失败的 `attemptRef`、完整诊断
和只读宿主复核命令；补充工具说明不会刷新已消费槽位或原纠正上限。

若最新初始世界槽位已结算失败，且原诊断仅为 `MISSING_OPENING_FIELD_EVIDENCE`，
先在同 source/task 的 `inspect-identity-repairs` 中复制
`typedRepairs[].lastFailure.attemptRef`。原 `execute-identity-repair` 可带
`--correct-failed-attempt <ref> --correction-authorization-ref <已有明确授权引用>`
和 `--inspect` 做只读预检。首次执行须有明确的一次额外有界纠正授权；旧槽位的
4 次上限、已用调用、失败、原计划和提案 ID 均不变。ID 不符最多按发现值纠正
一次；其他失败、进行中会话、已开始验收、范围变化或预算漂移停止，不适用此入口。

去掉 `--inspect` 后先保留 `correction.intent.json`，额外 Pi 纠正阶段最多 4 次
调用、单次 512000 请求字节、累计 2048000 请求字节；这些是调用／字节限制，
不是 tokenizer 估算。用量累加到原失败之后，并传给原独立验收及后续消费者。
`read_identity_upstream_correction` 一次完整返回原上下文，精确复制
`failedProposal.proposal_id`、`context.readable[].id`、
`context.stagedDependencies[].payload.id` 和 `context.evidence[].segmentId`，
不得猜测或重复发送完整上下文来消耗额度。`submit_identity_upstream_correction`
只能在完整读取后的单独响应提交一次，只改原提案的 `evidence_selectors`；
payload、来源与提案 ID 均保留。该工具只保留 Pi 草稿，任一错误均停止，不另开
会话、不更名、不重复提交。原文不足时保持阻塞，不编造证据。

真实 Pi 会话、完整读取、请求用量和终结回执封存后，宿主才把原样草稿交给已有
`authorizeHostCorrection` 与常规 staging 校验。它显式关联原失败会话和新的
只读 Pi 证明，不伪造成功的模型 staging reservation。中断只恢复同一证明、
宿主授权或精确已预留输入，不能重放 Pi。失败的宿主校验保留完整诊断并停止。
已暂存实体保持原样，联合图仍须由独立 Pi 按原要求验收，再进入原 finish 和
convergence；该局部恢复不代替消费者重验、原来源审计或整体认证。

后续独立验收前先运行与 finish 相同的只读 canonical commit preview，保留绑定
暂存图的诊断，不消费 Pi 验收调用、不提交世界。该预检通过仍不能替代语义验收。
`INACTIONABLE_INITIAL_WORLD` 沿用原多角色来源的可执行开场条件：在场角色须有
有证据的地点、计划或动态状态；读者上下文、观察文字和 `alive=true` 不能代替。
不得因局部身份要求已获 supported 就删除这道门禁。finish 已冻结后失败时，
`typedRepairs[].currentStop` 返回当前停止记录与原 finish intent；旧
`lastFailure` 继续保留原槽位错误。不能误走已完成回执的 convergence recovery，
也不能重复 evidence-only 纠正；需要按原 pre-receipt finish revision 协议由
Pi 提出所需语义修订，并对变化后的图重新独立验收，保留旧提案与旧验收。

该恢复通过原 `execute-identity-repair` 的
`--revise-failed-finish <typedRepairs[].currentStop.recordRef>` 与
`--revision-authorization-ref <明确修复授权引用>` 进入；同 source/task/ref、
原 authorization-ref 和 revalidation-id 必须完全一致。先带 `--inspect` 只读
验证；ID 不符只允许从同作用域发现结果纠正一次。范围变更、未结算 I/O、已有
prepared/completed finish 回执、已消费修订或任何修订失败均停止，不猜测、不
换授权、不原样重试，也不与 evidence-only 纠正入口合并。

`read_identity_finish_revision` 完整返回原失败图、精确可读依赖、原文和可写字段。
复制 `intent.proposalId` 与 `source[].segmentId`，不自行生成 ID。
`submit_identity_finish_revision` 在完整读取后的独立响应中提交一次完整
`propose_initial_world` 输入；只允许原单例范围的实质 payload 修订，不能仅换
证据、保留同一失败内容或写入宿主猜测的地点、计划、动态状态。工具仅封存草稿，
任何错误都停止。一次额外草稿阶段最多 4 次调用、单次 512000 请求字节、累计
2048000 请求字节；失败也计入原累计用量，不能重置原槽位额度。

宿主验证真实 Pi 会话、原文字节、精确依赖、请求预算与唯一终结提交后，复用
已有 pre-receipt finish revision 协议暂存，并运行原确定性 commit preview。
独立验收写入 `finish-revision-acceptance.*`，保留 `acceptance.*` 原文件；两次
验收合计不能超过原 24 次／12288000 请求字节上限。新验收必须使用另一会话，
绑定变化后的完整图，旧 supported 不能授权新图。只恢复同一已封存证明的宿主
中断，不重放 Pi；提交、收敛后仍由原回执绑定的消费者重验判定效果。

验证已完成的 source-local 消费者审阅时，仍核对冻结语义契约、原输入、真实
会话、来源、失败与预算链；后续代码或测试文件变化本身不使历史证据失效。
新模型调用仍要求实现哈希匹配原冻结 scope，不允许以读取历史为由续 grant。

如果草稿会话读取原文后未提交修订，失败和实际调用仍原样保留，独立验收不启动。
`inspect-identity-repairs` 的 `typedRepairs[].finishRevisionProgress` 及执行入口的
只读 `--inspect` 显示已消费阶段、实际用量和原消息文件；当前恢复类型为
`inspect-consumed-opening-revision`，不能再次提示开启同一修订。复制
`stages[].modelResponseFile` 查看原助手解释，它是诊断而非独立验收。来源或原字段
不足时保留 host-review；不重放调用、不续授权、不扩张范围或降低开局门禁。

契约升级不会自动解除以上停止。仅在用户明确授权后，可按本文开头的
Entry capability contract recovery 入口核验旧会话并登记一次契约转换；
旧修订保持 stopped，新阶段最多使用原剩余的两次调用，失败后不可再次恢复。

## Compile loop domain recovery

`COMPILE_LOOP_DOMAIN_ACTION` 保留阶段回执中的结构化领域或宿主状态停止条件。
先在同 source 的 `compile-novel plan` 复制 `tasks[].command` 并满足
`tasks[].resumeCondition`；不会仅凭错误文本启动工程代理或重复编译。不修改
旧 BREAK、事故计数和原授权；未知工程异常仍进入原工程恢复，已验证宿主补丁
仍按原独立复核协议处理。

领域修复完成后，先通过原阶段入口重新验收。明确恢复原监督停止时，监督器仅在
同一编译运行保留完整旧历史、追加对应阶段 completed 且没有后续失败的情况下
登记领域解除证据，再让编译器重新校验当前输入；不凭一句 resolution、换 run
或删掉失败历史启动工作，也不为已经解除的领域条件启动无关工程修复。
