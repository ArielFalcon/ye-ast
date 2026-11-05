# ADR-0022: Recover selected evidence through typed query replay

- Status: Accepted, 2026-11-04, owner
- Decision source: the owner, 2026-11-04: "Vale, resuelvelas como recomiendas", accepting the preceding six recommendations: typed `select` on existing tools, explicit projections, verified query replay without final-result retention, a declared-repository selector, per-repository revision/live selection, and result-bound cursors.
- Related: [ADR-0010](0010-trust-modes.md), [ADR-0020](0020-host-budgeted-snapshot-memory-cache.md), [ADR-0021](0021-enable-snapshot-memory-cache-by-default.md), [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0010](../rfc/0010-impact-queries.md), [RFC-0011](../rfc/0011-cross-repository-impact.md), [response-modes plan](../../superpowers/plans/2026-11-04-common-mcp-response-modes.md)

**In short:** Keep query families as the units of analysis. Recover a typed selection by repeating its semantic query and verifying the result identity. Resolve repository and snapshot context explicitly, and paginate projections without retaining final facts between requests.

## Context

The common-mode migration distinguishes concise findings, explanatory details and exhaustive structured facts. Its text can omit recorded origins, dependency support and cut places. Requesting a whole fact to recover one category adds irrelevant data to the response.

The current tools are bound to one repository. A coordinate from another repository therefore cannot be forwarded directly to callers or outline. Workspace traversal currently uses committed revisions; enabling live reads requires consistent capture throughout discovery, link resolution and traversal.

The snapshot cache retains serialized SHA sources and completed extraction findings, not final facts or live results (ADR-0020/0021). A result-handle store would introduce a new retention lifecycle. Verified replay can use the existing query path while explicitly refusing continuation when its result has changed.

| Choice | Decision and consequence |
|---|---|
| Recovery API | Typed `select` on the existing query tool; no separate expansion tool in this version |
| Selected output | An explicit projection with source provenance, selection and page metadata; never a shortened original fact |
| Result lifecycle | Recompute and verify; no cross-request final-result store or result handles |
| Repository context | Optional `repo` identifier from the externally declared set; omitted means the launch repository |
| Snapshot context | Per-repository `revision` or `live`, mutually exclusive; capture once for each query operation |
| Pagination | Stateless opaque cursors bound to source identity, selection and deterministic position |

## Decision

1. **Selection stays with its query.** Add optional `select` only to tools with implemented typed selections. Their schemas describe the supported subjects and evidence categories; there is no free-form SQL, code or JSONPath input. Start with impact/callers recovery of recorded handler origins, cut places and workspace-link evidence. Other tools gain selections when their contracts define a useful recorded category. `select`, `mode` and page controls do not change seeds, scope, traversal or the source fact's identity.

2. **Selected data has its own response shape.** A selected response is discriminated as a projection, with the source result identity, repository/snapshot provenance, analysis status/reason, material global cut summaries, relevant recorded anchors, selection and page information. Do not copy every original evidence/cut-place array into every page; exhaustive cut places are themselves selectively recoverable, and unselected full retains them all. Preserve material global limitations as well as relevant local ones without implying a causal relationship the source did not record. Known source data does not make an unknown source complete, and presentation omissions never create analysis cuts. Unknown sources retain their reason and have no invented empty selection value.

   Without `select`, `full` keeps the complete public fact. With `select`, `full` returns all structured data for the requested page of the selection; summary/details render that same selected page and provide its projection receipt. Page metadata states whether more recorded matches remain. It never labels one page as the whole fact or the entire selection. Schema and documentation distinguish original facts, original text receipts and projected results. References in a selected page must be interpretable without reconstructing unrelated arrays: include the referenced records or an explicit resolvable reference context, without inventing edges.

3. **Replay has a deterministic identity and an explicit assertion.** Deterministic participating responses expose a model-visible `resultIdentity` as transport metadata, outside the fact. Derive it after public filtering and redaction from the normalized semantic query and deterministic public fact, including schema/producer and contributing-read provenance. Normalize context using resolved committed SHAs and complete live identities, preserving subjects, change selection, scope, budgets and actual membership. Exclude `mode`, `select`, pagination, identity assertions, absolute clone roots, refresh/staleness sidecars and timestamps. Different analysis inputs or facts must not share an identity. Return enough pinned replay arguments for the caller to repeat the query without a hidden saved request; the digest alone cannot retrieve that context. This does not create a new domain fact schema.

   A recovery request repeats the original semantic arguments with committed revisions pinned and can assert the source using `expect`. Recompute through the existing use case and compare identities before emitting the selected data. A first selected query may omit `expect` and establish a new source identity; it must not claim continuation of an earlier result. Subsequent pages always assert the cursor's identity. Check current declarations and trust on every call. A changed identity is a typed failure, never a silent restart, an empty result or substitution of current `HEAD`. Hashing a result does not retain it between requests. Deadline-cut facts have no guaranteed replay identity and must not advertise stable recovery or pagination.

4. **Repository targeting uses declared identities.** Add optional `repo` to the query entrypoint as a repository identifier, not an arbitrary filesystem path. Resolve it through the externally declared repository set available to the host, including the launch repository. Missing or ambiguous identifiers fail explicitly; they never fall back to the launch root. Resolve related file/symbol/range targets in the chosen repository and recorded snapshot. The selector grants no trust and performs no installation write. Additional workspace membership retains its existing explicit semantics.

5. **Mixed workspace reads capture each repository once.** Each repository may select a committed `revision` or `live`; the schema and runtime reject both together. Live remains conditional on that repository's external `trusted` declaration. Discovery, matching and every walk for a repository use its captured snapshot for the duration of that operation. A live snapshot records both `head` and `stateId`; replacing it with its head SHA is invalid. Preserve the snapshot vector, every contributing read, per-repository uncertainty and stale notices. This is not a cross-repository atomic-time guarantee. Trigger `base`/merge-base semantics, analysis scope and trust boundaries remain explicit. After a live state changes, replay/pagination of the old result fails; retrieving past live results is outside this version.

6. **Pagination is stateless and deterministic.** Page controls apply only with a supported `select`. A page uses an explicit positive safe-integer `limit` and optional opaque `cursor`; this decision introduces no empirically unverified default page size or token cap. The versioned cursor binds the result identity, normalized selection, page limit and next deterministic position. Replaying the source query and validating those fields suffices; no cursor-to-result store is required. Changed source/selection or incompatible cursor arguments fail explicitly. Count only recorded matches; preserve the source's partial/unknown interpretation. The requested page limit is independent of traversal budgets. No deadline-based page slicing or arbitrary ranking is introduced.

7. **Installation applies the user's chosen trust to the selected set.** As the owner specified during the discussion, selecting project repositories and `trusted` in installation applies the external declaration to all explicitly selected repositories in one operation. Reuse the existing trust writer and report actual per-repository outcomes. The user does not repeat the choice for every repository; membership or repository content does not grant trust. MCP tools remain read-only.

## Consequences

- The six strategy decisions are closed. Detailed wire schemas, implementation ownership and offline proof cases are completed in the plan's bounded capability designs. Current schemas do not advertise the new arguments before implementation.
- The initial mode migration remains adapter-only. Query targeting and mixed workspace reads require core/composition/transport work in later coherent changes; adding schema fields alone cannot provide them.
- Selective replay reduces the data delivered for an investigation but reruns query-specific analysis. The SHA snapshot cache can reuse its existing stages, without promising cache hits or lower latency. Live refresh remains necessary. Real task-level benefit is unmeasured.
- Stable identity and page metadata extend the presentation contract when recovery is implemented. Add them to the appropriate receipts/output schemas together; they do not silently enter the exact minimal receipts of the earlier mode-only migration or stored facts.
- Failure to replay an old live result is an intentional capability boundary. This version needs no final-result cache, handle expiry or new retention budget and does not supersede ADR-0020/0021.
- The owner initially deferred empirical evaluation until the pending `main` improvements were complete, then confirmed readiness and authorized the built-current-engine evaluation. The plan records that baseline and its gaps. Empirical results evaluate the accepted design; they were not needed to choose these six semantics.

## Not decided here

- Exhaustive per-family selection schemas, exact fault codes, cursor encoding and digest implementation, defined in the bounded designs using existing ports and conventions.
- Page-size defaults, extra selection categories, representative-origin ranking or performance/adoption claims; these require the plan's deferred evidence track.
- Retention of old live results, result handles, a separate expansion tool, a resource-based replacement or a universal pipeline executor. Reconsidering an accepted strategy requires an explicit later decision with evidence.

