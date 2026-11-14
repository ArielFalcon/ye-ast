# ADR-0085: A module that is not read is bounded by the strings it writes

- Status: Accepted, 2026-11-14, owner
- Decision source: Owner's standing instruction of 2026-11-13: "No te detengas más a preguntarme, escoge tú la opción
  recomendada" (stop asking me; pick the recommended option yourself). The design below is the recommended one, adopted
  under it and reported to the owner afterwards.
- Related: [ADR-0036](0036-dependence-is-the-compile-time-binding.md),
  [ADR-0081](0081-a-syntax-error-confined-to-a-body-leaves-its-sources-declarations-read.md),
  [ADR-0082](0082-a-use-in-a-files-top-level-statements-names-the-file-as-its-dependent.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md)

**In short:** a TypeScript source whose module statements cannot be proven read is left out of the module statements
the dependents of a declaration are read from, and the readers that reach the declaration through it leave the answer
with no cut. The source still bounds what it can name: every module statement writes its specifier as a string. A
declaration whose module one of those strings resolves to may be exposed by the unread source, and the files that read
the unread source are then a cut of that declaration, not an absence.

## Context

Reproduced on `callers`, each beside a control whose barrel parses and lists the reader:

| The unread module | The reader | Answer |
|---|---|---|
| `export * from "./a"` and a syntax error beside a module keyword | `import * as b from "./b"`, `b.X` | `complete`, no dependent |
| `export { default } from "./a"` and the same error | `import D from "./b"`, `D()` | `complete`, no dependent |
| the middle one of two `export *` barrels | a namespace import of the outer barrel | `complete`, no dependent |

`impact` gives `partial` in the three, through the `module-unread` cut of the module, with the same dependents missing.

The reader of module statements reports the source in `unread` with no statement. The dependents read from sources
receive the statements only, so the chain of re-exports stops at the unread source without a trace. A cut at every file
that reads any unread source would be sound and would mark every answer of a repository that holds one broken file.

## Decision

1. **The bound.** For a source whose module statements are not read, the reader states the repository files the
   strings it writes resolve to, with the resolver of the read statements. The strings are every run of text between
   two consecutive quote characters of the source that holds no line break, a run that holds a backslash taken by the
   value it spells too. This is a superset of the specifiers of its module statements whatever the syntax error is:
   no tokenization is trusted.
2. **A reached module makes the unread source a link of the chain.** When the chain of modules that expose a
   declaration holds a file an unread source reaches, the unread source joins the chain as a module that may expose the
   declaration under any name. The chain continues through the sources that re-export from it.
3. **A reader of the unread source is a cut.** A file that reads a declaration of the chain through the unread source,
   by a namespace or by a name it imports from it, is `hidden-caller` at the place it writes the read, unless the
   answer already lists that place as a dependent. No reason and no entry kind is added.
4. **An absent bound reaches every module.** An unread TypeScript source whose reader stated no bound is treated as
   reaching every module of the repository.
5. **The bound of the change.** A declaration whose chain holds no file an unread source reaches gains no cut. A
   repository whose sources are all read answers byte-identically. The `module-unread` cut of `impact` and of
   `importers` is unchanged.

## Alternatives considered

- **Read the statements the parser recovered.** Dropped as the answer: they are a lower bound of what the source
  writes, so a statement swallowed by the error is still lost in silence. It may be added beside the cut later.
- **A cut at every reader of every unread source.** Dropped: one broken file would mark every answer of the repository,
  and a mark on every answer says nothing.
- **Tokenize the unread source for its string literals.** Dropped: a regular expression or a template with a
  substitution shifts where a tokenizer without a parser sees a string start, and a specifier it skips is a false
  `complete`.

## Consequences

- The `unread` entries of the module dependencies gain the files the source reaches, optional as the reader's other
  later additions are; the dependents read from sources receive `unread` beside the statements.
- Cost: one pass over the text of each unread source and one resolution per distinct string, paid only by sources that
  are not read.
- A declaration read through an unread source is `partial` with the reader marked, where it was `complete` without it.
