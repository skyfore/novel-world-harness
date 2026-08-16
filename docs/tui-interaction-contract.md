# TUI interaction contract

This document is the implementation contract for every operation launched from
the Pi-based NWH TUI. It covers both model-backed work and deterministic host
work. A command is not considered interactive merely because it eventually
prints a result.

## Invariants

1. The first visible acknowledgement must be scheduled before the first
   potentially unbounded filesystem, history, cache, lock, or model await.
2. A foreground model response is rendered incrementally. The final model
   message must be the same content the user saw streaming; host verification
   may append status but must never replace model output.
3. Structured model boundaries that are not prose (for example player action
   capture) show explicit phase/retry activity. Their raw candidate JSON and
   hidden reasoning are not rendered as narrative.
4. Deterministic work lasting longer than a perceptible instant exposes its
   current phase and elapsed time. Multi-stage work records those phases in a
   foreground task transcript.
5. A backgroundable task starts in the foreground. Escape/Left backgrounds it,
   `/tasks` restores it, and cancellation is a separate explicit action.
6. Completed and failed background tasks retain an inspectable result for the
   rest of the TUI session. Session shutdown cancels and joins live nested model
   tasks before disposing the Pi host.
7. Extension commands use a centralized compatibility check because Pi executes
   slash commands even while the main agent is streaming. Read-only operations
   may coexist; conflicting compiler/world mutations may not.
8. Compiler evidence and detailed batch traffic do not become ordinary
   assistant context after the batch settles. The visible transcript may retain
   model output for inspection, but later model calls receive only the context
   appropriate to their mode.
9. Startup handlers must return before catalog scans, branch-history walks, or
   nested model calls. Restoring the saved world is post-render work with visible
   activity.
10. Cancellation semantics reflect truth: cancelling before a player commit
    leaves the world unchanged; cancelling narration after commit never rolls
    back or repeats the committed action.

## Surfaces

- Main Pi turns use Pi's native assistant, thinking, and tool components.
- Isolated scene sessions bridge Pi assistant events into a TUI-only transient
  message in Pi's native scrollable transcript. Provider/model, attempt, retry,
  and capture-tool phases use compact footer status. The accepted text is
  checked against the live stream before replacing it with a clean narrator
  message; a rejected first draft is removed before its replacement streams.
- Thinking defaults to `auto`: an active block is visible, `thinking_end`
  collapses it, text-start and message-end are fallbacks, and Pi's existing
  Ctrl+T binding expands completed blocks without an NWH key interceptor.
- Every accepted scene opens an AskUserQuestion-style next-move dialog with
  2-4 actor-scoped suggestions and a free-form action path. Suggestions are
  capture-only proposals; selection still enters the normal deterministic
  player-action validation and commit boundary.
- Managed long-running operations use the NWH task overlay for host progress,
  assistant messages, thinking, and tool calls. A compact dock remains while a
  task is in the background.
- Short host preflights use a keyed activity widget and footer status. The widget
  is cleared in `finally` on success, failure, or cancellation.

## Target command behavior

| Path | Default | Model output | Background/cancel |
| --- | --- | --- | --- |
| Ordinary assistant / one compiler batch | Foreground | Native Pi stream | Pi interrupt |
| Full preparation | Foreground staged workflow | Native stream plus host phases | May pause at decisions; no silent stage |
| Reparse | Foreground managed task | Task assistant/tool stream | Escape backgrounds; `/tasks` restores; cancel is explicit |
| Player action | Foreground | Phase activity, then narrator stream | Abort propagates to nested sessions |
| Audit, ingest, catalog, cache preflight | Foreground host activity | N/A | Clear phase and elapsed feedback |

## Verification gates

- Tests gate startup restoration behind a deferred host scan and prove
  `session_start` returns first.
- Tests preserve compiler final text and separately verify host checkpointing.
- Streaming task tests send many updates and assert rendering is coalesced.
- Tests cover foreground-to-background-to-foreground, cancellation, completion,
  and shutdown joining.
- Tests invoke conflicting slash commands while a compiler turn is active and
  require an immediate explanatory rejection.
- Player tests cover cancellation before commit and narration failure after
  commit as distinct outcomes.
- Player tests verify that historical custom transcripts do not trigger a new
  narrator, native scene deltas match the persisted prose exactly, stored
  current-head choices resume without a model call, and selected choices pass
  through the ordinary player-action translator.
