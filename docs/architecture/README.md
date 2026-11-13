# Architecture records

Read the ADRs for what is decided and the RFCs for designs under discussion. Start with ADR-0001 and RFC-0001. An ADR
marked **Proposed** awaits the owner's acceptance.

## How an RFC and an ADR relate

- An **RFC** holds a design: the problem with its evidence, the confirmed root cause, the rules and contracts, the
  delivery units and the open questions with a recommended answer each. It stays `Draft` until the owner accepts it.
- An **ADR** records one narrow decision the owner took, quotes the owner's words, and points to the RFC that designs
  it. It carries neither the design nor the delivery units.
- Owner, 2026-11-09: "los ADR recogen decisiones mas acotadas referentes a un RFC" (ADRs record narrower decisions
  that refer to an RFC).
- ADR-0041 to ADR-0045 predate this rule and hold their design inside the ADR; they stay as written, and new work
  follows the split.

## Decisions (ADR)

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-product-scope-and-priority.md) | Code truth engine; qayaba first, any harness second; one product with deployment profiles; own repository; extracted modules after qayaba's migration ([0012](adr/0012-foundation-before-qayaba-migration.md)) | Accepted |
| [0002](adr/0002-project-name.md) | Name `ye-ast` | Accepted |
| [0003](adr/0003-implementation-language.md) | TypeScript; speed from a long-lived process, native code only for a profiled hot path | Accepted |
| [0004](adr/0004-codegraph-dependency-with-own-fact-layer.md) | codegraph as a dependency with an own fact layer, no fork | Accepted |
| [0005](adr/0005-runtime-topology-and-delivery-order.md) | MVP first (library, CLI, stdio MCP); then hooks and daemon in topology A1; no MCP over HTTP. [0011](adr/0011-query-protocol-in-the-mvp.md) supersedes its delivery order and the place of the socket client | Accepted |
| [0006](adr/0006-qayaba-graph-state-per-run.md) | On qayaba's server, graph state lives per run | Accepted |
| [0007](adr/0007-dependency-versions.md) | Latest stable dependencies, pinned exactly | Accepted |
| [0008](adr/0008-typescript-compiler-api-source.md) | TypeScript 6.0.3 as the single version, an exception while TypeScript 7 has no stable compiler API | Accepted |
| [0009](adr/0009-route-data-in-two-levels.md) | Route breadth from codegraph, route depth from own extractors | Accepted |
| [0010](adr/0010-trust-modes.md) | Two trust modes, `trusted` and `untrusted`, describe the repository content and are declared outside it; no mode per host | Accepted |
| [0011](adr/0011-query-protocol-in-the-mvp.md) | One query protocol, JSON-RPC over stdio from the MVP (`ye-ast serve`); the daemon serves it later; hooks do not wait for the daemon | Accepted |
| [0012](adr/0012-foundation-before-qayaba-migration.md) | The foundation starts now; modules extracted from qayaba wait for its migration and move in their migrated form | Accepted |
| [0013](adr/0013-coverage-grows-only-with-evidence.md) | Coverage grows only with evidence: five fact families, parsers never builds, measured entry, failing fixtures first, idioms as data, one owner per fact | Accepted |
| [0014](adr/0014-angular-and-spring-from-own-extractors.md) | Angular and Spring from own extractors over parser libraries (TypeScript compiler API, `@angular/compiler`, tree-sitter-java), with the definition of done | Accepted |
| [0015](adr/0015-index-reuse-by-content.md) | Index reuse by staged content; `sync`-derived indexes serve only live facts that record it | Accepted |
| [0016](adr/0016-remote-refresh-under-trusted.md) | Under `trusted`, declared remotes are refreshed into ye-ast's own mirrors before a query; facts depend on pinned shas only. Supersedes the network clause of 0010 decision 4 for `trusted` | Accepted |
| [0017](adr/0017-owner-of-a-member-expands-only-whole-type-edges.md) | A type reached through one of its members expands only through whole-type edges | Accepted |
| [0018](adr/0018-type-information-as-a-fact-input.md) | A fact may settle a reference with `typescript`'s compiler API in process, from a type root outside the snapshot; the root is an input of every fact that used it. Measured: as an edge source it removes one cut. Rejected and removed, 2026-11-05 | Rejected |
| [0019](adr/0019-cuts-retired-on-a-proven-external-target.md) | A cut is not emitted when the file's own imports prove its target outside the repository; no type root, and a file-level shadow rule that gives up 6% of the retirements. Measured: 6% to 13% fewer cuts | Proposed |
| [0020](adr/0020-host-budgeted-snapshot-memory-cache.md) | Serialized snapshot data in memory, bounded by a host-overridable byte budget; Git exports stay temporary | Accepted |
| [0021](adr/0021-enable-snapshot-memory-cache-by-default.md) | Snapshot data cache enabled by default with 32 MiB; host override and explicit zero preserved | Accepted |
| [0022](adr/0022-typed-query-replay-and-selective-evidence.md) | Typed selection on existing tools, explicit projections, verified query replay, declared repository targeting, mixed snapshots and result-bound pagination | Accepted |
| [0024](adr/0024-one-producer-version-for-every-family.md) | Every query family stamps one producer version; the edge-policy suffix is removed. Supersedes 0017 decision 3 | Accepted |
| [0025](adr/0025-template-member-calls-join-as-component-calls.md) | A template call through a component's injected field joins as a call of the component, with the template as evidence; amends the ADR-0017 amendment | Accepted |
| [0026](adr/0026-snapshot-data-may-retain-reader-outputs.md) | The snapshot data cache may also retain serialized relations and whole-universe module-dependency outputs, keyed by every input they read; amends ADR-0020 decision 2 | Accepted |
| [0027](adr/0027-retention-of-immutable-index-entries.md) | Kept full indexes are retained by last use: 14 days unused and 512 MiB of logical bytes, never an entry an open reader holds; amends ADR-0015 | Accepted |
| [0028](adr/0028-lazy-export-materialization.md) | A SHA request lists the export afresh every time and writes its files only when a reader needs them (source read miss, index build, focused Java read); amends ADR-0020 decisions 4 and 5 | Accepted |
| [0029](adr/0029-lexical-bindings-from-the-typescript-binder.md) | The TypeScript compiler's binder, through a one-file program with no library and no resolution, is the one source of lexical bindings, for import origins and function-value calls alike | Accepted |
| [0030](adr/0030-live-captures-use-the-snapshot-data-cache.md) | A live capture uses the snapshot data cache, keyed by the content hashes of its reconciled listing and never by HEAD; amends ADR-0020 decision 6 | Accepted |
| [0031](adr/0031-snapshot-data-is-keyed-by-the-written-files.md) | SHA snapshot data is keyed by the scope, trust, export budget and the path and blob of every written file, never by the commit or the repository; amends ADR-0020 decision 4 | Accepted |
| [0032](adr/0032-a-query-family-is-done-when-every-surface-exposes-it.md) | A query family is delivered only when it answers the fact contract and every surface (library, MCP, compose, CLI, protocol) reaches it; a deferred surface names its phase | Accepted |
| [0033](adr/0033-contract-consequences-as-one-query-family.md) | Contract consequences become one family, `contractConsequences` (written hypotheses or a diff), answering one composite fact on every surface as `ye_ast_contract_consequences`; a fresh family | Accepted |
| [0034](adr/0034-name-contract-consequences-explicitly.md) | Name the family `contractConsequences`, MCP and compose `ye_ast_contract_consequences`, and CLI `contract-consequences`; supersedes the naming in 0033 | Accepted |
| [0035](adr/0035-derived-facts-are-retained-by-content.md) | The snapshot data cache may retain plain facts derived from one file or from named inputs, keyed by content; amends 0020 and 0026 | Accepted |
| [0036](adr/0036-dependence-is-the-compile-time-binding.md) | A graph edge on a value receiver is a name match (confidence 0.3) until a source proof binds the receiver to the member's class; every followed dependence carries its derivation | Accepted |
| [0037](adr/0037-host-declared-build-outputs.md) | A host may declare build outputs (a `node_modules` its own install produced); read as data, checked against the commit's lockfile, they let the TypeScript checker bind calls at a revision (`typed` derivation), and one not used is a `build-output` cut | Accepted |
| [0038](adr/0038-evidence-composition-is-derived-in-the-core.md) | Evidence composition (normalize, identity, materialize, reference and issue checks) is derived in the core behind a driving port; the MCP executes queries, orchestrates compose requests and renders | Accepted |
| [0039](adr/0039-behavior-changes-pass-a-corpus-gate.md) | Every change of behavior under `src/core/` passes a corpus gate before reaching `main`: base and candidate runs over a frozen out-of-repository manifest, differences explained by declared families and directions; extends 0013 rule 4 | Accepted |
| [0040](adr/0040-a-snapshot-read-parses-each-java-source-once.md) | A snapshot read parses each Java source once into trees its hold keeps, and frees them when the read ends, whether it answers or throws; concurrent reads never share trees | Accepted |
| [0041](adr/0041-one-call-reconciliation-for-every-family.md) | One core owner aligns codegraph's records with the written calls per file and binds every call with one chain; families extend it by composition, narrowing and never re-binding; reverse queries read a name index of per-file deltas retained by content | Accepted |
| [0042](adr/0042-completeness-is-relative-to-the-question.md) | Every cut carries a required reason from a closed set and a typed reach; each family declares what its answer asserts, and a cut makes it `partial` only when its reach can hold an asserted item, by positive proof that fails closed; a place is an item or a cut, never both; undecided items are stated; amends RFC-0002 rules 1 and 2 | Accepted |
| [0043](adr/0043-a-change-seeds-only-where-its-tokens-differ.md) | A changed hunk whose base and head tokens are equal (comments, whitespace, Java import order) seeds nothing and is reported as `settled`, never dropped; a line no token touches selects nothing; when unsure, it is a token | Accepted |
| [0044](adr/0044-one-implementation-closure-with-scoped-vetoes.md) | What a Java call names (`receiverMethods`) and what it may run (`dispatchTargets`) have one owner per language, read by trace, the call-site flow and data effects; a veto is released only on proven target types; framework selection is per call; generated Java sources enter as a declared build output; dispatch stays trace's extension of 0041 | Accepted |
| [0045](adr/0045-one-assembly-line-for-the-snapshot-reading.md) | One owner in `core/application/snapshot` assembles per snapshot every evidence stage (syntax, origins, modules, relations, Java readings, typed bindings, edge targets, reconciled calls) with one retention each; every family reads the same proofs and extends by narrowing; the bound snapshot is prebuilt in the background and rebuilt only where content changed; the line is language-agnostic and one language pack per language implements its stages, declares absent capabilities and supplies a profile; amends 0035, 0036, 0037 and 0041 | Accepted |
| [0046](adr/0046-a-call-binds-by-its-receivers-type.md) | A member call binds to what its receiver's type declares at the call: overload sets collapse to their implementation, interfaces declare, the dispatch bridge matches by signature, trace keeps no receiver rule of its own; designed in RFC-0024 | Accepted |
| [0047](adr/0047-angular-routes-are-read-as-a-graph-from-the-router-configuration.md) | Angular routes are read as a graph from the router's configuration (module imports, every `loadChildren` form, real prefixes); an `include` narrows only the answer; the entrypoint map carries its reading's cuts; designed in RFC-0025 | Accepted |
| [0048](adr/0048-a-framework-invoked-implementation-is-an-entrypoint.md) | Code a framework invokes through a library contract is an entrypoint of kind `callback`, declared as plugin data and proven by the Java supertype closure; designed in RFC-0026 | Accepted |
| [0049](adr/0049-every-written-callable-is-a-declaration.md) | Object-literal and factory members, anonymous-class bodies and method references are declarations or references; a Java type target is `partial` until its type references are read; designed in RFC-0027 | Accepted |
| [0050](adr/0050-one-request-summary-per-declaration.md) | One request summary per declaration, applied at every call, is the only reader of a request's parameters and a response's container; one owner answers "is this call a request"; designed in RFC-0028 | Accepted |
| [0051](adr/0051-an-answer-never-hides-what-the-engine-knows.md) | Where the engine holds a fact the answer states it: one owner of fault text, a missing file is a fault everywhere, a declared answer bound refuses instead of truncating, an empty `include` is a fault, entrypoints carry their declaration place, `importers` relationships carry their lines; designed in RFC-0029 | Accepted |
| [0052](adr/0052-request-knowledge-is-independent-of-enumeration-completeness.md) | Preserve identified request occurrences separately from enumeration completeness; scoped gaps retain fail-closed target and execution limits; partially supersedes of ADR-0050 decision 3; a gap blocks an occurrence only inside the request call or the entering receiver, and an unknown target keeps its stated verb | Accepted |
| [0053](adr/0053-multi-repository-relations-retain-their-proof-context.md) | Source-complete provider values and scoped execution-to-producer matches retain build, route competition and snapshot proof | Accepted |
| [0054](adr/0054-a-stated-route-links-when-only-its-base-is-undecided.md) | A request whose path is stated after an undecided base links by route, basis `suffix`, marked `authority: undecided`, only to one serving repository | Accepted |
| [0055](adr/0055-uncertainty-reaches-a-call-site-only-where-it-can-reach-a-request.md) | A framework plugin lists the value cells whose read runs nothing or a callback; `calleeOf` answers from that list, a gap names its leaf place, and trace treats package-constructed and package-typed receivers as leaves | Accepted |
| [0056](adr/0056-requests-in-listed-deferring-combinators-are-owned-deferred-effects.md) | A function value passed to an argument a registered framework deferral vocabulary lists (RxJS `defer`, `switchMap`, ...) is owned by its declaration; requests in it are effects marked `deferred`, and workspace trace matches them with the same mark | Accepted |
| [0057](adr/0057-partial-request-strings-keep-what-they-state.md) | A partial request string decides `startsWith` and slash-trimming by its stated prefix, request options accept shorthand and conditional spreads, one undecided branch states one URL per outcome, and the join links each expression that states its route | Accepted |
| [0058](adr/0058-the-suffix-rung-never-lets-a-stated-text-fill-a-route-variable.md) | The `suffix` rung never lets a text the call states fill a route variable and never cuts a call that states its origin; the exact and base-path rungs and a declared gateway prefix are unchanged | Accepted |
| [0059](adr/0059-a-field-written-once-in-the-constructor-from-a-readable-value-is-a-decided-callee.md) | A function-typed field written exactly once, unconditionally in the constructor, from a function or a readable factory's returned function is that function; any other write keeps the undecided dispatch | Accepted |
| [0060](adr/0060-a-request-to-a-host-evidenced-as-a-repository-is-unmatched.md) | A request to a host evidenced as one repository's (a call under its origin links to it and none to another) that matches no route is `unmatched` instead of `external`; a host with no link, or linked to two repositories, stays external | Accepted |
| [0061](adr/0061-a-trace-returns-the-links-of-requests-under-deferred-steps.md) | A trace returns the links of requests under deferred steps (a step is deferred when it or an ancestor is), marked deferred; a call that may reach a request is a `request-possible` cut, not an "http effect" | Accepted |
| [0062](adr/0062-java-names-and-receivers-resolve-under-the-repository-compiles-assumption.md) | A name one repository on-demand import declares is bound whatever other packages are imported; Spring Data repository interfaces declare no member type; an interface a declared OpenAPI generator emits does not make own, private and typed receivers unproven | Accepted |
| [0063](adr/0063-a-jdk-the-host-declares-is-the-library-signature-source.md) | The library signatures come from a JDK the host declares with `--jdk [<at>=]<path>`, read as data from `ct.sym` at the JDK's own release with no pin and no shipped table; it is a build output, stated unverified, and a cut when unusable or older than a build file's literal release | Accepted |
| [0064](adr/0064-a-supertype-outside-the-repository-redefines-no-java-name.md) | A supertype outside the repository is assumed to declare no member type and no inherited field named like a type that resolves to `java.*` by an import, an on-demand import or `java.lang`; it also covers a name a single-type import binds, and never a name a same-package reference or a non-java on-demand import supplies | Accepted |
| [0065](adr/0065-a-link-marks-the-literal-segment-a-producer-variable-cannot-parse.md) | A link keeps its place and gains a `drift` field when a literal request segment fills a producer path variable whose declared parse-strict type (`UUID`, integers, floats) cannot parse it; any other type or framework states no type and no mark | Accepted |
| [0066](adr/0066-the-mcp-answers-list-no-duplicate-and-count-template-noise.md) | The answers list no duplicate unresolved entry, count template and receiver cuts by cause, and refuse unusable controls | Accepted |
| [0067](adr/0067-record-and-lombok-members-and-mybatis-statements-are-settled-from-the-snapshot.md) | A record accessor and a plain-Lombok accessor, builder setter or `build()` is a settled `generated` receiver member (no step, no cut); a MyBatis mapper call is a data effect from its annotation or XML statement, or an `effect-unplaced` cut with its cause | Accepted |
| [0068](adr/0068-lombok-access-levels-superbuilder-and-inherited-members-are-settled.md) | An access level on `@Getter`/`@Setter`, `@SuperBuilder`, `@Builder.Default` and a member inherited from a Lombok superclass of the snapshot are settled `generated` receiver members; a member a class generates for its own field is settled when only outside superclasses leave the hierarchy open | Accepted |
| [0069](adr/0069-a-request-whose-route-is-stated-after-an-undecided-base-is-a-placed-effect.md) | A call site that states one method and route after a base the snapshot does not decide is a placed `http` effect marked `authority: "undecided"`, not `effect-unplaced`; a wrapper body adds no cut when its callers are placed | Accepted |
| [0070](adr/0070-a-spring-data-repository-call-is-a-proxy-supplied-member-and-a-vocabulary-name-an-on-demand-import-leaves-unsettled-is-read-from-its-package.md) | A call on a Spring Data repository interface whose outside hierarchy is the closed vocabulary is a settled `generated` member (derived, `@Query` or inherited operation) with its data effect placed; a closed-vocabulary name an on-demand import leaves unsettled is read from its package; `java.lang` names keep their identity; a single declared repository method needs no argument signature | Accepted |
| [0071](adr/0071-engine-investment-is-steered-by-a-cut-ledger-and-an-outcome-control.md) | Every gate run reports cuts by reason, normalized by expanded steps, and the agent evaluation gains an arm without the MCP; a change that claims fewer unknowns shows the matching number; designed in RFC-0031 | Accepted |
| [0072](adr/0072-one-owner-classifies-every-file-and-a-veto-is-released-by-reading-declarations.md) | The class of a path has one owner in the domain and a build script is build configuration in any language; a repository-wide veto from a sibling language is narrowed only by a reader of its declarations; designed in RFC-0032 | Accepted |
| [0073](adr/0073-a-classpath-the-host-declares-is-a-library-signature-source.md) | Jars a host declares are read as data for the members and supertypes of library types, beside the declared JDK; never run, loaded or discovered, and with none declared every answer is unchanged; extends ADR-0063; designed in RFC-0033 | Accepted |
| [0074](adr/0074-trace-walks-every-body-of-a-closed-set-and-a-cut-names-its-cause.md) | Trace walks each body of a proven closed set as a branch and stays `complete`; a candidate list states its basis and a cut names the places that blocked the proof; amends the last rule of ADR-0044 decision 4; designed in RFC-0034 | Accepted |
| [0075](adr/0075-the-core-names-no-language-or-framework.md) | Language and framework identities are registered values, every framework reader is a stage of a plugin registered in one place, and each adapter folder holds one technology; a refactor with no change in any answer; designed in RFC-0035 | Accepted |
| [0076](adr/0076-a-transport-is-a-protocol-plugin-and-a-link-inside-a-repository-is-kept.md) | A transport is a protocol plugin with a registered identity; a link whose ends share a repository is listed, followed and returned; a trace with a workspace continues through a link that names one entrypoint; designed in RFC-0036 | Accepted |
| [0077](adr/0077-derived-facts-persist-by-content-in-ye-asts-own-store.md) | The derived facts of ADR-0035 gain a disk tier behind the same port, keyed by content and reader version, in a directory a host may name; no fact changes; extends ADR-0035; designed in RFC-0037 | Accepted |
| [0078](adr/0078-locating-a-declaration-is-a-query-family.md) | A new query family answers the declarations and files a name or a path fragment designates, with a match class and no score; faults carry the same answer; the fixed layer is readable as MCP resources; designed in RFC-0038 | Accepted |

## Designs (RFC)

| RFC | Topic | Status |
|---|---|---|
| [0001](rfc/0001-architecture-and-layers.md) | Layers, ports, entrypoints, deployment profiles | Draft |
| [0002](rfc/0002-facts-contract.md) | Fact statuses (`complete`, `partial` with cuts, `unknown` with a reason), inputs and invalidation, determinism, redaction at egress | Draft |
| [0003](rfc/0003-codegraph-integration.md) | SDK-first access, raw-SQL remainder, path confidence (parity first, then the widest path, a bounded score for heuristic edges and free interface hops), index reuse across shas, upstream candidates | Draft |
| [0004](rfc/0004-deterministic-map.md) | `ye-ast map` in three slices, each with its parity diff, replacing the routes, operations and links of the LLM-written map; page names and flows stay with the host | Draft |
| [0005](rfc/0005-transports.md) | CLI, query server, fixed layer, MCP, hooks, daemon and its good practices | Draft |
| [0006](rfc/0006-configuration.md) | Workspace manifest and profile: trust mode, allowed snapshot kinds, budgets, redaction, store | Draft |
| [0007](rfc/0007-extension-model.md) | Languages, frameworks and protocols as plugins; the Angular and Spring plugins per gap; capability matrix; conformance | Draft |
| [0008](rfc/0008-distribution.md) | npm, Docker, Homebrew | Draft |
| [0009](rfc/0009-extraction-from-qayaba.md) | What moves, splits and stays; constraints for qayaba's migration | Draft |
| [0010](rfc/0010-impact-queries.md) | Impact of a change, callers and importers: the request, the walk without default bounds, the fact and its completeness | Draft |
| [0011](rfc/0011-cross-repository-impact.md) | Impact across repositories: links from call sites to entrypoints, upstream and downstream fixpoint, per-repository sections, the snapshot rule, reuse and completeness | Draft |
| [0012](rfc/0012-observability-and-measurement.md) | Two records: the deterministic fact as the record of why, the host's measurement of what it cost; cost inside the fact, reproduction by input identity, where a baseline lives | Draft |
| [0013](rfc/0013-trace-and-patterns.md) | `trace` and `patterns`: two read-only query families for an agent that must understand a repository and plan a change | Draft |
| [0014](rfc/0014-workspace-decisions.md) | Workspace decisions: the gaps the code cannot fill, offered to the user as options each verifiable with `path:line` | Draft |
| [0015](rfc/0015-answer-coordinates.md) | Answer coordinates an agent can act on: `endLine` on the values that name a place and the call-site line on `via`, from data the walk already reads | Draft |
| [0016](rfc/0016-type-resolution.md) | A synchronous port over `ts.createProgram` for the references the index cannot settle, a type root outside the snapshot, and the three gaps a measurement exposed: false cuts proven external, unread `paths`, and codegraph's undocumented coordinates. The port was retired 2026-11-05 | Draft |
| [0017](rfc/0017-answer-size-and-outline.md) | A counted elision is never longer than listing what it hides, and a file outline with declaration spans an agent reads around | Draft |
| [0018](rfc/0018-change-selection.md) | `changed` on `impact.ofChange`: globs over the changed paths select what seeds the walk while the repository stays indexed whole, so callers outside the selection are still known | Draft |
| [0022](rfc/0022-contract-change-consequences.md) | Contract change consequences: which consumers of a response, and which producers of a request, a contract change breaks, with evidence, from a written hypothesis or a diff | Draft |
| [0023](rfc/0023-consequences-surfaces.md) | The `contractConsequences` family on every surface: one composite fact, the MCP tool `ye_ast_contract_consequences`, the CLI command, protocol methods and compose parts | Draft |
| [0024](rfc/0024-receiver-typed-settlement.md) | Every call settles by its receiver's type and arity: the binder's member rule, candidates from the receiver's type, the contract bridge by signature, one receiver rule for trace | Accepted |
| [0025](rfc/0025-angular-route-tables.md) | Angular route tables are read wherever the router receives them: the module graph, `loadChildren` forms, prefixes, cuts, `include` | Accepted |
| [0026](rfc/0026-framework-invoked-entrypoints.md) | Code a framework invokes is an entrypoint: invoked contracts as plugin data, the `callback` kind, one finding per body | Accepted |
| [0027](rfc/0027-declaration-model.md) | Every callable the source writes is a declaration: one declaration model, object-literal and factory members, method references, anonymous classes, Java type references | Accepted |
| [0028](rfc/0028-value-flow-through-wrappers.md) | Values flow through the project's own wrappers: per-declaration request summaries, the request owner, holder carriers | Accepted |
| [0029](rfc/0029-presentation-residuals.md) | An answer never hides or misstates what the engine knows: fault text owner, absent files, answer bound, empty scope, entrypoint places, `importers` lines | Accepted |
| [0030](rfc/0030-preserve-domain-knowledge-through-projections.md) | Preserve request knowledge, unknown provenance and declaration placement; reuse grouped composition evidence and explicit selection in summaries | Accepted |
| [0031](rfc/0031-cut-ledger-and-outcome-control.md) | The cut ledger of the corpus gate and the control arm of the agent evaluation; the ledger rows each later RFC must move | Accepted |
| [0032](rfc/0032-file-classification-and-declaration-readers.md) | One classification of a snapshot's paths in the domain; a declaration reader for a language without a pack, so a veto falls only on the types a sibling-language file extends | Accepted |
| [0033](rfc/0033-declared-classpath.md) | A classpath the host declares as the library signature source: input, reading, identity, what it changes and what it must not, starting with a probe | Accepted |
| [0034](rfc/0034-closed-alternatives-and-cut-causes.md) | Branch steps for a proven closed set of bodies; the basis of a candidate list and the places of a cut's cause | Accepted |
| [0035](rfc/0035-closing-the-extension-model.md) | The as-built gaps against RFC-0007 and the refactor that makes a plugin the only thing a new framework adds | Accepted |
| [0036](rfc/0036-protocol-plugins-and-links-inside-a-repository.md) | The protocol plugin kind of RFC-0007, links whose ends share a repository, and a trace that continues through a decided link | Accepted |
| [0037](rfc/0037-persistent-derived-store.md) | A disk tier behind the derived-facts port, a host-named cache directory, and the workspace join reading only changed repositories | Accepted |
| [0038](rfc/0038-locating-declarations-and-fixed-layer-resources.md) | The `locate` family, faults that carry its answer, and the fixed layer as read-only MCP resources | Accepted |

## Pending decisions

| Topic | Where | Owner input needed |
|---|---|---|
| What to contribute to codegraph upstream | RFC-0003 | Deferred by the owner on 2026-10-29 |
| Publication | RFC-0008, Q1-Q2 | Public or private; clearance of extracted qayaba code; npm name and GitHub organization (license decided: Apache-2.0) |
| Recording the constraints in qayaba's migration | RFC-0009, Q1 | Accepted on 2026-10-30; where to record them, since qayaba's migration branch is active |
| Daemon good practices | RFC-0005 | Complete and agree before the daemon slice |

## Domain knowledge preservation follow-up

[RFC-0030](rfc/0030-preserve-domain-knowledge-through-projections.md) specifies five corrections derived from the
response-quality evaluation: request knowledge, reached uncertainty provenance, declaration placement, grouped
composition support and focused summaries. Its [implementation plan](domain-knowledge-preservation-plan.md)
tracks five implementation units and their verification. The owner accepted ADR-0052 and RFC-0030 on 2026-11-12;
that acceptance does not claim the original study is closed.

## Engine evolution program (2026-11-13)

RFC-0031 to RFC-0038 come from the engine audit of 2026-11-13: where the engine answers "cannot tell", why, and what
keeps a new language, framework or protocol from entering as a plugin. Each RFC names a mechanism, not a repository's
symptom, and each has one ADR. The owner accepted all eight on 2026-11-13, with every open question settled as
recommended. None is implemented yet.

| Order | RFC | First step | Depends on |
|---|---|---|---|
| 1 | [0031](rfc/0031-cut-ledger-and-outcome-control.md) | The ledger in the gate and one baseline. It confirms or changes the order below | nothing |
| 2 | [0032](rfc/0032-file-classification-and-declaration-readers.md) | The one classification; it removes a reproduced loss of proofs | nothing |
| 3 | [0034](rfc/0034-closed-alternatives-and-cut-causes.md) | The cause and basis of a cut; branch steps after their corpus measurement | 0031 for the measurement |
| 4 | [0033](rfc/0033-declared-classpath.md) | A probe that counts the hierarchies the jars would close; it gates the rest | 0031 |
| 5 | [0038](rfc/0038-locating-declarations-and-fixed-layer-resources.md) | The `locate` family; resources after the outcome baseline | 0031 for the resources |
| 6 | [0037](rfc/0037-persistent-derived-store.md) | A stage measurement of cold queries, then the disk tier | nothing |
| 7 | [0036](rfc/0036-protocol-plugins-and-links-inside-a-repository.md) | A probe of what each family answers for a link inside one repository | step 1 of 0035 for the protocol plugin |
| 8 | [0035](rfc/0035-closing-the-extension-model.md) | Registered identities and the hand-wired framework as a plugin; the rest with a second framework | nothing |

Three earlier decisions bound the program: a veto is released by positive proof, never by estimating what a construct
could reach (ADR-0044 decision 5, and the scoping dropped on 2026-11-08); coverage grows only with evidence
(ADR-0013); and a behavior change passes the corpus gate (ADR-0039).

## Templates

[ADR template](adr/0000-template.md) · [RFC template](rfc/0000-template.md)
