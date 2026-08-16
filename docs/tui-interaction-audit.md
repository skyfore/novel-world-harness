# Pi TUI interaction audit and repair report

This audit covers every NWH path that runs inside Pi's interactive TUI. It is
code-oriented: each finding names the control point that caused the behavior,
the user-visible failure mode, and the implemented repair.

## Runtime boundary and event order

NWH does not own the terminal event loop. `PiAgentSession.runInteractive()` in
`src/agent/pi-session.ts` creates Pi's `InteractiveMode`. Pi mounts the screen,
binds extensions, waits for `session_start`, and only then calls its own
`renderInitialMessages()`. During a model turn Pi renders `message_update`
events incrementally and persists the settled assistant message at
`message_end`. Extension slash commands are dispatched independently and can
be invoked while that main agent is still streaming.

Those details create three non-negotiable design rules for NWH:

1. `session_start` cannot await catalog scans or a nested model request.
2. A `message_end` transformer cannot replace text already shown by Pi's native
   stream.
3. Every NWH command must check compatibility with Pi's current foreground
   turn; an input hook alone cannot serialize slash commands.

The normative interaction rules are recorded separately in
`docs/tui-interaction-contract.md`.

## Findings and repairs

### 1. Compiler output appeared, then was replaced by a generic host notice

**Cause.** `createNwhExtension()` previously registered a `message_end`
handler which replaced a completed compiler assistant message with the fixed
"Model batch output ended..." text. Pi had already rendered the original
`message_update` deltas, so the final component was mutated out from under the
user. This exactly explains why useful model output appeared to vanish at the
end of a batch.

**Repair.** The transformer and its fixed terminal-text function were removed.
The native assistant message now remains byte-for-byte the content Pi settled.
Host verification remains in the `agent_settled` handler, where
`compilerBatchOutcomeFromMessages()` verifies the finish handshake and the host
emits a separate checkpoint/retry notification. Verification can no longer
overwrite model prose.

**Evidence.** `test/nwh-extension.test.ts` asserts that no NWH `message_end`
handler is registered while compiler context isolation and checkpointing still
work.

### 2. TUI startup could look frozen before the first screen was restored

**Cause.** The old `session_start` handler synchronously awaited
`inspectPlayExperience()`, then called `activatePlayer()`, which performed
another world/branch scan. Pi waits for extension binding before it restores
the transcript, so both scans were on the critical first-render path. A scene
narrator could be scheduled only after that work.

**Repair.** `session_start` now configures the UI and returns synchronously. A
zero-delay post-render job first reads the small `PlaySessionStore` pointer. If
a saved session exists, it performs one validated `activatePlayer()` pass under
a visible elapsed activity; optional narration is launched without awaiting it.
If no saved session exists, startup does not scan every branch merely to count
them. An input arriving during restoration awaits the same restoration promise,
so it cannot be misrouted to assistant mode while the saved player mode is
still loading.

**Evidence.** The restored-world test gates the narrator with deferred promises
and proves `session_start` returns before any narrator completion or persisted
narrator message.

### 3. Isolated scene models produced no foreground stream

**Cause.** Opening/orientation narration used a separate tool-free
`PiAgentSession`. Its final string was added only after `prompt()` resolved, so
Pi's main TUI had no component subscribed to the nested session's deltas. The
same gap existed after an accepted player action.

**Repair.** `createPiPlayerOpeningNarrator()` accepts a
`PlayerSceneNarrationObserver`. Pi exposes a transient assistant-stream handle
that mounts the nested session in the native scrollable transcript without
adding it to the parent model context. Provider/model, attempt, retry, and the
capture-only choice-tool lifecycle use compact footer status. Active thinking
is visible and collapses on `thinking_end`; text-start and message-end provide
fallbacks. The accepted stream is checked against the settled result, then that
same native component is committed in place as the durable `nwh-narrator`
entry. Its thinking and choice metadata persist outside parent-model context;
there is no second scene copy. A scene-validation retry disposes the rejected
attempt before the retry starts. Opening, orientation, retry, and post-commit
narration share this path; status never masquerades as prose.

**Evidence.** Narrator tests assert provider/model status and native thinking
and text events in the stream, prove that no scene widget or duplicate narrator
message is mounted, and verify that persisted narration and thinking come from
the accepted native stream.

### 3a. Restored player transcripts were mistaken for new conversations

**Cause.** Player input and narrator prose are durable `nwh-play` and
`nwh-narrator` custom messages. Freshness detection looked only for ordinary
`role=user` messages, so a long-running player-only transcript could be treated
as empty and receive another automatic scene request.

**Repair.** Startup now recognizes visible custom transcript entries and uses a
separate player-context check for automatic scene timing. `activeWorldScene`
is consumed only by the first Pi runtime, and `auto` is suppressed when the
selected actor/instance is already active. Explicit `/scene`, a new instance,
or an actual switch remain deliberate narration triggers. Scene choices are
stored with branch, actor, and commit identity; history restores them only when
that identity still matches, without requesting another narrator.

**Evidence.** Tests cover historical player-only transcripts even with an
explicit startup `auto`, repeated `/play` selection, and current-head choice
restoration with zero narrator calls.

### 3b. Narration handed agency back as an empty text box

**Cause.** The prose ended on an actionable beat but did not expose grounded
actions through the existing AskUserQuestion interaction.

**Repair.** The isolated narrator has one capture-only
`propose_player_choices` tool. It returns 2-4 immediate actor-visible
utterances, or conservative host defaults if the provider omits the tool. The
TUI presents those choices plus free-form input. Choosing an option schedules
its utterance through the same restricted translator, scope/knowledge checks,
engine validation, and commit path as typed player input.

### 4. Player action translation looked hung and could run forever

**Cause.** Natural-language action translation is intentionally structured: the
nested model must call one capture-only `propose_player_action` tool, so there
is no narrative text stream to show. Previously this invisible request had no
wall-clock timeout and no abort propagation from the TUI.

**Repair.** The action translator now has a 90-second default timeout, receives
an `AbortSignal`, and aborts its nested Pi session. The TUI displays explicit
"understanding", retry, and deterministic validation phases. Escape cancels
only while the action remains a proposal. Once the candidate crosses into
deterministic commitment, cancellation is disabled and shutdown waits for the
commit boundary to finish. `performPlayTurn()` normalizes translator failures
into a rejected result, so the extension also checks the original abort signal
after that call and reports a user cancellation rather than a misleading model
rejection.

**Evidence.** The cancellation test holds an injected translator indefinitely,
invokes `/leave`, and verifies the branch head is unchanged and the user gets an
explicit no-commit message.

### 5. Accepted actions had a diagnostic result but no world response

**Cause.** The prior flow ended after deterministic `performPlayTurn()` output.
It exposed engine-oriented commit information and did not run the scene
narrator against the new committed actor frame.

**Repair.** An accepted action reloads durable play-session state and renders a
`turn` scene from the new committed head. The narrator may dramatize only the
actor-visible result. If narration fails, NWH says the action is already
committed and directs the user to `/scene`; it never asks the player to repeat
the action. Rendering itself never changes branch truth.

### 6. Reparse streaming performed excessive work per token

**Cause.** `NwhTask.appendAgentEvent()` previously sanitized and cloned the
entire growing assistant message on every `message_update`. Reparse also updated
elapsed status for the same event stream, producing multiple renders per token.
For a growing message this approaches quadratic copied text and can make a live
stream appear to stall.

**Repair.** Assistant updates are retained as the latest pending message and
flushed at most once every 32 ms. `message_end` cancels the timer and flushes the
authoritative final message. Repeated identical task activity is deduplicated.
Pi's `AssistantMessageComponent` and `ToolExecutionComponent` still render the
actual structured output.

**Evidence.** A test submits 100 immediate update events, confirms there is no
per-token transcript revision, then confirms the final model message is flushed
exactly.

### 7. A background task had no complete lifecycle

**Cause.** `NwhTask` originally had only running/completed/failed states. It had
no cancellation signal, shutdown join, cancelled state, or durable settled
dock. Escape/Left could hide the overlay, but failure/completion removed all
task chrome.

**Repair.** Tasks now support
`running -> cancelling -> cancelled`, own an `AbortController`, and pass its
signal into the operation. Escape/Left backgrounds; the displayed Pi cancel
key is a separate action; `/tasks` restores running or settled output. A compact
completed/failed/cancelled dock remains for the TUI session. `/exit` and
`session_shutdown` cancel and await the operation before Pi resources are
disposed. Reparse propagates the signal through compilation and nested Pi
sessions; its existing rollback restores the previous prepared revision on an
interruption.

**Evidence.** Tests cover signal delivery, cancelled settlement, foreground to
background behavior, high-frequency streaming, settled inspection, and a
session shutdown that does not complete until the fake reparse observes abort.

### 8. Slash commands could conflict with a streaming model turn

**Cause.** Pi dispatches extension slash commands directly. The NWH `input`
handler's `pendingTurn` check therefore did not protect `/play`, `/scene`,
`/create-instance`, `/audit`, or other command handlers. A world selection or
mutation could begin while a foreground compiler was still proposing data.

**Repair.** `guardForegroundIdle()` centralizes compatibility checks for Pi's
`ctx.isIdle()`, NWH compiler/full-preparation state, player translation, scene
narration, and managed task state. Conflicting operations receive an immediate
message explaining whether to wait, press Escape, or open `/tasks`. Read-only
status/catalog operations may coexist with a background task, but not with a
main foreground model stream.

**Evidence.** A test invokes `/play` with `ctx.isIdle() === false`, verifies no
world/narrator action starts, and verifies the immediate streaming-conflict
message.

### 9. Host-only preflights had silent multi-second gaps

**Cause.** Source ingestion, catalog scans, preparation inspection, cache
restore, evidence audit, and reparse batch preparation all awaited filesystem
and history work before their first notification. Pi's model spinner cannot
explain host-only work.

**Repair.** `beginHostActivity()` publishes a keyed below-editor widget and
footer status before the first heavy await, updates elapsed time every second,
supports named phase transitions, and clears in `finally`. `/prepare-all` keeps
one persistent activity through inspection, cache restore, batch setup,
proposal convergence, revision publication, and branch creation. Convergence
reports every ten items instead of leaving a stale phase for fifty.

### 10. Compiler batches polluted later ordinary assistant context

**Cause.** Context slicing was active only while a compiler request was
pending. After settlement, hidden evidence boundaries, assistant output, and
tool results returned to the next ordinary assistant context. This increased
latency/token use and allowed unverified compiler commentary to influence a
different mode.

**Repair.** `filterNwhModelContext()` keeps only the current compiler boundary
during a compiler turn and removes completed compiler spans for later ordinary
turns. A source-path user message is tagged at its hidden boundary and removed
with that compiler span. The transcript remains visible for human inspection;
only model context is separated.

## Resulting command behavior

| Flow | Foreground output | Background/cancel behavior |
| --- | --- | --- |
| Ordinary assistant | Pi native assistant/thinking/tool stream | Pi Escape interrupt |
| Source batch, `/compile-next` | Pi native assistant/thinking/tool stream; final text preserved | Deliberately foreground |
| `/prepare-all` | Native model stream plus persistent named host phase | Foreground staged workflow; user may pause at barriers |
| `/reparse` | NWH task overlay using Pi assistant/tool components | Escape/Left backgrounds, `/tasks` restores, cancel signal rolls back safely |
| Player selection | Visible host phase, then scene stream when required | Escape cancels scene narration |
| Player action | Structured phase status, deterministic commit, then scene stream | Escape cancels before commit; shutdown joins a started commit |
| Catalog/audit/cache/status | Immediate host phase and elapsed time | No hidden model work |

## Verification status and residual boundary

The repair is gated by TypeScript compilation, the production build, and the
full test suite. The current suite has 61 test files and 293 passing tests.

Pi still persists foreground compiler messages in the user-visible session, by
design, so a user can inspect exactly what streamed. The new context filter
prevents those messages from reaching later models, but it does not delete them
from Pi's transcript. Pi restores transcript entries through its
compaction-aware `buildContextEntries()` path. If future profiling shows that a
very large number of retained compiler batches makes transcript restoration
itself expensive, the next architectural step is to run all multi-batch
compilation in a dedicated managed-task session and persist an inspectable task
log rather than mutating or truncating the model text at `message_end`. The old
replacement behavior must not be reintroduced as a shortcut.
