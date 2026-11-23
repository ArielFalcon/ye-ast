# ADR-0158: The Java call-site readers take a root call's methods from the one reading of the calls

- Status: Accepted, 2026-11-23, owner
- Decision source: Owner, 2026-11-23, over unit L23 (translated): profile inside `call-sites` and, "if the global part
  dominates, keep the dispatch index and the reachability graph incrementally instead of per-file answers"; and
  2026-11-17: "todo lo que queda pendiente se debe ir integrando a medida que se pueda, lo haces de forma autonoma"
  (everything pending is integrated as it can be, autonomously). The targets it serves (translated): "Times must sit
  between a few hundred milliseconds and, for the most critical jobs, 3-5 s in specific cases; the p75 should be below
  1 s", "without sacrificing functionality and quality".
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §6, units L23c and L23b;
  [ADR-0155](0155-a-java-syntax-tree-is-shared-by-its-holders-and-kept-resident-in-the-snapshot-cache-by-its-path-and-content.md);
  [ADR-0156](0156-background-priming-passes-its-turn-between-units-and-gives-the-mirror-lock-up-where-it-costs-nothing.md);
  [ADR-0146](0146-the-outside-supertypes-of-a-java-method-are-kept-by-the-questions-its-closure-asks.md)

**In short:** the Java call sites are not kept incrementally: no global part of the stage dominates, and the one that
depends on the whole project cannot be kept by what an edit changes. What the profile showed instead is that each
reader selects again, for every call it expands, the methods the shared reading of the calls already selected with the
same arguments. A reader now takes them from that reading, so the stage drops by about a fifth on the largest Java
repository and no fact changes.

## Context

After an edit, `trace` and `workspace` derive the Java call sites of the whole snapshot again (the slot
`trace-call-sites` and ADR-0045's `workspace-call-sites` are keyed by every source). Measured through the stdio MCP on
`main` `a08367510`, right after an edit of one Java file, median of five, with the stage split by temporary
instrumentation (since reverted) and confirmed in process with resident trees:

| shopizer/backend (1,204 Java files) | ms |
|---|---|
| `call-sites` stage | 878-890 |
| parse (resident trees, ADR-0155) and `createJavaProject` | 12 + 54 |
| the reading of the calls (`javaCallUnits`): the invocations of every type, a syntactic walk | ~240 |
| the reading of the calls: the methods each invocation may select | ~170 |
| per reader (HTTP, event): the reachability fixpoint | ~45 each |
| per reader: the expansion of every owned invocation | ~105 each, of which ~88 select the root call's methods again |
| per reader: the rest (reading requests and publications) | ~65 each |

On jhipster-monolith/application the Java part is about 45 ms of a 190 ms stage (the rest is the TypeScript call
sites).

| Option | Verdict |
|---|---|
| Keep the reading of the calls (the dispatch index) and the reachability graph across an edit | Rejected: a method selection reads the whole project (receiver types, supertypes, the beans a `@Qualifier` names, which records the listing in 94 of 1,173 files), so an edit anywhere may change any selection; the per-file form of ADR-0154 (never landed) measured slower than the whole reading |
| Keep the syntactic invocations per resident tree | Not now: ~240 ms here and ~230 ms in `data-effects`, but a new memory tier whose charge and lifetime ride on ADR-0155's trees needs its own measurement and decision |
| Read each member's nodes once instead of twice in `invocationsOf` | Rejected: measured 20-30 ms; the cost is the tree's nodes, not the second walk |
| Take a root call's methods from the reading of the calls when the arguments are the same | Chosen: ~176 ms of the ~210 ms the two expansions take, no new state |

The reading of the calls is built once per project and shared by every reader (`javaCallSiteUnits`); its selections are
what the readers' reachability already uses. A selection is `stagedSelections(call, project, text, concrete, proof)`,
and `text` reaches it only through `fieldOf`, a function of the project, the type and the name: the shared reading and a
reader's own evaluator answer it alike for the same project.

## Decision

1. **The same arguments, the same selection.** When a reader expands a call from a scope whose concrete type is the
   call's own type, it takes the call's methods from the shared reading of the calls; with any other concrete type, or
   for a call the reading holds no selection for (one written outside a member), it selects them as before.
2. **Nothing is kept.** The selections live as long as the reading of the calls of one project, as before.

## Consequences

- Measured through the stdio MCP, `main` against the change, one Java file edited before each call, median of five:
  on shopizer/backend `call-sites` falls from 896 to 707 ms in `trace` (wall p50 4,031 -> 3,641 ms) and from 888 to
  723 ms in `workspace` (wall p50 2,024 -> 1,834 ms); on jhipster-monolith/application it moves within noise (205 ->
  180 ms). In process with resident trees the stage falls from 865 to 707 ms. The call sites are byte-equal on four
  corpus repositories, and the warm differential on shopizer/backend and petclinic/backend-microservices passes (51
  steps, none differing).
- The post-edit Java cost left in these stages is the syntactic walk of every type and the project-wide selection;
  `data-effects` (about 1.5 s on the same edit of `trace`, of which ~645 ms are the per-file receiver bindings) is the
  larger stage and is reported to its own unit.

## Not decided here

- L23b, the outside supertypes of `callers` after an edit (ADR-0146): the whole hierarchy a closure with a functional
  interface reads costs ~110 ms on shopizer/backend and nothing on jhipster; keeping it needs per-file hierarchy parts
  whose supertype resolution is recorded, more than one bounded change for a gain at the threshold. Dropped.
- A per-tree memory of the syntactic invocations, and keeping the per-file receiver bindings of `data-effects`.
