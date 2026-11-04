# RFC-0019: Report module dependencies separately from symbol impact

- Status: Accepted, 2026-11-04
- Related: RFC-0002, RFC-0010, ADR-0013, ADR-0017

**In short:** A change to static imports or exports has a module origin, not an invented declaration seed.
Report its consuming modules and dependency evidence in an additive `modules` section of the impact value.
Declaration seeds, reached symbols, reached entrypoints and cross-repository propagation retain their meanings.
The owner approved this direction and the recommendation to report module consumers without co-located entrypoints.

## Contract

`ImpactValue.modules`, when present, holds `origins`, reached `modules`, and its own `cost.expansionsUsed`.
An origin names a changed file and whether it was added, modified or deleted. Each reached module names its `base`
or `head` snapshot, depth, origin indexes and the import/reexport evidence that first reached it. `base` means the
fact's merge base; `head` means the fact's snapshot, including a live snapshot. Old dependencies are never presented
as current ones. An origin or reached module is not a `Seed`, `ImpactedSymbol` or `ReachedEntrypoint`.

Static module dependencies are facts about imports, not proofs that an imported symbol is used. A module consumer
is therefore not used to seed every declaration, reach every entrypoint or initiate cross-repository propagation.
The new section must not make missing symbol coverage appear complete: only a wholly covered module-only source
can retire its declaration-free `no-extractor` cut. That coverage concerns the source: traversal bounds, unread
consumer files and unresolved dependencies keep their specific cuts rather than mislabeling a parsed barrel as
unextractable. Other unresolved declaration cuts remain. Dynamic loads not traversed by the static module reader
are explicit module `unresolved-link` cuts, using the existing dynamic-load reader, even when they name a literal.
That reader also reports type-level `import()` references; the cut describes an untraversed module reference, not
necessarily a runtime load. Wider module coverage can therefore surface additional cuts rather than reduce totals.

## Reading and traversal

A consumer-owned `ModuleDependenciesReader` receives immutable snapshot sources. Its TypeScript adapter reuses
the existing snapshot module resolver. It reports successful file coverage, static statements, import/reexport
edges, proven external modules, unresolved targets and unread files. It does not build a program or read installed
application dependencies. Parse failures and unsupported constructs cannot silently become complete empty results.

Compare the selected changes' static module statements and exported declaration names/visibility (not bodies)
between base and head. A changed import/export surface or
a deleted TypeScript module creates a module origin. A declaration-body-only edit retains the existing symbol walk.
Run reverse module traversal independently on base and head, retaining both evidence sets. A rename is the diff's
deletion plus addition, not an inferred identity. Unresolved current imports and unread sources remain cuts.

Build reverse adjacency once per snapshot. Use visited distances and origin sets to terminate cycles, preserve
all origins and choose deterministic first evidence. Do not repeatedly scan every edge for every origin.
Impact excludes test consumers; revision `importers` includes them using an explicit snapshot source selection and
the same selection in fact/index fingerprints. A live mirror that omitted them retains `not-exported` cuts rather
than claiming complete coverage. That query merges static direct imports with indexed
importers/users and reports reexporters separately rather than calling them ordinary imports.

## Bounds and compatibility

Existing requested walk bounds apply independently to each dependency walk. The existing symbol cost and fan-in
keep counting symbols/callers. The module section counts module expansions; its fan-in is direct module consumers.
The module expansion allowance is shared across base and head, and a bound that leaves consumers unreached emits
the existing cut kind with a snapshot-qualified module anchor. No new request flag or implicit limit is added.
Export budgets, declared scope and cancellation remain enforced by the existing snapshot/query orchestration.

The response additions require a minor schema increment relative to the integrating checkout, not a downgrade
from concurrent schema changes. Missing optional module-reader injection preserves the older embedding behavior
and its cuts; production composition supplies the reader. Rendering and guidance expose the new section without
changing the transport or adding a second full/detail option.

## Verification

- Alias to a declaration-free barrel reaches direct importers and reexport chains, without changing symbol provenance.
- Export changes, deleted and renamed barrels report base/head evidence separately; unresolved imports remain partial.
- Cycles, multiple origins, bounds, tests and parse errors retain deterministic coverage and explicit cuts.
- Importers distinguish direct imports/reexports and never return complete-empty because the index missed alias edges.
- Symbol-only changes and cross-repository propagation retain their previous values.
- Run focused red/green regressions, type-correct break proofs, real MCP probes and the full architecture/type/test gate.

## Extension

[RFC-0020](0020-literal-module-and-resource-coverage.md) extends this static baseline with literal runtime/type import evidence and JSON resource origins. Its certified unsupported-reference list replaces blanket dynamic cuts for the production reader; older injected readers retain their fallback.

## Open questions

None for this increment. Receiver resolution, dynamic module loading and co-located entrypoint navigation are not
part of this capability and retain their existing uncertainty.
