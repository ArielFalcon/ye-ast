# ADR-0141: A source or construct that leaves Java bindings unproven does so only for the types it can reach, and where the reach cannot be bounded the answer carries one cut for the cause

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas, optimizar recursos y aprovechar mejor los
  recursos que ya tiene disponible" (improve the quality of the analysis that exists, fix problems, optimise resources
  and make better use of the resources already available).
- Related: [RFC-0047](../rfc/0047-an-unproven-reading-reaches-only-what-its-cause-can-reach.md) (the design),
  [ADR-0042](0042-completeness-is-relative-to-the-question.md),
  [ADR-0044](0044-one-implementation-closure-with-scoped-vetoes.md) (decision 5; the strict reader's veto table),
  [ADR-0051](0051-an-answer-never-hides-what-the-engine-knows.md),
  [ADR-0072](0072-one-owner-classifies-every-file-and-a-veto-is-released-by-reading-declarations.md) (decisions 6 and 7),
  [ADR-0075](0075-the-core-names-no-language-or-framework.md),
  [ADR-0081](0081-a-syntax-error-confined-to-a-body-leaves-its-sources-declarations-read.md) (decision 2)
- Supersedes: ADR-0081 decision 2, third bullet, for `receiverMethods` only (it stays on the stricter reading); and the
  rows of ADR-0044's table "Vetoes: a dynamic-implementation API, an unparsed source, call-rewriting annotations" for the
  strict reader, where the conditions below are scoped. ADR-0044 follow-up F4 ("a source that does not parse vetoes
  every Java proof") holds for a source whose error is not confined to a body.

**In short:** the strict Java binding turns every call of the repository into `unproven` when any source is unread or
unparsed, when a dynamic implementation is named, or when a call-rewriting annotation exists. Each condition now
reaches only the calls it can reach, where the sources prove a bound; where no bound is provable (an unread or
unparsed source) it keeps the repository-wide reach. Either way the answer names the cause and its place, and the
families that read it emit one cut for the repository-wide causes.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| One boolean gates the strict binding for the whole repository | `provesBinding`, `receiverMethodAt`, `src/core/adapters/spring/java-receiver-methods.ts` |
| The answer states the reach only as `repositoryWide: true`, with no cause and no place | `ReceiverMethod`, `src/core/ports/import-origins.port.ts` |
| `callers` and `impact` keep the edge and add no cut for a repository-wide answer, so the answer stays `complete` | `declaredMethodsOf`, `src/core/application/navigation/edge-targets.ts` |
| ADR-0072 decision 6 keeps the repository-wide veto for a file no reader reads and a source the grammar cannot parse; decision 7 states that a cut caused by such a source names the cause and its files | ADR-0072 |
| A source with a syntax error confined to member bodies has its declarations read; the receiver reading stays on the stricter gate because an unread body may hold a proxy | `HeldJavaProject.declared`, `src/core/adapters/spring/java-project.ts`; ADR-0081 decision 2 |
| The dispatch closure already scopes its vetoes and releases one only by positive proof | `globalVeto`, `advisedBy`, `src/core/adapters/spring/java-dispatch-targets.ts`; ADR-0044 decision 5 |

Options weighed:

| Option | Verdict |
|---|---|
| Keep the boolean | Dropped: every call of a repository is unproven for one cause that reaches few of them, and the families that read the answer say nothing of why |
| Estimate the reach of an unread or unparsed file (for example, only its package) | Dropped: ADR-0072 narrows such a veto only by reading declarations, never by an estimate of what an unread file may touch |
| Scope each condition by what it can reach; keep the unbounded ones repository-wide and name them | Chosen |

## Decision

1. **Every unproven answer caused by a source or construct names the cause.** The answer states, per cause, its kind
   (`unparsed-source`, `unread-source`, `unreadable-declaration`, `dynamic-implementation`, `call-rewriting`), its place
   (path and line) and its reach (`repository` or `call`). The repository-wide flag is true if and only if some cause
   has reach `repository`.
2. **A call-reach cause leaves unproven only the calls it can reach.** A dynamic implementation reaches only a call
   whose receiver's static type is not a placed repository class (a class cannot be the type of a runtime-made
   interface instance). `@Delegate` reaches a call on the carrier, on a type below it, or on a type whose hierarchy has
   gaps or is unplaced. `@ExtensionMethod` reaches the calls written inside the annotated declaration. A source whose
   syntax error is confined to member bodies reaches the calls a dynamic implementation reaches, and nothing else.
3. **A cause whose reach cannot be bounded stays repository-wide.** A source the grammar cannot parse outside a member
   body, a JVM source no extractor reads and a declaration the project could not read keep the repository-wide reach
   (ADR-0072 decision 6). No estimate of what an unread file touches is made.
4. **A reach is never widened by a rule that cannot prove it.** Where a construct's carrier or scope cannot be
   determined, its cause is repository-wide. A receiver whose type the reading does not place is reached.
5. **A repository-wide cause is one cut per answer.** Each family that reads receiver answers emits, at most once per
   query, one cut that lists every repository-wide cause with its place, with the reach `anything` for the runtime
   (ADR-0042); the calls it affects keep their own per-call cuts. A family that today keeps the edge without a cut for
   such an answer (`callers`, `impact`) emits it, and its status follows the cut.
6. **A cause is proven narrower only by what the sources prove, and every measurement precedes a rule.** A narrower
   rule is built only for a condition a corpus measurement shows firing (RFC-0047 U0).
7. **The dispatch closure's vetoes are not changed.** This decision concerns whether a call's declaration is proven,
   not which bodies may run.

## Consequences

- A repository with one Kotlin or unparsed file keeps its repository-wide answer, now with one cut that names the file,
  and `callers` and `impact` stop reporting `complete` for it.
- A repository with a dynamic implementation or a `@Delegate` recovers the proofs of every call the construct cannot
  reach.
- A wrong reach is a wrong proof: the tests of RFC-0047 name each excluded input.
- `CUT_CAUSES` gains four members and the `unproven` answer gains one optional field; no schema version changes.

## Not decided here

- A package-level estimate for unread sources (a later rule with a shadow-aware name resolver and its own measurement).
- The other readers of the boolean gate (`implementedDeclarations`, `createJavaArgumentCounts`, `perPlacedType`): they
  answer `unknown` where the gate is false.
- The dispatch closure's global veto.
