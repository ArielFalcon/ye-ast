# Selective evidence through verified query replay

**Status:** Proposed implementation design for Task 4.2, not an implemented API. Observed checkout: `602ffe695f3e4130f8b5a603e20ccbaa85717200`. Integrate after the reviewed common-mode migration. [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) owns the accepted strategy; this document fixes its initial wire details and implementation boundaries.

## Outcome and constraints

Recover one recorded evidence category by repeating its original semantic query, verifying its identity and returning an explicitly typed page. Analysis still computes the same complete source fact. Selection never changes seeds, coverage, budgets, matching or the source fact's status.

There is no expansion tool, result store, resource replacement, arbitrary JSONPath, executable pipeline, retained live state, default page size or byte/token cap. `full` without selection retains the entire public fact. The projection has its own schema and cannot be mistaken for a shortened fact. Reuse `canonicalJson`, the `Digest` port and existing query execution; do not create another analysis engine or cache.

## Current source and the missing context

`src/mcp/server.ts` already owns public filtering, redaction, response assembly and typed faults. It removes `WorkspaceValue.repositories` from public workspace data and never exposes `FactRead.repositorySources`. `src/core/domain/shared/canonical-json.ts` sorts object keys and preserves arrays; `src/core/ports/digest.port.ts` exposes synchronous `of(text): string`. Composition supplies its SHA-256 adapter.

`ImpactValue` supplies reached-handler seed indexes, module-origin indexes and recorded cuts. `WorkspaceImpactValue` supplies section impacts, provenance reads and `ImpactedLink` records. `EntrypointMap` contains a fact of `Finding<Entrypoint>[]`, whose unknown findings still have evidence. These are the selection owners; importers has paths rather than relationship-line evidence and gains no speculative selection in this version.

Two normalization constraints need explicit treatment:

1. An impact's recorded `mergeBase` is the actual start of its diff. Replaying with `base` equal to that SHA and the recorded head preserves that diff; a branch name must not remain a moving replay base. An unknown impact that never records this context cannot advertise pinned recovery.
2. Replacing persisted workspace membership with an explicit pinned list changes `workspace.source` and composite identity. Recovery must pin reads **without relabelling membership as request-supplied**. The workspace replay contract below solves that actual incompatibility; pretending the two facts are identical would not.

## Initial input contract

Keep the existing semantic inputs and common `mode`. Add these fields only on implemented participating tools:

```ts
type ResultIdentity = `mcp-r1:${string}`; // runtime: 64 lowercase hex digits
type ImpactOwner = { kind: "local" } | { kind: "section"; repo: string };
type CutOwner =
  | { kind: "fact" }
  | { kind: "entrypoints" }
  | { kind: "section"; repo: string }
  | { kind: "read"; repo: string; index: number };

type EvidenceSelection =
  | { kind: "handler-origins"; owner: ImpactOwner;
      handler: { path: string; symbol: string; line: number } }
  | { kind: "module-origins"; owner: ImpactOwner;
      module: { file: string; snapshot: "base" | "head" } }
  | { kind: "entrypoint-evidence"; findingIndex: number }
  | { kind: "cut-places"; owner: CutOwner; cutIndex: number }
  | { kind: "workspace-link-evidence"; linkId: string };

type EvidencePageRequest = { limit: number; cursor?: string };
type RecoveryInput = {
  select?: EvidenceSelection;
  page?: EvidencePageRequest;
  expect?: ResultIdentity;
};
```

This is a closed discriminated union, specialized by registration:

| Tool/branch | Accepted selections |
|---|---|
| entrypoints | `entrypoint-evidence`, `cut-places` at fact/entrypoints owners |
| impact, local | `handler-origins`, `module-origins`, `cut-places` at fact owner |
| callers, local | `handler-origins`, `cut-places` at fact owner |
| impact/callers, workspace | Section handler origins, section module origins when recorded, fact/section/read cuts, workspace-link evidence |
| importers, outline, workspace, decisions | No `select`, `page` or `expect` in this initial release |

Reject a category unavailable for the tool/branch in advertised schema and runtime. Callers must not advertise module support that it does not compute. Workspace callers may accept a section module selection only if that branch actually produces modules; initially restrict it to workspace impact. `workspace-link-evidence` is never accepted for a local result.

`select` requires `page` with an explicit positive safe-integer `limit`; `page` without `select` is invalid. Indexes are nonnegative safe integers, and handler lines are positive safe integers. Require all listed subject fields and reject extras. `expect` is allowed with or without selection, for a verified whole-fact request as well. A cursor already asserts its source; if `expect` is also present it must equal the cursor identity. No preceding summary call is required.

## Workspace replay pins, with membership provenance preserved

Add the following operation input/output to the existing workspace families. This is core read context, not a stored fact or a retained object:

```ts
interface WorkspaceReplayContext {
  version: 1;
  declaration: string; // ws-r1:<64 lowercase hex>
  snapshots: readonly SnapshotRef[]; // one head selection per repo, sorted by repo
}

// Proposed: WorkspaceReposRequest.replay?: WorkspaceReplayContext.
// Proposed: FactRead<T>.workspaceReplay?: WorkspaceReplayContext.
```

MCP exposes `replay?: WorkspaceReplayContext` only on participating impact/callers workspace branches. Translate it into the core request. It grants neither membership nor trust. The complete recipe returned below includes this field when needed; a client echoes data, not a handle. Ordinary requests omit it. Query-protocol requests/results must carry the same read-context fields when these public ports are extended; CLI queries may retain their existing subset and omit replay.

Validation reconciliation, 2026-11-05: advertised Draft-7 schemas and runtime must agree on all expressible structural constraints, including selector exclusions, exact keys and snapshot field types. The server additionally checks strict repository ordering and uniqueness by repository ID before query dispatch; membership, trust and snapshot assertions remain core semantic checks before analysis. Portable Draft-7 has no relational keyword for comparing arbitrary property values across array entries; do not invent a custom keyword or weaken those runtime checks. State these preconditions in the schema description and test semantic rejection separately from structural schema parity. See [Draft-7 validation](https://json-schema.org/draft-07/draft-handrews-json-schema-validation-01), sections 3 and 6.4.

The owner is `workspace-queries.ts`, using `workspaceInForce` and `withAuthorizedRemotes`:

1. Resolve the current effective membership under current trust as today. Before applying pins, compute `declaration = "ws-r1:" + digest.of(canonicalJson(...))` over source (`request`/`persisted`/`none`), trigger ID, normalized member IDs and their original revision-or-live choices, authorized remote declarations, and effective gateways. Missing committed member revision normalizes to `HEAD`. Exclude absolute roots and the trigger's revision/head string, which is separately pinned. Preserve original selection kind and membership source.
2. For a replay input, require the version, declaration digest and exact member/root ID set to match current effective membership. Reject duplicate/extra/missing IDs and a SHA/live kind inconsistent with the original operation selectors. Re-read current trust. A digest mismatch is a proposed core `workspace-replay-mismatch` fault before reading pinned data; it cannot be bypassed by presenting the old context.
3. Within that same membership, use each SHA pin as the read revision instead of resolving its moving member revision. This has the same read effect as a pinned revision, while leaving `workspace.source` and the original declaration provenance unchanged. Preserve existing authorized-remote and offline rules; a pin does not authorize a new remote or a local fallback from an unavailable authorized mirror. If the pinned object is unavailable, keep existing typed fault/`revision-unavailable` semantics.
4. A live pin is an assertion on the newly captured `head` and `stateId`, not a request to open an old state. Under [Task 4.3](2026-11-04-mixed-workspace-snapshots-design.md), compare it with the operation capture before discovery/walk and fail on mismatch. A mutation after capture follows that design's stale-notice rule; this is not an atomic-time promise.
5. Return the actual context through `FactRead.workspaceReplay`, including the chosen SHA of any unavailable remote section whose snapshot is known. Workspace impact forwards discovery's context. No context or source fact survives the operation for replay purposes. Never expose internal mirror roots.

For explicit membership, the returned recipe preserves the original membership arguments and supplies separate pins. For persisted membership, it preserves omission of the list and supplies pins. Changes to the manifest's effective declaration fail verification, while a moving branch with an unchanged declaration can still replay an available old committed SHA. This distinction is covered by an explicit acceptance test.

## Identity and complete replay recipe

Every eligible participating response adds a `recovery` sibling to structured content, outside its Fact/receipt. The text contains the identity and the complete compact JSON recipe when recovery is advertised, so access does not rely on `_meta` or an undisclosed saved request. Do not add an instruction to perform another call or a catalog of unrelated tools.

```ts
type Recovery =
  | { version: 1; status: "available"; resultIdentity: ResultIdentity;
      query: { name: "ye_ast_entrypoints" | "ye_ast_impact" | "ye_ast_callers";
               arguments: Readonly<Record<string, unknown>> } }
  | { version: 1; status: "unavailable";
      reason: "deadline" | "unresolved-context" | "redacted-context" };
```

`query.arguments` is **validated against that tool's semantic input schema**, not an arbitrary dictionary accepted for execution. It includes the selected external `repo` ID, files/targets, scope, budget, changed selection, workspace/gateway arguments and offline policy actually used. Pin revision/head to the actual SHA, or preserve `live: true`; for a known impact pin `base` to its recorded merge base. Include workspace replay context as specified above. Omit `mode`, `select`, `page` and `expect`. Preserve omitted default membership; do not introduce an explicit list to make a recipe look pinned. A replay is a normal call of the named existing tool with those arguments and optional recovery controls; there is no recipe-execution tool.

Build the identity after public filtering and redaction:

```text
resultIdentity = "mcp-r1:" + Digest.of(canonicalJson([
  "mcp-recovery-v1", toolName, normalizedSemanticContext, publicSourceFact
]))
```

`publicSourceFact` is the complete fact even for text modes. Include schema, producer, all inputs, value when present, status/reason, evidence and all contributing-read provenance. `normalizedSemanticContext` contains the selected ID, actual root snapshot, effective comparison merge base when applicable, workspace declaration digest and sorted actual snapshot vector, effective offline policy, and the normalized scope/config declarations recorded by the source and its contributing reads. Reuse the source's canonical subjects/bounds rather than implement a different target/glob normalizer. Preserve array order. Include base-side provenance already recorded by the source.

Exclude absolute root paths, `repositorySources`, refresh/staleness sidecars (including `workspaceLive`), timestamps, `recovery`, presentation/selection/page/assertion fields and request IDs. Do not erase producer or config differences merely because counts/value happen to match. Existing `sameIdentity` omits source value/status and is not by itself this identity function. This extension changes MCP transport schemas, not `Fact.schema` or stored facts.

Eligibility requires complete pinned context and no deadline reason/cut anywhere in the public contributing facts/findings. A known local impact supplies merge base; an unknown impact without that context returns `recovery.status: "unavailable"` with `unresolved-context`. Do not invent a base SHA. For another unknown source with complete context, identity may be available; the selection still cannot invent items. If redacting the recipe changes a semantic argument, report `redacted-context` rather than emit secrets or advertise an unusable recipe. Missing context is explicit, never a handle stored secretly to fill the gap.

The recipe is transport overhead, including when a full fact is delivered; it is not a second listing of findings. Task 5 must measure that overhead and actual client exposure. No token or task-saving claim follows from returning a smaller selected value.

## Projection schema and meaning

Selected responses have a distinct discriminant and source summary. All names below are proposed wire fields:

```ts
type Analysis =
  | { status: "complete" }
  | { status: "partial" }
  | { status: "unknown"; reason: UnknownReason };
type SourceSummary = {
  schema: SchemaVersion;
  snapshot: SnapshotRef;
  producer: Producer;
  inputs: FactInputs;
  analysis: Analysis;
  reads: readonly { owner: CutOwner; schema: SchemaVersion; snapshot: SnapshotRef;
                     producer: Producer; inputs: FactInputs; analysis: Analysis }[];
  limits: readonly {
    owner: CutOwner;
    kind: Cut["kind"];
    cuts: number;
    places: number;
    limit?: number;
  }[];
};
type EvidencePage = {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  nextCursor?: string;
};
type Projection<T, C> = {
  kind: "projection";
  projectionSchema: 1;
  source: SourceSummary;
  select: EvidenceSelection;
  recovery: Recovery;
} & (
  | { availability: "available"; context: C;
      page: EvidencePage; items: readonly T[] }
  | { availability: "unavailable"; reason: UnknownReason;
      evidence: readonly Evidence[] }
);
```

The receipt uses `kind: "projection-receipt"` and the same source/selection/recovery/availability and page metadata, with no `items` or evidence context. An unavailable projection retains the actual evidence of its source/owner reason; text renders that evidence, while the receipt omits its array. Summary/details render the available page; selected full returns `Projection`. Specialized schemas bind each selection to its concrete item/context shapes below; no `z.unknown()` item placeholder is advertised as the final contract. Root JSON Schemas remain objects. Unselected receipts and full facts retain the mode migration's shapes plus the explicit `recovery` sibling.

`source.analysis` describes the **original analysis**. `availability` says whether this recorded selection can be read. `page.total` counts the recorded primary items defined below, not all real-world consumers. A complete page of a partial analysis remains sourced from that partial analysis; presentation limits do not add analysis cuts. Unknown source/owner data yields unavailable selection with its actual reason, no `items`, empty `value`, zero total or cursor. Unknown entrypoint findings with recorded evidence are different: that evidence is selectable and their unknown finding status/reason remains in context.

`source.limits` groups existing cuts by owner, kind and optional limit, counting cut objects and `at.slice(1)` places. It includes every contributing fact/read's material limitations, without summing overlapping owners as independent missing relationships. Do not copy all cut-place strings to each page. Relevant selected anchors are in context; unselected full retains every cut, and `cut-places` retrieves its recorded places. Preserve declared scope/config interpretation in the recipe and relevant owning-read analysis; include no fabricated call chain.

## Exact selection records

Use only the following existing source paths. An owner or subject absent from a known source is `selection-not-found`; a present subject with zero recorded matches is a valid zero-item page. A subject that matches multiple distinct records when uniqueness is required is `ambiguous-selection`, never an arbitrary first choice.

| Selection | Primary items and deterministic order | Always-present context |
|---|---|---|
| handler-origins | `{ seedIndex, seed: Seed }` for the distinct seed indexes referenced by reached entrypoints whose handler has the exact path/symbol/line. Sort indexes ascending. | Handler, owning repo/snapshot, matched entrypoint count, and interpretation “origin of at least one recorded entrypoint for this handler”. This is a union, not a claim every route alias has every origin. |
| module-origins | `{ originIndex, origin: ModuleOrigin }` from the unique matching reached module's `origins`, distinct and ascending. | Selected `ReachedModule` without its origins array, recorded origin count and the actual base/head snapshot. Base resolves through that impact's merge base. Never join to symbol seeds. |
| entrypoint-evidence | `{ evidenceIndex, evidence: Evidence }` from `value.entrypoints.value[findingIndex].evidence`, preserving source array order and duplicate records. | Finding index, its status/reason, known entrypoint identity with its recorded handler or UI component, and section analysis. Do not copy nested evidence arrays into this identity summary. |
| cut-places | `{ atIndex, place: string }`, where `atIndex` is the original index from 1 onward in the selected `Cut.at`. Preserve order. | Owning fact/read snapshot and analysis, cut index, kind, `at[0]` anchor and optional limit. An anchor is not itself a place or proof of impact. |
| workspace-link-evidence | One item per ID in the selected `ImpactedLink.reach`, in recorded order: `{ position, linkId, link?: Link }`. Include the referenced link when present; otherwise mark `{ position, linkId, unavailable: true }` explicitly. | The selected Link match, direction, reach-reference count and endpoint snapshots/section analysis. Its match includes from/to coordinates, transport, basis, profiles and confidence. |

For impact/callers the local owner is `value`; a section owner is `value.sections[repo].value.impact`. A section without impact has no invented empty table. Cut owners select the root `cuts`, the entrypoints section's `cuts`, workspace `sections[repo].cuts`, or `sections[repo].value.reads[index].fact.cuts` respectively. Read indexes and cut indexes are public result positions, not internal graph IDs, and are meaningful only with the verified source identity.

A `Link` has no independent arbitrary evidence array. Its selected match and recorded reach references are the available support; this API cannot manufacture an endpoint-to-screen execution proof. A dangling reach reference is reported as unavailable, not filled by guessing. Repeated workspace section/read cuts may reflect the same stop and remain separately owned.

Concrete context shapes specialize `Projection<T, C>` and its output schema:

```ts
type HandlerOriginsContext = {
  owner: ImpactOwner; snapshot: SnapshotRef; handler: Handler;
  matchedEntrypointCount: number; interpretation: "recorded-origin-union";
};
type ModuleOriginsContext = {
  owner: ImpactOwner; snapshot: SnapshotRef;
  module: Omit<ReachedModule, "origins">; originCount: number;
};
type EntrypointEvidenceIdentity =
  | Pick<Extract<Entrypoint, { kind: "http-route" }>,
      "kind" | "name" | "method" | "path" | "version" | "handler">
  | Pick<Extract<Entrypoint, { kind: "ui-route" }>,
      "kind" | "name" | "path" | "outlet" | "component">
  | Pick<Extract<Entrypoint, { kind: "listener" }>,
      "kind" | "name" | "protocol" | "destination" | "handler">
  | Pick<Extract<Entrypoint, { kind: "job" }>,
      "kind" | "name" | "trigger" | "handler">;
type EntrypointEvidenceContext = {
  findingIndex: number; section: Analysis;
  finding:
    | { status: "complete"; identity: EntrypointEvidenceIdentity }
    | { status: "unknown"; reason: UnknownReason };
};
type CutPlacesContext = {
  owner: CutOwner; snapshot: SnapshotRef; cutIndex: number;
  kind: Cut["kind"]; anchor: string; limit?: number;
};
type LinkEvidenceContext = {
  link: Link; direction: ImpactedLink["direction"]; reachCount: number;
  endpoints: {
    from: { snapshot: SnapshotRef; analysis: Analysis };
    to: { snapshot: SnapshotRef; analysis: Analysis };
  };
};
```

`EntrypointEvidenceIdentity` reuses the existing discriminated `Entrypoint` union. Preserve each selected field as recorded, including optional route version/outlet and handler end lines. A UI route keeps `component: Handler | "unknown"`; never rename it to `handler` or invent coordinates. A complete UI-route finding with an unknown component still has selectable recorded evidence and remains complete in context. An unknown finding instead retains its actual reason without an invented identity. The identity summary excludes HTTP `basePath` findings and UI guard arrays; the projection's items come only from the selected finding's recorded evidence.

The context snapshot is the owner read's actual snapshot; for a base module use that impact's recorded merge base. Workspace trigger `mergeBase` may supply it only when the owner is the trigger, never for an unrelated section. If the source lacks the necessary snapshot/endpoint provenance, return unavailable selection with `unresolved`, not a guessed head. Every section lookup uses own-property-safe access; a missing `constructor` section is not an inherited object member.

Summary/details and their guides must expose the selector coordinates for findings they show: handler/owner, module side/file, finding index, cut owner/index, or link ID. This makes selection discoverable without first retrieving full. Mark any example as a lookup example, not a ranked representative. The parser for the recipe and typed selection is the same advertised schema used by the handler.

## Stateless cursor and execution order

Encoding is `mcp-p1.` plus unpadded base64url of canonical UTF-8 JSON:

```ts
type CursorV1 = {
  version: 1;
  resultIdentity: ResultIdentity;
  selection: string; // Digest.of(canonicalJson(normalized select))
  limit: number;
  next: number;
};
```

The cursor is opaque by contract, not encrypted or an authorization token. It needs no secret or store. Decode strictly, reject unsupported versions/fields, invalid encoding and unsafe integers. Validate `resultIdentity`, selection digest and limit against the request and recomputed source. Require `0 < next < total` for continuation. A forged position cannot grant source access: it still runs the same currently authorized query and selects the same public category. No authenticity or tamper-proof claim is made.

Execution order:

1. Validate inputs and cursor syntax; reject incompatible selector/limit/expect before analysis. Resolve `repo` using Task 4.1.
2. Execute the existing semantic query, with workspace replay validation/pins where supplied, current trust and the request's cancellation signal. Capture live once under Task 4.3. Never reuse a previous result object.
3. Apply current public filtering and redaction. Build pinned recipe and identity if eligible. Compare `expect`/cursor source identity **before selecting or emitting items**. A new or missing identity fails verification rather than restarting.
4. Resolve the typed subject in the public source. For available data, enumerate the defined primary sequence, take the requested page, include only needed context/referenced records and produce truthful totals. First offset is zero; continuation uses `next`. Issue a cursor only when recorded matches remain.
5. Render the page/receipt or full projection. Release operation resources on every path. Keep no fact, cursor entry, recipe or capture between requests.

A first selection without `expect` establishes a new query result, not verified continuation of a previous answer. An available selection requires available recovery context; known data with an unavailable recipe fails `replay-unavailable`. For a non-deadline unknown source/owner on a first unasserted selection, return unavailable projection with its reason and recovery availability; do not fabricate a zero-item selection. For deadline-cut sources, ordinary unselected delivery is allowed, but selected or asserted replay fails `replay-unavailable`; no stable cursor is issued. A client may request the ordinary fact without recovery controls to inspect its limits.

Proposed adapter faults use the existing redacted `isError` channel without fact-shaped structured content:

| Kind | Meaning |
|---|---|
| `result-changed` | Recomputed identity differs, or core `workspace-replay-mismatch`/live pin mismatch; include expected identity and actual identity only when available, plus stage |
| `replay-unavailable` | A stable source cannot be asserted; reason is deadline, unresolved-context or redacted-context |
| `invalid-cursor` | Encoding/version/fields/position invalid, or selector/limit incompatible |
| `selection-not-found` | Known source lacks the requested recorded owner/subject |
| `ambiguous-selection` | The supplied unique subject identifies distinct records |

Schema-owned invalid inputs remain SDK validation errors. Existing query faults retain their own kinds. Never turn a mismatch into an empty projection, a partial source or a silent first page.

## Ownership and implementation slices

| Files | Responsibility |
|---|---|
| `src/mcp/server.ts`; proposed `src/mcp/recovery.ts` | Recovery inputs/metadata, existing answer pipeline integration, recipe/identity and typed fault mapping |
| Proposed `src/mcp/select-evidence.ts` | Pure source selection, owning-read summaries, concrete item/context projection and page assembly |
| Common-mode schema module, or proposed `src/mcp/recovery-schema.ts` if none exists | Object-root per-family original/receipt/projection unions and cross-field constraints; reuse the migration's schema owner |
| `src/composition/mcp.ts` | Inject the existing SHA-256 `Digest` adapter; no crypto implementation in MCP |
| `src/core/ports/workspace-repos.port.ts`, `workspace-queries.port.ts` | `WorkspaceReplayContext`, optional request replay and returned `workspaceReplay` sidecar |
| `src/core/application/topology/workspace-queries.ts`, `workspace-impact.ts` | Actual declaration digest, same-source pinning, remote/trust checks and context forwarding |
| Task 4.3 capture seams | Validate live pins against the fresh capture; no old-state retrieval |
| `src/protocol/params.ts`, query server/client | Serialize/validate workspace read context with changed public ports; preserve existing unselected Fact wire output |
| SDK/stdio tests and focused new recovery/selection tests | Public acceptance, schema parity, deterministic pages and no retained final result |

1. **Identity and replay context.** Integrate unselected recovery metadata after redaction; implement workspace declaration/pin ownership without changing ordinary source facts. Prove original and pinned replay match, including persisted membership. Test recipe secrecy, changed producer/config/trust and no deadline eligibility. Update relevant protocol documentation with this extension.
2. **Typed projections.** Implement the closed categories and concrete schemas in one coherent adapter change. Test direct selected calls in all three modes, exact owners/records, independent module/symbol indexes, unknown and verified-zero cases, section/read limitations and unsupported categories. This slice must not advertise unimplemented selection branches.
3. **Continuation.** Add strict opaque cursors, source assertions and deterministic pages. Cover all recorded matches once without duplicate positions, including the last page and exact boundaries. Compare the source before any selected data leaves the process. No final-result map or retention setting is permitted.
4. **Client/discovery integration.** Expose subject coordinates and compact complete recipes, update original and selected output schemas together, migrate supported protocol read-context consumers and actual stdio fixtures. Run focused tests, `npm run check` and a broad search for accepted `select` controls accidentally forwarded as analysis scope/budgets or stored in facts.

## Offline acceptance and later measurements

Each test guards the named public rule; follow the [project testing standard](../../../.claude/skills/ye-ast-testing/SKILL.md). Reuse existing fixtures and ports, write only disposable roots, and prove sensitivity by changing the guarded line.

| Rule | Decisive fixture/assertion |
|---|---|
| Pinned replay preserves provenance | Start with trusted persisted membership at moving branch names; replay returned arguments/pins and assert identical source identity and `workspace.source: "persisted"`. Turning pins into explicit membership must fail the test. |
| Current declaration wins | Change persisted membership/revision choice or lower trust after the first call; old replay fails before selected output. Unselected records never join from the replay input. |
| Moving commit reference is pinned | Advance a member branch without changing declaration; replay reads the old available SHA and returns the same identity. |
| Semantic identity | Change targets, scope, budget, changed globs, producer or source cuts: identity changes. Change only mode/selection/page/sidecar: identity stays equal. |
| Actual evidence and ownership | Distinct handler aliases, nonzero seed/origin indexes, base/head rows for the same file, two repositories with identical relative paths, nested read cuts and an unknown finding with evidence. Assert exact source records, not counts alone. |
| UI-route evidence preserves identity | Select evidence from two complete UI-route findings: one with recorded component coordinates and one with `component: "unknown"`. In all three modes, assert the exact recorded evidence page and complete finding status; selected full preserves route path/outlet and the original component without `handler`. Validate both against the advertised schema. Making `handler` mandatory for UI routes, replacing an unknown component with coordinates or treating it as an unknown finding must fail. |
| No fabricated empties or proof | Unknown source has no items/page; known selected subject with zero matches has total zero; link support with a missing reach record reports that reference unavailable. |
| Complete deterministic pagination | Follow returned cursors over a fixed ordered reference set; flattened primary positions equal the source set once, and repeated pages have identical structured content. An array reorder or skipped item must fail. |
| Cursor assertions | Wrong limit/category/source, malformed version/encoding, absent/extra fields and out-of-range position fail their kind; a valid request after failure succeeds. |
| Replay checks precede delivery | Change captured live state before the next call; no selected payload is emitted. A mutation during a successful capture follows stale semantics, not a fake current-time guarantee. |
| No retained answers | Instrument the public query family: each page invokes it again. A producer that returns changed facts on the second call makes the old cursor fail; a saved final fact would incorrectly pass. |
| Schema and redaction | Validate actual SDK/stdio outputs against advertised object-root unions; reject missing reason or page/items in unavailable projections. A semantic recipe argument redacted at egress disables recovery and never leaks raw text. |

Whole-flow benefit, page-size defaults, context overhead and recomputation latency remain Task 5. A page limit counts primary records, not bytes; one record or its required context can still be large. These initial categories recover support for a known subject; if its selector is not exposed by the current view, details or full may still be needed. This is not a general result-browser API. Compare complete verified investigations with direct full retrieval on matching analysis inputs, including both channels, discovery and every replay. No savings or autonomous adoption is established by this design.
