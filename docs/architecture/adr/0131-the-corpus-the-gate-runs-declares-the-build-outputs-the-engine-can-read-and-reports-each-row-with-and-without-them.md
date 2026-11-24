# ADR-0131: The corpus the gate runs declares the build outputs the engine can read, and reports each row with and without them

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra
  sesion por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente
  tenga que tomar decisiones improtantes o inventarse implementaciones" (translated: write every RFC and ADR needed so
  that a less capable agent implements it in another session; everything explicit, leaving almost no room for that agent
  to take important decisions or invent implementations). It serves the request of the same day: "mejorar la calidad de
  analisis de lo que ya existe ... y aprovechar mejor los recursos que ya tiene disponible" (translated: improve the
  quality of the analysis that exists ... and make better use of the resources it already has available).
- Related: [RFC-0042](../rfc/0042-a-call-cut-states-its-cause-and-the-corpus-declares-what-the-engine-can-read.md) (the design);
  [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md) decisions 2 to 4;
  [ADR-0037](0037-host-declared-build-outputs.md); [ADR-0063](0063-a-jdk-the-host-declares-is-the-library-signature-source.md);
  [ADR-0071](0071-engine-investment-is-steered-by-a-cut-ledger-and-an-outcome-control.md);
  [ADR-0010](0010-trust-modes.md); [ADR-0130](0130-a-call-cut-states-the-cause-its-binder-established-never-one-derived-from-the-candidate-count.md)

**In short:** the gate's manifest declares the JDK of every Java `trace` and the `node_modules` of every `impact` and
`callers` query whose repository has an install, as a second query beside the undeclared one, so the ledger shows each
row without and with the outputs. The machine paths live in the manifest, outside the repository, and no walk bound
is passed unless a query needs it.

## Context

The corpus passes `--node-modules` in none of its queries and `--jdk` in two, each with the path of a JDK written in
the query. The ledger therefore measures an engine without its type checker and almost without library signatures, a
state no user runs, and it cannot tell a gap of the engine from a gap of its input. The CLI accepts `--jdk` on `trace`,
`init` and `mcp`, and `--node-modules` on `impact`, `callers`, `init` and `mcp`; every other command refuses both
(`src/cli/main.ts`). Four callback `trace` queries pass `--depth 1` and hold all 36 `trace/java/depth` cuts, a row the
manifest produces, since the engine has no default depth.

| Option | Verdict |
|---|---|
| Switch the existing queries to their declared form | Rejected: the history of the ledger is lost and the effect of the inputs is invisible |
| Twin each declarable query in the same manifest | Chosen: the original is the control, the twin the experiment, both in one report |
| Two manifests, two gate runs | Rejected: twice the time, two reports to join |

## Decision

1. **Which query declares what.** A `trace` query over a repository with at least one tracked `.java` file at its pinned
   commit declares `--jdk {jdk}`. An `impact` or `callers` query over a repository with an installed `node_modules`
   declares `--node-modules {node-modules:<repository id>}`. No other query declares either: they refuse the flags. A
   `trace --workspace` query and a TypeScript `trace` declare nothing.
2. **Twins, not switches.** A declared query is a second query with id `<original>.declared`, the original's family and trust, and
   `declares: { of: <original id> }`. The original stays undeclared. The manifest may hold a twin only for an original of its group.
3. **Machine paths live in the manifest.** The manifest has one `buildOutputs` block: `jdk` (one JDK for the whole corpus) and
   `nodeModules` per repository id, each absolute or relative to the manifest's directory. Queries name them through
   `{jdk}` and `{node-modules:<id>}`, which the gate expands when it runs a query. An answer records the declared `argv`
   with its placeholders, so no report and no file of the repository names a path.
4. **The gate refuses an unusable declaration before running.** A placeholder without its `buildOutputs` entry, a twin
   whose original is missing, a JDK directory without `lib/ct.sym` and a node_modules path that is not a directory are
   gate faults. An output the engine cannot use at a snapshot is not a fault: the answer carries its `build-output` cut
   (ADR-0037 decision 9, ADR-0063) and the ledger counts it.
5. **Two ledgers, one of them unchanged.** The main ledger of each side counts every undeclared answer, as before. The
   twins form a second ledger beside it. The report prints, per ledger row, the cuts of the originals that have a twin
   (without) and of the twins (with), and the answers by status in each arm, for both sides. `--expect` and `--expect-cuts`
   keep acting on the whole comparison and the main ledger.
6. **The installs are made outside the gate.** A `node_modules` of the corpus is produced by `npm ci --ignore-scripts` into a
   folder outside the workspaces, from the lockfile of the pinned commit, or from the corpus's own lockfile where the commit
   has none (ADR-0037 decision 5: the declaration is then unverified). The gate never networks (ADR-0039 decision 4), runs no
   repository code (ADR-0010) and writes nothing inside the corpus repositories.
7. **No walk bound without a reason.** A manifest query passes no `--depth`, `--hub-fan-in` or `--expansions` unless a
   measurement shows the query cannot finish without it; then the owner decides the number. The four callback queries lose
   `--depth 1`.
8. **What is committed.** The gate script, its tests and these records are in the repository. The manifest, its generator,
   its pinned groups, the script that prepares the installs, the installs, the JDK path and the reports stay outside it
   (ADR-0039 decision 2).

## Consequences

- The gate runs 27 to 32 more answers (about a quarter more by count); the real cost is recorded by the first declared run.
- The first gate run after the manifest changes has a new reference ledger: the two queries that carried a machine-path
  `--jdk` become undeclared originals, and the `trace/java/depth` row disappears with the flag.
- A TypeScript `trace` cannot show the effect of a `node_modules` until the command accepts it.
- A repository whose install fails or needs an unavailable toolchain has no twin; it is recorded, not hidden.

## Not decided here

- Whether `trace` accepts `--node-modules`: RFC-0044.
- A measured `--expansions` for a callback query that cannot finish unbounded: the owner, if the measurement of RFC-0042 U12 finds one.
- Declaring a classpath (ADR-0073) in the corpus.
