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
  as you recommend". On 2026-11-08 the owner chose, from the gate's numbers, the derivation on `sha` snapshots only,
  answering the tech lead's "¿Vamos con A y dejo registrada en ADR-0037 esa revisión para cuando salga la 7.1 estable?"
  (shall we go with A, and I record that revisit in ADR-0037 for when 7.1 ships stable?): "si, vamos asi" (yes, let's
  go that way).
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
   never by a second glob implementation. A file with no owner, or with two, is not bound: an edge the checker did not
   type keeps the derivation ADR-0036 gives it, with its confidence, so the answer states how each of its edges is
   known and no cut repeats it per file. `inputs.buildOutputs` states what the checker read.
8. **One derivation per snapshot, retained as data.** The adapter binds every call and reference of the snapshot's
   TypeScript sources in one pass, drops the programs, and keeps the bindings as a derived fact (ADR-0035). Its key is the
   snapshot's content, each declaration's kind, `at` and path, and a fingerprint of each directory's install record. The
   fact also lists every path the derivation asked about under a declared directory, with the answer it got (absent, a
   directory, or a file's digest); a hit is used only when asking those paths again gives the same answers, since the
   compiler's answers are a function of its host's answers. Concurrent first requests for one key share one derivation
   inside the adapter. A
   derivation the per-call deadline cuts is discarded and never kept, and the query it served ends as every query its
   deadline cuts does. No memory or file budget is set until a host measures one.
9. **Fallback.** Without a declaration, on a live tree (Gate), where decision 5 or 7 withholds it, where a declared path
   cannot be read (the directory missing or not a directory, a permission refused) or the compiler fails, or for a call
   the checker leaves unbound (an `any`, an error type), the current syntactic settlement answers, unchanged. Every
   declaration an answer did not read is named by a `build-output` cut, at what withheld it where that is known, never
   dropped silently; a fault of a declared output never fails the query. Every answer without a
   declaration is byte-identical to the answer before this decision, in both modes.
10. **Where it settles.** `EdgeTargets`, the one owner of edge verdicts, takes the bindings as one more proof source and
    consults them first, for calls and `new`: a binding to the edge's own target makes the edge `typed` at confidence 1;
    a binding to another repository declaration the graph holds moves the edge there, `typed` (a dispatch to an override
    is then the bridge's to state); a binding to a library or to the language's own declarations removes the edge and,
    for a library, retires its cut as ADR-0019 does; no binding, or one to a declaration the graph does not hold, leaves
    ADR-0036's settlement. The checker also reads, apart from the export the index reads, the snapshot's lockfiles and
    the repository's own declaration files, through a second read of the same commit; the index's export, its listing
    and its cache key do not change, and the derived fact keys on what the checker read. An unresolved call the checker binds is settled, so its
    `unresolved-link` cut retires; bound to a repository declaration the graph holds, it becomes a `typed` inbound edge
    before the walk. This replaces ADR-0036 decision 3 ("no settled edge is dropped") for
    typed bindings. Trace keeps ADR-0029 decision 11: a declared type proves what a call depends on, not what runs.
11. **Placement.** Every use of the compiler API stays in `core/adapters/typescript/` (ADR-0008). The confined reader
    is a port the TypeScript adapter declares and `core/adapters/fs/` implements, synchronous because the compiler host
    is. The bindings port is declared by `core/application/navigation`. The lockfile comparison is a pure rule in the
    domain. The binder of ADR-0029 stays the only source of lexical bindings in both modes.

## Gate

Before any surface of decision 1 is exposed, the cost was measured inside the real process (the composition the MCP
server runs), on the three largest measured applications without their test files (decision 7), on 2026-11-08. The
machine was loaded, so CPU time and memory are reported, not wall time.

| Measurement | name-webapp | jhipster | realworld-nx |
|---|---|---|---|
| Peak memory, query + pass + query + pass, no forced collection | 1.39-1.46 GB | 0.89-0.93 GB | 0.92-1.10 GB |
| Peak memory, forced collection | 0.84 GB | 0.66 GB | 0.81 GB |
| Heap after each pass (no program retained) | 66-74 MB | 66-74 MB | 66-74 MB |
| Query alone, peak memory | 0.86 GB | 0.48 GB | 0.41 GB |
| CPU, pass | 6.0-6.9 s | 3.2-3.3 s | 5.1-5.2 s |
| CPU after one edit, whole-snapshot key | 3.9-4.5 s | 3.0-3.4 s | 3.3-4.0 s |
| CPU after one edit, per-program key | 3.3-3.7 s (one program) | 1.8-2.0 s | 0.43-0.93 s |
| CPU after one edit, per-file key (importers' closure), leaf / hub | 0.35-0.53 s / 3.0 s | 0.66-0.80 s (hub) | 1.1 s (hub) |

With test files the pass costs 13.6-15.3, 5.5-6.5 and 4.8-5.2 s of CPU and peaks at up to 2.59 GB.

Decided (the owner, 2026-11-08): **A, the derivation runs on `sha` snapshots only.** A live tree keeps the syntactic
settlement, with no `typed` derivation, and every answer over it names each declared output in a `build-output` cut.

- Discarded, B (a live tree re-derived under a per-program key): an edit still re-derives the program that holds the
  file, which on a one-program application is the whole pass (3.3-3.7 s of CPU per edit).
- Discarded, C (a live tree re-derived under a per-file key, the edited file's importers' closure): a hub edit costs
  what the whole pass costs, and the key is unsound for an edit of a `declare global`, a `declare module`, a
  `/// <reference>` or a configuration, which reaches files no import names.

Measured after the integration (2026-11-08), `callers` on up to 15 services per application and `impact` over the last
ten commits, with and without the declaration:

| Application | Lockfile | Edges now `typed` (were `resolved` / `proven` / `name-match`) | Certain edges lost |
|---|---|---|---|
| petclinic | verified | 40 / 0 / 0 | 0 |
| shopizer | unverified (none committed) | 39 / 22 / 2 | 0 |
| jhipster | unverified (none committed) | 13 / 1 / 0 | 0 |
| realworld-nx | verified | 3 / 0 / 0 | 0 |
| name-webapp | verified | 373 / 13 / 6 | 0 |

Six symbols left name-webapp's `impact`, all at confidence 0.3 and reached only through name matches the checker
refuted (`x.toUpperCase()` had been matched to a repository method). Ten derivations changed without becoming `typed`
(9 `resolved` to `proven`, 1 `proven` to `resolved`): certain steps on their paths changed the step the walk reports.

Unresolved calls the checker settles, measured on the same queries against the edges alone: no symbol lost, 6 gained
in name-webapp (`typed`, for example a `super.writeValue(...)` into the base class), 122 dependences reported through a
`typed` step where a `proven` one stood at the same confidence, and the `unresolved-link` cut entries fall from 2 to 0
(petclinic), 147 to 88 (shopizer), 583 to 245 (jhipster), 8 to 8 (realworld-nx) and 1766 to 110 (name-webapp).

Revisit when TypeScript 7.1 ships a stable programmatic API: a measured spike, first the API's coverage of what
`core/adapters/typescript/` uses, then the pass time on the corpus against 6.0.3. If it wins, a new ADR supersedes
ADR-0008, and the derivation on live trees is reconsidered then.

## Consequences

- With a declaration, `callers`, `impact`, `importers`, `outline` and contract consequences lose the false callers a
  name match produced and gain the dependences the index left unresolved; trace, entrypoints, URLs and `map` do not
  change. The cut lists change little (ADR-0018's measurement); that is not the benefit claimed.
- The first query on a snapshot pays 3-7 s of CPU and up to 1.46 GB on the measured applications (Gate); later queries
  on it pay a cache hit and a re-digest of 4.5-14.9 MB. A live tree is not typed.
- No hand-written resolution is deleted: the binder, import origins, the generated `lib` globals, the member proofs
  and ADR-0036's settlement all answer the calls without a declaration, the bindings the checker leaves open, and
  trace. The code grows by the adapter, the confined reader, the lockfile rule and the surfaces.
- Without a lockfile, an answer rests on a declaration ye-ast could not check, and says so in its inputs.
- A new input, derivation value and cut kind are vocabulary under RFC-0002 rule 6; no SCHEMA version moves.

## Not decided here

- Java class paths, generated OpenAPI sources and SCIP indexes: each needs a measured application where it changes an
  answer.
- yarn and pnpm lockfiles. A check of installed versions against the manifest's ranges is out (decision 5).
- npm workspaces: the lockfile is looked for only at the declaration's `at`, so a declaration below a workspace root
  whose lockfile sits at the root is used and stated unverified.
- Reusing a previous program for an edited live tree.
- Whether trace may use a typed binding of a nominal class (ADR-0029 decision 11).
