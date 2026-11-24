# ADR-0164: A declaration carries its signature as a fact

- Status: Proposed, 2026-11-24
- Decision source: Owner, 2026-11-24, on signature lines superseding the clause of ADR-0078: "si entiendes que esto
  tiene alto ROI aplicalo" (if you judge this has a high return, apply it). Lead decision under it: applied, and kept
  only if the evaluation shows the reads after an answer fall. And the target: "agregando info util que se
  desaprovecha o no se tiene hoy" (adding useful information that is wasted or missing today).
- Related: [RFC-0041](../rfc/0041-presentation-model-for-mcp-answers.md) §3.10;
  supersedes the clause "No tool reads source text" of
  [ADR-0078](0078-locating-a-declaration-is-a-query-family.md) and of RFC-0038 for the signature only, and the refusals
  "A code snippet or the signature" of RFC-0015 and "Parameter lists, return types, generic parameters" of RFC-0017;
  [ADR-0008](0008-typescript-compiler-api-source.md), [ADR-0013](0013-coverage-grows-only-with-evidence.md),
  [ADR-0077](0077-derived-facts-persist-by-content-in-ye-asts-own-store.md), RFC-0027

**In short:** the header of a callable or type declaration (modifiers, name, type parameters, parameters with types,
return type, heritage, `throws`) is a fact the language readers produce and the answers carry. It tells overloads
apart and answers "what does it take" without opening the file. No body, default value, annotation or other line of
source is added.

## Context

- A declaration is a kind, a name and a span (`src/core/domain/outline/outline-fact.ts:4-14`,
  `src/core/ports/code-graph.port.ts:49-61`). Three `fetchBagRelationships [method]` rows of one outline cannot be
  told apart, and the oracle of the evaluation separates `updateUser(AdminUserDTO)` from
  `updateUser(String, ...)`: this is a correctness gap, not only a convenience.
- In the trace task the four MCP sessions read 15 to 17 source files after the answer; file operations fell with the
  MCP (12.9 to 8.4 per session) and tokens did not (50.7k against 53.3k).
- RFC-0015 refused the signature because it "goes stale against the snapshot" and multiplies bytes. A signature read
  at the answer's snapshot is as fresh as the line numbers beside it; the bytes are bounded by where it prints.
- The readers that would produce it already walk each declaration's syntax:
  `core/adapters/typescript/declared-member-names.adapter.ts` and
  `core/adapters/tree-sitter/java-member-names.adapter.ts`.

## Decision

1. A signature is one line built from syntax parts: kept modifiers (`static`, `abstract`, `async`, visibility),
   name, type parameters, parameters with their types, return type, `extends`/`implements`, `throws`. It holds no
   body, default value, initializer, decorator, annotation or comment; whitespace runs are one space.
2. The TypeScript reader (compiler API) and the Java reader (tree-sitter) produce it as an optional `signature` of
   `DeclaredDeclaration` (`core/ports/declared-member-names.port.ts`). Absent means no reader produced one, never an
   empty parameter list. A language plugin that adds one carries conformance fixtures.
3. The declaration model carries it, and the value types that name a declaration gain an optional `signature`:
   `OutlineDeclaration`, `ImpactedSymbol`, `Seed`, `Handler`, `TraceStep`. One application helper reads the
   signatures of the declarations an answer names, from per-file derived facts kept by path and content. The reader is
   the one owner of the value.
4. It is repository content read as data, never run, and leaves the process through the redaction the public fact
   already passes.
5. In an MCP reply the signature replaces the bare name in the row label: on `outline` rows and on any row whose name
   is ambiguous in its group in both modes; on the symbols of `callers` and `impact`, entrypoint handlers and trace
   steps in `details`.
6. The text of a cited line is not added, on request or otherwise.
7. Both units change behaviour under `src/core` and pass the corpus gate.
8. The decision is kept only if the evaluation shows source reads after an answer fall; otherwise rule 5 narrows to
   ambiguous names, which is the correctness part.

## Consequences

- A row that prints a signature grows by about 30 to 50 bytes; an outline of two files by about 1 KB, less than the
  envelope it loses (ADR-0161).
- Overloads are distinguishable in every family.
- The facts of five value types gain a field; no schema version moves while the MCP has no consumers.
- "Facts about code, not code" (RFC-0002, RFC-0015) is narrowed: the header of a declaration is a fact about it.

## Not decided here

- Annotations and decorators as facts (RFC-0041 open question 4).
- Declared types of fields and properties, which the two readers do not report as declarations today.
- Cited-line text, reopened only by the evaluation (RFC-0041 open question 3).
