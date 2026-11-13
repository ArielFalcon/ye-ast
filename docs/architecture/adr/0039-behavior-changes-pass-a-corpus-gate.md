# ADR-0039: A change of behavior in the core passes a corpus gate before it reaches main

- Status: Accepted, 2026-11-08, the owner through the tech lead
- Decision source: the owner, in the audit request of 2026-11-07: "un cajon de reglas... un bucle sin fin de 'debo
  agregar el arreglo de este fallo concreto'" (translated: "a drawer of rules... an endless loop of 'I must add the fix
  for this specific failure'"), and on 2026-11-08: "implementa B8, explicame si el cambio es de prompt o es un mecanismo"
  (translated: "implement B8, explain whether the change is a prompt or a mechanism"); the tech lead approved this
  design that day.
- Related: extends [ADR-0013](0013-coverage-grows-only-with-evidence.md) rule 4;
  [RFC-0002](../rfc/0002-facts-contract.md), [ADR-0010](0010-trust-modes.md)

**In short:** ADR-0013 measured a framework on real applications when it entered, and nothing measured the fixes
after it. Every change of behavior under `src/core/` now runs a fixed set of queries over a fixed local corpus with the
engine before and after it, and every answer that differs must belong to a family, in a direction, that the change
declared. A script decides it; a local git hook, once the owner activates it, keeps `main` from moving without it.
CI cannot run it, because the corpus is not in the repository.

## Context

The engine audit of 2026-11-07 found the engine growing by per-case fixes at two edges:

- one URL-evaluator predicate gained one clause per fix over three commits (`928cdde6`, `7493422e`, `d68fabdc`);
- a fix in impact (`989ba6d1`) caused a regression that a second fix (`ede536dd`) repaired 52 minutes later;
- 54% of the last 100 commits were fixes, and 4 were refactors.

Since then each unit has been checked by hand on the corpus, before and after: links unchanged, every answer
byte-identical, false certain callers reduced. Each unit wrote its own script, chose its own queries and reported its
own numbers, and nothing failed when an unexplained difference went unnoticed.

| Option | For | Against |
|---|---|---|
| A. Keep the manual check as a written rule | No code | Nothing stops a skipped or partial measurement; each unit measures something different |
| B. Committed golden answers | One run per check | The corpus is private, so its answers cannot be committed, and golden files go stale with every change to `main` |
| **C. Base and candidate runs over a fixed manifest, differences explained by declared families and directions** | Same queries every time; the base is the current `main`; a failure is an exit code | Minutes per run; the explanation is declared after the diff is seen |

## Decision

1. **The gate.** `scripts/corpus-gate.ts` runs the queries of a corpus manifest through the CLI of a base and a
   candidate engine revision. Each revision runs from its own clean worktree, over fresh clones of the corpus at pinned
   commits, with its own cache, configuration and temporary directories. The two revisions run one after the other in
   the same fixed directory, so both engines see the same paths: the engine redacts a path segment shaped like an
   encoded secret, and a random scratch segment was redacted on one side only. The runs take a lock, so only one run is
   heavy at a time.
2. **The manifest lives outside the repository.** It names the corpus repositories by path and pinned commit, groups
   them, declares the workspace a group installs, and lists the queries as CLI arguments with a family label. The gate
   has no default manifest. A repository is in the corpus only if the manifest lists it. No application name enters
   this repository.
3. **Frozen inputs.** Queries are declared, never derived from an engine's answers, so a change to the engine cannot
   change what is asked. They are chosen once per repository with a rule from git alone:
   - impact: the most recent first-parent commit at or before the pinned one that changes a source file outside tests;
   - importers and outline: the first such file of that commit;
   - callers and trace: that file's first changed line range;
   - contract consequences: the most recent change to an OpenAPI document of a workspace repository;
   - entrypoints for every repository, and the workspace and its decisions for every group that declares one.
4. **Untrusted by default, never networked.**
   - Queries run on clones for which no trust was ever declared.
   - Only queries marked `trusted` run on the clones a group's `init --trust trusted --workspace` installed. They read a
     declared workspace, which `untrusted` ignores by design.
   - Git may use only the `file` protocol, telemetry is off, and the corpus repositories are never written.
5. **Comparison.** Answers are compared byte for byte after the scratch paths are normalized.
   - A differing answer is diffed structurally, without rules per family: object keys added, removed or changed by
     path, and arrays as multisets, where a modified element is one removal and one addition and a reordering is a
     change. It also gets the length of every array it holds.
   - The result is a machine-readable report and a short readable one, kept outside the repository.
   - The answers of an engine commit are reused for the same manifest, Node version and gate runner.
6. **Explained differences.** The change declares `--expect <family>:+|-|±`, or `--expect none` (the default).
   - The gate fails on a difference in an undeclared family, or in a direction the family did not declare. Under `+`
     the answer may only gain elements, under `-` only lose them, and a changed value or a reordering needs `±`.
   - It also fails on a `complete` answer that is no longer `complete` without `±`, and on a new non-zero exit in any
     case.
   - The report and a `Corpus-Gate:` commit trailer record the expectations and the counts.
   - Whether a declared difference is right stays the reviewer's judgement, made over the differences the report lists.
   - The report also carries the cut ledger of each side and their difference (ADR-0071). It is informative unless the
     change declares `--expect-cuts <reason>:+|-|±`: then a declared reason whose cuts did not rise, fall or change as
     declared fails the run. A cut reason outside the facts contract is a fault.
7. **Scope.** The gate applies to every change of behavior under `src/core/`, meaning any file there but `*.test.ts`
   and `*.testing.ts`. That covers fixes and refactors, which declare `none`. ADR-0013 rule 4 still applies when a
   framework enters, and this rule applies to every change after that.
8. **What code enforces and what is a rule.**
   - Code enforces two things. The gate's exit code is 0 only when every difference is declared. The
     `.githooks/reference-transaction` hook refuses to move `refs/heads/main` onto such a change unless a pass is
     recorded for exactly that pair of trees. It covers a fast-forward, a fetch into `main` and a merge.
   - The hook works only where `core.hooksPath` names `.githooks`. Activating it is the owner's step.
   - The rest is a written rule in the repository's instructions: running the gate before committing such a change,
     and writing the trailer. CI has no corpus, so it can check neither.

## Consequences

- An integration into `main` that changes core behavior costs one gate run, minutes on the full corpus. The base side is
  reused when the previous candidate was the current `main`.
- An unexplained difference becomes a failure instead of something a measurement must happen to notice. The regression
  of `989ba6d1` would have failed a fix declared `impact:+`.
- The expectations are declared after the diff is seen, so the gate records a claim and does not prove it. The trailer
  makes the claim part of the history.
- A candidate whose `package-lock.json` differs from the installed one is refused, because the gate installs nothing.
- Integrating `main` into a branch before the gate keeps the candidate tree equal to the tree `main` will hold, so the
  hook finds the pass.

## Not decided here

- Activating the hook, after the branches in flight land: the owner's step.
- The evaluation records under `docs/evaluations/` that name corpus applications, against ADR-0013 rule 4: reported
  separately and not changed here.
