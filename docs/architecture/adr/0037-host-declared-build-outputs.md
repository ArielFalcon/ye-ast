# ADR-0037: A host may declare build outputs, and TypeScript bindings are then read from the type checker

- Status: Proposed
- Decision source: the owner, 2026-11-07, answering the tech lead's recommendation "B6: aceptar build outputs
  declarados por el host (por ejemplo node_modules), sin ejecutar nada del repo" (B6: accept build outputs a host
  declares, for example `node_modules`, without running anything of the repository): "B6 acepto tu recomendacion, me
  parece bien implementarlo, se debe hacer bien" (B6, I accept your recommendation, implementing it seems right to me,
  it must be done well). Standing owner rules that bound it: no repository code runs in either mode; `untrusted` must
  work in pipelines and outside a developer's machine without precautionary restrictions that block features, while
  every restriction that blocks a real attack stays; no limit without a measurement; duplicated logic is unified, not
  patched. On 2026-11-08 the owner approved this design (translated): "we go on with B6 as you recommend", with a
  measurement gate before any surface is exposed (below), and decided the snapshot without a lockfile (decision 5): "yes,
  as you recommend".
- Supersedes in part: [ADR-0010](0010-trust-modes.md) decisions 2 and 6, [ADR-0013](0013-coverage-grows-only-with-evidence.md)
  decision 2, [ADR-0014](0014-angular-and-spring-from-own-extractors.md) the definition-of-done item on fixtures,
  [ADR-0036](0036-dependence-is-the-compile-time-binding.md) decision 3. Reopens the host contract that
  [ADR-0018](0018-type-information-as-a-fact-input.md) left without a consumer.
- Related: [ADR-0008](0008-typescript-compiler-api-source.md), [ADR-0029](0029-lexical-bindings-from-the-typescript-binder.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0006](../rfc/0006-configuration.md), [RFC-0016](../rfc/0016-type-resolution.md)

**In short:** a host may declare, outside the repository, directories its own install produced. ye-ast reads them as
data through a confined reader, never loads or runs anything from them, and checks them against the snapshot's
lockfile. For TypeScript, a declared `node_modules` lets ye-ast's own pinned compiler bind calls by type: once per
snapshot, retained as derived facts, settling the edges ADR-0036 marks as name matches. Without a declaration every
answer is byte-identical to today's, in both modes, so no hand-written resolution is deleted.

## Context

Measured on 2026-11-07 on `main` (`d682b070`), TypeScript 6.0.3, on four corpus applications and one private one, each
exported with `git archive` at its sha. Dependencies were installed by the measurement, never in the repositories, with
`npm ci --ignore-scripts` into a separate directory: from the committed lockfile where one exists, from the corpus
copy's local lockfile where the commit has none. Each cell ran twice; the checker's answers were byte-identical across
runs.

| Application shape | Calls | ye-ast today settles | Checker, declared `node_modules` | Checker, no `node_modules` |
|---|---|---|---|---|
| Angular, single project | 733 | 76.7% | 99.5% | 25.1% |
| Nx monorepo, 55 tsconfig files | 606 | 57.1% | 100% | 12.9% |
| JHipster gateway | 1,690 | 69.6% | 99.5% | 32.5% |
| Angular 8 admin | 4,053 | 69.1% | 93.8% | 45.6% |
| Angular 21 standalone | 14,505 | 68.3% | 99.8% | 46.9% |

What the checker changes, call by call: 140 calls ye-ast answers today with a certain edge into a repository member
the checker binds elsewhere (0, 8, 16, 33, 83 per application; for example 29 of the 133 callers `callers` lists for a
service's `get` are Angular's `ParamMap.get`); 503 calls ye-ast leaves unresolved that the checker binds to a repository
declaration; 5,846 it leaves unresolved that the checker binds to a library. On a judged sample of 200 disagreements
from the same day's earlier probe of the same applications: ye-ast wrong 40, ye-ast unknown and the checker right 143, the checker wrong 1, the
checker unknown and ye-ast right 10 (a `types` option the probe had emptied). The checker reconstructs no HTTP URL that
ye-ast's URL evaluator leaves unknown.

ADR-0036 already marks an unproven value-receiver edge as a `name-match` (226 on the same corpus: 114 false, 91 true,
19 dispatch). The checker is what settles those both ways, and binds the 503.

Cost of one derivation over a whole snapshot, in a process that does nothing else, two runs each (other processes were
running on the machine):

| | Programs | Derivation, in process | Process wall; CPU | Peak RSS | Every call again, program kept |
|---|---|---|---|---|---|
| single project | 1 | 3.3-3.6 s | 4.4-7.6 s; 2.4-3.3 s | 462-486 MB | 11-126 ms |
| Nx monorepo | 9 | 3.0-3.3 s (19 s unshared) | 3.8-3.9 s; 5.8-6.5 s | 848-893 MB (1.54 GB unshared) | 19-31 ms |
| JHipster | 2 | 3.6-4.7 s | 4.1-5.4 s; 5.7-5.8 s | 919-930 MB | 34-104 ms |
| Angular 8 | 1 | 3.5-3.7 s | 4.6-4.7 s; 3.6-3.8 s | 520 MB | 121-252 ms |
| Angular 21 | 2 | 5.9-6.1 s | 6.9-7.0 s; 10.2-10.5 s | 1.03-1.08 GB | 184-208 ms |

"Unshared" is a separate parse of every declaration file per program; sharing parsed files across programs gives the
same answers. The declaration files read under the declared directory were 414 to 2,568 files, 4.5 to 14.9 MB.

ADR-0018 shipped a type root and was rejected on 2026-11-05: first-pass `impact` latency rose 2 to 3.4 times, peak RSS
2 to 3.6 times, a server grew from 804 MB to 1,481 MB over four queries, and the benefit was 0 to 25 cuts. Three
differences hold here: the measured benefit is which edges are true, not which cuts disappear; the program is dropped
after one pass and only JSON bindings are retained; and nothing changes for a caller that declares nothing.

Evidence on staleness and layout, same corpus: 2 of 5 commits have no lockfile (one also needs a local edit of its
`package.json` to install); 1 of 5 developer `node_modules` differs from its commit (one package version); 1 of 5 has no
install record. The npm installs hold only `.bin` links, none leaving their directory; no application uses pnpm or
npm workspaces. Under the tsserver rule (a file belongs to the nearest `tsconfig.json` that includes it, or to one of
its references that does), 1,986 of 2,000 TypeScript files have exactly one owner; 13 have none and 1 has two. The
Nx monorepo's 55 configurations hold 11 distinct option sets; settled with its root `tsconfig.base.json` instead, the
same checker binds 86.7% of its calls, not 100%.

| Option | For | Against |
|---|---|---|
| A. Keep syntax only (ADR-0036) | No new input | 114 false edges stay visible as name matches, 91 true ones look uncertain, 503 dependences stay unresolved |
| B. Declared outputs read by the checker, syntax as fallback (chosen) | 94-100% of calls bound; deterministic; no process, no network | A new host contract; 3-6 s and up to 1.1 GB per snapshot; no line of today's resolution can go |
| C. Discover `node_modules` in a trusted working tree | No declaration step | Honours a directory the repository's state decides; two paths to one input |
| D. Host-supplied SCIP or LSIF index | No checker in ye-ast | A pre-built index ye-ast did not build (ADR-0010 decision 2); its answers depend on the indexer's version and options |

## Decision

1. **A build output is declared by a host, outside the repository.** It is a typed value composition passes to the
   core: a closed union of kinds, each with the host path and the repository-relative directory it stands for
   (`{ kind: "node-modules", at: "", path }`: `path` is a `node_modules` directory, standing for `<at>/node_modules`
   in the snapshot). A host declares it through the library, a query-protocol parameter, a
   command-line flag or the user-level record `ye-ast init` writes. ye-ast never discovers one and never reads one from
   repository content, configuration or environment. One kind enters now, `node-modules`; Java class paths, generated
   sources and external indexes enter each with its own measured evidence (ADR-0013 decision 4).
2. **Read as data, never as code.** ye-ast reads declaration files (`.d.ts`, `.d.mts`, `.d.cts`) and `package.json`
   files under a declared directory through the TypeScript compiler's own host, with ye-ast's pinned compiler and its
   own `lib` files. Nothing under it is required, imported or run, and no install, build or script runs. Language
   service plugins, incremental build information and emit are off whatever the configuration says.
3. **Confinement, in both modes.** The compiler host serves three sets only: the snapshot's files, the files under each
   declared directory, and ye-ast's own `lib` files. Every other path does not exist for it, so a configuration's
   `extends`, `paths`, `typeRoots`, `include` or `references` cannot reach a file outside them. A symbolic link under a
   declared directory is read through its link text, as the directory stands in the snapshot: a target inside the same
   declared directory is followed, a target inside the repository is read from the snapshot (never from a working
   tree), and any other target is refused and named in the answer.
4. **Trust.** Under `untrusted` every rule of ADR-0010 decision 2 holds, and the declared directories are read only
   through decision 3. A declared directory may lie inside the repository's checkout: the restriction that blocks the
   attack (a link or a configuration path leading out of the declared set) is decision 3, and refusing the location
   would block the pipeline case (`checkout`, then install). Declared outputs are as untrusted as the repository that
   chose its dependencies: a declaration file may state any type, as a source file may, and the facts are what the
   declarations state (ADR-0029, Consequences). Under `trusted` nothing more is honoured.
5. **Staleness is checked, and stated.** For each package the program read, the installed version in its
   `package.json` is compared with the snapshot's lockfile entry at the same install path (npm lockfile versions 2 and
   3). Any mismatch, or a package the lockfile does not list, makes the declaration unused for that snapshot: every
   answer falls back to decision 9 and carries a `build-output` cut naming each mismatched package. A snapshot without a
   readable lockfile uses the declaration, and every fact that used it states it as unverified, in its inputs and
   visibly in the answer, never as a verified fact (the owner, 2026-11-08, translated: "yes, as you recommend"). No
   check against the manifest's version ranges is made. Another lockfile format enters with evidence.
6. **The fact records its basis.** `inputs` gains, per declaration, its kind, its `at`, whether it was verified, and the
   digest of the files the derivation read (path under the directory and content). The derivation of a dependence gains
   `typed` beside ADR-0036's `proven`, `resolved` and `name-match`.
7. **Projects.** A file's options come from its owning configuration by the tsserver rule: the nearest `tsconfig.json`
   that includes it, else the one of its references, transitively, that includes it. Files whose owners have equal
   options share one program, and every program shares one parse of each declaration file. A configuration's `include`,
   `exclude` and `files` are matched by the compiler's own matcher (`matchFiles`, internal in 6.0.3 and held by a test),
   never by a second glob implementation. A file with no owner, or with two, is answered by decision 9 and carries an
   `unresolved-link` cut naming the configurations.
8. **One derivation per snapshot, retained as data.** The adapter binds every call and reference of the snapshot's
   TypeScript sources in one pass, drops the programs, and keeps the bindings as a derived fact (ADR-0035). Its key is the
   snapshot's content, each declaration's kind, `at` and path, and a fingerprint of each directory's install record. The
   fact also lists every path the derivation asked about under a declared directory, with the answer it got (absent, a
   directory, or a file's digest); a hit is used only when asking those paths again gives the same answers, since the
   compiler's answers are a function of its host's answers. Concurrent first requests for one key share one derivation
   inside the adapter. A
   derivation the per-call deadline cuts is discarded and never kept; that answer falls back to decision 9 with a
   `deadline` cut. No memory or file budget is set until a host measures one.
9. **Fallback.** Without a declaration, or where decision 5 or 7 withholds it, or for a call the checker leaves
   unbound (an `any`, an error type), the current syntactic settlement answers, unchanged. Every answer without a
   declaration is byte-identical to the answer before this decision, in both modes.
10. **Where it settles.** `EdgeTargets`, the one owner of edge verdicts, takes the bindings as one more proof source and
    consults them first: a binding to the edge's member, or to a declaration it overrides, makes the edge `typed` at
    confidence 1; a binding to another declaration removes the edge and, for a library, retires its cut as ADR-0019
    does; no binding leaves ADR-0036's settlement. An unresolved reference the checker binds to a repository declaration
    becomes a `typed` inbound edge before the walk. This replaces ADR-0036 decision 3 ("no settled edge is dropped") for
    typed bindings. Trace keeps ADR-0029 decision 11: a declared type proves what a call depends on, not what runs.
11. **Placement.** Every use of the compiler API stays in `core/adapters/typescript/` (ADR-0008). The confined reader
    is a port the TypeScript adapter declares and `core/adapters/fs/` implements, synchronous because the compiler host
    is. The bindings port is declared by `core/application/navigation`. The lockfile comparison is a pure rule in the
    domain. The binder of ADR-0029 stays the only source of lexical bindings in both modes.

## Gate

Before any surface of decision 1 is exposed, the cost is measured inside the real process (the composition the MCP server
runs): peak memory with codegraph and the derivation together, on the three largest measured applications, and a live
tree after one edit (whether the whole snapshot is derived again, the first query's latency and CPU, and whether a key
per file or per program spares an edit the whole pass, still never retaining a program). The owner decides from those
numbers whether the derivation also runs on live trees or on `sha` snapshots only.

## Consequences

- With a declaration, `callers`, `impact`, `importers`, `outline` and contract consequences lose the false callers a
  name match produced and gain the dependences the index left unresolved; trace, entrypoints, URLs and `map` do not
  change. The cut lists change little (ADR-0018's measurement); that is not the benefit claimed.
- The first query on a snapshot pays 3-6 s and up to 1.1 GB on the measured applications; later queries on it pay a
  cache hit and a re-digest of 4.5-14.9 MB. An edit of a live tree re-derives the whole snapshot.
- No hand-written resolution is deleted: the binder, import origins, the generated `lib` globals, the member proofs
  and ADR-0036's settlement all answer the calls without a declaration, the bindings the checker leaves open, and
  trace. The code grows by the adapter, the confined reader, the lockfile rule and the surfaces.
- Without a lockfile, an answer rests on a declaration ye-ast could not check, and says so in its inputs.
- A new input, derivation value and cut kind are vocabulary under RFC-0002 rule 6; no SCHEMA version moves.

## Not decided here

- Java class paths, generated OpenAPI sources and SCIP indexes: each needs a measured application where it changes an
  answer.
- yarn and pnpm lockfiles. A check of installed versions against the manifest's ranges is out (decision 5).
- Reusing a previous program for an edited live tree.
- Whether trace may use a typed binding of a nominal class (ADR-0029 decision 11).
