# Local-first CLI design

## Decision

Phase 0 is a Novel World Harness CLI backed by Pi. Its interaction conventions deliberately resemble Claude Code:

- `nwh` opens an interactive session in the current directory;
- `nwh -p "..."` runs one prompt and exits;
- `nwh --continue` resumes the latest workspace-local Pi session;
- `@path` resolves a local file before the model request;
- `/files`, `/search`, and `/read` work without a model request;
- `NOVEL.md` provides checked-in project instructions;
- `.novel-harness/instructions.md` provides local additions.

Claude Code is an interaction reference, not a runtime dependency. Pi supplies the reusable agent loop, provider abstraction, event stream, tool protocol, and session format.

## Retrieval boundary: file search, not RAG

The model receives no automatic workspace dump and there is no embedding pipeline. It can request three read-only tools:

1. `list_files`
2. `search_files`
3. `read_file`

`search_files` invokes `rg` with fixed-string, case-insensitive, bounded options. If `rg` is absent, a safe Node scanner provides the same result shape. The usual flow is search first, then read a narrow evidence range.

Tool results and explicit `@path` excerpts are included in the configured model provider request. Local-first therefore means local discovery, policy enforcement, and persistence; it does not mean selected text stays on-device when using a remote model.

The access layer enforces:

- workspace-root and real-path confinement;
- rejection of `..` and symbolic-link escapes;
- exclusion of `.git`, `.novel-harness`, dependency, build, and coverage directories;
- denial of common credential and private-key files;
- UTF-8 text only, 2 MiB maximum file size;
- bounded line, character, and result counts;
- no shell, write, network, database, or commit tool.

## Sessions and local state

Pi transcripts are stored under `.novel-harness/sessions/` unless `--no-save` is used. Because tool results become conversation context, retrieved excerpts can be present in a transcript. `/clear` starts a new Pi session without deleting prior append-only files.

Project manifests, source indexes, compiler jobs, and metrics are also local files. These are inspectable implementation state, not model memory. They remain hidden from general model file search.

## Next capability gate

The next model-side mutation should be a narrow compiler proposal tool producing a typed candidate artifact. Deterministic code must validate it before an explicit commit:

```text
proposal -> validate -> commit -> render
```
