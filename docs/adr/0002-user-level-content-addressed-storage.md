# ADR 0002: User-level content-addressed source and world storage

- **Status:** Accepted
- **Date:** 2026-08-14
- **Scope:** Source ingest, evidence, prepared revisions, compiler state, runtime branches, and migration

## Context

Workspace-local `.novel-harness/` state made a disposable input directory the
authority for compiler progress and branch history. Prepared bundles retained
canonical artifacts but not source bytes, so cache restore, audit, and reparse
still reopened the origin file. Deleting the origin or workspace therefore
removed capabilities that users reasonably expect a completed world to retain.

File-only ingest also prevented callers from supplying exact text through stdin,
an API, or an explicit TUI content command.

## Decision

NWH stores all mutable application state below `$NWH_HOME`, defaulting to
`~/.novel-harness/`:

- exact UTF-8 source bytes are immutable objects below
  `sources/v1/<sha256>/source.utf8`;
- MD5 remains a prepared-cache lookup key, while SHA-256 remains the source
  authority and collision boundary;
- workspace compiler and runtime state lives below
  `workspaces/v1/<path-label>-<path-hash>/`;
- prepared revisions and sessions retain their user-level namespaces;
- branch objects, heads, play state, and frontiers are never shared between
  workspace worlds merely because they share source bytes.

The origin path is provenance only after ingest. Segmentation, evidence
verification, cache restore, audit, and reparse read the archived source object.
File, stdin, inline content, and TUI content all pass through the same byte-level
registration function.

On first open, an existing workspace-local `.novel-harness/` tree is copied
atomically into the user-level workspace namespace. The legacy tree is retained;
automatic migration never deletes the user's recovery copy.

## Consequences

- Ordinary NWH use no longer creates or mutates `.novel-harness/` in the current
  directory.
- A registered source and an executable world remain usable after the origin
  file—and even the original workspace directory—has been removed.
- Exact source bytes are intentionally retained in the private user store. A
  future purge command must explain that removing them disables evidence audit
  and reparse; it must not be implicit garbage collection.
- Workspace identity is currently derived from its resolved path. State can be
  reopened for a deleted directory by passing the same `--root`; a future world
  registry may add friendlier stable aliases without changing storage authority.
- The file layout remains inspectable and local; no database is introduced.
