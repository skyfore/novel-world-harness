# Configuration

The interactive TUI can start without a configuration file. Defaults are:

- workspace: current directory;
- Pi provider/model: the user's Pi selection, otherwise Pi's first available authenticated model;
- authentication: Pi `/login`, a Pi-managed credential, or an optional profile environment variable;
- source, compiler, world, and session data: the user's `~/.novel-harness/` directory;
- workspace files: read-only inputs and optional checked-in configuration/instructions.

The TUI can open without credentials. NWH directly uses Pi's native user-level
authentication, model catalog, and default model settings from `~/.pi/agent/` (or
Pi's configured agent directory). Existing Pi login and model selection therefore
work without a second NWH setup. Inside NWH, `/login` and `/model` update that same
Pi state. An explicit `--model` or configured role profile overrides the default
selection for that invocation.

`nwh init` writes only a provider-neutral project section; `llm` is optional. `init`, `doctor`, `ingest`, and `status` use `novel-harness.yaml` when present. Supply a different path with `--config`. `${NAME}` references are expanded before YAML validation; a missing referenced variable is an error.

## Pi model profiles

```yaml
version: 1

project:
  name: demo-world
  language: zh-CN
  # Only these explicitly named files become trusted workspace guidance.
  # Novel sources are never trusted by filename.
  instructions:
    - NWH.md

llm:
  defaultProfile: main
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-5
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: medium
    fast:
      provider: anthropic
      model: claude-haiku-4-5
      apiKeyEnv: ANTHROPIC_API_KEY
      thinkingLevel: low
  routing:
    controller: main
    extractor: fast
    narrator: main
```

The harness consumes these role routes (an unconfigured route inherits
`defaultProfile`):

- `controller`: guided `nwh compile` sessions;
- `extractor`: bounded `compile-source` batches;
- `narrator`: ordinary `nwh` / `nwh play` sessions and the restricted `play-world` action translator.
- `player-action`: Web player-action translation.
- `adjudicator`: Web world adjudication.
- `npc`: Web NPC reaction reasoning.
- `specialist`: Web world-response and canonical-attachment specialist calls.

Unknown routes are allowed for future adapters, but they have no effect until code asks for that role.

`project.instructions` is an explicit trust allowlist (maximum eight files and
64,000 rendered characters total). A listed file that is missing, unsafe, or
outside the workspace makes startup fail visibly; NWH never silently falls back
to a conventionally named instruction file. Real-path checks reject a registered
novel source as guidance, and ingest/source-loop entry rejects the inverse role
change, so aliases and symlinks cannot make one physical file both trusted code
guidance and untrusted evidence.

Pi owns provider transport. A custom compatible endpoint can be described without changing CLI code:

```yaml
llm:
  defaultProfile: local
  profiles:
    local:
      provider: local-openai
      model: novel-model
      baseUrl: http://127.0.0.1:8080/v1
      apiProtocol: openai-completions
      apiKeyEnv: LOCAL_LLM_API_KEY
      contextWindow: 131072
      maxTokens: 8192
  routing: {}
```

`apiKeyEnv` is optional. Omit it when using Pi-managed `/login` authentication;
when present, it must name an `*_API_KEY` variable. Secrets stay in environment
variables or the private Pi auth store and must not be committed to YAML.
NWH does not lower Pi catalog output limits. `maxTokens` is required only as
model metadata for a custom model that Pi does not already know.

## User-level local state

There is no database configuration. Current state is stored in the private user directory:

```text
$NWH_HOME/
├── sources/v1/<sha256>/{manifest.json,source.utf8}
├── prepared-novels/v1/<content-md5>/
├── sessions/<workspace-id>/
└── workspaces/v1/<workspace-id>/
    ├── project.json
    ├── sources/<content-id>.json
    └── world/v1/
        ├── compiler/batches/<source-id>.json
        ├── proposals/{pending,accepted,rejected}/
        ├── canon/
        ├── objects/
        ├── branches/
        ├── play/active.json
        ├── frontier/
        └── snapshots/
```

JSON control files use a temporary file plus atomic rename. Source manifests retain the origin label for provenance, but exact source bytes are copied once into the immutable SHA-256 material store. The origin file is no longer an authority after successful ingest.

Legacy `.novel-harness/` is excluded from normal model file discovery. A workspace file becomes trusted guidance only when its path is explicitly listed in `project.instructions`; there are no conventionally trusted filenames. Retrieved source excerpts may appear in persisted Pi transcripts, but remain untrusted evidence.

Synthetic readiness thresholds and unused runtime tuning fields are intentionally not configuration. Inventory is reported by `nwh status`; evidence and consistency are checked by `nwh audit`; semantic quality must be measured against an explicit annotated corpus.
