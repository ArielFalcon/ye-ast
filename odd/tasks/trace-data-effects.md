# Trace data-access effects (RFC-0013 R12)

Objective: report framework-proven data-access effects at their exact call sites without guessing targets or amplifying getter noise.
Branch: `feat/trace-data-effects`, base `b4b421439792b2eb108e6342402dcce1aec24890` (local main).
Status: implementation and verification complete; no push.

## Specs

- S1: RFC-0013 R12 and decision 3: one framework row, project data layers traversed as code.
- S2: RFC-0007 and ADR-0013: evidence before rows, conformance fixtures, measured real applications; no app-specific vocabulary.
- S3: preserve slice 4 exact-position ownership and function-value cuts; no type checker, no tool-description growth.
- S4: facts carry the operation; entity/table/collection only with source proof. Unknown targets are optional, never inferred from names.
- S5: isolate HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME; never use ThingsBoard; never push.
- S6: Owner standing rule, reaffirmed in this task: no SCHEMA bump or compatibility arguments while MCP has no consumers; add data in place.

## Tasks

| Task | Status |
|---|---|
| Copy and read instructions, create branch and isolated scratch | done |
| Discover corpus, collect initial framework evidence | done |
| Record design and contract decision | done; owner confirmed no bump and MyBatis deferral |
| Freeze baseline workload and measure all 111 traces plus differential | done |
| RED conformance fixtures, GREEN implementation, break-proof | done |
| Measure candidate, cleanup, final Node 24.22.2 check | done |

## Log

- L1 (2026-11-07) Goal from brief: a `data` effect kind for the framework data-access APIs actually used by the probe and acceptance repositories; facts only, minimal noise, measured before/after, existing slice 4 machinery reused.
- L2: Copied AGENTS.md, CLAUDE.md, .claude/ and odd/ from the main checkout before investigation. Read RFC-0013, RFC-0007, ADR-0013, RFC-0011, slice 4 task and evaluation/testing skills. Scratch: `/tmp/ye-ast-data-effects.fcVevF`; isolated home/config/cache subdirectories; node_modules symlink to main. No repository code executed during inventory.
- L3: Corpus from evaluation catalog and slice 4: pfe (Angular frontend), pbr (REST backend), rwf (Nx frontend), rwb (MyBatis backend), shop (commerce backend), ord (acceptance service), web (acceptance frontend), self. ThingsBoard excluded. Scratch inventory.json records paths, HEADs and source coordinates. These are lexical evidence candidates, NOT measured trace effect counts. Whole-file call candidates include unrelated receivers and must not be reported as resolved data calls.

### Inventory evidence (initial)

| Probe | Verified framework evidence | Proposed coverage |
|---|---|---|
| pfe, rwf, web, self | No matching ORM imports in initial tracked-source scan | No new TypeScript rows |
| pbr | Spring Data Repository generic specializations; NamedParameterJdbcTemplate, JdbcTemplate, SimpleJdbcInsert; jakarta.persistence.EntityManager | Spring Data, JDBC, JPA |
| shop | 58 JpaRepository imports, 15 PagingAndSortingRepository imports; 10 javax.persistence.EntityManager imports | Spring Data, JPA |
| ord | OrderRepository extends JpaRepository<OrderEntity, UUID> | Spring Data |
| rwb | 10 MyBatis @Mapper imports; repository calls mapper.find/insert/delete | Explicit MyBatis frontier until a measured mapper/XML row is justified |

Examples: pbr `repository/springdatajpa/SpringDataOwnerRepository.java:39` extends both its own OwnerRepository and framework Repository<Owner,Integer>; pbr `repository/jdbc/JdbcOwnerRepositoryImpl.java:85` calls namedParameterJdbcTemplate.query; shop `repositories/catalog/category/CategoryRepositoryImpl.java:31` calls em.createQuery; rwb `infrastructure/repository/MyBatisArticleFavoriteRepository.java:21-33` calls mapper.find/insert/delete, whose interface has @Mapper. Paths are suffixes of the source roots recorded in inventory.json.

No MongoTemplate, RedisTemplate or TypeScript ORM was found in this initial scan. Do not add their rows on the strength of examples in the brief alone. MyBatis source evidence is real, but only one measured application currently supports it; ADR-0013's two-application requirement must be reconciled before claiming that row delivered.

### Proposed design

1. A Spring syntax vocabulary declares framework type/member pairs. Resolve imports strictly; follow repository generic supertypes with type-variable substitution and ambiguity guards. An override with a body remains project code and must be traversed, never replaced with a framework effect.
2. Keep data sites separate from workspace HTTP/event transport: data is not a cross-service link. Reuse the placed-site shape and existing trace ownership/join rule; generalize only the site's payload if needed, avoiding a new transport leaking into workspace matching.
3. Proposed TraceEffect variant: `{ kind: "data", line, operation, access: "read" | "write" | "unknown", target?: { kind: "entity" | "table" | "collection", name } }`. Operation is the proven framework member; target is optional. Generic repository entity proof is allowed. No SQL parser is introduced just to guess a table. JPA query construction alone is not query execution; fluent query execution needs its own syntax proof or an explicit cut.
4. Reads stay visible, distinguished from writes; no bean getter is a row. Keep per-call source order first. Do not group away locations or suppress reads before measuring the frozen probes. Measure read/write counts and text bytes before deciding whether further presentation changes are warranted.
5. Undecidable framework targets may still yield operation-only effects when framework membership is proven. Ambiguous membership, unaccounted calls and unproven function values are cuts using slice 4 ownership. No method-name heuristic for save/find/delete.
6. Render/MCP/compose normalization and schema must accept data consistently. Keep all tool descriptions unchanged. Shared effect files receive minimal additive edits for integration with feat/trace-effects-reach.

### Alternatives considered

| Alternative | Advantage | Reason discarded / cost |
|---|---|---|
| Recommended and accepted: explicit data variant in place | Truthful typed payload, optional proven target, read/write distinction | SCHEMA stays unchanged under the owner rule |
| Bump the fact schema | Follows the general versioning RFC | Discarded by the owner: no MCP consumers, so no bump or compatibility argument |
| Put data into existing message/http targets | Avoids version edit | Changes transport meaning and creates false workspace links; violates facts contract |
| Reuse external names or cut text as data output | Leaves schema unchanged | Does not implement the requested data effect contract or structured compose behavior |
| Drop all reads | Reduces text | Hides data dependencies; no measurement supports that loss |
| Group by entity immediately | Potentially shorter text | Can hide ordering and repeated operations; unknown entity remains common |
| Add all example APIs now | Broad catalog | Violates evidence-first coverage |

### Contract checkpoint

Confirmed: the owner reaffirmed that SCHEMA remains 0.21.0 while MCP has no consumers. The explicit data variant and compose schema are added in place, independently of HTTP/message shapes. MyBatis stays deferred. The previous request for a schema decision was superseded by this instruction.

### Verification plan and current results

Freeze the 15-largest-class workload for each slice 4 repository, the two self symbols and four acceptance traces, pinned to identical input SHAs for both engine versions. Preserve raw text and structured output under scratch; count resolved data/read/write effects and cuts per repo, total UTF-8 trace text bytes, and validate every added effect against source. Run the existing 14-command differential and compare raw bytes; SCHEMA remains unchanged. RED per row, GREEN, type-correct mutations, then one final `npm run check` with Node 24.22.2.

At the design checkpoint, the before/after and checks were not measured. Historical slice 4 counts are not this branch's baseline; final measurements are recorded below.


- L4: Owner explicitly rejected the schema checkpoint: no bump or compatibility argument while MCP has no consumers. Implement structured data in place; defer MyBatis; continue full process. The checkpoint discussion above is historical and superseded.
- L5: RED adapter fixtures failed with empty sites; GREEN Spring Data generic ancestry, raw generics, framework direct bindings, JDBC and JPA execution fixtures. Additional RED caught @Modifying being mistaken for read; GREEN annotation precedence. Integration RED had no data effects; GREEN exact owning method, same-line sibling exclusion and uninvoked Java lambda cut. Existing walk limitation observed separately: an internal method named save may remain a receiver-resolution cut; this change does not alter that walk rule.
- L6: Baseline and candidate run-owned artifacts retained under scratch. Initial manifest accidentally matched the word class inside an advice comment (target handles); both versions returned unknown-symbol. Corrected the target to ExceptionControllerAdvice and retain both failed attempts; correction re-run pending. Frozen differential: 3 maps, 4 callers, 2 importers, 2 outlines, 3 impacts = 14 commands. No target-repository state changed.

- L7: Complete syntax inventory before fluent JPA execution: pbr 138, shop 294, ord 1 data sites; all other corpora zero. A broad terminal-call reconciliation found 2 additional JPA executions in the REST backend and 9 in the commerce backend through standard query setters. RED reproduced empty extraction for createQuery().setParameter().setMaxResults().getResultList(); GREEN follows only declared Query configuration members, never an arbitrary fluent method. Final syntax inventory: pbr 140, shop 303, ord 1; zero conflicting single imports in every corpus snapshot. The premature full check was terminated before completion; its log is check-interrupted.log. The completed final gate is check-final.log.
- L8: Preserve all earlier candidate attempts. Candidate refresh reuses only facts whose expanded steps and folded leaves do not touch any of the three files with newly admitted fluent sites; changed/unmeasured traces are re-run with the final reader. Baseline correction artifacts override the invalid advice target and supply the four acceptance traces. Manifests, raw stdout/stderr, render text and exact pinned SHAs are retained under scratch. Inventory is extraction evidence, distinct from effects reached by traces.

- L9: Final Node v24.22.2 gate: npm run check exited 0; 3714 tests, 3714 pass, 0 fail (154736.923 ms), typecheck and arch:check clean. Catalogue measurement is exactly 36,100 bytes for original tools, with unchanged descriptions. Cleanup over the implementation diff found no remaining issue; broad effect-kind consumers were searched and the old test helper's union narrowing was updated. SCHEMA remains 0.21.0. Final completed full gate log: check-final.log; one earlier run was intentionally interrupted to fix the newly reproduced fluent-query gap.

- L10: The corpus selector also matched a class comment in RestaurantModel (target encapsulates). Both engines failed equally; corrected to RestaurantModel and re-ran both, retaining failed attempts. Acceptance selectors were reconciled with the actual checkout API and OrderPage UI route, and all four re-run on both engines. Final manifests and comparison.json select the corrected results explicitly. All 111 final cases exit 0.
- L11: Final measurements: pfe 0→0, pbr 0→74 (43 read/31 write), rwf 0→0, rwb 0→0, shop 0→21 (21 read), ord 0→3 (3 write), web 0→0, self 0→0, acceptance 0→0. No new data cuts. 95/111 raw traces identical; stripping only data effects makes all 111 structured facts equal. Differential 14/14 byte-identical, all exit 0.
- L12: Summary UTF-8 text 301146→314247 bytes (+13101, 4.35%). Maximum 16 data effects per trace; keep reads and writes visible and getters excluded. Detailed per-repository figures are in RFC-0013's Data effects measured section. Cleanup of the final documentation diff: clean; no source changed after the final gate except wording/comment clarification.

- L13: Independent review ac6c13b9 NOT READY: B1 local type identity and wrong local entity target, B2 lexical value shadowing, B3 name-only overload annotation aggregation. RED from the local JdbcTemplate/Order, enhanced-for and SELECT-vs-@Modifying repros; table covers parameter, typed lambda, catch and inner-class shadowing. Root: place-free java-invocations receiverOf/localBindings and qualifiedTypeName bypassed the existing lexical receiver/type proof; same-name methods were combined without a signature. Correction reuses javaReceiverBindings, annotationAt/resolve (strict JavaProject.bindName with lexical place), typeIdentity for entity identity, readSignature/sameSignature before reading method annotations or bodies. Unproven data-site ownership, receiver identity or called signature produces a cut; no read/write is invented. A proven project/local type is not a data row. The baseline local-class false complete is deliberately unchanged. Wildcard coverage remains advisory.

- L14: The shared receiver reader can optionally retain annotation candidates marked unproven. Data requests these only to preserve cuts when value ownership fails; existing readers default to proven bindings only. The shared strict type resolver can optionally identify a non-platform library type, so a REST or MyBatis client is not mislabeled as an unknown data access. No plugin name/field fallback was added. Four exact compiled review fixtures are retained and exercised end to end; all compile with the cached Spring/JPA jars (javac-final.log). Focused conformance and shared signature tests pass. Six type-correct break-proof mutations were detected, covering lexical receiver scope, entity scope, signature identity, shared value binding, unproven-candidate rejection and conflicting imports.

- L15: Correction gate on Node v24.22.2: npm run check executed once and exited 0, 3720 tests/pass, 0 fail (286300.298 ms); typecheck and arch:check pass. Focused correction/shared-reader suite: 31 pass, 0 fail. Cached-jar javac compilation of all four review fixtures exits 0. Global and repository code-cleanup over the correction diff: reuse shared proof owners, no remaining findings; only API comment clarification followed the gate. No SCHEMA/catalogue-description changes.
