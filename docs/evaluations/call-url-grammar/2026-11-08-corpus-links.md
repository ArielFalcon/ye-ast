# One call URL grammar: corpus links (2026-11-08)

Before and after the call-site readers state their targets as the URL the call reaches, as written, with
`core/domain/topology/path-template.ts` the only reader of an origin (RFC-0011, "Path templates"). The question: does
any link, unlinked outcome or host change, and is every change explained by that one grammar rule?

## Method

- Corpus: the test workspaces `petclinic`, `realworld-nx`, `jhipster-monolith` and `shopizer` (ThingsBoard excluded).
  Each repository was cloned into a scratch directory; the corpus itself was not written.
- Per workspace, one at a time, through the CLI: `ye-ast init --trust trusted [--workspace <manifest>] <first repo>`,
  then `ye-ast workspace <first repo> --offline`, with the cache and the trust records under the scratch directory.
  Link counts are deterministic, so the run order and the machine load do not change them.
- Every HTTP call site is classified once: linked; unlinked as `unmatched`, `ambiguous` or `could-match`; `external`
  (a complete target that names a host and lands nowhere); `internal` (a complete target that names no host and lands
  nowhere); `undecided target` (an `unknown` target). Event call sites are counted apart.
- Before: local `main` at `315f1c3b`, which already reads every URL through the grammar but writes the origin as the
  target's base. After: the change, which writes the origin inside the target's path.
- Per call site, the outcome before and after was compared, and the target with the origin read back into the path.

## Counts (identical before and after)

| Workspace | Links | Unmatched | Ambiguous | Could match | External | Internal | Undecided target | Event sites |
|---|---|---|---|---|---|---|---|---|
| petclinic | 31 | 7 | 0 | 0 | 2 | 0 | 4 | 0 |
| realworld-nx | 17 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| jhipster-monolith | 0 | 10 | 0 | 0 | 0 | 42 | 0 | 0 |
| shopizer | 171 | 24 | 2 | 0 | 0 | 0 | 17 | 60 |

## Changed links

None. No call site changed its outcome, and no target changed beyond where its origin is written: 34 targets carry the
origin in the path instead of the base (petclinic 33: 31 Angular service calls to `http://localhost:9966`, two Spring
calls to `http://customers-service` and `http://vets-service`; shopizer 1: `http://localhost:8080`). The host each names
is the same origin, read back by the grammar.

## Holes inside one segment

A call segment that a run-time value fills only in part (`user-{}`) is already a template segment of text and holes.
Measured over the same corpus:

- routes with a parameter inside one segment: 0 of 432;
- complete call sites with a hole inside one segment: 0;
- letting the TypeScript reader accept a URL that starts with a run-time value inside its first segment decides 6
  shopizer calls (`crud.service.ts`, the `${base}${path}` wrappers), and all 6 become false `external` targets. That
  relaxation is not made.
