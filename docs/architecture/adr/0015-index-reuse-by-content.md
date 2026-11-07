# ADR-0015: Index reuse by staged content, and `sync` only for live facts that say so

- Status: Accepted, 2026-11-01, owner
- Decision source: the owner, 2026-11-01, answering "Si" to the eight recommendations of the independent review of
  [RFC-0010](../rfc/0010-impact-queries.md), among them: "Index cache key: staged content, not sha" and "Allow live
  facts on a `sync`-updated index with the index's origin recorded in `inputs`, and bring the `sync` parity test
  forward".
- Supersedes: [ADR-0006](0006-qayaba-graph-state-per-run.md) decision 2.
- Amended by: [ADR-0027](0027-retention-of-immutable-index-entries.md) (retention of kept indexes)
- Related: [ADR-0010](0010-trust-modes.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0003](../rfc/0003-codegraph-integration.md), [RFC-0005](../rfc/0005-transports.md),
  [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** a full index is reused for any snapshot whose staged files are byte-identical, not only for the same
sha, so commits that change nothing in scope cost no build. A `sync`-derived index serves only `live` facts, which
record that origin in their inputs; `sha` facts keep reading full builds until the `sync` parity test passes.

## Context

- Building the index is the cost of an impact query: an unbounded inbound closure on an 18,004-node Angular store took
  about 10 ms (review of RFC-0010, 2026-11-01), while a build is a full codegraph index. Impact is meant for constant
  use.
- ADR-0006 decision 2 keys reuse by (repository, sha, scope). Two shas with the same staged (path, blob) set give the
  same input to the build, so the sha key rebuilds what it already has after every commit that touches nothing in
  scope.
- [RFC-0005](../rfc/0005-transports.md) "Live freshness" serves live facts from an index brought up to date with
  codegraph's `sync`, while ADR-0006 decision 2 and RFC-0003 open question 2 forbid `sync`-derived indexes before a
  parity test. Reading codegraph 1.6.2, `sync` re-resolves references from the changed files and retries failed ones by
  name, but never revisits an edge an unchanged file already resolved (`bundle:index.js:880-905`; inference from
  reading), so a `sync`-derived index can differ from a fresh build.
- A build's determinism is measured on 29 files only ([RFC-0003](../rfc/0003-codegraph-integration.md)).

## Decision

1. A full index is keyed by the digest of the staged (path, blob) set, the content digest of
   [RFC-0002](../rfc/0002-facts-contract.md) rule 5, plus the codegraph version, its schema and extraction versions,
   and the version of ye-ast's staging rules. A stored index is immutable; a snapshot whose key matches reuses it.
   (repository, sha, scope) is the special case of one commit.
2. Before content-keyed reuse is the default, a determinism test builds one large real repository twice and compares
   the stores; until it passes, reuse stays per sha as before.
3. A `sync`-derived index serves `live` facts only (`trusted`, [ADR-0010](0010-trust-modes.md)). Their `inputs` record
   the index's origin (`full` or `sync` from a named full build), so a consumer can tell them apart. `sha` facts read a
   full build.
4. The `sync` parity test of RFC-0003 is brought forward: it runs with the first live slice, and its result decides
   whether `sha` facts may use `sync`-derived indexes.

## Consequences

- ADR-0006's other decisions stand; qayaba's host keeps the stores between runs.
- RFC-0002's `FactInputs` gains the index origin for live facts; RFC-0003 open question 2 is answered by decision 4.
- A change to the staging rules changes the key, so an index built under older rules is never reused.
- Determinism check (decision 2), 2026-11-01, codegraph 1.6.2 (schema 11, extraction 27): one export of a large real
  repository (a 701-file Java and TypeScript repository at one sha, 594 files indexed, none left out) was indexed twice
  into separate stores. Compared independent of order and node ids, by what facts read: 10,429 nodes, 18,103 edges
  (kind, line, column, confidence, provenance, synthesizer) and 23,167 unresolved references (with their candidates)
  were equal in both stores, and the list of staged files the engine left out was equal (empty). No difference, so
  content-keyed reuse is the default. This is evidence, not a test in the repository.
- `sync` parity measurement (decision 4, RFC-0010 "The `sync` parity test"), 2026-11-01, codegraph 1.6.2 (schema 11,
  extraction 27): the last first-parent commits of two real repositories were replayed in order through ye-ast's live
  mirror (checkout, working-tree listing, reconcile). The first step was a full build of the mirror; each later step
  was `sync` over the paths the reconcile changed, and was compared with a fresh full build of a second mirror
  reconciled from the same listing, by what facts read and independent of order and node ids: symbols, outgoing edges
  (kind, line, column, confidence, provenance, synthesizer, keyed by path and symbol), unresolved references with their
  candidates, and the files the engine left out. The comparison code is that of the parity gate test, copied.

  | Repository | Files | Steps compared | Steps with a difference | Last step: nodes / edges / unresolved | `sync` median / max | Full build median / max |
  |---|---|---|---|---|---|---|
  | A Java/Angular repository of 1,117 files | 1,117 | 14 (1 build, 13 `sync`) | 4 | 11,670 / 20,894 / 31,512 | 370 ms / 902 ms | 2,432 ms / 3,060 ms |
  | A Java multi-service repository of 208 files | 208 | 20 (1 build, 19 `sync`) | 0 | 914 / 984 / 1,183 | 608 ms / 1,250 ms | 1,174 ms / 1,866 ms |

  On the second repository every step was equal. On the first, four steps differed, each by one edge present in the
  fresh build and absent after `sync`: a `navigates` edge (heuristic, synthesized by the engine's Angular router-link
  resolver) from a component class to a route node of `app.routes.ts`. Each of the four steps changed only an HTML
  template (and an i18n JSON file) of the component or of a neighbouring page, never the component's `.ts` file or the
  routes file. Symbols, unresolved references and the files left out were equal in every step. So `sync` does not equal a
  fresh build when a template changes: it drops a cross-file synthesized `navigates` edge. The impact walk never
  follows that kind (`src/core/domain/impact/edge-policy.ts`), but `importers` counts every edge into a file as a user,
  synthesized edges included, so the measurement's "equal on what facts read" did not hold for it. The engine
  synthesizes a template's renders (`calls`, `angular-template`) and router links (`navigates`, `angular-router-link`)
  only when the file that declares the component is indexed; a `sync` that takes only a `templateUrl` file leaves them
  as the last full build left them, added or removed. The adapter now reports the paths a `sync` took that the engine
  does not parse, the live mirror records them until the next full build, and a query that reads synthesized edges
  (`importers`) builds the store in full first (RFC-0010 "The `sync` parity test"). `sha` facts keep full builds, and
  whether they may read `sync`-derived indexes stays the owner's decision. Durations are evidence, not a limit. This is
  evidence, not a test in the repository.
- `sync` parity re-measurement, 2026-11-07, codegraph 1.6.2, after the parity gate compared every field of the code
  graph port: the last first-parent commits of the same two repositories were replayed through a mirror (the files in
  map scope; each step `sync` over the paths the commit changed, deletions included) and each step was compared with a
  fresh full build of the same files, on every symbol, edge (`resolvedFrom` included) and unresolved reference field
  and on the files left out.

  | Repository | Steps | Steps with a change in scope | Steps whose `sync` named unparsed files | Steps with a difference | Differences outside the edges synthesized from those files |
  |---|---|---|---|---|---|
  | The Java/Angular repository of 1,117 files | 13 | 12 | 9 | 4 | 0 |
  | The Java multi-service repository of 208 files | 30 | 14 | 2 | 0 | 0 |

  Every difference was a `navigates` edge (`angular-router-link`) present in the fresh build and absent after `sync`,
  in a step whose `sync` named the changed template unparsed; a stale edge stayed through later steps until a build,
  as `unparsedSinceBuild` assumes. The files left out were equal in every step and no `sync` failed a file. This is
  evidence, not a test in the repository.
- The key of a kept index is the digest of the content fingerprint of the head export
  (`contentFingerprint`, RFC-0002 rule 5), the installed codegraph version, the supported schema and extraction
  versions, and `STAGING_RULES_VERSION`, which changes with any change to what the staging places; a test pins the
  digest of the staging and indexing sources to each version, so a change to them without a new version fails the gate. A kept index is
  published by an atomic rename of a directory built beside it; a build that loses the rename to a concurrent one
  keeps the winner. An index that cannot be opened is replaced, never used. A cache directory that is a symbolic link, owned by
  another account or open to other accounts is refused, never repaired, since an entry planted there would be a false fact source; the
  query then builds a per-call index. Where indexes live under `untrusted`
  without a host is [RFC-0006](../rfc/0006-configuration.md) open question 4.
- Garbage collection of kept indexes is decided by [ADR-0027](0027-retention-of-immutable-index-entries.md): last use,
  14 days unused and 512 MiB, never an entry an open reader holds. A `.build-*` directory a killed build leaves is
  removed by the same sweep once unwritten for an hour (ADR-0027 decision 8).
