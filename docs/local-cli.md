# Local-first CLI design

## Decision

Phase 0 is a standalone Novel World Harness CLI, not a Pi integration.

The interaction model borrows the useful terminal conventions of Claude Code while keeping the novel domain and safety boundary explicit:

- `nwh` opens an interactive session in the current directory;
- `nwh -p "..."` runs one prompt and exits;
- `nwh --continue` resumes the latest workspace-local session;
- `@path` resolves a local file before the model request;
- `/files`, `/search`, and `/read` work without a model or API key;
- `NOVEL.md` provides checked-in project instructions;
- `.novel-harness/instructions.md` provides a local override.

This is an interaction reference, not a dependency on Claude Code or its Agent SDK.

## Local retrieval boundary

The model receives no automatic dump of the workspace. It can request three read-only tools:

1. `list_files`
2. `search_files`
3. `read_file`

All three execute locally. Tool results or explicitly attached `@path` excerpts are then included in the Anthropic Messages API conversation. “Local-first” therefore means retrieval and access control happen locally; it does not mean the selected excerpts remain on-device when a model request is made.

The implementation currently enforces:

- workspace-root confinement;
- real-path checks against `..` and symbolic-link escapes;
- no traversal into `.git`, `.novel-harness`, `node_modules`, `dist`, or `coverage`;
- direct denial of common credential files such as `.env`, `.npmrc`, private keys, and certificates;
- UTF-8 text only;
- 2 MiB maximum file size;
- bounded line and character output;
- fixed-string local search with bounded results.

There is intentionally no shell, network, file-edit, database-write, MCP, gateway, or world-state commit tool in Phase 0.

## Model transport

The initial transport uses `@anthropic-ai/sdk` against the official Anthropic API. Configuration contains only:

- `provider: anthropic`
- `model`
- `apiKeyEnv`
- `maxTokens`

Custom `baseUrl`, alternate API protocols, Pi credential storage, and external tool/service connections are out of scope for this phase.

## Session policy

Sessions are stored under `.novel-harness/sessions/` with file mode `0600`. `.novel-harness/latest-session` points to the most recent session. Session state is workspace-local and excluded from file discovery. Because tool results are part of the conversation, selected source excerpts can also be present in the persisted session transcript; use `--no-save` when that is undesirable.

The transcript is useful conversational continuity, not durable world memory. Compiled evidence, entities, events, state deltas, knowledge states, and branches continue to belong in NWIR/PostgreSQL.

## Next capability gate

The next implementation step should not be a general-purpose edit or shell tool. It should be a narrow compiler proposal tool that writes a typed candidate artifact, followed by deterministic validation and an explicit commit step. This preserves the central invariant:

```text
proposal -> validate -> commit -> render
```
