# RFC-0030: Preserve domain knowledge through analysis and answer projections

- Status: Accepted, 2026-11-12; owner: "haz la implementacion"
- Related: [ADR-0052](../adr/0052-request-knowledge-is-independent-of-enumeration-completeness.md) (accepted),
  ADR-0038, ADR-0042, ADR-0045, ADR-0049, ADR-0050, ADR-0051; RFC-0002, RFC-0027, RFC-0028, RFC-0029
- Delivery: [five-unit implementation plan](../domain-knowledge-preservation-plan.md)

**In short:** Repair three losses of meaning in existing domain contracts, then improve two MCP projections using
information the core already holds. Preserve useful source knowledge, scoped uncertainty and provenance without new
bounded contexts, services or independent parsing paths. The implementation plan records verification and remaining acceptance evidence.

## Scope and evidence

The assessment starts with business meaning, then domain invariants, contracts, use cases and adapters. Import
direction and a single owner remain necessary but do not prove semantic preservation.

| Problem | Confirmed mechanism | Proposed owner-level correction |
|---|---|---|
| P1 Request knowledge | Declaration-wide summary gaps invalidate an identified HTTP operation | Separate occurrence knowledge from request-set completeness |
| P2 Unknown provenance | `ReachedEntrypoint` cannot carry the original finding's reason and evidence | Retain provenance through projection and merges |
| P3 Declaration placement | An absent representable parent becomes a tree root and appears top level | Separate proved file-level placement from unresolved containment |
| P4 Composition volume | Shared evidence is expanded into compatible attestation pairs | Compactly project the existing grouped relation |
| P5 Focused usefulness | A static summary category hides explicitly selected declaration coordinates | Project explicit selections before counting broad context |

Baseline: `16f583e8a121178949a48e52fea8a26ef76c0cee`. Evidence lives outside this repository in the evaluation archive:

- `evaluations/runs/20261112T102250Z-all-mcp-quality-16f583e8/{report.md,findings.json}`: all-tool observations.
- `evaluations/runs/20261112T110926Z-historical-quality-c2861dba-16f583e8/`: matched requests, fixed source revisions,
  `report.md`, `semantic-comparison.json`, `effect-diagnostic.json` and `integrity-check.json`.

These are archive-relative paths, not shipped fixtures or required local absolute paths. Reduced fixtures must
express the general mechanism. The historical sample covers 17 matched requests, not closure of the 106 study items.
P1 is a reproduced useful regression; P2 predates that refactor cycle. P3's exact index-join contribution is not fully
isolated. P4's pair mechanism is confirmed, but not every pair is irrelevant. P5 retains its data in full output.

Out of scope: provider-value and external-library coverage, the unclassified reduction in Java caller associations,
new frameworks, a new cache, a daemon, a generic proof engine, and claims of global recall or token savings.

## Domain vocabulary and invariants

| Term | Meaning |
|---|---|
| Identified request | A source-supported occurrence and the request components established for it; not guaranteed execution |
| Request alternative | A different possible target for the same occurrence, with its condition or dispatch evidence |
| Enumeration completeness | Whether the represented reading established the whole request set within its scope |
| Gap | A source-backed limitation on a specified inference; not an unconditional veto on every fact in a declaration |
| Reached finding | A source finding together with how a dependency walk reached it |
| Lexical containment | Source-proven enclosure, including through unnamed constructs |
| Binding | The declaration or name proven to hold a value; not identical to lexical containment |
| Shared evidence | Several observations cite one location; this proves neither causality nor equivalence |
| Explicit selection | Existing typed `targets`, `files`, `focus` or change selectors; no inferred natural-language intent |

1. Preserve established knowledge independently of unrelated missing knowledge. Keep uncertainty whenever its
   independence is not positively established. Do not turn a static occurrence into an execution claim.
2. Preserve the original reason, every distinct supporting place and the context needed to interpret a finding.
3. Unknown placement is not file-level placement. A missing edge proves neither root ownership nor absence.
4. Equal locations do not merge incompatible reads, snapshots, configurations or conditional chains.
5. Presentation may shorten repeated representation, but must expose the selected subject, uncertainty and a
   reproducible route to the retained evidence. Measure the complete interaction, not only its first response.

## D1 — Request occurrence knowledge and scoped gaps (P1)

### Contract responsibilities

`core/domain/topology/request-summary.ts` remains the owner of request-summary meaning. Extend its existing shapes
and gap representation with the minimum information that connects each limitation to the inference it can block.
Do not expose AST nodes or invent a universal claim abstraction.

The representation must answer these independent questions:

| Question | Required retained knowledge |
|---|---|
| Which requests were identified? | Stable source occurrence, components, conditions and hop evidence |
| Are these targets alternatives? | Association to the same occurrence and branch/dispatch conditions |
| Could the set contain more requests? | Enumeration limitation and its causal evidence |
| Is this target unique or this occurrence an issuing boundary? | Positive proof over the relevant alternatives and gaps |
| What does the response belong to? | Association to its request occurrence; never select the first of several requests |

Use source positions and existing declaration identity within the snapshot to distinguish occurrences, including
two calls on one line. An identity must not depend on discovery order or a mutable parser object crossing a port.
Keep the current nearest eligible request boundary rule and its leaf/body provenance; this proposal changes the
knowledge retained there, not arbitrary call-site placement.

The implementation must apply this truth table through the shared lookup:

| Reading | Result |
|---|---|
| One identified occurrence, no relevant gap | Preserve its known target and existing consumer behavior |
| Identified occurrence plus positively independent unresolved call | Preserve the occurrence; retain enumeration uncertainty |
| Gap may affect that occurrence, its arguments, receiver or target | Keep the affected conclusion unknown |
| Two independent identified leaves | Preserve both, not a synthetic dispatch disagreement |
| Different targets for the same occurrence | Keep alternatives and their uncertainty; do not choose one |
| Unread or unclassified intermediary | Fail closed; do not infer absence or independence |
| Conditions or deferred execution | Preserve conditions; identification does not prove the operation executes |

`CallSite` currently has a single target. U1 must reconcile this consumer contract: identified occurrences may yield
separate sites distinguished by existing place/provenance; uncertainty about additional operations remains explicit.
If the current site/envelope cannot retain both, extend that domain contract and all consumers in U1. Do not silently
emit only the known sites or encode an empty complete set. ADR-0052 authorizes this change to R1.

`trace` can retain a statically identified effect under a partial walk; it must keep its execution/flow limits.
Topology and contract consequences cannot promote it to a unique link or use it to exclude competitors without their
own proof. `issuingBoundary` requires positive proof for that occurrence and its represented alternatives. Response
flow must retain independent chains and frontiers.

### Implemented occurrence boundary

`RequestShape.gaps` is an optional occurrence-level limitation list; absence retains the conservative declaration-wide
fallback. An empty list is produced only after a positive eager-evaluation ordering proof: a call receiver is evaluated
before its arguments, and arguments left to right. A request already identified in that prefix retains its method and
URL when a later call limits enumeration. Earlier calls, request arguments, conditions, statements, await and missing
provenance do not receive this independence proof. This identifies a static request; it does not establish execution.

The extractor emits distinct leaves separately and retains an unresolved enumeration site alongside known targets.
Its issuing-boundary marker remains unavailable when the declaration has gaps. Response lookup counts full occurrence
chains even through outer wrappers; when several requests could be meant, it returns an explicit frontier instead of
selecting the returned body's first request. Alternative shapes of the same occurrence still undergo agreement checks.

## D2 — Reached uncertainty retains original provenance (P2)

Refine `ReachedEntrypoint` using the existing finding vocabulary, so the unknown branch requires the original reason
and evidence. Traversal context (handler, seeds, depth and confidence) supplements that observation. It does not
replace its source location. Do not add a second unknown taxonomy.

In `reached-entrypoints.ts`, merging observations for one handler must deterministically preserve distinct reasons
and evidence. Do not keep only the first observation or overwrite the source evidence with the handler span. Known
entrypoint identities and current walk scoring remain unchanged.

Carry the result through callers, impact, workspace sections, composition parts, persisted facts and every exposed
surface. The MCP renderer lists a usable cause/location or provides an exact evidence reference. This is not a
renderer-only change: erased provenance must first survive the core projection.

## D3 — Declaration placement is explicit (P3)

`navigation/declaration-model.ts` remains the single owner of the joined declaration model. The syntax port must
distinguish a proved named declaration parent from anonymous lexical ancestry and absent/unknown placement. Reuse
source positions and spans; a binding holder remains a separate relation.

The model must distinguish:

- **File level:** positively established by the syntax/index reading, not inferred from a failed parent join.
- **Nested:** a proven ancestry path to a represented declaration, possibly through anonymous containers.
- **Unplaced:** parentage cannot be established or represented; preserve its evidence and reason.

Retain unnamed ancestry internally when needed to prove nesting; do not fabricate user-visible named declarations.
`declarationTree` must not silently classify unplaced nodes as file roots. Full-file outline must retain those
declarations with explicit placement uncertainty rather than omit them. Selectors and call ownership cannot claim a
dotted parent path from unresolved containment. Existing named bindings must continue to resolve normally.

Apply syntax containment consistently when index and syntax describe the same declaration; first reproduce the
indexed variant before changing that join. Never guess parentage from overlapping line spans. Update RFC-0027's root
and path rules and the public outline shape together; ADR-0049's coverage/identity principle stays intact.

## D4 — Compact shared support using the existing relation (P4)

`evidence-composition.port.ts` already defines an n-ary `shares-evidence` relation and contextual attestations.
The first implementation reuses it for the summary; it does not replace the full graph or eliminate pair generation.

Show an exact shared-evidence group once with references to its observations/reads and the compatibility limits.
Retain exact drill-down to the current connections and attestations. A group must not imply that all members are
mutually compatible: compatibility is not assumed transitive. Distinct snapshots, scopes and branches remain distinct.

Preserve every non-support connection and actionable relation. Measure summary plus the follow-up needed for the
task. If grouping fails to reduce repeated context without losing information, retain the current projection and
report that result. Core pair-materialization optimization requires separate cost evidence; it is not in this plan.

## D5 — Explicit selections remain actionable in summary (P5)

Reuse `DeclaredConfig` and the renderer's existing asking/enumerating distinction. For a selected declaration, expose
its source label, file, symbol and usable line/span before applying broad context counts. Enumerating reads may still
count background observations. Do not invent task relevance from repository names or natural-language heuristics.

Apply the rule to focused outline parts in composition, including a selected observation not joined to a connection.
Preserve redaction, uncertainty, omission notices and the host's answer bound. When mandatory coordinates and guidance
cannot fit, use the existing explicit refusal; do not silently truncate. Full facts and semantic identity stay equal.

## Compatibility, lifetime and surfaces

U1–U3 audit the fact/schema version and retained/stored data readers before changing public fields. Use the existing
schema-version and cache-identity mechanisms; old records cannot silently become proof of complete request enumeration,
known placement or absent uncertainty. Reject or recompute incompatible records according to the existing store
policy. Update RFC-0002 and all affected CLI, protocol, MCP and compose schemas in the unit that owns the behavior.
Do not assign separate incompatible schema versions from parallel branches.

All derivations use the captured read and existing holds. No new process-global cache, parse lifetime, AST exposure,
per-caller summary computation or invalidation mechanism is introduced. Two live captures must not share a stale
conclusion after a relevant edit; an ongoing read remains bound to its captured input. An incomplete failed reading
must not be retained as a complete negative result.

U4–U5 change presentation only: full facts, graph identities, request semantics, budgets and redaction remain intact.
Their response-size comparison uses the same semantic task and mode, including required follow-up.

## Delivery and acceptance

The [unit plan](../domain-knowledge-preservation-plan.md) owns dependencies, checks and integration.
Each of U1–U5 delivers code, contract/schema changes, tests, documentation and evidence as one behavior. Work is not
complete merely because a smaller response or fewer gaps is observed.

Acceptance separates recovered knowledge, useful loss, filtered irrelevant content, relocation into detail and
unclassified reductions. Preserve the demonstrated route/callback/contract gains. This plan does not relabel the
unreconciled Java caller reductions as noise or close the original study globally.

## Decision closure

The owner accepted ADR-0052 and this design on 2026-11-12 by requesting implementation. No product decision is pending.
The five-unit plan records the evidence still required before delivery; unavailable coverage is not marked complete.
