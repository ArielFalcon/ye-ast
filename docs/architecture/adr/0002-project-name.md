# ADR-0002: Project name ye-ast

- Status: Accepted, 2026-10-29, owner
- Decision source: the owner, 2026-10-29 (translated): "fine, this project will be called ye-ast", explained as "a play
  on words between yeast (because it is the foundation for the LLM to grow) and AST because it was already in the
  word".
- Related: [RFC-0008](../rfc/0008-distribution.md)

**In short:** the project, its npm package and its CLI are named `ye-ast`.

## Context

Availability checked on 2026-10-29:

| Registry | `ye-ast` |
|---|---|
| npm | free |
| npm scope `@ye-ast` | not verifiable without creating the organization |
| Homebrew | free |
| crates.io, PyPI | free |
| GitHub user or organization | free |

Known collisions: the npm package `yeast` (an id generator) sounds the same; a small GitHub repository
`yvan-sraka/YeAST` ("Yet Another Shell Trick").

## Decision

The repository, the npm package and the CLI binary are `ye-ast`.

## Consequences

- Reserve the npm name, the GitHub organization and the npm scope before the first publication.
- Documentation writes the name with its hyphen to keep it apart from `yeast` in searches.
