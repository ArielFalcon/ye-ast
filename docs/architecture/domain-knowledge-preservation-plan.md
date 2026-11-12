# Preserve domain knowledge: five implementation units

- Status: U1–U5 implemented; verification record below, 2026-11-12
- Design authority: [RFC-0030](rfc/0030-preserve-domain-knowledge-through-projections.md)
- Accepted semantic decision: [ADR-0052](adr/0052-request-knowledge-is-independent-of-enumeration-completeness.md)
- Baseline inspected: `16f583e8a121178949a48e52fea8a26ef76c0cee`; rebase each unit on current main before integration.

Goal: preserve source-supported facts, their uncertainty and actionable locations through five shared mechanisms.
This plan schedules implementation, not another architecture discovery project. The five units do not reopen the
delivered RFC-0024–0029 units or claim to close the 106-item study.

## Order and ownership

| Unit | Outcome | Prerequisite | Status |
|---|---|---|---|
| U1 | Identified request knowledge survives independently limited enumeration | Acceptance of ADR-0052/RFC-0030 D1 | Implemented |
| U2 | Reached unknowns retain original reasons and evidence | Acceptance of RFC-0030 D2 | Implemented |
| U3 | Unplaced declarations cannot appear as proved top-level declarations | Acceptance of RFC-0030 D3 | Implemented |
| U4 | Summary represents shared evidence compactly with exact drill-down | Acceptance of RFC-0030 D4 | Implemented |
| U5 | Focused composition summaries expose requested coordinates | Acceptance of RFC-0030 D5 | Implemented |

Recommended priority: U1, then U2/U3, then U4/U5. There is no semantic dependency between U2 and U3. Parallel work is
optional, only if it reduces elapsed work: use isolated worktrees and one owner per writable file. The lead owns
shared schema/version edits and integration; merge those changes serially. U4 and U5 edit the same renderer and must
be implemented serially or owned by one implementer. Do not serialize unrelated units behind U1's implementation.

Use one complete brief per unit, including its consumers, tests and docs. A file boundary must not become a reason
to deliver a known schema failure: expand the assigned surface with the lead instead of adding a compatibility
facade or leaving an integration defect.

## U1 — Scope uncertainty to request conclusions

**Owner and reach:** `core/domain/topology/request-summary.ts`, the existing TypeScript summary/lookup owner and the
call-site consumers. One summary per declaration, one held reading. D1 defines the business truth table.

**Edit surfaces:** request-summary and call-site domain contracts; `request-summaries.ts`,
`http-call-sites.adapter.ts`, request lookup/origins and response flow where the representation changes; trace
effects, topology/contract joins and issuing-boundary proof consumers; affected surface/schema/store readers.
Use graph discovery to enumerate those consumers before editing. These are ownership boundaries for one cohesive
behavior, not separate competing implementations.

**Implementation:**

1. Reproduce the captured known-effect regression through the public seam and a reduced fixture. Inspect the same
   all-gaps-to-target rule for independent leaves, alternatives, target inputs and response association.
2. Refine the domain contract before changing its adapter application. Connect a gap to the conclusion it can block;
   when this cannot be proved, retain current fail-closed uncertainty. Keep execution and enumeration separate.
3. Carry identified occurrences and enumeration limits together through the lookup. Reconcile the single-target
   site representation and every consumer as specified by D1; never recover the effect by reading the leaf again.
4. Update RFC-0028 R1 and the ADR-0050 supersession references only after ADR-0052 is accepted. Preserve placement,
   parameter substitution, encoding, wrapper hops, dispatch agreement and response-origin associations.

**Acceptance:**

- [x] A known request survives an independently limited wrapper; its uncertainty remains visible and the answer
  does not assert exhaustive requests or guaranteed execution.
- [x] A gap that can change the same request's receiver, path or arguments still blocks that conclusion.
- [x] Independent requests survive separately; alternatives at one occurrence remain uncertain. Response flow does
  not arbitrarily select one request or merge their chains.
- [x] An unread intermediary cannot become an empty complete result, an exclusion proof or an exact link.
- [x] Two calls on one line and two wrappers of one leaf retain distinct occurrence/chain evidence as required.
- [x] The existing exact contract link and direct HTTP/response cases remain valid through public queries.
- [x] Two relevant live generations change the result appropriately; an edit during a read does not mix captures.

**Proof:** owner fixtures cover the truth-table branches with distinguishable operands. One integration fixture
checks the shared lookup into trace and contract consequences. Break proofs restore the blanket veto and, separately,
ignore a genuinely blocking gap; both must fail. Replay the captured regression and wrapper/contract acceptance
probes with identical pinned source revisions. Inspect every corpus difference; plan `trace:±` because recovered
effects may replace existing uncertainty records. Declare possible `workspace`, `decisions` and
`contract-consequences` movement from the actual consumer diff. A direction is not a quality verdict: explain useful
knowledge retained, recovered or removed in every changed answer.

## U2 — Carry uncertainty provenance through reached findings

**Owner and edit surfaces:** `impact/impact-fact.ts`, `impact/reached-entrypoints.ts`; callers/impact renderers,
workspace/compose normalization and `evidence-composition.port.ts`; affected public schemas and persistence readers.

**Implementation:** make original unknown provenance mandatory in the corresponding domain branch, reuse the existing
finding vocabulary, and preserve it during merges. Do not change known handler identities, walk scoring or matching.
Update the relevant RFC-0010 and fact contract documentation with the final public representation.

**Acceptance:**

- [x] Two findings with different causes/places reaching one handler preserve both original observations and seeds.
- [x] Evidence remains source evidence, distinct from the reached handler's declaration span; output is deterministic.
- [x] Callers and impact expose the same underlying provenance, and compose preserves it through evidence retrieval.
- [x] Existing complete entrypoints, identities and confidence/depth policies are unchanged.

**Proof:** a pure owner regression checks merging, followed by one public projection fixture exercising the changed
schema. Dropping the second source and replacing source evidence with handler evidence must fail. Replay the saved
unknown-entrypoint case. Expect `callers:+` and `impact:+`; add `workspace`/`compose` only if present in the gate's
actual family inventory. Do not claim this repairs a regression: the omission existed before the refactor cycle.

## U3 — Preserve declaration placement through anonymous containment

**Owner and edit surfaces:** `declared-member-names.port.ts`, the language syntax projection,
`navigation/declaration-model.ts`, `shared/declaration-tree.ts`, outline domain/producer, selection/call ownership
consumers and affected schemas. Navigation remains the joined-model owner.

**Implementation:** retain source-proven ancestry across unnamed containers, or explicitly retain unplaced state.
Separate lexical containment from binding. Reproduce syntax-only and index-matched variants before changing their
join. Amend RFC-0027's tree/path rules, plus the public outline contract in RFC-0002.

**Acceptance:**

- [x] A named nested literal inside an unnamed argument is not reported as proved file level.
- [x] A class-field nested value, a true file-level declaration and unresolved ancestry remain distinguishable.
- [x] Syntax and index descriptions of the same declaration retain one identity without duplicates.
- [x] Unplaced nodes remain visible with uncertainty, and selectors cannot fabricate dotted ownership.
- [x] Existing callable ownership/deferred execution rules remain unchanged; lexical nesting does not prove execution.

**Proof:** syntax-port and joined-model fixtures cover their own invariants; one public outline fixture checks the
visible placement. Break proofs classify all parentless nodes as roots and ignore the indexed syntax-parent case.
Replay the two saved nested-container cases on fixed sources. Expect `outline:±`; inspect and declare any `trace`,
`callers`, `impact` or contract movement caused by the corrected shared ownership, rather than weakening the gate.

## U4 — Compact the shared-evidence summary

**Owner and edit surfaces:** `mcp/render-composition.ts` and its presentation tests/documentation. Reuse the existing
`shares-evidence` relation, contextual attestations and evidence selection. Core pair generation and the full graph
are outside this unit.

**Acceptance:**

- [x] A shared evidence group is not repeated solely to enumerate each pair in summary.
- [x] Source/read identifiers and exact detail/evidence references recover every retained attestation and connection.
- [x] A/B compatible and B/C compatible does not become an assertion that A/C are compatible.
- [x] Different snapshots, scopes, branches and causal relations are not collapsed; full output is unchanged.
- [x] Summary plus necessary follow-up contains less repeated representation for the captured composition task;
  report the bytes and retained information, without converting bytes into invented token counts.

**Proof:** renderer fixtures exercise grouped support with a non-transitive compatibility variant and a distinct
causal connection. A mutation merging incompatible contexts must fail. Replay the saved composition query; compare
full graph identity and references. No core behavior change is planned; if implementation needs one, return to D4's
scope instead of silently optimizing pair materialization.

## U5 — Keep selected coordinates in bounded summaries

**Owner and edit surfaces:** `mcp/render-composition.ts`, focused summary/public MCP tests and presentation docs.
Reuse explicit query selection and existing text-budget/redaction owners. Coordinate changes with U4.

**Acceptance:**

- [x] A focused declaration without a connection is visible with source, file, symbol and location in summary.
- [x] A broad enumeration may still count context. Explicit focus is the deciding input, not a size threshold.
- [x] Unknown findings retain their reason/provenance; lack of a complete binding does not suppress the selection.
- [x] Redaction and answer bounds hold; an insufficient budget produces the existing refusal with no silent loss.
- [x] Full facts, semantic identities and ordinary unbounded query results remain unchanged.

**Proof:** one renderer fixture contrasts explicit selection with enumeration; the public MCP boundary verifies the
budget/redaction wiring once. Restoring the unconditional counted-category skip must fail. Replay the captured
focused composition query and compare the initial actionable coordinates and required follow-ups. No core behavior
change or token-saving claim is planned.

## Verification and integration policy

During each unit, read the testing skill and run only touched specs, then `npm run typecheck` and `npm run arch:check`
as appropriate to its contract changes. Search globally for the broad form of the corrected rule. Perform cleanup
over the complete unit, including schemas, tests and docs. Use one correction batch and a bounded recheck for genuine
findings; do not create a review phase for each layer or repeat reviews of unchanged work.

Run `npm run check` once when a unit's implementation and integration corrections are finished, immediately before
its final integration. A failed check is diagnosed before the necessary retry. Serialize heavy commands using the
existing host wrapper when available; no dependency installation or new resource manager is required.

For each U1–U3 core integration: merge current main into the branch, then run the existing corpus gate once, with the
external frozen manifest and declared expected families/directions. Include its exact trailer in the integration
commit and explain every difference. U4–U5 normally need presentation regressions and identical semantic facts;
if they touch core behavior, the same corpus rule applies. Do not invent a `compose` gate family if the installed
manifest does not have it: use the real MCP comparison for that surface.

Schema/version and storage compatibility changes belong with the behavior that needs them. A schema is not left
failing for another implementer. Check library, CLI, protocol, MCP, composition, evidence retrieval and stored facts
for the fields actually changed; mark a surface unaffected only after tracing its consumer.

## Completion record per unit

Record: baseline/candidate, owner and changed invariant, reproduction and variant, focused/check/gate commands and
observed outcomes, real MCP before/after evidence, compatibility handling, useful gains/losses/filtering, remaining
unknowns, and exact integrated commit. Leave checkboxes open until the evidence exists. A transport success, smaller
payload or green corpus with no relevant case is not acceptance of the original task.

## Implementation verification record (2026-11-12)

The owner authorized implementation with "haz la implementacion". ADR-0052 and RFC-0030 record that acceptance.
The working branch is `feat/domain-knowledge-preservation`; no branch commit or publication is part of this record.

| Unit | Observed proof |
|---|---|
| U1 | Reduced known-request and multiple-occurrence REDs became GREEN; argument-order and captured-generation controls pass. Three bounded mutations were detected. Real MCP restores the known effect while remaining partial. Two successive live captures retain different state IDs and the corresponding changed URL. Outer wrappers and repeated calls of one leaf retain an explicit response frontier. |
| U2 | Owner/normalization tests and public schema/render tests pass. Real MCP retains the original unknown reason and source place alongside the reached handler. |
| U3 | Anonymous-container REDs became GREEN. A real outline nests the selected property under its enclosing method. Lexical and binding trees remain distinct; direct semantic-child lookup and independently proved qualified imports preserve resolution. Focused integration exposed seven consumer regressions; their correction and the full retry pass. |
| U4 | On the same captured graph, summary is 55,581 to 51,846 UTF-8 bytes; details remains 79,405 bytes. Full and graph are identical for the renderer-only comparison. Compatibility and exact connection references remain available. |
| U5 | Real focused MCP output exposes both requested declaration spans. Public tests preserve proved and unproved uses. Host bounds now pass through the shared projection-bound owner; a real 100-byte bound returns an explicit metadata-only refusal. Request-level `answerBytes` for compose remains unsupported and is outside this unit. |

The integrated `npm run check` retry passed typecheck, dependency rules and 4,751 tests with no failures/skips.
The first full run had seven containment integration failures; they are recorded rather than counted as success.
The new projection test lives under composition because it joins real core producers with an MCP renderer; no
architecture exception was added. Schema 0.24.0 and schema-qualified derived keys prevent stale representations
from supplying the new proofs. The fixed-layer identity already compares schema and producer.

The final corpus uses an immutable verification commit object built with a temporary index, leaving branch history
and the user's index untouched. Its report remains outside the repository. All families declare potential metadata
movement from schema 0.24.0; the review separately classifies semantic payload differences. The older intermediate
snapshot report is diagnostic evidence, not proof for later production edits. Integration into main, if requested,
requires the gate trailer for the exact candidate tree; do not reuse a different tree's marker.

External evidence retained by the lead includes the full-check logs, real MCP request/response transcripts, live
capture comparison, mutation results, same-graph renderer comparison and both corpus reports. The response-quality
archive supplies the fixed source revisions. No global 106-item closure, inference-token saving or runtime speedup is
claimed. Runtime provider values and external library evidence remain outside this implementation.
