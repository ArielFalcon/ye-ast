# ADR-0091: Only advice that can replace a body vetoes dispatch

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner, 2026-11-14: "Acepto" (I accept), on the transversal fix plan of MCP evaluation run
  20261114T125655Z-c68fc8, whose decision D2 reads: only advice that can replace a body (`@Around`) vetoes dispatch.
- Related: [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md) (decision 5 extended),
  [ADR-0072](0072-one-owner-classifies-every-file-and-a-veto-is-released-by-reading-declarations.md),
  [ADR-0013](0013-coverage-grows-only-with-evidence.md)

**In short:** the aspect veto exists because an aspect "may replace the body". Only an `@Around` advice can: `@Before`,
`@After`, `@AfterReturning` and `@AfterThrowing` run beside the body and leave it as the call's body. They stop
vetoing dispatch, and an aspect whose other advices have a pointcut the closed subset cannot read no longer vetoes
every dispatch site of the repository. An `@Around` advice keeps today's scoped veto, and an `@Around` pointcut
outside the subset keeps today's repository-wide one.

## Context

ADR-0044 decision 5 scopes the aspect veto to the join points the pointcuts of an aspect may select, and keeps it
repository-wide when a pointcut is outside the closed subset (`java-dispatch-targets.ts`, `adviceOf` and `globalVeto`).
The code reads every advice annotation (`Around`, `Before`, `After`, `AfterReturning`, `AfterThrowing`) as a veto, and the
veto's own reason is "aspect may replace the body".

In the evaluation run, shopizer:trace:01 stops at its first hop: `dispatch (aspect may replace the body):
createTaxClass → 1 candidate`, no effect and a 10-line reading plan, so the facade → service → repository read → save
chain the oracle expects is lost. Every advice of that repository is `@After` or `@AfterReturning`
(`PublishProductAspect.java`, `PersistableAuditAspect.java`), and one of them states its pointcut through a named
`@Pointcut` method (`entityCreationMethods()`), which the closed subset cannot read. That single unreadable pointcut
is the repository-wide veto.

ADR-0072 records, in its context, that on 2026-11-08 the owner dropped a narrower aspect veto: one that estimated what
a pointcut could select, for no measured gain and with a risk of false steps. This decision is not that path.

| | Dropped on 2026-11-08 | This decision |
|---|---|---|
| What it does | Estimates which join points an unreadable pointcut could select, to narrow the veto | Reads the advice kind, a syntactic property of the annotation, and never estimates a pointcut |
| What proves it | A guess about a pointcut the reader cannot parse | The language: only `@Around` receives the join point and decides whether the body runs (`proceed()`); the other kinds run before or after it and cannot substitute it |
| Gain | None measured | shopizer:trace:01 regains facade → service → repository read and save, from an empty trace (evaluation run 20261114T125655Z-c68fc8, TR-F1) |
| False steps | Possible | One, stated below |

| Option | Verdict |
|---|---|
| Estimate what an unreadable pointcut selects | Rejected: the path dropped on 2026-11-08 |
| Extend the pointcut subset to read named `@Pointcut` references | Rejected here: it keeps reading code that cannot change the answer, and a reference can name any expression |
| Read only the advice kinds that can replace a body | Chosen |

## Decision

1. Only an `@Around` advice is read as a join-point veto. Its pointcut is read by the closed subset exactly as
   ADR-0044 decision 5 states.
2. `@Before`, `@After`, `@AfterReturning` and `@AfterThrowing` are not read: they join no veto, scoped or
   repository-wide, whatever their pointcut.
3. An `@Around` pointcut outside the closed subset keeps the repository-wide veto, and so does an aspect member that
   introduces types (`@DeclareParents`, `@DeclareMixin`): an introduction makes a type implement more than its
   declarations state, which is a different rule.
4. The veto's reason, `aspect may replace the body`, now holds for every case that raises it.

## Consequences

- Trace follows a call through a closed dispatch whose only aspects are after-advice, and the Java method flow reads
  the same closure (ADR-0044 decision 3), so workspace, decisions and contract consequences inherit it. Expected
  corpus-gate move: `trace:+`; `workspace`, `decisions` and `contract-consequences` `±`.
- A `@Before` advice that throws stops the body, so a step the trace lists may not run. Trace already states that its
  branches are not evaluated; no new cut is added.
- An aspect that wraps the call with `@Around` is unchanged, scoped or repository-wide.

## Not decided here

- Whether a named pointcut reference should be read for `@Around` advice: no measured case asks for it.
