# ADR-0082: A use in a file's top-level statements names the file as its dependent

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0017](0017-owner-of-a-member-expands-only-whole-type-edges.md),
  [ADR-0039](0039-behavior-changes-pass-a-corpus-gate.md), [RFC-0002](../rfc/0002-facts-contract.md),
  [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0031](../rfc/0031-cut-ledger-and-outcome-control.md)

**In short:** a declaration used by a statement a file writes outside every declaration (`bootstrap(AppModule)`,
`app.use(router)`) had no dependent the fact could name. The answer either dropped it with `complete`, or credited a
function of the file that does not write the use. The file itself is now the dependent: an entry of `symbols` of kind
`file`, with the lines that write the use.

## Context

The index records no edge for a read of a value, so the uses of a reached TypeScript declaration are read from the
sources that import it, bound by the file's own scoping and credited to the innermost declaration that writes them.
A use outside every declaration has no such declaration.

RFC-0010 stands the file's top-level functions, classes and components in for its top-level code ("`imports` into a
symbol: yes when the importing file's top-level code uses it"). Measured on the corpus by the occurrence oracle
(RFC-0031 rule 5):

- a file that declares none of them loses the dependent, and the answer stays `complete`: the file that bootstraps an
  application's root module is not among the callers of that module;
- a file that declares one lists a declaration that does not write the use, with no line.

`ImpactedSymbol` requires a declaration, so no entry can name the file.

A cut at the place was implemented first: it turned `partial` every answer that reaches a route table, an application
configuration or a root component (fourteen existing end-to-end tests of three suites). A cut there says "cannot
tell" about a use the sources prove.

## Decision

1. **The file is the dependent.** A use the sources prove, written in a statement outside every declaration of its file,
   makes the file's top-level code depend on the declaration used. `symbols` lists it as an entry of kind `file`: `file`
   is the path, `symbol` the name the index gives the file's node (its base name), `line` and `endLine` the file's
   span, and `via` carries the lines that write the use, `basis: "reference"`, `derivation: "proven"`. The use may be
   of a declaration of the same file or of an imported one.
2. **An export is not a use.** A statement that only re-exposes a name (`export { X }`, `export { X } from`,
   `export default X`) writes no dependence of the file's code: whoever imports the name is reached through its own
   edges.
3. **The stand-in ends where the sources are read.** In a file whose places that write the name are all settled (a use
   a declaration holds, a use the file holds, an export, a binding of another declaration), no top-level declaration
   stands in for the file's code. A file with a place whose binding is unknown keeps the rule of RFC-0010, as does a
   language whose written uses are not read.
4. **The walk stops at a file.** RFC-0010 already says that a file node leads nowhere: what loads a file is the answer
   of `importers` and of the module part of `impact`, not a chain of callers. A file entry is expanded into nothing,
   reaches no entrypoint by itself, counts no fan-in and adds no cut.
5. **Test sources stay out**, as for every other dependent (RFC-0010).
6. **Seeds are unchanged.** A change to a file's top-level statements still seeds the file's top-level symbols
   (RFC-0010 "Seeds"). Naming the file as the seed there is a separate decision with its own evidence.

## Alternatives considered

- **A cut at the place of the use.** Dropped: it degrades every answer that reaches a file of routes or of
  configuration to say "unknown" about a proven use.
- **Keep the stand-in.** Dropped: a silent omission where the file declares no function or class, and a dependent that
  does not write the use where it does.
- **A second collection beside `symbols` for files.** Dropped: every consumer would merge two lists of dependents that
  share depth, confidence and `via`; a kind tells them apart at no cost.
- **Follow the files that import the file.** Dropped: loading a module is not a use of what its statements use, and the
  module part of `impact` already answers what a file reaches by imports.

## Consequences

- The fact gains a kind of entry in `symbols`. A consumer that feeds every entry back as a `callers` target gets an
  unknown-symbol fault for a file entry; the kind says not to.
- A declaration credited before through the stand-in, and everything reached only through it, leaves the answers of
  the files whose uses are read. The value ledger of the corpus gate shows them as lost; each is a declaration that
  does not write the use.
- Languages whose written uses are not read keep the stand-in until they are.
