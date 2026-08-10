# Configuration

The interactive CLI can start without a configuration file. In that mode it uses:

- workspace: current directory;
- model: `ANTHROPIC_MODEL` or `claude-sonnet-5`;
- credential: `ANTHROPIC_API_KEY`;
- session storage: `.novel-harness/`.

The compiler and database commands use `novel-harness.yaml`. A different path can be supplied with `--config`.

Environment references use `${NAME}` syntax and are expanded before YAML validation. Missing references are errors.

## LLM profiles

```yaml
llm:
  defaultProfile: main
  profiles:
    main:
      provider: anthropic
      model: claude-sonnet-5
      apiKeyEnv: ANTHROPIC_API_KEY
      maxTokens: 8192
    fast:
      provider: anthropic
      model: claude-haiku-4-5
      apiKeyEnv: ANTHROPIC_API_KEY
      maxTokens: 4096
  routing:
    controller: main
    extractor: fast
    verifier: main
    narrator: main
```

Phase 0 supports the official Anthropic API only. `apiKeyEnv` is fixed to `ANTHROPIC_API_KEY` so a repository configuration cannot select an unrelated secret environment variable. Custom endpoints, alternate protocols, external tool services, and Pi-specific settings are intentionally absent.

Secrets stay in environment variables and must not be committed to YAML.

## Local workspace instructions

- `NOVEL.md`: project intent, source layout, terminology, constraints, and expected language. It is suitable for source control.
- `.novel-harness/instructions.md`: machine-local or experimental additions.

Both are loaded into the interactive system context. Novel source files themselves are not loaded until referenced or retrieved through a local tool.

## Database

```yaml
database:
  url: ${DATABASE_URL}
  poolMin: 0
  poolMax: 10
  statementTimeoutMs: 30000
```

PostgreSQL remains the authoritative store for compiled NWIR and runtime state. The interactive local file commands do not require PostgreSQL.

## Harness

- `maxLoops`: hard safety bound for one compiler run.
- `maxConcurrentWorkers`: worker concurrency cap.
- `batchSize`: default work assigned in a compiler batch.
- `checkpointEvery`: report cadence.
- `targetCoverage`: readiness thresholds.

## Runtime

- `defaultPlayerMode`: `canon-character`, `reader-possession`, or `observer`.
- `canonAttractorWeight`: weak canonical prior while divergence is low.
- `divergenceDisableCanonAt`: stop future canon guidance past this divergence.
- `snapshotEveryEvents`: branch snapshot cadence.
