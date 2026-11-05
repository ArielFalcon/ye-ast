# Task 3 Investigate contract data changes

## Assignment

Role: investigator and implementation planner for backend data contracts. Determine which useful OpenAPI schema changes the current engine cannot describe, then propose a staged extension grounded in public-query reproductions and application evidence. Do not implement or adopt a dependency during this assignment.

Workspace: `/Users/arielyumn/Desktop/TRABAJO/ye-ast`. Handoff baseline: `d35093f807c4a789cb32b50040fad31c0a73ab04`, 2026-11-05. Recheck current code and local modifications. You are not alone: preserve other agents' work. Own only your investigation and task-specific follow-up document. No subagents, commits or pushes.

## Why this matters

An operation can retain its method and path while changing the data it accepts or returns. A structural caller graph can identify a DTO dependency without describing the changed wire contract. Conversely, calling an operation does not prove that a consumer reads a particular response field. Preserve these distinctions in every conclusion.

## Read first

- `AGENTS.md`, `.claude/skills/ye-ast-testing/SKILL.md`.
- ADRs `0001-product-scope-and-priority`, `0010-trust-modes`, `0013-coverage-grows-only-with-evidence`, and `0014-angular-and-spring-from-own-extractors`.
- RFCs `0002-facts-contract`, `0007-extension-model` (including row A5), `0010-impact-queries`, and `0011-cross-repository-impact`.
- `docs/superpowers/plans/2026-11-05-current-engine-mechanism-improvements.md` and relevant current response-mode/recovery contracts, including ADR-0022.

Use structural tools before broad code searches. Start from these contracts and consumers:

| Surface | Responsibility |
| --- | --- |
| `src/core/ports/contract-routes.port.ts` | Current `ContractOperation` shape and supported operation extraction. |
| `src/core/adapters/openapi/contract-document.adapter.ts` | YAML/JSON parsing, route/base extraction and source locations. |
| `src/core/adapters/spring/spring-routes.adapter.ts` | `operationId` use to reconstruct controller routes; preserve existing behavior. |
| `src/core/domain/entrypoints/http-route.ts` | Existing route facts and completeness. |
| `src/core/domain/impact/changed-entrypoints.ts` | What counts as a changed entrypoint today. |
| `src/core/domain/change/changed-file.ts` and `src/core/application/impact/impact-queries.ts` | Changed contract files, seeds and uncertainty. |
| `src/core/application/topology/workspace-impact.ts` and `src/core/domain/topology/link-match.ts` | Actual operation-to-consumer evidence and propagation. |

## Reproduced extraction evidence

The current `ContractOperation` records `operationId`, method, path, base path, document and line. It has no request/response schema. The following probe was executed successfully:

```bash
node --import tsx --input-type=module <<'JS'
import { createContractRoutes } from './src/core/adapters/openapi/contract-document.adapter.ts';
const contract = (type) => ({ path: 'openapi.yaml', content:
`openapi: 3.0.3
info: {title: API, version: '1'}
paths:
  /orders:
    get:
      operationId: getOrders
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  total:
                    type: ${type}
` });
const reader = createContractRoutes();
const before = reader.operations([contract('number')]);
const after = reader.operations([contract('string')]);
console.log(JSON.stringify({ same: JSON.stringify(before) === JSON.stringify(after), before, after }));
JS
```

Observed: `same: true`; both extracted operations are `getOrders`, `GET /orders`, with the same source location. This establishes loss of schema distinctions in this adapter, not a globally identical fact or absence of every DTO dependency. Snapshot hashes or generic cuts can change even when operations do not.

The [oasdiff rules](https://www.oasdiff.com/docs/breaking-changes) and [upstream documentation](https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md) provide an external reference for contract diffs. They do not establish which field any application actually reads, and their compatibility verdicts are not automatically ye-ast facts. Verify the exact evaluated version and use it as an offline oracle before considering integration.

## Investigation steps

- [ ] Rerun the extraction probe; trace a contract-only change through the public impact query. Record whether it is represented as a route change, a generic cut, another fact or no specific schema information.
- [ ] Compare that with a matching Java DTO change. Identify what the graph already recovers so the plan does not duplicate existing dependency reach.
- [ ] Inventory real contract changes on at least two measured applications. Separate request and response properties, type changes, requiredness, removals, references and operation changes. Start from observed shapes rather than a catalog of hypothetical OpenAPI features.
- [ ] Inspect existing JSON/YAML parsing and location utilities. Assess local `$ref` resolution and cycles within confined snapshot sources. External references remain explicit unknowns; do not fetch them.
- [ ] Identify which changed schema nodes belong to which operations, including shared schemas. Do not report all endpoints as affected by every shared document edit.
- [ ] Establish what existing workspace links prove about operation consumers. Keep candidate consumers distinct from consumers proven to read a changed field.
- [ ] Compare a small supported subset with a pinned offline oasdiff run or manually verified contract inventory. Account for both missing changes and false associations.
- [ ] Propose the minimal core fact/port/query integration and schema/version implications. Determine how it fits accepted fact families; ask the owner to resolve consequential contract or architecture choices before implementation.

## Proposed staging to evaluate

1. **Contract changes per operation.** Preserve source-backed structural changes between committed snapshots: direction, operation, schema location and changed property. Do not equate every structural difference with a runtime break.
2. **Operation consumers.** Attach existing verified cross-service consumer links, retaining their confidence and ambiguity. State that these consumers call the operation, not necessarily that they read the changed property.
3. **Field-specific consumers.** Investigate separately only after demonstrating reliable response provenance through assignments, aliases, transformations and templates. This may need bounded data-flow analysis and is not part of the initial implementation recommendation.

The stages are a research proposal, not approved interfaces. The report may narrow or reject them. Do not add a new query family or compatibility policy merely because an external tool exposes one. Request and response compatibility have different rules; report facts before proposing verdicts.

## Acceptance and verification

The initial candidate must distinguish the reproduced schema edit, attribute it to the correct operation and snapshot, and preserve evidence on both sides. A shared schema affects only operations that actually reference it. Unsupported schema constructs and unavailable references retain explicit uncertainty. Existing Spring route reconstruction must stay correct.

For proposed tests, follow the project testing skill: observable contract-reader and query-family behavior, one test per named rule, failing regression fixture first and meaningful break proof. No tests of YAML or third-party parser behavior alone. A later implementation ends with focused checks, `npm run check`, `git diff --check` and a global search for duplicate contract/schema extraction.

Measure useful contract changes recovered, correct operation associations and independently proven consumer reach. Report false positives, unknowns, latency and memory. A changed digest or a smaller cut list is not enough. Keep raw corpus data outside the engine repository.

Return a task-specific report and improved plan with verified gaps, what current DTO analysis already covers, oracle results, staged scope, proposed ownership/contracts, approval decisions, exact checks and implement/narrow/defer/reject recommendation. Do not claim field-level precision until demonstrated end to end.

## Outcome

Status 2026-11-05: stage 1 implemented on owner authorization; stages 2 and 3 not started. Inspected base: `98b9cc5`.

### Implemented

- `ContractOperation` (now in `core/domain/contracts/`, re-exported by the port) carries `data`: request and response
  digests, the extra files its references reach, and the references it could not follow. The contract-document adapter
  follows local and in-snapshot `$ref`s (cycle-safe, each place once), leaves documentation members out and records URL,
  outside-repository and missing targets as unresolved. Operations without `operationId` are now read (placed at their
  verb); the Spring join skips them, so routes are unchanged.
- `changedContracts` (`core/domain/impact/changed-contracts.ts`) pairs base and head operations by document, verb and
  path: added, removed, or altered with `parts` (`request`, `response`). Only operations whose document or reached file
  the change touched (and the `changed` selection keeps) are reported. A touched unresolved reference is an
  `unresolved-link` cut; a touched unparsable document a `no-extractor` cut.
- `impact.ofChange` exposes `value.changedContracts` when not empty (commit and live paths share `readChange`); the MCP
  text lists `changed contracts (n)`. RFC-0010 and RFC-0007 row S5 describe the shape. Fact schema `0.12.0` → `0.13.0`.

### Evidence

Scratch repository with `src/main/resources/openapi.yaml` (`getOrders` → `$ref Orders`, `getItems` without schema);
base `Orders.total: number`, head `string`. Command: `npm run cli -- impact <repo> --base HEAD~1`.

| Case | Before (`98b9cc5`) | After |
| --- | --- | --- |
| Schema type change under unchanged `GET /orders` | `complete`, `changedEntrypoints: []`, no contract information | `complete`, `changedContracts: [altered GET /orders (getOrders) response, line 6]`; `getItems` absent |
| Negative control: only response `description` edited | `complete`, nothing | `complete`, no `changedContracts` |
| Changed document with a URL `$ref` | `complete`, nothing | `partial`, cut `unresolved-link` at `<document>:16 <ref>` |

Tests: e2e (`impact.e2e.test.ts`: altered/negative control, unresolved cut), adapter conformance (reference attribution,
request/response direction, documentation vs property names, external/unresolved references, cycles, missing
`operationId`), domain pairing and cut rules, Spring "no `operationId` joins no override", MCP rendering. Each was
observed failing (RED before implementation for the e2e and MCP tests; type-correct break proofs for the adapter and
domain rules; removing the cycle guard hangs the adapter test). `npm run check`: 2,251 tests pass.

Not measured: real-application inventories, oasdiff comparison, latency and memory on large contracts. Operations are
now parsed for every `impact.ofChange` on a snapshot holding contract documents.

### Known gaps (explicit, not silent)

- Path items that are themselves a `$ref`, and `discriminator.mapping` targets not also referenced by `$ref`, are not
  followed (the former is the pre-existing route gap).
- A renamed component schema with identical content reads as altered (the reference place is part of the digest).
- An `operationId` change alone is not a data change; Spring route changes still report it.

### Staged plan for the remaining stages

1. **Measure stage 1** on two real applications: count altered operations against a manual diff or a pinned offline
   oasdiff run; record false associations, unresolved cuts, latency and memory.
2. **Operation consumers** (stage 2): in `workspace-impact`, treat an altered contract operation like a changed route so
   existing verified call-site links name the callers, keeping link confidence and ambiguity, labelled "calls the
   operation", never "reads the field".
3. **Field-specific consumers** (stage 3): only after response provenance through assignments, aliases and templates is
   demonstrated (RFC-0007 rows A5 and S9).

### Needs owner decision

- Stage 2 changes the cross-repository answer (RFC-0011) and the public workspace fact; confirm before implementing.
- Whether to name changed properties (schema location and property) in `changedContracts` rather than only `parts`.
