# Literal module and resource coverage implementation plan

**Goal:** Resolve supported module uncertainty using existing syntax, snapshots and resolver without new dependencies or invented symbol impact.

**Architecture:** TypeScript adapters extract syntax and resolve destinations through immutable source maps. The consumer-owned module port carries dependency evidence, resource coverage and exact unsupported references. Pure domain traversal decides origins, reachability, bounds and cuts. Application supplies complete selected snapshot inputs; composition and transports retain their roles.

**Spec:** RFC-0019 plus this approved-scope increment requested by the owner on 2026-11-04.

## Constraints

No new dependencies, installs, repository code execution, pushes or main-checkout writes. Commits require an explicit owner request. Preserve prior dirty changes. Module relationships never become declaration seeds or cross-repository triggers. Missing environment/configuration/type declarations remain unknown. Do not suppress coverage gaps by name, line, or package spelling alone.

## Decisions and work units

1. Node and JSON resolution: adapter validates only `node:` builtins with Node's own builtin table. JSON is opt-in on the shared resolver (`jsonModules?: boolean`), only explicit `.json` targets that exist. Existing readers retain TS-only behavior. Tests: invalid builtins, absent/escaped JSON, aliases, default refusal and repeated reads.
2. Literal syntax: module adapter visits each parsed AST once for nested literal `import()` and import-type nodes, adding `form: dynamic-import | type-query` and an offset to import evidence. Static imports/reexports keep current values. Existing resolver memoization is reused. Ordinary `require` stays unsupported because a local binding can shadow it; computed loads also stay unsupported.
3. Exact coverage: `ModuleDependencies.untraversed?` lists unsupported module references by file, line and source offset. Its presence certifies that dynamic-reference coverage was read by this adapter, including when empty. The domain emits these cuts. Older injected readers lacking this property retain the existing DynamicLoadReader fallback; no line-based reconciliation. Symbol-side dynamic and binding contracts are unchanged.
4. JSON resources: successfully resolved, referenced JSON targets and explicitly selected data resources become `ModuleSource` records with `resource: true`, content signature and no declaration obligation. Pure domain origin selection admits these records for JSON edits/deletions. Snapshot selection/fingerprints include JSON resources, commit and live; budget omissions remain explicit. Arbitrary configuration JSON is not claimed as a parsed TypeScript module. Resource origins reach consumers, never symbols.
5. Importers and response: expose dynamic importers and import-type consumers separately from static importers/reexporters; users is their union. Propagate reference form in module `via` and render it. Increment additive response schema from 0.11.0 to 0.12.0. Tests preserve prior symbol/entrypoint values.
6. Performance and verification: preserve per-snapshot reverse adjacency and batched traversal; no type Program or installed dependency read. Avoid the previous second base/head dynamic AST scan when coverage is supplied. Measure frozen before/after on the same pinned application, record phase timings and total observed latency without claiming statistical significance. Run focused red/green tests, full check, architecture gate and real MCP probes.

## Acceptance checks

- Literal runtime and type-only consumers appear with distinct evidence in base/head and importers.
- Same-line literal/computed calls, missing targets, shadowable require and parse failures retain uncertainty.
- Node and present JSON no longer generate false unresolved module cuts; missing environment remains unresolved.
- JSON changes invalidate content/index identities and reach consumers, including deletion and bounded/cancelled cases.
- No new declaration seed, symbol use or entrypoint is inferred from a module relationship.
- Full type/architecture/test gates pass. Residual cuts are classified and measured; no promised cut reduction before evidence.
