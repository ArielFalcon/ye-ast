# Trace data-access effects (RFC-0013 R12)

Objective: report framework-proven data-access effects at their exact call sites without guessing targets or amplifying getter noise.
Branch: `feat/trace-data-effects`, base `b4b421439792b2eb108e6342402dcce1aec24890` (local main).
Status: design checkpoint; implementation not started.

## Specs

- S1: RFC-0013 R12 and decision 3: one framework row, project data layers traversed as code.
- S2: RFC-0007 and ADR-0013: evidence before rows, conformance fixtures, measured real applications; no app-specific vocabulary.
- S3: preserve slice 4 exact-position ownership and function-value cuts; no type checker, no tool-description growth.
- S4: facts carry the operation; entity/table/collection only with source proof. Unknown targets are optional, never inferred from names.
- S5: isolate HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME; never use ThingsBoard; never push.
- S6: RFC-0002 rule 6 versions added fact fields as a minor change. Report any unavoidable SCHEMA change before applying it.

## Tasks

| Task | Status |
|---|---|
| Copy and read instructions, create branch and isolated scratch | done |
| Discover corpus, collect initial framework evidence | done; call inventory reconciliation pending |
| Record design and contract decision | done; owner decision pending |
| Freeze baseline workload and measure all 111 traces plus differential | pending |
| RED conformance fixtures, GREEN implementation, break-proof | pending |
| Measure candidate, cleanup, final Node 24.22.2 check | pending |

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
| Recommended: explicit data variant and minor fact-schema version | Truthful typed payload, optional proven target, read/write distinction | Changes global schema bytes; requires owner checkpoint before implementation |
| Put data into existing message/http targets | Avoids version edit | Changes transport meaning and creates false workspace links; violates facts contract |
| Reuse external names or cut text as data output | Leaves schema unchanged | Does not implement the requested data effect contract or structured compose behavior |
| Drop all reads | Reduces text | Hides data dependencies; no measurement supports that loss |
| Group by entity immediately | Potentially shorter text | Can hide ordering and repeated operations; unknown entity remains common |
| Add all example APIs now | Broad catalog | Violates evidence-first coverage |

### Contract checkpoint

Confirmed: `trace-fact.ts:24` admits only HTTP/message variants, `call-site.ts` only HTTP/event transports; RFC-0002 rule 6 requires minor versioning for added fields. SCHEMA currently is 0.21.0. The proposed structured data operation/access/target fields cannot be expressed faithfully in those variants. Recommendation: authorize a minor bump (next free minor at integration), then implement. No SCHEMA edit has been made. This is a public-contract decision, not a parser limitation.

### Verification plan and current results

Freeze the 15-largest-class workload for each slice 4 repository, the two self symbols and four acceptance traces, pinned to identical input SHAs for both engine versions. Preserve raw text and structured output under scratch; count resolved data/read/write effects and cuts per repo, total UTF-8 trace text bytes, and validate every added effect against source. Run the existing 14-command differential and compare bytes after excluding only explicitly versioned schema metadata if the bump is approved; report raw byte differences as well. RED per row, GREEN, type-correct mutations, then one final `npm run check` with Node 24.22.2.

Before/after data counts, text-size delta, 14-command differential: not measured (design checkpoint). Historical slice 4 counts are not a baseline for this branch. `npm run check`: not run; implementation and final verification pending. No success claim.
