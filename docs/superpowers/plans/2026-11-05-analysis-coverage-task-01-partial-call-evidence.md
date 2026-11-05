# Task 1 Preserve partial outbound call evidence

## Assignment

Role: investigator and implementation planner for backend call evidence. Determine how to preserve known parts of an unresolved Java HTTP call and carry unresolved call details through workspace impact. Return a concrete plan; do not implement yet.

Workspace: `/Users/arielyumn/Desktop/TRABAJO/ye-ast`. Handoff baseline: `d35093f807c4a789cb32b50040fad31c0a73ab04`, 2026-11-05. Recheck current code and working-tree changes. You are not alone in this repository: preserve others' edits. Own only your investigation and its task-specific follow-up document. Do not spawn subagents, change dependencies, commit or push.

## Why this matters

An unknown destination does not make a known HTTP method and path useless. Keeping `GET /orders` helps an agent locate the provider or request a user declaration while the destination remains unknown. This improvement preserves evidence; it must not be described as recovering a verified cross-service link.

There are two boundaries to investigate together: Java extraction discards partial request information; workspace impact can discard details discovery already produced.

## Read first

- `AGENTS.md` and `.claude/skills/ye-ast-testing/SKILL.md`.
- `docs/architecture/rfc/0002-facts-contract.md`, `0011-cross-repository-impact.md`, and `0015-answer-coordinates.md`.
- `docs/architecture/adr/0010-trust-modes.md` and `0022-typed-query-replay-and-selective-evidence.md`.
- `docs/superpowers/plans/2026-11-05-current-engine-mechanism-improvements.md` and `docs/superpowers/specs/2026-11-04-mcp-selective-evidence-recovery-design.md`.

Prefer the available code graph for structural discovery, then inspect the implementation. Start from these owners and consumers:

| Surface | Responsibility |
| --- | --- |
| `src/core/domain/topology/call-site.ts` | `CallSite.stated`, `StatedRequest`, `UnresolvedCallSite`, `unresolvedCallSite`. |
| `src/core/adapters/spring/http-call-sites.adapter.ts` | `JavaHttpReader.target` and `targetOf`: method, URL and base resolution. |
| `src/core/adapters/spring/java-call-sites.adapter.ts` | Public Java call-site reader, shared parsing. |
| `src/core/adapters/typescript/http-call-sites.adapter.ts` | Existing `stated` behavior when only the base is undecided. |
| `src/core/application/topology/workspace-queries.ts` | Discovery's unresolved evidence. |
| `src/core/application/topology/workspace-impact.ts` | `RepoImpact` construction and `sectionOf`. |
| `src/core/ports/workspace-impact-queries.port.ts` | Verify the current public contract and its domain imports. |
| `src/mcp/render.ts`, `src/protocol/` | Inspect actual downstream delivery; do not assume full structured output retains missing core data. |

## Evidence already observed

The current domain model permits `stated: { method, path }` beside an unknown destination. TypeScript extraction already produces it. The Java target helper returns only a `Finding<HttpTarget>`; when base resolution fails, the method and path can disappear together.

This adapter probe was executed successfully during the investigation:

```bash
node --import tsx --input-type=module <<'JS'
import { createJavaParser } from './src/core/adapters/tree-sitter/java-parser.adapter.ts';
import { createJavaHttpCallSites } from './src/core/adapters/spring/java-call-sites.adapter.ts';
const reader = createJavaHttpCallSites(await createJavaParser());
const content = `package app;
import org.springframework.web.client.RestClient;
class OrdersClient {
 private final RestClient rest;
 OrdersClient(RestClient.Builder builder, String base) { this.rest = builder.baseUrl(base).build(); }
 String load() { return rest.get().uri("/orders").retrieve().body(String.class); }
}`;
console.log(JSON.stringify(await reader.of([
  { path: 'src/main/java/app/OrdersClient.java', content }
], 'consumer')));
JS
```

Observed: one HTTP site in `OrdersClient.load`, line 6, with `target.status: "unknown"`, `reason: "unresolved"`, and no `stated`. The source explicitly states `GET /orders`.

Separately, source inspection found that discovery carries `unresolved`, but workspace impact constructs values with `reads`, optional `impact`, `callSites`, `unmatched` and `external`. The cut remains; the detailed unresolved record is not copied into that value. Reproduce this second boundary through the public workspace-impact query before treating it as an implementation-ready defect.

## Investigation steps

- [ ] Rerun the Java probe and identify the precise point where method/path knowledge is lost. Inspect declarative clients too; do not widen coverage without a reproduced shape.
- [ ] Trace the same call through discovery, impact composition, full structured delivery and text. Record fields retained or lost at each boundary.
- [ ] Reuse TypeScript's meaning of `stated`; establish how unresolved URL segments, query strings and dynamic methods affect eligibility. Never infer a known path from an unknown expression.
- [ ] Find the smallest public-seam fixture for discovery-to-impact loss. Inspect existing `workspace-impact.test.ts` unresolved-site tests before adding a new test proposal.
- [ ] Decide whether existing cut locations suffice for some consumers and which additional record materially avoids a follow-up source read.
- [ ] Propose the public-contract change, if needed, with deterministic order, repository ownership, schema/producer implications, redaction and compatibility. The owner must agree before production changes.

## Acceptance criteria for the proposed implementation

- Known method/path survive an unknown base, with their original source evidence.
- The target remains unknown; no speculative link is created and no valid cut is retired.
- Unknown method or path never becomes a fabricated `stated` request.
- Workspace impact preserves useful unresolved context from its actual contributing snapshot, without merging unrelated repositories or ambiguous sites.
- Presentation-only omission stays separate from analysis uncertainty and follows the current response/recovery design.

## Verification and return

Plan meaningful tests through the Java reader and workspace query family; follow the project testing skill, with observed RED/GREEN and type-correct break proofs when implementation begins. Candidate focused files are `http-call-sites.adapter.test.ts`, `call-site.test.ts` and `workspace-impact.test.ts`; add transport coverage only for changed wiring.

Record the baseline and candidate public payloads, retained evidence, false links, latency and memory under the same inputs. Do not claim additional reach unless a separately verified link is recovered. Finish implementation verification with `npm run check`, `git diff --check` and a global search for other places that discard the same existing evidence.

Return a task-specific investigation report and improved plan: verified root causes, ownership, proposed signatures/contracts, tests, compatibility decisions, risks and an implement/narrow/defer/reject recommendation. Report exact commands and observed results, not assumed outcomes.

## Outcome

Implemented on 2026-11-05 from `98b9cc5`, after the owner authorized implementation. Classification: **preserved
evidence**. No dependency or cross-service link is recovered; every target that was `unknown` stays `unknown` and every
`unresolved-link` cut stays.

### Root causes (verified)

1. Java extraction: `targetOf` in `src/core/adapters/spring/http-call-sites.adapter.ts` returned `undefined` for a
   relative URL under a client base the snapshot does not decide (`UNDECIDED`), and `target` collapsed that into a bare
   unknown finding. The Feign path did the same when its `url`/`name` attribute was not decided.
2. Workspace impact: `RepoImpact` had no field for the discovery record. `workspace-impact.ts` kept only the discovery
   provenance (without value) and its cuts, so declaration, transport, library and stated request were dropped.

### What changed

- `JavaHttpReader` returns the target with an optional `stated` (a local `ReadTarget`, the TypeScript reader's
  precedent). `targetOf` keeps the path with base `UNDECIDED`; `target`, wrapper calls and Feign clients turn that into
  an unknown target plus `stated: { method, path }`. The wrapper rule (`wrapperOf`) still treats an undecided base as
  undecided. An undecided method, a URL whose text is not decided, or a URL a run-time part leads (`{}` first) states
  nothing.
- `RepoImpact.unresolved: UnresolvedCallSite[]` is copied from the section's own discovery fact
  (`workspace.sections[repo]`), never merged across repositories; ambiguous sites stay cuts only.
- MCP: the `ye_ast_impact`/`ye_ast_callers` output schema validates `sections[repo].value.unresolved` (shared
  `unresolvedCallSite` zod shape, also used by `ye_ast_workspace`); summary/details text lists the section's unresolved
  sites with the existing `unresolvedListing`, as `ye_ast_workspace` already does.
- Fact schema `0.12.0` -> `0.13.0` (RFC-0002 rule 6, a field added). RFC-0002 and the RFC-0011 envelope updated.

### Evidence

Scratch reproduction through `composeQueries().workspaceImpact.callers` with two git repositories (`orders` serving
`GET /orders`, `consumer` with the brief's `RestClient` client), trigger `OrderController.list`:

| Field | Before (`98b9cc5`) | After (`1168f6b`) |
| --- | --- | --- |
| discovery `unresolved[0]` | `{path, line: 6, symbol: "OrdersClient.load", transport: "http"}` | same plus `stated: {method: "GET", path: "/orders"}` |
| impact `sections.consumer.value.unresolved` | absent | the same record, `stated` included |
| impact `sections.consumer.cuts` | `unresolved-link` at `OrdersClient.java:6` | unchanged |
| `links` / composite status | `0` / `partial` (cut `section consumer`) | unchanged |

Single runs, not a benchmark: 1454 ms / 267 MB RSS before, 637 ms / 246 MB after (the first run includes cold parser
and cache setup); no latency or memory claim is made.

Tests (RED observed for the stated reason, then GREEN, each break-proofed with a type-correct mutation):

- `http-call-sites.adapter.test.ts`: undecided base states the request; undecided method or a `String.format` URL led
  by a run-time part states nothing (negative control, fails when the method guard or the leading-placeholder guard is
  removed); a wrapper call states its arguments' request; a Feign client with an undecided `url` states each mapping.
- `workspace-impact.test.ts`: each section carries its own discovery's records (fails when emptied or merged across
  repositories).
- `server.test.ts`: the output schema rejects a malformed `unresolved` entry (runtime and JSON schema); the section
  text lists the record with its stated request.

`npm run check`: typecheck, arch check and 2,244 tests pass. `git diff --check` clean.

### Not changed, and why

- `@HttpExchange` with an undecided type-level prefix, and Feign with a decided but non-absolute `url`: the undecided
  part can hold path segments, so no path is known; they stay unknown without `stated`. No reproduced need.
- Concatenations whose first operand is undecided (`base + "/orders"`) are undecided text in `UrlText`, so they state
  nothing: the base may carry a path prefix. This is the "never infer a known path" rule, not a gap.
- `decision-set.ts` reads only `via` from unresolved sites; whether decisions should show `stated` is a separate
  question.
- No full-mode guide line was added for `value.unresolved`; ADR-0022 selection is unchanged (the cuts remain the
  selectable records). No new response API.
