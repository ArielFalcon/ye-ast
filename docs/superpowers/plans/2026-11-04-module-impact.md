# Module Impact Implementation Plan

**Goal:** Report static module consumers with evidence without changing declaration or entrypoint provenance.

**Architecture:** A snapshot module-dependencies port feeds a pure reverse module walk. Application orchestrates
base/head reads and integrates optional module facts; composition wires the TypeScript adapter. Existing symbol
walk and workspace propagation remain independent.

**Tech Stack:** Existing TypeScript compiler API, node:test, tsx, dependency-cruiser; no dependencies added.

**Spec:** `docs/architecture/rfc/0019-module-impact.md`.

## Global constraints

- Preserve all prior uncommitted cut fixes and concurrent production-root work. Commits require an explicit owner request; no pushes or installs.
- English code/docs, neutral Spanish communication. Domain has no I/O; adapters do not import application code.
- Never invent declaration seeds, suppress genuine uncertainty or promote module consumers to symbol entrypoints.

## Work units

1. Reader: write failing public-port regressions, implement snapshot TypeScript static imports/reexports and coverage,
   reuse module resolver and memoization; test aliases, externals, syntax failures and unsupported dynamics.
2. Domain: write failing reverse-walk regressions, implement origin selection, before/after graphs, provenance,
   cycles and existing bounds with separate module accounting; test determinism, multiple origins and cuts.
3. Integration: inject reader through composition, add module facts without changing symbol provenance, merge
   direct static imports/reexports into importers, render both paths and version the additive response.
4. Verification: focused query and real-composition regressions, break proofs, real pinned MCP probes, full
   `npm run check`, `git diff --check`, and inspect adapter/domain boundaries and unchanged symbol results.

Reader owns its new adapter/test files. Domain worker owns its new walk/test files. Lead owns shared types,
application wiring, public contract, composition, renderers, integration tests and documentation.
