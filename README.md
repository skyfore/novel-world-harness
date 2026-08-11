# Novel World Harness

A local-first, Pi-backed CLI for compiling novels into verifiable executable worlds.

The goal is not to build a novel RAG chatbot. The harness starts with Claude Code-style terminal interaction and local file discovery, then grows toward an event-sourced, evidence-backed world model that can reconstruct its past, continue into an uncertain future, and safely diverge after counterfactual intervention.

## Phase 0 boundary

- `nwh` opens an interactive session in the current novel workspace.
- Pi owns model/provider abstraction, streaming, tool calls, and session persistence.
- The model receives only three read-only tools: `list_files`, `search_files`, and `read_file`.
- Search prefers local `rg` and falls back to a bounded Node scanner. There are no embeddings, vector indexes, or RAG services.
- Project, source manifests, compiler jobs, metrics, and Pi sessions are files under `.novel-harness/`.
- There is no PostgreSQL, external database, shell tool, file-write tool, or world-state commit tool.
- `NOVEL.md` contains checked-in project instructions; `@path` attaches a bounded local file excerpt.

Selected source excerpts are sent to the configured model provider as conversation context. “Local-first” describes discovery, access control, and persistence—not an offline model guarantee.

## World-model direction

The long-term architecture treats a novel as evidence for one canonical history, not as a fixed script that every runtime branch must follow.

The core principles are:

- **World before narrative.** Narrative is a source observation or rendering of world history, not the authority that mutates it.
- **Events before state.** Branch truth is committed event history plus deterministic state deltas; `WorldState(branch, t)` is a projection.
- **Possibility is not fact.** Future developments live in a possibility frontier until validation/adjudication commits an event.
- **Canon is evidence and an attractor, not a scheduler.** A future canonical event may disappear or transform when its preconditions no longer hold.
- **Rules may be temporal.** Engine invariants stay deterministic, while in-world laws, policies, institutions, permissions, or fictional mechanisms may change through committed events.
- **Knowledge is actor-scoped.** Compiler omniscience and future canon never leak automatically into runtime characters.
- **Proposal -> validate -> commit -> render.** LLM output never directly mutates world truth.

This distinction also separates two forms of rewrite: a narrative retelling can render the same committed history differently, while a counterfactual rewrite forks history and evolves a genuinely different world.

See [ADR 0001: World truth is committed history; the future is a possibility space](docs/adr/0001-world-truth-history-and-possibility-space.md).

## Quick start

```bash
npm install
npm run build
npm link

export ANTHROPIC_API_KEY=your_key
nwh
```

A config file is optional for interactive use. Useful forms:

```bash
nwh -p "列出这个项目里的主要人物资料"
nwh --continue
nwh --root ./my-novel
nwh play --model claude-sonnet-5
```

Inside a session:

```text
/files chapter
/search 赤壁
/read chapters/12.md 40:100
分析 @chapters/12.md 中曹操的错误判断
/status
/clear
/exit
```

## Local compiler scaffold

Create the workspace files, register a source, and inspect local state:

```bash
nwh init ./my-novel
cd ./my-novel
export ANTHROPIC_API_KEY=your_key
nwh doctor
nwh ingest ./books/three-kingdoms.txt
nwh status
```

`ingest` records a content-addressed source manifest and initial jobs under `.novel-harness/`; it does not copy the novel or upload it to a database. Production extraction, event/state reduction, dynamic-rule modeling, possibility scheduling, canon replay, and the full world simulator are not implemented yet.

## Architecture

```text
Novel files
  │ local list / rg search / bounded read
  ▼
Pi-backed Harness CLI
  │ typed compiler proposals
  ▼
Compiler validation boundary
  │ proposal -> validate -> commit
  ▼
Canonical Record + local world artifacts
  │ evidence / entities / events / rules / knowledge / causality
  ▼
Branch Runtime
  │ committed history -> WorldState(branch, t)
  │ active rules + possibility frontier
  ▼
Validated player / NPC / background events
  ▼
Narrative renderer
```

The source's complete canonical trajectory is available to the compiler for evidence and evaluation. A runtime branch only treats its own committed history as world truth; later canon is reference material, not an automatic future.

## Commands

```text
nwh [--root <path>] [--continue] [-p <prompt>]
├── init [directory]
├── doctor
├── ingest <novel>
├── status
└── play
```

See [local CLI design](docs/local-cli.md), [Pi integration](docs/pi-integration.md), [configuration](docs/configuration.md), [world-model design](docs/design.md), and the [architecture decisions](docs/adr/).
