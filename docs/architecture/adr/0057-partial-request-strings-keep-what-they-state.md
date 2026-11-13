# ADR-0057: Partial request strings keep what they state

- Status: Accepted, 2026-11-12, owner
- Decision source: Owner, 2026-11-12: "Corrígelo todo de forma planificada y con calidad, que se integre bien a las reglas del proyecto y que resuelvan los problemas detectados para mejorar la calidad multi repo", authorizing mechanism M3 of the diagnosis, a string abstract domain for prefixes and segments. The rule for alternatives follows the precedent of one link per consuming listener in RFC-0011 slice 5.
- Supersedes: ADR-0054 decision 1 only (one URL expression states the route; each expression that states its route does now).
- Related: ADR-0013, ADR-0051, ADR-0054, RFC-0011, RFC-0028

## Context

A request whose path is partly known lost what it did state in three places, measured on a real web application and on
the RealWorld sample:

1. A URL helper that tests `path.startsWith('http://')` and trims leading slashes decided only a fully literal path. On
   `'/orders/' + id` both tests answered "unknown", the two arms of the guard differed, and the whole URL collapsed to
   one unknown, dropping the stated `/orders/`.
2. A request options object written with a shorthand member (`{ params }`) or a spread (`{ ...(q ? { params } : {}) }`)
   was unknown as a whole; the wrapper read an unknown member, the request was never bound to its caller and the call
   was absent from the answer without a trace (an ADR-0051 violation).
3. A path with one undecided branch (`'/articles' + (type === 'FEED' ? '/feed' : '')`) collapsed to one unknown URL, so
   neither route linked.

## Decision

1. A partial string is the existing `text` value (literal parts and holes); no new value kind. `startsWith(text,
   literal)` is decided by the literal prefix the text states: true when the prefix starts with the literal, false when
   they differ within their shared length, undecided when the prefix is shorter and the text is not closed (a text that
   begins with a hole is undecided). Trimming leading slashes strips them from the stated prefix; a text whose stated
   prefix is only slashes before a hole is unknown, since the hole may start with one. `split`, `filter`, `map` and
   `join` get no transfer function.
2. An object literal accepts shorthand members and a spread of an object literal or of a conditional whose two arms are
   object literals. A key a conditional spread may set reads as a choice between the arm's value and the earlier member of
   the same name (absent when none). Any other spread keeps the whole object unknown.
3. When exactly one undecided choice with differing outcomes reaches the URL, the request states one URL per outcome,
   true outcome first. Two or more such choices state none: the URL stays the one unknown expression. Alternatives
   replace the single expression in `stated.expressions` only when they differ.
4. The join reads every URL expression of a call site that states its route (ADR-0054 decision 1 now applies per
   expression), once per distinct path. The call site's links are the union of its alternatives, once per `Link.id`. An
   alternative that is ambiguous across repositories does not block the others: the call site reports the merged
   ambiguity beside its links. Of the alternatives some route could take, the first path in sorted order is reported
   undecided. Gateway inference and gateway decisions read every such path.
5. Amendment, lead decision under the owner's standing instruction (2026-11-13). A string derivation the evaluator does
   not model (`split`, `join`, `reduce`, `padEnd`, `slice` and any other method) yields an explicit unknown, never a
   guess, and never an absent request: the request stays present as an unresolved call site with the cause
   (ADR-0051). A path the code fills at run time from nothing it states, taken whole as the request's path, is that same
   unknown instead of a path of one hole; a hole inside a text stays a hole. `trim`, `trimStart` and `trimEnd` are
   modeled exactly: a literal is trimmed, and a text keeps its stated parts, since only whitespace at its edges goes; an
   edge that is a hole stays the hole, and an edge made only of whitespace next to another part is undecided.

## Consequences

- Requests whose path is stated behind a URL builder, an options object or a single branch link by route instead of
  answering nothing.
- Several links can come from one place; the call site's stated expressions say that they are alternatives. No link
  field and no schema version change.
- A request whose options object is unknown for another reason (a spread of an identifier) is still absent; that gap
  needs its own scoped fix. A path rewritten only by `replace`/`replaceAll` calls, in a loop or not, keeps the text
  before the first character a pattern begins with and is present.
