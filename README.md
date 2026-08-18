# Novel World Harness

A local-first, Pi-backed terminal harness for compiling novels into evidence-backed executable worlds.

The target is not a novel RAG chatbot. Source text is compiled into a canonical model; runtime branches then evolve through validated events without forcing a divergent branch back onto the book's future plot.

## Current status

The repository contains a tested, constrained end-to-end novel-player vertical slice. It is not yet evidence that arbitrary full novels compile reliably or that the runtime is a finished role-playing product.

Implemented:

- Claude Code-style TUI with a persistent transcript, streaming responses, rendered tool calls, a multiline editor, status/footer information, and bounded local `list_files`, `search_files`, and `read_file` tools;
- user-level local state under `$NWH_HOME` (default `~/.novel-harness/`), with no PostgreSQL, vector database, or RAG service;
- deterministic source registration, hashing, segmentation, and resumable compiler batches;
- Pi compiler sessions that can only create typed pending proposals;
- an explicit compiler-batch finish handshake, so failed or partial tool runs remain retryable instead of being checkpointed;
- cryptographic evidence verification before canonical or possibility acceptance;
- logical canonical IDs backed by immutable content-addressed revisions;
- event-sourced branch history pinned to immutable canonical snapshots, deterministic state projection, temporal rules, knowledge isolation, snapshots, and integrity checks;
- canonical and non-canonical possibilities, counterfactual branches, checkpoint replay, and deterministic actor-goal policies.
- a derived `prepare` workflow that guides ingest, bounded compilation, explicit review, audit, and branch creation without automatically accepting model output;
- a world-aware TUI and catalog commands (`novels`, `instances`, `characters`, `progress`, `resume`) that select a committed character and route play through an actor-scoped, capture-only model boundary before deterministic scope, knowledge, engine, and commit gates;

Still intentionally limited:

- a Pi/LLM actor reasoner connected to the CLI runtime;
- model-backed literary narration connected to `world render`;
- player actions can change the selected actor and currently owned artifacts, but broader physical/social simulation is not yet modeled;
- corpus-backed proof that model extraction is reliable across full novels and genres.

The governing invariant is:

```text
proposal -> validate -> commit -> render
```

See [ADR 0001](docs/adr/0001-world-truth-history-and-possibility-space.md) for the temporal model, [the context-injection audit](docs/context-injection-audit.md) for model data/tool/authority boundaries, and [implementation status](docs/implementation-status.md) for the detailed completion assessment.

## Install

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
```

Node 22.19 or newer is required.

## Local terminal assistant

```bash
pnpm dev
```

No API key is required to open the TUI. To use an existing provider subscription,
authenticate and select a model inside the session:

```text
/login
/model
```

Pi supports subscription sign-in for ChatGPT Plus/Pro (Codex), Claude Pro/Max,
and GitHub Copilot. `/model` switches models but does not authenticate a provider,
so run `/login` first. NWH reuses Pi's native authentication, model catalog, and
default model selection in `~/.pi/agent/`; a user who has already configured Pi
does not need to authenticate again. An explicit `--model` or configured role
profile overrides Pi's default for that invocation. NWH conversations, archived
source material, compiler state, and executable world data are stored under
`~/.novel-harness/`; ordinary runs do not create `.novel-harness/` in the project.

API keys remain supported as an alternative:

```bash
export ANTHROPIC_API_KEY=your_key
pnpm dev
nwh novels
nwh instances
nwh characters
nwh resume main --character 曹操
nwh continue huozhe.txt
nwh switch huozhe.txt
nwh create huozhe.txt
pnpm dev --new-session
pnpm dev --session <session-id>
pnpm dev --root ./my-novel
pnpm dev --tui-mode fullscreen
```

Paste or drag a standalone UTF-8 novel path (`.txt`, `.text`, `.novel`, `.md`, or
`.markdown`) into the TUI to begin the compiler workflow immediately. NWH
registers the source, builds bounded evidence segments,
dynamically enables the typed pending-proposal tools, and processes the first
compiler batch without first exploring the repository or explaining the CLI:

```text
'/absolute/path/to/novel.txt'
/compile-next
```

Each successful batch is checkpointed under `$NWH_HOME/workspaces/v1/`. `/compile-next`
continues the active novel from the next unfinished batch. The loop is deliberately
one batch per user action so importing a long novel cannot silently trigger an
unbounded sequence of model requests. Generated artifacts remain pending proposals
until deterministic validation and explicit acceptance. A defective proposal can
be withdrawn to rejected history within its originating batch, and repeated
unchanged finish failures or a 40-call general compiler-tool budget trip a circuit breaker
instead of extending the Pi tool loop.
One additional final `finish_compiler_batch` call is reserved for the required
checkpoint handshake. Concurrent CLI compiler writers are rejected by a
workspace lock instead of racing proposal files.
Non-interactive compiler turns also have a ten-minute wall-clock deadline; a
timed-out turn is aborted without checkpointing and resumes from durable progress.
Batch identity is persisted on each proposal, so retrying an interrupted batch
recovers its active drafts, supplies their exact proposal IDs to the retry turn,
and can withdraw them without re-extracting duplicate logical artifacts. Ordinary
source batches leave the initial world to the dedicated opening pass. The finish handshake is host-owned:
the model reviews segment IDs but no longer has to echo an ever-growing proposal-ID list.

Run `/prepare-all [source-id] [branch-id]` inside the TUI to finish the remaining
batches in the current session, review guided acceptance choices, generate a
missing opening state, and create a playable branch. Its internal continuation
messages stay hidden from the visible transcript and carry their complete evidence
slice directly rather than depending on user-prompt hooks.

`nwh` and `nwh play` open Pi's viewport-based `fullscreen` TUI by default and continue the last transcript the interactive user opened. NWH records that selection explicitly when the TUI starts or switches sessions instead of inferring it only from JSONL modification times. On the first run after upgrading, it bootstraps the pointer from logical user/assistant/player activity and ignores title or startup metadata touches, preventing an old `main` transcript from becoming permanently sticky. A plain `--new-session` starts a blank Harness conversation: committed novels and world instances remain on disk, but no saved novel, instance, or character is attached to the new transcript. When `--new-session` accompanies an explicit player-entry command such as `resume`, `switch`, or `create`, that explicitly selected world is still opened. `/clear` has the same blank-conversation boundary and never silently re-enters the previously active character. Continuing an existing transcript—including one made entirely of player custom messages—does not inject another scene opener; a fresh transcript created by an explicit player-entry command receives one current-scene orientation because its screen has no prior context. While the main model is thinking, streaming, or waiting on a tool, an animated NWH owl and rotating context-aware status copy remain attached immediately above the editor; the indicator disappears only after the agent fully settles, is cancelled, or the session closes. Startup returns control to Pi before an optional narrator request begins, so transcript restoration and the first screen are never held behind a second model call. Opening, orientation, and post-action scenes mount the nested Pi session as one assistant stream inside Pi's native scrollable transcript; provider/model, retry, and capture-tool phases remain compact footer status instead of occupying an editor dock. Accepted prose is verified against that stream, then the same native component is committed in place as the durable scene—no second copy is mounted. Thinking and player-choice metadata persist outside parent-model context, survive transcript reload, and retain Pi's Ctrl+T behavior. A rejected underspecified attempt is removed before its one automatic retry starts. The TUI then offers 2-4 contextual next actions plus free-form input; either path enters the same restricted validation and commit pipeline. The TUI enters at the newest transcript content while keeping the editor, task status, and footer fixed; PageUp/PageDown scroll, Ctrl+Shift+Up/Down jump between prompts, and Ctrl+Shift+F searches the transcript. Pi's native Ctrl+O expands tool output, Ctrl+T toggles reasoning, and ↑/↓ browse prompt history. Foreground compiler tasks use Pi's assistant and tool components inside a focused fullscreen overlay: live thinking remains visible, completed thinking blocks collapse behind Ctrl+T, PageUp/PageDown inspect earlier task events, and new events follow the end until the user scrolls away. The first Ctrl+C clears pending input or stops the active model/scene/foreground task and displays a two-second confirmation; a second Ctrl+C in that window exits. After terminal restoration, NWH prints an exact `nwh --root ... --session ...` command for the current transcript (compiler sessions retain their compiler entry point). Fullscreen still avoids dumping the entire transcript. Use `--tui-mode regular` for terminal-native scrollback or terminal compatibility, and `-p` for non-interactive scripts and pipelines. An explicit Pi TUI preference saved through `/settings` is honored when the CLI flag is absent.

Ordinary conversation starts with read-only discovery tools. Starting a source
compiler loop adds only the narrow typed tools that can create pending proposals,
withdraw defective current-batch drafts, and finish the batch; it still cannot
commit world truth or write arbitrary files. When a saved character session exists,
the TUI resumes player mode automatically. In player mode, ordinary input bypasses
the local-file assistant and is translated in a fresh actor-scoped session that
receives committed character context only. Inside the TUI:

```text
/novels
/instances
/remove instance main
/remove analysis huozhe.txt
/remove all huozhe.txt
/characters main
/play 曹操 main
/continue huozhe.txt
/switch huozhe.txt
/create-instance huozhe.txt
/scene
/progress
/leave
/world-resume main 曹操
/files chapter
/search 赤壁
/read chapters/12.md 40:100
分析 @chapters/12.md 中曹操的错误判断
/compile-next
/prepare-all
/status
/clear
/exit
```

`/remove` is an explicitly confirmed development/debugging flow. `instance`
deletes one leaf branch and its resume state, `analysis` resets the selected
novel's evidence index, compiler artifacts, proposals, and prepared cache while
leaving its registered source and pinned instances intact, and `all` also removes
every owned instance and unregisters the novel. Immutable content-addressed
source evidence is retained in every mode; it is never silently garbage-collected.

The TUI also supports multiline editing, `↑`/`↓` prompt history, interrupt/queue shortcuts, session navigation, and expandable tool output; use `/hotkeys` for the current key map. The main agent receives a metadata-only `rename_session` tool and names a transcript after its concrete novel, character, or objective; host-known compiler/player contexts provide the same meaningful-title fallback, while an existing manual name is preserved. Long NWH operations such as `/reparse` open in a live task panel with host lifecycle events, tool calls, provider reasoning activity, and streamed model text explicitly labeled as unverified proposal commentary. `←` or `Esc` returns the task to a compact background widget without cancelling it, `/tasks` brings it back to the foreground, and the task panel's displayed cancel key propagates an abort into its nested Pi session. Completed, failed, and cancelled task output remains inspectable for the rest of the TUI session. A leading `!` is an explicit user-run shell command provided by the terminal UI. It is not exposed to the model as a tool.

Selected excerpts are sent to the configured model provider. “Local-first” describes discovery, access control, and persistence; it is not an offline-model guarantee.

Pi may also perform startup metadata checks or obtain its optional `fd` autocomplete helper. Set `PI_OFFLINE=1` to suppress those startup operations; model prompts still require the configured provider unless that provider is local.

## Prepare and enter a world

To authorize one command to compile all remaining batches, automatically accept
every proposal that passes deterministic validation, create the initial world,
and open a playable branch:

```bash
nwh prepare-all ./books/novel.txt
nwh characters
nwh resume main --character <id-or-name>
```

`prepare-all` asks focused multiple-choice questions before running all model
batches, accepting validated proposals, generating a missing opening state, and
creating the playable branch. Choose the review/pause option at any question to
retain the current durable progress. For scripts and CI, `--yes` accepts every
recommended choice without prompting:

```bash
nwh prepare-all ./books/novel.txt --yes
```

`prepare-all` never force-accepts a blocked proposal. After the user authorizes
safe convergence, invalid and staging-only drafts move to immutable rejected
history while validated artifacts continue. If the dedicated opening-state model
pass leaves no valid initial world, NWH proposes a conservative evidence-backed
opening cast and runs it through normal validation before branch creation.
The existing `prepare` flow below remains the review-first path.

```bash
nwh init ./my-novel
cd ./my-novel
nwh doctor
nwh prepare ./books/novel.txt
nwh proposals list
nwh proposals show <proposal-id>
nwh proposals accept <kind> <proposal-id>   # or: nwh proposals reject <proposal-id>
nwh audit
nwh prepare --source <source-id>
nwh status
nwh novels
nwh instances
nwh characters <source-id> --branch main
nwh resume main --character <id-or-name>
nwh continue <source-id-or-title>
nwh switch <source-id-or-title> --instance <id>
nwh create <source-id-or-title> --instance <new-id>
```

`init` is provider-neutral. Use the TUI's `/login` and `/model`, an existing workspace-local Pi authorization, or an explicit optional `llm` profile. `prepare` derives the next safe stage from durable artifacts, runs at most one unfinished compiler batch by default, and always prints `Next:`. It stops at the review barrier and never accepts model output. Once every proposal is explicitly accepted or rejected and the audit is clean, rerunning `prepare` creates the canonical-initialized branch exactly once.

`ingest` and `compile-source` remain available as lower-level commands. Ingest stores a content-addressed source manifest and deterministic evidence segments; it does not copy the novel into a database. Compiler tools can only write pending typed proposals. `proposals accept-all` remains an automation helper that revalidates dependencies and evidence, but individual `show` plus `accept`/`reject` is the recommended review path.

Ingest copies the exact UTF-8 bytes into the private immutable user material
store before compilation. The disposable origin file may then be removed. File,
stdin, inline CLI content, and TUI content use the same identity pipeline:

```bash
nwh ingest ./novel.txt
nwh ingest --stdin --title novel.txt < novel.txt
nwh ingest --content '第一章……' --title novel.txt
# TUI: /prepare-content 第一章……
```

Prepared data is explicitly revisable. A full rebuild or a bounded chapter repair
creates a new prepared revision for the same source bytes:

```bash
nwh reparse --all --source <source-id>
nwh reparse --chapters 3,7-9 --source <source-id>
nwh prepared-cache list --source <source-id>
nwh prepared-cache activate <bundle-hash> --source <source-id>
```

The same lifecycle is available without leaving the TUI. Omit flags to select
the novel, scope, chapters, or revision through the native question UI:

```text
/reparse --chapters 3,7-9 --source <source-id>
/reparse --all --source <source-id>
/audit --source <source-id>
/prepared-cache list --source <source-id>
/prepared-cache activate <bundle-hash> --source <source-id>
```

Chapter ordinals follow detected heading sections; a heading-free source uses its
deterministic evidence blocks as the selectable units. Reparse invalidates only
the selected current artifacts, retains their immutable revisions, and publishes
the result only after compilation, convergence, opening-state preparation, and
cache validation succeed. A failed run restores the previous active revision.
Activating an older revision changes the baseline used by future branches but
does not rewrite any existing branch.

For guided compiler work, `nwh compile` opens the same TUI in compiler mode and starts a small evidence-backed proposal batch. `nwh compile "<instruction>"` preserves the one-shot form.

## Execute a compiled world

```bash
nwh world create main --source <source-id> # --source is optional only when one novel is registered
nwh world show --branch main
nwh world frontier --branch main
nwh world move --branch main
nwh world history --branch main
nwh world render --branch main
```

The low-level runtime also accepts an explicit `EventProposal` JSON file:

```bash
nwh world validate ./player-action.json --branch main
nwh world move --branch main --player ./player-action.json
```

The primary natural-language path is the full TUI entered by `nwh continue [novel]`, `nwh switch [novel]`, `nwh create [novel]`, `nwh resume`, `nwh play`, or the equivalent slash commands. `continue` selects that novel's most recently played/updated instance; `switch` asks when several source-owned instances exist; `create` starts a fresh instance from the novel's active prepared revision. If a selected prepared novel has no instance, NWH creates one automatically instead of falling back to an unrelated `main`. Branch ownership and prepared-revision identity are persisted, and each genesis snapshot contains only that novel's artifacts. Existing branches remain pinned to their original prepared revision; the TUI warns when that revision is stale or its actor state is sparse instead of silently rewriting history. Scene narration follows the command's intent: `play` makes the narrator speak first for the chosen character, `create` opens a new story, and an actual `switch` establishes the selected current moment. `continue`, `resume`, and ordinary process restart add no duplicate narration. A fresh transcript opened through an explicit player-entry command gets one orientation; an unbound `--new-session` or `/clear` remains at the Harness welcome, and `/scene` explicitly re-renders a selected current moment. The narrator runs in a fresh isolated session with a bounded committed actor frame, exact read-only retrieval over that same actor-safe corpus, and one capture-only next-choice tool; it streams its actual Pi events into the current TUI, automatically revises a short/generic first draft once, and reports final model failure with direct recovery commands instead of displaying a canned pseudo-opening. Its 2-4 suggested utterances and the free-form alternative enter the restricted player-action boundary. Observation, reflection, and short waiting are host-owned empty-delta intents, so a recommended observation remains valid even in a sparse world; only such a verified-safe observation receives the recommended badge. Rendering and choice capture never advance the branch or act for the player. Long TUI selectors use Pi's native height-aware scrolling window and remain filterable, with an additional free-form id/name/alias input instead of forwarding the decision to the model; RPC clients fall back to bounded pages. Every free-form player action uses a fresh Pi session with no novel-file tools, project instructions, compiler extension, future canon, or branch-write capability. Its actor-safe corpus is bounded with exact read-only retrieval, and stable entity/claim IDs become turn-local opaque handles. The model can only capture one candidate in memory; the host decodes those handles, supplies branch/head/source/actor identity, and commits only after deterministic validation. Missing state fields remain unknown and cannot be invented as positive preconditions. While translation, validation, and scene rendering run, the TUI uses the same animated working indicator. An accepted action is then rendered by the isolated narrator from the new committed actor frame; raw commit IDs and hidden background events are not shown as narrative. Ordinary turns do not automatically commit background canon; `--advance-background` explicitly opts into temporally ordered advancement. If rendering fails, the action remains committed and `/scene` safely retries only the prose. A rejected proposal leaves the branch head unchanged, persists its diagnostic audit, and automatically returns the player to a live narration/choice loop instead of ending on an engine notice. Novel and character selection is persisted per instance, with one active pointer that ordinary `nwh` startup resumes automatically. `play-world --action` remains the compact script/legacy readline path.

Branch and integrity workflows:

```bash
nwh world fork alternate --branch main
nwh world diff main alternate
nwh world replay ./checkpoints.json --branch main --output-branch replay-main
nwh world snapshot --branch main
nwh world fsck
```

`world diff` reports state, committed-history, and actor-knowledge divergence. `world replay` always forks a new output branch (or generates one when `--output-branch` is omitted), so replay success or failure never advances the source branch.

Actor inspection remains available alongside the embodiment loop:

```bash
nwh world knowledge hero --branch main
nwh world actor hero --branch main
```

NWH does not impose a token budget, request-count ceiling, or smaller output cap
on Pi model calls. Transient provider failures use Pi's automatic retry policy;
the CLI reports retry progress and only returns a failure after retries are
exhausted.

Successful full preparation publishes an immutable reusable revision under
`$NWH_HOME/prepared-novels/v1/<content-md5>/revisions/<bundle-hash>/` (default
`~/.novel-harness/prepared-novels/`). The MD5 is the lookup key for the exact
novel bytes; SHA-256 and a canonical bundle hash are verified before reuse, so
an MD5 collision cannot select another source. Reusing the same bytes in a new
workspace restores canonical artifacts and compiler checkpoints without another
model pass. A small atomic `active.json` pointer chooses the default revision;
publishing or activating a revision never mutates an existing revision bundle.
Branch objects and branch heads are never cached: every new branch captures its
canonical data, actor policy, and possibility-template revisions and then evolves
independently from later preparation changes and from every other branch.
The exact source bytes are stored once under
`$NWH_HOME/sources/v1/<content-sha256>/source.utf8`; prepared revisions refer to
that immutable material, so audit, restore, and reparse do not reopen the origin
path.

## Architecture

```text
Novel files
  -> deterministic evidence index
  -> bounded Pi compiler batches
  -> typed pending proposals
  -> evidence + structural validation
  -> versioned content-keyed preparation revisions + active pointer
  -> revisioned canonical model / possibility templates
  -> immutable branch events and StateDelta objects
  -> WorldState(branch, t) projection
  -> possibility + actor + player proposals
  -> validate / adjudicate / commit
  -> narrative frame and renderer
```

The compiler may inspect the complete canonical trajectory. A runtime branch treats only its own committed history as truth; later canon is evidence and an evaluation reference, not an automatic schedule.

Further reading: [local CLI](docs/local-cli.md), [Pi integration](docs/pi-integration.md), [configuration](docs/configuration.md), [world-model design](docs/design.md), and [technical design](docs/technical-design.md).
