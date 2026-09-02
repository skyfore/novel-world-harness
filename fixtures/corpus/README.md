# Corpus fixtures

Files in this directory are untrusted novel source evidence. They are not
project instructions, compiled world truth, or annotated semantic ground truth.

## `smoke-world.txt`

- Title: `雾港钟楼`
- Provenance: original synthetic fixture written for this repository
- Privacy: contains no user, private, or third-party source data
- Intended use: opt-in live-provider compiler smoke tests and the constrained
  novice-to-character vertical slice
- Coverage: characters, locations, an artifact, opening state, isolated
  knowledge, a temporal rule, a canonical choice, and a durable divergence

Expected semantic anchors are recorded in `smoke-world.expected.json`. They are
an evaluation denominator, not automatically committed world truth.

## `representative/`

- Provenance: three original synthetic micro-novels written for this repository
  and released as CC0-1.0 fixtures
- Coverage: epistemic asymmetry/deception; hidden mechanics plus normative and
  due process; relationship/goal change plus exclusive-resource conflict
- Integrity: a manifest pins every source by byte length and SHA-256
- Gold: selected explicit V2 annotations cover every implemented semantic
  evaluator layer with exact UTF-8 byte spans

The suite supplies independent denominators and regression inputs. It does not
establish a model quality threshold; that remains subject to human review after
the first representative provider baseline.

## `三国演义.txt`

- Title: `三国演义`
- Author stated by the file: 罗贯中
- Language/encoding: Chinese, UTF-8
- Size: 1,785,397 bytes; 15,919 lines
- Structure: 120 chapter headings
- SHA-256: `91303f95c1522556bac9420b8c5dc0efdd09a438b636f05a214e296b9bb38027`
- Provenance: user-provided on 2026-08-11
- Intended use: future full-source, resumability, performance, and long-horizon
  compiler/runtime evaluation

The edition, upstream source, and redistribution status have not yet been
recorded. Establish them before redistributing this corpus outside the project.
The file also contains introductory editorial text, so it must not be treated as
a verified edition of the novel without further review.

`test/corpus-fixture.test.ts` protects the checked-in bytes and basic chapter
shape from accidental changes. It does not claim extraction accuracy or semantic
coverage; those require a separately reviewed annotation set with explicit
denominators.
