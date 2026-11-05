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
