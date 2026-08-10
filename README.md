# Novel World Harness

A local-first, Pi-backed CLI for compiling novels into verifiable executable worlds.

The goal is not to build a novel RAG chatbot. The harness starts with Claude Code-style terminal interaction and local file discovery, then grows toward a temporal, evidence-backed world model that can be replayed and safely diverged.

## Phase 0 boundary

- `nwh` opens an interactive session in the current novel workspace.
- Pi owns model/provider abstraction, streaming, tool calls, and session persistence.
- The model receives only three read-only tools: `list_files`, `search_files`, and `read_file`.
- Search prefers local `rg` and falls back to a bounded Node scanner. There are no embeddings, vector indexes, or RAG services.
- Project, source manifests, compiler jobs, metrics, and Pi sessions are files under `.novel-harness/`.
- There is no PostgreSQL, external database, shell tool, file-write tool, or world-state commit tool.
- `NOVEL.md` contains checked-in project instructions; `@path` attaches a bounded local file excerpt.

Selected source excerpts are sent to the configured model provider as conversation context. “Local-first” describes discovery, access control, and persistence—not an offline model guarantee.

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

`ingest` records a content-addressed source manifest and initial jobs under `.novel-harness/`; it does not copy the novel or upload it to a database. Production extraction, state-delta derivation, canon replay, and the full world simulator are not implemented yet.

## Architecture

```text
Novel files
  │ local list / rg search / bounded read
  ▼
Pi-backed Harness CLI
  │ typed compiler proposals
  ▼
Local compiler state (.novel-harness)
  │ evidence / entities / events / state / knowledge / causality
  ▼
World Runtime
  │ validated player, NPC, and background proposals
  ▼
Narrative renderer
```

The critical invariant is **proposal -> validate -> commit -> render**. An LLM never directly mutates world truth.

## Commands

```text
nwh [--root <path>] [--continue] [-p <prompt>]
├── init [directory]
├── doctor
├── ingest <novel>
├── status
└── play
```

See [local CLI design](docs/local-cli.md), [Pi integration](docs/pi-integration.md), [configuration](docs/configuration.md), and [world-model design](docs/design.md).
