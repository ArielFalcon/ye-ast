# RFC-0020: Literal module references and JSON resources

- Status: Accepted implementation direction, 2026-11-04
- Related: RFC-0001, RFC-0002, RFC-0019, ADR-0013, ADR-0019

The owner requested implementation of the bounded cut corrections without new dependencies, after explicit analysis of the hexagonal and DDD boundaries. This extends module evidence only. A module relationship is never proof of symbol use, an entrypoint reach, or a cross-repository trigger.

## Responsibilities

| Change | Technology adapter | Pure domain | Application / composition |
|---|---|---|---|
| Node builtins | Validate `node:` names with the host Node builtin table; return a proven external target without source reads | External targets do not create unresolved dependency cuts | No new reader or I/O path |
| JSON targets | Opt into explicit `.json` resolution using the same confined snapshot source reader; never infer extensionless JSON | A referenced or explicitly selected data resource has content identity and can originate module impact, without a declaration | Stage JSON candidates, preserve selection/budgets, and fingerprint every read input |
| Runtime literal `import()` | Visit nested syntax on the already parsed AST; preserve literal destination, source offset and `dynamic-import` form | Traverse possible dependencies under existing bounds; preserve the conditional reference form | Keep symbol-side dynamic analysis independent |
| Import types | Read literal import-type expressions, mark `typeOnly` and `type-query` | Preserve type evidence in the same module walk | Render separately from runtime loading |
| Unsupported references | Report computed imports and shadowable `require` calls by exact source offset | Retain explicit snapshot-qualified cuts | Fall back to the old dynamic reader only for injected readers lacking certified coverage |

`ModuleDependencies.untraversed` is optional for compatibility. Presence, including an empty array, means the adapter has inspected nested module references; its entries are those it did not traverse. An unresolved literal is already represented by its dependency target and produces one cut, not an additional generic dynamic cut. The application never retires a symbol-side cut using this module coverage.

A selected JSON resource is materialized from the supplied immutable source bytes even if its first import is added, or its last import removed, in the same diff. Missing source bytes remain unread. Resource deletion has base evidence only; no rename identity is guessed. JSON content is not parsed or executed: the relationship and byte changes are what this capability proves.

## Response and compatibility

Schema 0.12.0 adds `via.form` to module reach evidence and distinct `dynamicImporters` and `typeImporters` arrays. Static `importers` and `reexporters` keep their categories; `users` is their union with the new dependency evidence. Indexed imports from the same files are reconciled so dynamic-only consumers are not relabeled static.

The shared resolver's JSON option defaults off. Other TypeScript readers keep their prior accepted source kinds. Only validated prefixed Node builtins gain an external proof. Bare names retain the existing alias/manifest rules. The builtin table belongs to the host runtime; a different Node release can recognize a newly introduced builtin, so cross-runtime reproducibility is bounded by that runtime capability.

A JSON resource edit changes the query content fingerprint, index input identity and live state id. Composition changes the live staging version to invalidate old mirrors which had listed, but not copied, JSON files. The existing snapshot ports enforce confinement, scope, cancellation and export budgets. Live mirrors copy JSON candidates; unrelated entrypoint extraction ignores them.

## Cost and limits

Reuse one module parse per supplied TypeScript source, the existing per-file/specifier resolution memoization, and the domain's reverse adjacency and batched origin propagation. Certified coverage removes the old extra base/head dynamic parse from module cut generation. Symbol analysis still reads its own dynamic evidence under its existing contract. New reachable consumers can increase traversal and response size; no constant-latency claim follows from avoiding new dependencies.

No installed application dependency tree, type Program, network call or repository code execution is added. Ambient package-only types (`geojson` in the audit), absent environment files, arbitrary computed imports, receiver/DI inference and Java/messaging analysis remain outside this increment. General snapshot coverage gaps remain explicit; this change does not narrow them to the selected origin or hide them through deduplication.

## Validation

Reader/domain tests cover literal/type/conditional evidence, same-line computed references, missing targets, resource content origins and unread snapshots. Real composition tests cover revision and live JSON edits, first/last imports, cache identity, bounds and unchanged symbol semantics. Resolver tests cover valid/invalid builtins, default JSON refusal, missing/escaped JSON and aliases. Full TypeScript, architecture and test gates plus pinned MCP probes are required before delivery. Timing observations are retained separately from correctness claims.
