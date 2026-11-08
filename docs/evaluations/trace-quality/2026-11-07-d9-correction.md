# D9 review correction validation (2026-11-08)

Correction source commit: `b05065eeec286bd7a24bff0f48faea128942cca5`.

Review baseline: `63468af5557649467932a398903ed17fde37533f`. This is the single owner-authorized correction round for the 2026-11-07 evaluation. Evidence: `/tmp/ye-ast-d9-correction.O9w1aI`; review: `tmp.7OJQzaYuN2/review.md` and `reproduce.py` in the supplied system-temp directory.

## Confirmed cause and correction

The initial lift trusted incomplete exclusion sets. Type-pattern annotation matching omitted lexical enclosing types; the aspect inventory omitted source Advisor/Advice/proxy factories and Spring XML; generation checks stopped at the owner instead of every subtype.

- Type designators now use declaring types and the full TypeDecl.outer chain, including annotation reads. Undecidable annotation identities stay possible matches.
- Source references to AOP advice types, static proxy factories, unresolved AOP imports and supplied library sources preserve a global veto. Java names use the existing resolver and type-name reader. Programmatic Advisor applicability is not proven by a literal initial pointcut, so these registrations remain conservative cuts.
- XML missing from the sources or not classified as a plain Maven model keeps the global veto. Spring beans/AOP/autoproxy/advisors/interceptors and unknown XML vocabularies are not assumed empty. This can also veto non-AOP XML that the bounded reader cannot classify.
- Every type at/below the owner and its ancestors is checked for generator annotations and Spring Data supertypes. Every method on those types participates: an annotation on another member or a default method can signal a proxy implementing the entire interface.
- Every Java adapter dispatch-veto unknown carries a closed reason: aspect may replace the body, generated implementation, or dispatch not proven. SCHEMA is unchanged.

## RED / GREEN and runtime evidence

The reviewer's five runtime cases were reproduced before changes; each printed zero calls to the body claimed by the reviewed lift. Five review regressions were RED. Additional default-member, other-member and static factory variants were observed RED before closing their general rule. Final focused suite: 149 pass; dependent receiver suite: 9 pass. Eight type-correct mutations are caught and restored GREEN.

The original reviewer probe supplies a nonexistent application.xml path to every fixture. To avoid masking the Java/type fixes with the XML veto, the correction also uses an unmasked probe with actual paths only: nested/Advisor/XML/generated all cut, for their corresponding reasons. The independent unit rows similarly isolate each mechanism. Runtime and probe logs are retained.

### Dependency boundary (advisory preserved)

The unmasked unread-library fixture still proves a body, while its external library advice suppresses it at runtime. This is explicitly outside the source-bound proof, preserving main's behavior as the owner required; it is not claimed fixed. A row supplying that library's Java source proves the inventory then vetoes dispatch. The R7 vocabulary does not certify absence of advice in unread dependencies. No jar/type checker is introduced.

## Named cases: reviewed head to correction

Each cell is steps / maximum depth / cuts / complete / effects. All remain partial.

| Case | Reviewed 63468af5 | Corrected |
|---|---|---|
| PCR-1 | 8 / 3 / 5 / no / 0 | 4 / 1 / 5 / no / 0 |
| PCR-2 | 6 / 3 / 6 / no / 0 | 4 / 1 / 6 / no / 0 |
| JH-1 | 13 / 3 / 10 / no / 0 | 13 / 3 / 10 / no / 0 |
| JH-2 | 1 / 0 / 3 / no / 0 | 1 / 0 / 3 / no / 0 |
| JH-3 | 3 / 1 / 2 / no / 0 | 3 / 1 / 2 / no / 0 |
| JH-4 | 41 / 4 / 14 / no / 1 | 41 / 4 / 14 / no / 1 |
| JH-5 | 8 / 2 / 5 / no / 0 | 8 / 2 / 5 / no / 0 |
| SHJ-1 | 11 / 1 / 12 / no / 2 | 11 / 1 / 12 / no / 2 |
| SHJ-2 | 2 / 1 / 1 / no / 0 | 2 / 1 / 1 / no / 0 |
| SHJ-3 | 8 / 3 / 15 / no / 0 | 8 / 3 / 15 / no / 0 |
| SHJ-4 | 16 / 3 / 12 / no / 0 | 16 / 3 / 12 / no / 0 |
| RWJ-2 | 10 / 3 / 7 / no / 0 | 6 / 2 / 6 / no / 0 |

PCR-1/2 and RWJ-2 withdraw the earlier expansions. The stronger source inventory and generation closure do not justify choosing those bodies. Cuts are retained at the earlier interface boundary; fewer downstream cuts reflect less traversal, not a completeness gain.

## Same 111 pinned probes

The same reconstructed manifest as the initial task is reused exactly on both engines. It is not a claim of historical manifest identity with the deleted slice-4 scratch. Baseline63468af5 was freshly archived; completed immutable baseline sessions were reused when the intermediate after run was stopped. All final after sessions were restarted after the complete generator closure.

| Repository | Traces | Steps | Max depth | Cuts | Complete | Effects |
|---|---|---|---|---|---|---|
| pfe | 15 | 345 → 345 | 4 → 4 | 50 → 50 | 0 → 0 | 47 → 47 |
| pbr | 15 | 390 → 330 | 5 → 5 | 286 → 284 | 0 → 0 | 0 → 0 |
| rwf | 15 | 150 → 150 | 3 → 3 | 67 → 67 | 2 → 2 | 16 → 16 |
| rwb | 15 | 386 → 318 | 6 → 5 | 347 → 330 | 0 → 0 | 0 → 0 |
| shop | 15 | 485 → 485 | 6 → 6 | 261 → 261 | 1 → 1 | 41 → 41 |
| ord | 17 | 383 → 236 | 8 → 8 | 664 → 329 | 0 → 0 | 0 → 0 |
| web | 17 | 2759 → 2759 | 12 → 12 | 1282 → 1282 | 0 → 0 | 0 → 0 |
| self | 2 | 5144 → 5144 | 17 → 17 | 2768 → 2768 | 0 → 0 | 0 → 0 |

Labels: pfe/Petclinic Angular; pbr/Petclinic REST; rwf/Realworld Angular; rwb/Realworld Java; shop/Shopizer admin; ord/ms-name-orders; web/name-webapp; self/ye-ast. The ord/web rows include two acceptance traces each.

Complete-status changes: **0** across 12 named cases and 111 paired probes. No new complete answer is asserted. Effects remain unchanged. All canonical calls succeed, with no timeouts or unknown facts.

## Warm latency

Shopizer, largest Java backend; median of the eight summary samples after discarding the first call per case. The machine had concurrent external load; this is a descriptive comparison, not an isolated causal benchmark.
- before: 20340.2 ms.
- after: 20683.6 ms.

## Verification

- 14-command differential: stdout/stderr/exit byte-identical; all exit 0. Pinned command manifest retained.
- Global code-cleanup and repo extension reviewed only the correction. Existing annotation reader, lexical outer relation, Java resolver, type-name reader and JVM-build classifier reused. No dependency or trace-walk change.
- Single `npm run check`, Node24.22.2: exit 1; typecheck and architecture pass; 3736 tests pass and 10 fail. All ten failures were java-signature-certainty.test.ts comparing the new explained unknown to its old bare UNKNOWN fixture. That one fixture constant was updated; the affected spec then passed 10/10. No production code changed after the full gate. The full gate was not repeated, honoring the owner's one-run limit; no all-green full-gate claim is made.

## Risk

Unclassified XML and programmatic advisors keep conservative global cuts, so depth gains can be withdrawn. Dependency advice outside the supplied snapshot remains the explicit main boundary. Original111 historical identities are unavailable; the same documented reconstructed manifest is pinned for this comparison.
