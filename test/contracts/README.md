# Native semantic contract tests

These tests import the actual dependency-free TypeScript contract modules through Node type stripping. They do not mock the world engine, initialize a workspace, read a novel, call Pi, or write world state. The `.native.mjs` suffix keeps them separate from Vitest discovery.

On the repository-supported Node version (see package.json):

```sh
pnpm test:semantic-contracts
# Equivalent, with no package installation required for these tests:
node --experimental-strip-types --test test/contracts/*.native.mjs
```

This is an additional test command; `pnpm test` retains its existing Vitest argument semantics. Before accepting changes into a release, run both suites and the repository type checks:

```sh
pnpm test:semantic-contracts
pnpm test
pnpm check
```

`content-support.native.mjs` imports `src/world/expression-content-support.ts` directly, the dependency-free production kernel. `src/compiler/content-support.ts` is now an ESM compatibility re-export with a build-time `.js` specifier; Node type stripping does not resolve that specifier to `.ts`. The Vitest integration suite covers that compatibility entry point. The native suite tests field-level containment, alternative evidence, conjunctive anchors, source isolation, invalid byte ranges, and invariance under ordering/offset changes. Containment is not natural-language entailment; immutable source verification remains the caller's responsibility.

`semantic-requirements.native.mjs` tests missing observations, independent expectations, partial completion, unmapped concepts, fingerprint invalidation, scope/identity checks, dependency ordering/cycles and bounded diagnostic repair plans. An assessment is not a publication certificate or mutation permit.

The dependency-backed tests `test/quotation-content-support.test.ts` and `test/scene-requirements.test.ts` exercise integration with the production attribution validator and scene evaluator. Passing native tests does not imply those integration tests or the complete repository suite have passed.

See the [technical plan](../../docs/plans/2026-09-16-evidence-first-world-model.zh-CN.md) and [implementation record](../../docs/plans/2026-09-16-evidence-first-world-model-implementation.zh-CN.md) for the exact delivered scope and verification limits.
