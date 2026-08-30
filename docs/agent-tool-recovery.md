# Agent tool failure recovery

Model-facing tool failures are part of the agent protocol, not terminal exception strings. A failure must remain a real error for audit, circuit-breaker, and checkpoint logic, while also telling the agent how to make bounded progress.

## Contract

Every NWH tool exposed to a model is registered through `withNwhToolRecovery`. The wrapper preflights the tool schema and intercepts argument-preparation and execution failures. It preserves Pi's thrown-error behavior, so the resulting tool message still has `isError=true`, and appends a host-generated `<nwh-tool-recovery>` block with:

- the failure category and whether a retry is allowed;
- the condition that must change before retrying;
- ordered, concrete recovery steps;
- a paired read-only discovery call when one is safe and available.

The recovery block controls only tool invocation. It is not source evidence, world truth, character knowledge, or permission to widen the active source/actor/time scope.

## Required SOP by failure class

| Failure | Required next step | Retry policy |
| --- | --- | --- |
| Unknown/stale opaque `ref`, ID, or path | Name the paired `find_*`/`list_*` tool, refresh within the same active scope, and copy the exact returned field | One corrected retry; never guess an ID |
| Unknown compiler dependency | Find the source-scoped artifact, read it when exact payload matters, and distinguish `ref` from logical/domain/proposal IDs | Submit a genuinely new dependency first or retry once; preserve unresolved semantics when absent |
| Unknown actor/player opaque handle | Re-read only the current isolated prompt/options and copy an offered handle | One corrected retry; never search outside actor scope |
| Invalid JSON/schema/path/enum | Point to the first failing field and correct the smallest invalid part | One corrected retry |
| Incomplete compiler finish graph/trace | Treat the full finish diagnostic as one report; repair every listed dependency while preserving valid drafts | One retry after concrete proposal progress; an unchanged full diagnostic stops |
| Invalid page offset | Reuse the exact returned `nextOffset`, or restart at `0` | One corrected retry; never estimate offsets |
| Unknown/stale source-accounting page token or index | Refetch `find_source_accounting_units` with `status=unresolved, offset=0`, copy the exact `pageToken`/`unitIndex`, and review the complete page | One corrected retry; never guess, copy long unit IDs, or reuse a consumed page token |
| Duplicate proposal | Keep the accepted draft, or use the supported withdraw/replace workflow for a genuinely defective draft | Never create duplicate IDs just to bypass the guard |
| Single-use capture, finished batch, tool scope block | Stop calling that tool and use the accepted result/current active tools | No retry in the same turn |
| Budget/circuit breaker | Stop the tool loop and resume only through a fresh host-started turn | No retry in the same turn |
| Stale/corrupt/unsafe host state | Surface the exact diagnostic and perform the named host repair, re-ingest, or reparse | Rediscover IDs only after repair |
| Unexpected failure | Verify scope and inputs with read-only tools; change something concrete | At most one corrected retry, then stop and report |

If the same diagnostic repeats after the prescribed correction, the agent must stop. Rewording or resubmitting the same call is not recovery.

## Development pattern

Domain and storage code may throw precise errors. The model-facing registration boundary must add recovery guidance; do not convert failures into successful tool content because that breaks failure accounting.

When adding a new tool or a future `SKILL.md` workflow:

1. Register the tool through `withNwhToolRecovery`.
2. Make opaque lookup failures precise enough to identify the failed kind (`ref`, segment ID, entity ID, proposal ID, and so on).
3. Add/update the safe finder mapping in `src/agent/tool-recovery.ts`. Suggest only tools actually available in that scope.
4. State which returned field must be copied. A retrieval `ref` must never be described as a domain entity/event ID.
5. Bound the retry: one retry after a concrete correction; repeated failure stops.
6. Preserve trust and authority boundaries. Recovery cannot broaden evidence, reveal hidden actor context, activate future canon, or bypass validation/commit gates.
7. Test the failure as an agent sees it: original diagnosis, `isError` semantics, recovery category, exact next action, and repeated-failure stop rule.

Bad:

```ts
throw new Error(`Artifact ref '${ref}' was not found.`);
```

Expected agent-visible result (the domain error may remain unchanged internally):

```text
Artifact ref '…' was not found.

<nwh-tool-recovery>
{ "category": "lookup-miss", "suggestedCall": { "tool": "find_compiler_artifacts", … } }
</nwh-tool-recovery>
```

Pi skills are currently disabled by the NWH embedding. If skills are enabled later, every model-callable tool introduced by a skill follows this same contract.
