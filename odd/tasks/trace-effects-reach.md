# Resolved trace effects through library sources and URL helpers

Status: implemented and verified. Branch: `feat/trace-effects-reach`.
Initial design baseline: `b4b42143`. Implementation baseline: `84ca4361` (descends from `2ebc1a91`).

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
| T2 | Record general design and alternatives | complete; approved (L11) |
| T3 | RED, GREEN, mutation proof and behavior documentation | implemented; RED/GREEN and break-proof observed |
| T4 | Acceptance/probe measurements and 14-command differential | complete; see L16 |
| T5 | Initial design verification and commit | complete |
| T6 | Final implementation cleanup, Node 24.22.2 check and work-unit commits | complete |

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
- L11: Owner approved declared workspace library sources for trace; runtime URL policies stay cuts; owner URL contracts excluded. Rebased onto local main `84ca4361` (descendant of `2ebc1a91`). Read findings Multi-repository analysis.
- L12: Step 0, real stdio MCP plus internal workspace read on the same sources: root service has 8 complete sites (2 NATS, 6 HTTP), 0 unresolved. HTTP sites are propagated to controller calls by existing wrapper summaries, hence more occurrences than the historical 6-site inventory. Target values and `(library)/...` provenance retained in `/tmp/ye-ast-trace-effects-step0.U1Tzwx/internal-workspace.json`. This proves library-source target resolution exists; zero workspace links is expected when no destination services are declared and is not a failure to resolve targets. MCP raw request, response, catalog and timing retained beside it.
- L13: RED integration: explicit declared-library trace returned no effects. GREEN: the same query resolves the HTTP path; a repeated local query remains identical. Extraction now receives library sources while the existing exact-position join remains unchanged. Workspace capture reuses snapshot preparation and held live captures and pins committed root sources. Composite input identity includes the workspace read.
- L14: Additional invariant repro: a request inside an uninvoked library lambda was propagated as a resolved caller effect. The source-only method-flow summary did not carry deferred execution through leaves/edges. It now carries that uncertainty for library function values using the existing syntax predicate; HTTP/message target readers retain a no-extractor cut. No trace-walk, dispatch or receiver-resolution code changed. The fixture covers HTTP through another method and a message lambda.
- L15: Compose gives effects, call sites and Link.from canonical call-place evidence (repository, snapshot, file, line); generic shared-evidence relations and shared-support connections join them. No pair-of-families branch added. Trace summaries in compose show the effects count, including a single trace.

- L16: Reconstructed and froze 111 slice-4 traces (15 largest class files per external probe repository, two engine functions, four acceptance selectors). Two initial selectors matched comment prose; their unknown-symbol attempts are retained, and workload-v2 corrects them to the actual class names. Corrected cases were rerun on both versions in separate repair directories. All 111 final cases succeed. Counts below sum occurrences across traces, not unique call sites. Acceptance service cases alone: 0/5 resolved/cuts before, 5/0 after; acceptance frontend cases: 0/0 before and after. No excluded repository was opened.
- L17: Differential: 14/14 map/callers/importers/outline/impact commands are byte-identical, all exit 0. Local trace compatibility: 111/111 trace facts without workspace are byte-identical to baseline. Raw workloads, pinned snapshots, replies, timings and comparisons are retained in scratch.
- L18: Latency below is one representative trace per repo with an empty engine cache followed by the identical warm request; one sample per cell, on a shared loaded host. These descriptive timings do not establish a speedup. The full workload also retains first-pass and repeat timings.

| Probe | Traces | Resolved effects | Effect cuts | Cold ms | Warm ms |
|---|---:|---:|---:|---:|---:|
| pfe | 15 | 47 → 47 | 0 → 0 | 3253 → 1489 | 331 → 183 |
| pbr | 15 | 0 → 0 | 0 → 0 | 5266 → 3015 | 3194 → 1843 |
| rwf | 15 | 16 → 16 | 0 → 0 | 2528 → 1106 | 232 → 137 |
| rwb | 15 | 0 → 0 | 0 → 0 | 6574 → 4525 | 4544 → 3644 |
| shop | 15 | 41 → 41 | 0 → 0 | 3856 → 2985 | 885 → 736 |
| ord | 17 | 0 → 13 | 7 → 0 | 2791 → 2642 | 1561 → 1716 |
| web | 17 | 0 → 0 | 0 → 0 | 8434 → 8085 | 1885 → 2374 |
| self | 2 | 0 → 0 | 0 → 0 | 11907 → 14539 | 4264 → 5069 |

- L19: Break-proof: library-source wiring, dependency closure, deferred edge, deferred message, deferred cache identity, effect place, link place, MCP dispatch, CLI input and protocol input mutations are caught. The call-site place mutation exposed an incorrect fixture expectation (15 instead of 14); after correcting it, GREEN and the failing mutation are both recorded. Final proof: 11 distinct mutations caught; all mutated files restored.
- L20: Catalogue: 33,807 bytes for the complete tools list versus 45,287 at baseline, within 36,100. Common field conventions are centralized in server instructions, duplicated descriptions shortened, validation constraints retained. The catalogue test now enforces the requested full-list budget. Real stdio proof: workspace trace resolves a publisher effect; compose accepts trace + workspace; a single composed trace prints effects (1).
- L21: Global code-cleanup plus repo extension reviewed this own diff. Reused workspace capture/dependency closure, library paths, syntax predicate, composite input identity and generic composition shared-support rules. Cleanup confined call-place metadata to its three consumers and kept workspace-match relation identity unchanged. No new service, dependency or schema version. Final verification follows below. Earlier focused suites used their own OS temporary fixtures; subsequent focused runs and the final gate set TMPDIR inside scratch.
- L22: Work units: (1) declared-source trace input/extraction and catalogue coverage, with tests/docs; (2) canonical call-place composition and summary, with tests/docs. Rollback: revert the corresponding unit; root walk/dispatch/receiver files are untouched. Runtime harness: real stdio requests and responses in scratch/public-proof, CLI integration fixture, and protocol routing test. No push or merge.

- L23: Final `npm run check`, Node v24.22.2: exit 0; 3736 tests pass, 0 fail, 0 cancelled/skipped. Typecheck and architecture pass (565 modules, 3673 dependencies). The command ran once at the end; complete log: scratch/check-final.log. No production source changes followed this run. Initial stdio probes and early focused suites used engine/test-owned OS temporary directories; later runs set TMPDIR inside scratch. No pre-existing external content was deleted.
- L24: Work unit 1: `341204e32550e14bef58666a84ee539bba8a19f1` (declared-source trace input/extraction and catalogue). Work unit 2 is this closure commit (call-place evidence and composed summary). The final check covers the integrated source tree. No push; the worktree is retained for lead integration and independent review.
