# Resolved trace effects through library sources and URL helpers

Status: design only; owner decision required. Branch: `feat/trace-effects-reach`.
Baseline: `b4b421439792b2eb108e6342402dcce1aec24890` (descends from requested minimum).

## Specs

- S1: RFC-0013 R12: resolve only effects proven by source or declared contracts; preserve library-naming cuts otherwise.
- S2: RFC-0011 call-site extraction owns targets and wrapper derivation. A wrapper request belongs at its caller.
- S3: RFC-0007 and ADR-0013: application idioms are data; no application-specific vocabulary, type checker or SCHEMA bump.
- S4: Preserve exact-position ownership and cuts inside undeclared function values. Leave concurrent data-access work untouched.
- S5: Stop after design if completing acceptance requires an owner decision about library-source declarations or external reads.

## Tasks

| ID | Work | State |
|---|---|---|
| T1 | Inspect existing source transport, workspace declarations and wrapper derivation | complete |
| T2 | Record general design and alternatives | complete; pending owner decision |
| T3 | RED, GREEN, mutation proof and behavior documentation | blocked by T2 |
| T4 | Acceptance/probe measurements and 14-command differential | not executed; design gate |
| T5 | Final Node 24.22.2 check and design commit | complete |

## Log

- L1: Goal: resolve effects robustly and generically when calls pass through project-owned HTTP/messaging libraries or URL helpers, using only source or declared contracts as proof.
- L2: Confirmed: `LibrarySource` and `libraryPath` already carry external repository source and provenance (`src/core/domain/topology/library-source.ts:2`). Workspace extraction computes dependency closures from declared repositories and artifact evidence and passes their sources into extraction (`src/core/application/topology/workspace-queries.ts:130-147`). This is usable infrastructure, not automatic discovery or permission to read arbitrary installed artifacts.
- L3: Confirmed: trace has neither a workspace nor a library-source request field (`src/core/ports/trace-queries.port.ts:40-52`), and passes only the root snapshot sources to placed call-site extraction (`src/core/application/trace/trace-queries.ts:126`). Therefore merely configuring a workspace does not currently give trace library sources.
- L4: Confirmed: wrapper derivation already follows same-class helpers that forward a parameter as an unchanged path tail (`src/core/adapters/typescript/http-call-sites.adapter.ts:358-418`). The acceptance helper instead delegates to another injected service; that service substitutes placeholders, checks absolute URLs, chooses an options/configuration base, trims slashes and concatenates. Treating this as unchanged-tail forwarding would assert a rule the code does not prove. Its runtime base may change the path, so resolving just a suffix is insufficient evidence.
- L5: Recommended design, pending approval: let trace consume explicitly supplied workspace repository snapshots through the existing workspace declaration and dependency-closure rules. Reuse library extraction and provenance; never scan dependency caches, read jars, execute helpers or infer destinations from library names. Extend parameter-flow evaluation only for source-proven operations, conservatively rejecting unresolved branches, mutations and cycles. For opaque/runtime URL policies, require an explicit contract through the existing extension/configuration model; keep unresolved targets as cuts. Do not edit the trace ownership/join algorithm. This is general because repositories, dependency coordinates and helper semantics arrive as input rather than product vocabulary.
- L6: Alternatives: (a) implicit local/cache/jar scanning rejected: widens source authority, loses snapshot provenance and does not establish the deployed version; (b) library/name-specific effect rows rejected: violates project agnosticism and facts-only coverage; (c) generic call markers rejected: adds noise without resolving a target; (d) extending only the same-class helper rule rejected as a complete solution: does not address absent library snapshots or the acceptance helper's delegated runtime semantics; (e) interpreting arbitrary helper bodies rejected: disproportionate semantic scope and no guarantee of decidability. Source declarations cost setup but preserve evidence and trust; contracts reduce source requirements but require users to own their correctness.
- L7: Decision requested: approve explicit workspace sources for trace, with unresolved runtime helper policies remaining cuts until source evaluation or a declared contract proves the full target. This changes the request/configuration surface and cannot be silently selected under S5. Library repositories exist locally, but their presence alone is not a declared snapshot dependency for trace.
- L8: Measurement status: no new acceptance or probe measurements collected; no before/after improvement claimed. Historical slice-4 measurements remain in `trace-slice4.md` and RFC-0013, tied to their original revisions. The 14-command differential, RED/GREEN and break-proof are deferred until implementation is authorized. No production behavior or RFC/ADR decision text changed. Corpus discovered through the evaluation skill's sibling catalog; excluded corpus entry was not opened or probed.
- L9: Scratch: `/tmp/ye-ast-trace-effects-reach.53pOeN`; check uses isolated HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME there. Dependencies symlinked from main checkout. No push or deletion performed. Cleanup reviewed only this document against global/repository bars; no findings.
- L10: `npm run check` on Node v24.22.2 exited 0 (typecheck, architecture check and tests); raw output retained in scratch/check.log. Design-only handoff; implementation and measurement remain pending.
